import { clearAssets, deleteAsset, putAsset } from '../src/asset-store';
import { createSceneArchive } from '../src/export-scene';
import {
  SESSION_KEY,
  sanitizeRecordedRoute,
  sanitizeRecordedText,
  slugify,
  type CapturedState,
  type CapturedStep,
  type RecorderMessage,
  type RecorderResponse,
  type RecorderSession,
} from '../src/protocol';
import { DEFAULT_STUDIO_URL, studioImportUrl, STUDIO_URL_KEY } from '../src/studio-url';

let captureQueue = Promise.resolve();
let lastCaptureAt = 0;
let creatingOffscreenDocument: Promise<void> | undefined;

async function irreversiblyMaskScreenshot(
  source: Uint8Array,
  masks: Extract<RecorderMessage, { type: 'capture' }>['masks'],
): Promise<Uint8Array> {
  if (masks.length === 0) return source;
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    throw new Error('This browser cannot apply the required pre-storage privacy masks.');
  }
  for (const mask of masks) {
    if (
      ![mask.x, mask.y, mask.width, mask.height].every(Number.isFinite) ||
      mask.x < 0 ||
      mask.y < 0 ||
      mask.width <= 0 ||
      mask.height <= 0 ||
      mask.x + mask.width > 1 + Number.EPSILON ||
      mask.y + mask.height > 1 + Number.EPSILON
    ) {
      throw new Error('Capture contains an invalid privacy-mask rectangle.');
    }
  }

  const owned = Uint8Array.from(source);
  const bitmap = await createImageBitmap(new Blob([owned.buffer], { type: 'image/png' }));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('This browser cannot create a secure capture compositor.');
    context.drawImage(bitmap, 0, 0);
    context.fillStyle = '#171512';
    for (const mask of masks) {
      const left = Math.max(0, Math.floor(mask.x * bitmap.width) - 2);
      const top = Math.max(0, Math.floor(mask.y * bitmap.height) - 2);
      const right = Math.min(bitmap.width, Math.ceil((mask.x + mask.width) * bitmap.width) + 2);
      const bottom = Math.min(bitmap.height, Math.ceil((mask.y + mask.height) * bitmap.height) + 2);
      context.fillRect(left, top, right - left, bottom - top);
    }
    const sanitized = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await sanitized.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

function messageComesFromRecordingTab(
  session: RecorderSession,
  sender: chrome.runtime.MessageSender,
): boolean {
  const extensionOrigin = chrome.runtime.getURL('/');
  return (
    sender.tab?.id === undefined ||
    sender.tab.id === session.tabId ||
    sender.url?.startsWith(extensionOrigin) === true
  );
}

async function readSession(): Promise<RecorderSession | undefined> {
  const value = await chrome.storage.session.get(SESSION_KEY);
  return value[SESSION_KEY] as RecorderSession | undefined;
}

async function writeSession(session?: RecorderSession): Promise<void> {
  if (session) await chrome.storage.session.set({ [SESSION_KEY]: session });
  else await chrome.storage.session.remove(SESSION_KEY);
  await chrome.action.setBadgeText({
    text: session?.status === 'recording' ? String(session.steps.length) : '',
  });
  await chrome.action.setBadgeBackgroundColor({ color: '#e5482c' });
}

function decodeDataUrl(dataUrl: string): Uint8Array {
  const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function safelyNotifyTab(tabId: number | undefined, message: unknown): Promise<void> {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Restricted browser pages do not host the content script.
  }
}

async function injectRecorder(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['recorder.js'],
  });
}

type ScreenshotMessage = Extract<RecorderMessage, { type: 'capture' | 'checkpoint' }>;

function assetIsReferenced(session: RecorderSession, assetHash: string): boolean {
  return (
    session.checkpoint?.assetHash === assetHash ||
    session.steps.some((step) => step.assetHash === assetHash)
  );
}

