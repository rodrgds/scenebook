import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { chromium, type ServiceWorker } from '@playwright/test';
import sharp from 'sharp';

const productionExtensionDirectory = resolve(import.meta.dir, '..', '.output', 'chrome-mv3');
const productionStudioDirectory = resolve(import.meta.dir, '..', '..', 'studio', 'build');
const profileDirectory = await mkdtemp(join(tmpdir(), 'scenebook-extension-e2e-'));
const extensionDirectory = join(profileDirectory, 'extension');
await cp(productionExtensionDirectory, extensionDirectory, { recursive: true });
const manifestPath = join(extensionDirectory, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
  host_permissions?: string[];
};
assert.equal(
  manifest.host_permissions,
  undefined,
  'The production extension must not request standing host access',
);
await writeFile(
  manifestPath,
  `${JSON.stringify({ ...manifest, host_permissions: ['<all_urls>'] }, null, 2)}\n`,
);
let privateFrameUrl = '';
const privateFrameServer = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html lang="en"><body style="margin:0;background:#fff">
    <label>Card number <input value="4111 1111 1111 1111"></label>
    <p>account.owner@example.test</p>
  </body></html>`);
});
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html>
    <html lang="en"><head><title>Recorder fixture</title></head><body>
      <label>Email address <input type="email" value="private.person@example.test"></label>
      <div contenteditable="true" aria-label="Private note">violet otter launch phrase</div>
      <iframe title="External payment widget" src="${privateFrameUrl}" style="display:block;width:340px;height:120px"></iframe>
      <div id="phase" aria-hidden="true" style="position:fixed;left:900px;top:40px;width:40px;height:40px;background:rgb(10,80,200)"></div>
      <button type="button" id="invite">Invite member</button>
      <div style="position:relative;width:max-content;margin-top:16px">
        <button type="button" id="blocked">Blocked action</button>
        <div id="blocked-cover" aria-hidden="true" style="position:absolute;inset:0;z-index:2;background:#fff"></div>
      </div>
      <script>
        document.querySelector('#invite').addEventListener('pointerdown', () => {
          document.querySelector('#phase').style.background = 'rgb(200,40,10)';
          const revealed = document.createElement('p');
          revealed.dataset.scenebookRedact = 'author';
          revealed.textContent = 'newly.revealed@example.test';
          document.body.append(revealed);
        });
      </script>
    </body></html>`);
});
const studioServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const decoded = decodeURIComponent(url.pathname);
    const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+|\/+$/gu, '');
    const path = resolve(productionStudioDirectory, relativePath);
    if (
      path !== productionStudioDirectory &&
      !path.startsWith(`${productionStudioDirectory}${sep}`)
    ) {
      response.writeHead(400).end('Invalid path');
      return;
    }
    const types: Record<string, string> = {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    };
    response.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream');
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end('Not found');
  }
});

await new Promise<void>((resolveListen, rejectListen) => {
  privateFrameServer.once('error', rejectListen);
  privateFrameServer.listen(0, '127.0.0.1', resolveListen);
});
const privateFrameAddress = privateFrameServer.address();
assert(privateFrameAddress && typeof privateFrameAddress === 'object');
privateFrameUrl = `http://127.0.0.1:${privateFrameAddress.port}/private-frame`;
await new Promise<void>((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', resolveListen);
});
await new Promise<void>((resolveListen, rejectListen) => {
  studioServer.once('error', rejectListen);
  studioServer.listen(0, '127.0.0.1', resolveListen);
});