async function captureScreenshot(
  message: ScreenshotMessage,
  sender: chrome.runtime.MessageSender,
): Promise<RecorderResponse> {
  const session = await readSession();
  if (!session || session.status !== 'recording') {
    await safelyNotifyTab(sender.tab?.id, { type: 'capture-complete' });
    return { ok: false, error: 'No active Scenebook recording.' };
  }
  if (sender.tab?.id !== session.tabId) {
    await safelyNotifyTab(sender.tab?.id, { type: 'capture-complete' });
    return { ok: false, error: 'This tab is not the active Scenebook recording.' };
  }

  const task = captureQueue.then(async () => {
    const delay = Math.max(0, 550 - (Date.now() - lastCaptureAt));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      const recordingTab =
        sender.tab?.id === undefined ? undefined : await chrome.tabs.get(sender.tab.id);
      if (!recordingTab?.active) {
        return {
          ok: false,
          error: 'Capture cancelled because the recording tab is no longer active.',
        } as RecorderResponse;
      }
      const screenshot =
        sender.tab?.windowId === undefined
          ? await chrome.tabs.captureVisibleTab({ format: 'png' })
          : await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
      lastCaptureAt = Date.now();
      const bytes = await irreversiblyMaskScreenshot(decodeDataUrl(screenshot), message.masks);
      const assetHash = await sha256(bytes);
      await putAsset(assetHash, bytes);

      const current = await readSession();
      if (!current || current.id !== session.id || current.status !== 'recording') {
        await deleteAsset(assetHash);
        return {
          ok: false,
          error: 'The recording ended before capture completed.',
        } as RecorderResponse;
      }

      const state: CapturedState = {
        createdAt: new Date().toISOString(),
        route: sanitizeRecordedRoute(message.route),
        assetHash,
        assetMime: 'image/png',
        masks: message.masks,
        viewport: message.viewport,
      };
      let updated: RecorderSession;
      if (message.type === 'checkpoint') {
        updated = { ...current, checkpoint: state };
      } else {
        const ordinal = current.steps.length + 1;
        const recordedTitle = sanitizeRecordedText(String(message.title ?? '')).trim();
        const step: CapturedStep = {
          ...state,
          id: `step-${String(ordinal).padStart(2, '0')}`,
          kind: 'capture',
          title: recordedTitle || `Step ${ordinal}`,
          caption: recordedTitle || `Continue to step ${ordinal}.`,
          target: message.target,
        };
        // A manual state capture is also a valid frame for the next interaction. Sharing its
        // content-addressed asset avoids another screenshot without changing the explicit Step.
        updated = { ...current, steps: [...current.steps, step], checkpoint: state };
      }
      await writeSession(updated);
      const superseded = current.checkpoint?.assetHash;
      if (superseded && superseded !== assetHash && !assetIsReferenced(updated, superseded)) {
        await deleteAsset(superseded);
      }
      return { ok: true, session: updated } as RecorderResponse;
    } finally {
      await safelyNotifyTab(sender.tab?.id, { type: 'capture-complete' });
    }
  });

  captureQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return await task;
}

async function captureAction(
  message: Extract<RecorderMessage, { type: 'capture-action' }>,
  sender: chrome.runtime.MessageSender,
): Promise<RecorderResponse> {
  const session = await readSession();
  if (!session || session.status !== 'recording') {
    return { ok: false, error: 'No active Scenebook recording.' };
  }
  if (sender.tab?.id !== session.tabId) {
    return { ok: false, error: 'This tab is not the active Scenebook recording.' };
  }
  if (!session.checkpoint) {
    return {
      ok: false,
      error: 'The recorder is still preparing the pre-action frame. Try the interaction again.',
    };
  }

  const ordinal = session.steps.length + 1;
  const recordedTitle = sanitizeRecordedText(String(message.title ?? '')).trim();
  const step: CapturedStep = {
    ...session.checkpoint,
    id: `step-${String(ordinal).padStart(2, '0')}`,
    kind: 'capture',
    title: recordedTitle || `Step ${ordinal}`,
    caption: recordedTitle || `Continue to step ${ordinal}.`,
    target: message.target,
  };
  const updated: RecorderSession = {
    ...session,
    checkpoint: undefined,
    steps: [...session.steps, step],
  };
  await writeSession(updated);
  return { ok: true, session: updated };
}

async function waitForOffscreenDownload(archiveKey: string, filename: string): Promise<number> {
  const observed: chrome.downloads.DownloadItem[] = [];
  let expectedUrl: string | undefined;
  let resolveDownload: ((id: number) => void) | undefined;
  const created = new Promise<number>((resolveCreated) => {
    resolveDownload = resolveCreated;
  });
  const onCreated = (item: chrome.downloads.DownloadItem): void => {
    observed.push(item);
    if (expectedUrl && item.url === expectedUrl) resolveDownload?.(item.id);
  };
  chrome.downloads.onCreated.addListener(onCreated);
  try {
    const response = (await chrome.runtime.sendMessage({
      target: 'scenebook-offscreen',
      type: 'download-archive',
      archiveKey,
      filename,
    })) as { ok: boolean; url?: string; error?: string };
    if (!response.ok) throw new Error(response.error ?? 'Could not download portable Scene');
    if (!response.url?.startsWith(`blob:${chrome.runtime.getURL('/')}`)) {
      throw new Error('The local download service returned an invalid archive URL.');
    }
    expectedUrl = response.url;
    const alreadyCreated = observed.find((item) => item.url === expectedUrl);
    if (alreadyCreated) return alreadyCreated.id;
    return await Promise.race([
      created,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('The browser did not start the Scene download.')),
          10_000,
        ),
      ),
    ]);
  } finally {
    chrome.downloads.onCreated.removeListener(onCreated);
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  const offscreenUrl = chrome.runtime.getURL('/offscreen.html');
  let exists: boolean;
  if ('getContexts' in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [offscreenUrl],
    });
    exists = contexts.length > 0;
  } else {
    const worker = globalThis as typeof globalThis & {
      clients: { matchAll: () => Promise<Array<{ url: string }>> };
    };
    const contexts = await worker.clients.matchAll();
    exists = contexts.some((context) => context.url === offscreenUrl);
  }
  if (exists) return;
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen
      .createDocument({
        url: offscreenUrl,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: 'Create a local portable Scene download without uploading its contents.',
      })
      .finally(() => {
        creatingOffscreenDocument = undefined;
      });
  }
  await creatingOffscreenDocument;
}

async function download(session: RecorderSession): Promise<number> {
  const archive = await createSceneArchive(session);
  const archiveKey = `download:${crypto.randomUUID()}`;
  await putAsset(archiveKey, archive);
  try {
    await ensureOffscreenDocument();
    return await waitForOffscreenDownload(archiveKey, `${session.sceneId}.scene.zip`);
  } finally {
    await deleteAsset(archiveKey);
  }
}

async function configuredStudioImportUrl(): Promise<string> {
  const stored = await chrome.storage.local.get(STUDIO_URL_KEY);
  const configured = stored[STUDIO_URL_KEY];
  return studioImportUrl(typeof configured === 'string' ? configured : DEFAULT_STUDIO_URL);
}