const address = server.address();
assert(address && typeof address === 'object');
const studioAddress = studioServer.address();
assert(studioAddress && typeof studioAddress === 'object');
const context = await chromium.launchPersistentContext(profileDirectory, {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${extensionDirectory}`,
    `--load-extension=${extensionDirectory}`,
  ],
});

try {
  let worker: ServiceWorker | undefined = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent('serviceworker', { timeout: 10_000 });
  const extensionId = new URL(worker.url()).hostname;
  const extensionPage = await context.newPage();
  await extensionPage.setViewportSize({ width: 320, height: 600 });
  await extensionPage.goto(`chrome-extension://${extensionId}/popup.html`);
  const popupLayouts = await extensionPage.evaluate(() => {
    const viewIds = ['idle-view', 'active-view', 'finished-view'];
    const initial = viewIds.map((id) => document.getElementById(id)!.hidden);
    const layouts = viewIds.map((visibleId) => {
      for (const id of viewIds) document.getElementById(id)!.hidden = id !== visibleId;
      const viewportWidth = document.documentElement.clientWidth;
      return {
        visibleId,
        viewportWidth,
        scrollWidth: document.documentElement.scrollWidth,
        buttons: [...document.querySelectorAll<HTMLButtonElement>('button')]
          .filter((button) => button.getClientRects().length > 0)
          .map((button) => {
            const bounds = button.getBoundingClientRect();
            return {
              id: button.id,
              height: bounds.height,
              left: bounds.left,
              right: bounds.right,
            };
          }),
      };
    });
    viewIds.forEach((id, index) => {
      document.getElementById(id)!.hidden = initial[index]!;
    });
    return layouts;
  });
  for (const layout of popupLayouts) {
    assert.equal(layout.viewportWidth, 320, `${layout.visibleId} must render at the 320px target`);
    assert.equal(
      layout.scrollWidth,
      layout.viewportWidth,
      `${layout.visibleId} must not overflow horizontally`,
    );
    assert(layout.buttons.length > 0, `${layout.visibleId} must expose its action controls`);
    for (const button of layout.buttons) {
      assert(
        button.height >= 44,
        `${layout.visibleId} action ${button.id} must retain a 44px target`,
      );
      assert(
        button.left >= 0 && button.right <= layout.viewportWidth,
        `${layout.visibleId} action ${button.id} must remain within the viewport`,
      );
    }
  }
  const productPagePromise = context.waitForEvent('page');
  const createdTab = await extensionPage.evaluate(
    async (url) => chrome.tabs.create({ url, active: true }),
    `http://127.0.0.1:${address.port}`,
  );
  const page = await productPagePromise;
  await page.waitForLoadState('load');
  assert(createdTab.id);
  await extensionPage.evaluate(
    async (tabId) => chrome.tabs.update(tabId, { active: true }),
    createdTab.id,
  );

  const started = await extensionPage.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'start', title: 'Extension privacy proof' }),
  );
  assert.equal(started.ok, true, JSON.stringify(started));

  const input = page.getByLabel('Email address');
  const inputBox = await input.boundingBox();
  assert(inputBox, 'Sensitive input must be visible');
  const privateFrame = page.getByTitle('External payment widget');
  const privateFrameBox = await privateFrame.boundingBox();
  assert(privateFrameBox, 'Cross-origin private frame must be visible');
  const phaseBox = await page.locator('#phase').boundingBox();
  assert(phaseBox, 'Screenshot-phase marker must be visible');
  await page.getByRole('button', { name: 'Invite member' }).focus();
  await page.keyboard.press('Enter');

  const deadline = Date.now() + 8_000;
  let session:
    | {
        steps?: Array<{
          assetHash: string;
          masks: Array<{
            x: number;
            y: number;
            width: number;
            height: number;
            reason: string;
          }>;
          target?: {
            accessibleName?: string;
            nearbyText?: string;
            selectors: string[];
            visible?: boolean;
            occluded?: boolean;
          };
          viewport: { width: number; height: number; devicePixelRatio: number };
        }>;
        checkpoint?: { assetHash: string };
      }
    | undefined;
  while (Date.now() < deadline) {
    session = await worker.evaluate(async () => {
      const stored = await chrome.storage.session.get('scenebook.recorder.session.v1');
      return stored['scenebook.recorder.session.v1'];
    });
    if (session?.steps?.length === 1) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  assert.equal(session?.steps?.length, 1, 'A keyboard activation should create one captured step');
  assert.equal(
    session?.steps?.[0]?.masks.length,
    3,
    'The Step must retain only masks present in the pre-action frame',
  );
  assert.equal(
    session?.steps?.[0]?.masks.some((mask) => mask.reason === 'author'),
    false,
    'Content revealed by the action belongs to the following checkpoint, not states.before',
  );
  const embeddedMask = session?.steps?.[0]?.masks.find(
    (mask) => mask.reason === 'embedded-content',
  );
  assert(embeddedMask, 'Opaque embedded content must receive a fail-closed automatic mask');
  const frameCenter = {
    x: (privateFrameBox.x + privateFrameBox.width / 2) / page.viewportSize()!.width,
    y: (privateFrameBox.y + privateFrameBox.height / 2) / page.viewportSize()!.height,
  };
  assert(
    frameCenter.x >= embeddedMask.x &&
      frameCenter.x <= embeddedMask.x + embeddedMask.width &&
      frameCenter.y >= embeddedMask.y &&
      frameCenter.y <= embeddedMask.y + embeddedMask.height,
    'The embedded-content mask must cover the rendered cross-origin frame',
  );
  assert.equal(
    JSON.stringify(session?.steps?.[0]?.target).includes('violet otter launch phrase'),
    false,
    'Arbitrary typed content must not enter target names, selectors, or nearby metadata',
  );
  assert.equal(session?.steps?.[0]?.target?.visible, true);
  assert.equal(session?.steps?.[0]?.target?.occluded, false);

  const checkpointDeadline = Date.now() + 8_000;
  while (Date.now() < checkpointDeadline) {
    session = await worker.evaluate(async () => {
      const stored = await chrome.storage.session.get('scenebook.recorder.session.v1');
      return stored['scenebook.recorder.session.v1'];
    });
    if (session?.checkpoint) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert(session?.checkpoint, 'The post-action pre-action checkpoint must be ready');
  await page.evaluate(() => {
    const target = document.querySelector<HTMLButtonElement>('#blocked');
    if (!target) throw new Error('Missing occluded target fixture');
    target.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        composed: true,
        pointerId: 71,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 1,
      }),
    );
    target.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        composed: true,
        pointerId: 71,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 0,
      }),
    );
  });
  const occlusionDeadline = Date.now() + 8_000;
  while (Date.now() < occlusionDeadline) {
    session = await worker.evaluate(async () => {
      const stored = await chrome.storage.session.get('scenebook.recorder.session.v1');
      return stored['scenebook.recorder.session.v1'];
    });
    if (session?.steps?.length === 2) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert.equal(session?.steps?.length, 2, 'The synthetic covered action should be recorded');
  assert.equal(session?.steps?.[1]?.target?.visible, true);
  assert.equal(
    session?.steps?.[1]?.target?.occluded,
    true,
    'A real covering element must be retained as target occlusion evidence',
  );
  const assetHash = session?.steps?.[0]?.assetHash;
  assert(assetHash);

  const storedBytes = await worker.evaluate(async (hash) => {
    const database = await new Promise<IDBDatabase>((resolveDatabase, rejectDatabase) => {
      const request = indexedDB.open('scenebook-recorder-v1', 1);
      request.onsuccess = () => resolveDatabase(request.result);
      request.onerror = () => rejectDatabase(request.error);
    });
    try {
      return await new Promise<number[]>((resolveAsset, rejectAsset) => {
        const transaction = database.transaction('assets', 'readonly');
        const request = transaction.objectStore('assets').get(hash);
        request.onsuccess = () => resolveAsset(Array.from(request.result as Uint8Array));
        request.onerror = () => rejectAsset(request.error);
      });
    } finally {
      database.close();
    }
  }, assetHash);

  const decoded = await sharp(Buffer.from(storedBytes))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const phaseX = Math.round(
    ((phaseBox.x + phaseBox.width / 2) * decoded.info.width) / page.viewportSize()!.width,
  );
  const phaseY = Math.round(
    ((phaseBox.y + phaseBox.height / 2) * decoded.info.height) / page.viewportSize()!.height,
  );
  const phaseOffset = (phaseY * decoded.info.width + phaseX) * 4;
  assert.deepEqual(
    Array.from(decoded.data.subarray(phaseOffset, phaseOffset + 3)),
    [10, 80, 200],
    'states.before must contain the UI pixels from before the recorded pointer action',
  );
  for (const recordedMask of session?.steps?.[0]?.masks ?? []) {
    const x = Math.round((recordedMask.x + recordedMask.width / 2) * decoded.info.width);
    const y = Math.round((recordedMask.y + recordedMask.height / 2) * decoded.info.height);
    const offset = (y * decoded.info.width + x) * 4;
    assert.deepEqual(
      Array.from(decoded.data.subarray(offset, offset + 3)),
      [23, 21, 18],
      'Every sensitive region must be replaced before the PNG reaches IndexedDB',
    );
  }

  const stopped = await extensionPage.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'stop' }),
  );
  assert.equal(stopped.ok, true);

  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
  await optionsPage.getByLabel('Studio URL').fill(`http://127.0.0.1:${studioAddress.port}/`);
  await optionsPage.getByRole('button', { name: 'Save connection' }).click();
  await optionsPage.getByText('Studio connection saved.').waitFor();
  await optionsPage.close();

  const studioOrigin = `http://127.0.0.1:${studioAddress.port}`;
  const opened = await extensionPage.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'open-studio' }),
  );
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(typeof opened.downloadId, 'number', 'Studio handoff must expose its download');
  const studioPageDeadline = Date.now() + 10_000;
  let studioPage = context.pages().find((candidate) => candidate.url().startsWith(studioOrigin));
  while (!studioPage && Date.now() < studioPageDeadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    studioPage = context.pages().find((candidate) => candidate.url().startsWith(studioOrigin));
  }
  assert(studioPage, 'Configured Studio tab must open');
  await studioPage.waitForLoadState('domcontentloaded');
  await studioPage
    .getByRole('heading', { name: 'Import Scenes or a project' })
    .waitFor({ timeout: 10_000 });
  assert.equal(new URL(studioPage.url()).origin, studioOrigin);
  let archiveDownload: chrome.downloads.DownloadItem | undefined;
  const downloadDeadline = Date.now() + 10_000;
  while (Date.now() < downloadDeadline) {
    archiveDownload = await extensionPage.evaluate(async (downloadId) => {
      const downloads = await chrome.downloads.search({ id: downloadId });
      return downloads[0];
    }, opened.downloadId);
    if (archiveDownload?.state === 'complete') break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert.equal(archiveDownload?.state, 'complete', 'Portable Scene download must complete');
  assert.equal(archiveDownload?.danger, 'safe');
  assert.equal(archiveDownload?.mime, 'application/zip');
  const archiveFile = await stat(archiveDownload.filename);
  assert(archiveFile.size > 0, 'Portable Scene download must contain bytes');
  assert.deepEqual(
    Array.from((await readFile(archiveDownload.filename)).subarray(0, 4)),
    [0x50, 0x4b, 0x03, 0x04],
    'Portable Scene download must be a ZIP archive',
  );
  process.stdout.write(
    'Extension E2E passed: masked pixels persisted, target occlusion was measured, a non-empty portable ZIP downloaded, the validated Studio setting was honored, and the built import dialog opened.\n',
  );
} finally {
  await context.close();
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  await new Promise<void>((resolveClose, rejectClose) =>
    studioServer.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  await new Promise<void>((resolveClose, rejectClose) =>
    privateFrameServer.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  await rm(profileDirectory, { recursive: true, force: true });
}