export async function handleMessage(
  message: RecorderMessage,
  sender: chrome.runtime.MessageSender,
): Promise<RecorderResponse> {
  switch (message.type) {
    case 'status':
      return { ok: true, session: await readSession() };
    case 'start': {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab?.id || !activeTab.url || !/^https?:\/\//u.test(activeTab.url)) {
        return { ok: false, error: 'Open an HTTP or HTTPS product page before recording.' };
      }
      const recordedTitle = sanitizeRecordedText(String(message.title ?? '')).trim();
      const now = new Date().toISOString();
      const session: RecorderSession = {
        id: crypto.randomUUID(),
        tabId: activeTab.id,
        sceneId: slugify(recordedTitle),
        title: recordedTitle || 'Untitled product story',
        startedAt: now,
        status: 'recording',
        steps: [],
        checks: [],
      };
      const previousSession = await readSession();
      await injectRecorder(activeTab.id);
      await writeSession(session);
      try {
        // IndexedDB clear is transactional. Clear superseded evidence only after the new
        // recording tab and session are both established; on failure, restore the prior session.
        await clearAssets();
      } catch (error) {
        await writeSession(previousSession);
        throw error;
      }
      await safelyNotifyTab(activeTab.id, { type: 'recorder-started' });
      return { ok: true, session };
    }
    case 'capture':
    case 'checkpoint':
      return await captureScreenshot(message, sender);
    case 'capture-action':
      return await captureAction(message, sender);
    case 'add-check': {
      const session = await readSession();
      if (!session || session.status !== 'recording')
        return { ok: false, error: 'No active recording.' };
      if (!messageComesFromRecordingTab(session, sender))
        return { ok: false, error: 'This tab is not the active Scenebook recording.' };
      const updated: RecorderSession = {
        ...session,
        checks: [
          ...session.checks,
          {
            id: `check-${session.checks.length + 1}`,
            kind: 'visible',
            label: message.label,
            target: message.target,
          },
        ],
      };
      await writeSession(updated);
      return { ok: true, session: updated };
    }
    case 'undo': {
      const session = await readSession();
      if (session && !messageComesFromRecordingTab(session, sender))
        return { ok: false, error: 'This tab is not the active Scenebook recording.' };
      if (!session?.steps.length) return { ok: true, session };
      const removed = session.steps.at(-1);
      const updated = { ...session, steps: session.steps.slice(0, -1) };
      await writeSession(updated);
      if (removed && !assetIsReferenced(updated, removed.assetHash)) {
        await deleteAsset(removed.assetHash);
      }
      return { ok: true, session: updated };
    }
    case 'stop': {
      const session = await readSession();
      if (!session) return { ok: false, error: 'No recording to stop.' };
      if (!messageComesFromRecordingTab(session, sender))
        return { ok: false, error: 'This tab is not the active Scenebook recording.' };
      const stopped: RecorderSession = {
        ...session,
        status: 'stopped',
        checkpoint: undefined,
      };
      await writeSession(stopped);
      if (session.checkpoint && !assetIsReferenced(stopped, session.checkpoint.assetHash)) {
        await deleteAsset(session.checkpoint.assetHash);
      }
      await safelyNotifyTab(session.tabId, { type: 'recorder-stopped' });
      return { ok: true, session: stopped };
    }
    case 'download': {
      const session = await readSession();
      if (!session?.steps.length) return { ok: false, error: 'Capture at least one step first.' };
      if (!messageComesFromRecordingTab(session, sender))
        return { ok: false, error: 'This tab is not the active Scenebook recording.' };
      const downloadId = await download(session);
      return { ok: true, session, downloadId };
    }
    case 'open-studio': {
      const session = await readSession();
      if (!session?.steps.length) return { ok: false, error: 'Capture at least one step first.' };
      if (!messageComesFromRecordingTab(session, sender))
        return { ok: false, error: 'This tab is not the active Scenebook recording.' };
      // Studio is deliberately a static, local-first application and exposes no
      // unauthenticated loopback upload endpoint. Hand off through an explicit
      // user-owned download, then open its validated import dialog.
      const downloadId = await download(session);
      await chrome.tabs.create({ url: await configuredStudioImportUrl() });
      return { ok: true, session, imported: false, downloadId };
    }
    case 'clear': {
      const session = await readSession();
      if (session && !messageComesFromRecordingTab(session, sender))
        return { ok: false, error: 'This tab is not the active Scenebook recording.' };
      await clearAssets();
      await writeSession();
      return { ok: true };
    }
  }
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener(
    (message: RecorderMessage & { target?: string }, sender, sendResponse) => {
      if (message.target === 'scenebook-offscreen') return false;
      handleMessage(message, sender)
        .then(sendResponse)
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Recorder failed.',
          }),
        );
      return true;
    },
  );
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'complete') return;
    void readSession().then(async (session) => {
      if (session?.status !== 'recording' || session.tabId !== tabId) return;
      try {
        await injectRecorder(tabId);
        await safelyNotifyTab(tabId, { type: 'recorder-started' });
      } catch {
        // activeTab is revoked when a journey crosses origins. The user must
        // explicitly reopen the recorder on that origin before capture resumes.
      }
    });
  });
});
