import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecorderSession } from './protocol';

const assets = vi.hoisted(() => ({
  clearAssets: vi.fn(),
  deleteAsset: vi.fn(),
  putAsset: vi.fn(),
}));

vi.mock('./asset-store', () => assets);
vi.mock('./export-scene', () => ({ createSceneArchive: vi.fn() }));

let storedSession: RecorderSession | undefined;
let chromeMock: any;

function priorSession(): RecorderSession {
  return {
    id: 'prior-session',
    tabId: 9,
    sceneId: 'prior-scene',
    title: 'Prior recording',
    startedAt: '2026-07-20T12:00:00.000Z',
    status: 'stopped',
    checks: [],
    steps: [
      {
        id: 'prior-step',
        kind: 'capture',
        title: 'Prior step',
        caption: 'Prior caption',
        createdAt: '2026-07-20T12:00:01.000Z',
        route: 'https://example.test/prior',
        assetHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        assetMime: 'image/png',
        masks: [],
        viewport: { width: 1200, height: 800, devicePixelRatio: 1 },
      },
    ],
  };
}

async function background() {
  vi.stubGlobal('defineBackground', vi.fn());
  return await import('../entrypoints/background');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  storedSession = priorSession();
  chromeMock = {
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
    runtime: {
      getURL: vi.fn(() => 'chrome-extension://scenebook/'),
    },
    scripting: { executeScript: vi.fn(async () => undefined) },
    storage: {
      session: {
        get: vi.fn(async () => ({ 'scenebook.recorder.session.v1': storedSession })),
        set: vi.fn(async (value: Record<string, RecorderSession>) => {
          storedSession = value['scenebook.recorder.session.v1'];
        }),
        remove: vi.fn(async () => {
          storedSession = undefined;
        }),
      },
      local: { get: vi.fn(async () => ({})) },
    },
    tabs: {
      query: vi.fn(async () => [{ id: 42, url: 'https://example.test/app' }]),
      get: vi.fn(async () => ({ id: 42, active: true })),
      captureVisibleTab: vi.fn(async () => 'data:image/png;base64,iVBORw=='),
      sendMessage: vi.fn(async () => undefined),
    },
  };
  vi.stubGlobal('chrome', chromeMock);
});

describe('background persistence boundary', () => {
  it('sanitizes popup Scene titles before session persistence and slugging', async () => {
    const { handleMessage } = await background();

    const response = await handleMessage(
      { type: 'start', title: 'Invite private@example.test' },
      {} as chrome.runtime.MessageSender,
    );

    expect(response).toMatchObject({
      ok: true,
      session: { title: 'Invite [PRIVATE]', sceneId: 'invite-private' },
    });
    expect(storedSession?.title).toBe('Invite [PRIVATE]');
    expect(assets.clearAssets).toHaveBeenCalledOnce();
  });

  it('sanitizes captured HUD Step titles and captions before session persistence', async () => {
    storedSession = { ...priorSession(), tabId: 42, status: 'recording', steps: [] };
    const { handleMessage } = await background();

    const response = await handleMessage(
      {
        type: 'capture',
        title: 'Choose private@example.test',
        route: 'https://example.test/app',
        masks: [],
        viewport: { width: 1200, height: 800, devicePixelRatio: 1 },
      },
      { tab: { id: 42, active: true } } as chrome.runtime.MessageSender,
    );

    expect(response).toMatchObject({
      ok: true,
      session: {
        steps: [{ title: 'Choose [PRIVATE]', caption: 'Choose [PRIVATE]' }],
      },
    });
    expect(storedSession?.steps[0]?.title).toBe('Choose [PRIVATE]');
  });

  it('binds an interaction to the privacy-scrubbed frame captured before the action', async () => {
    storedSession = { ...priorSession(), tabId: 42, status: 'recording', steps: [] };
    const { handleMessage } = await background();
    const sender = { tab: { id: 42, active: true } } as chrome.runtime.MessageSender;

    const checkpoint = await handleMessage(
      {
        type: 'checkpoint',
        route: 'https://example.test/app?private=value#secret',
        masks: [],
        viewport: { width: 1200, height: 800, devicePixelRatio: 1 },
      },
      sender,
    );

    expect(checkpoint).toMatchObject({ ok: true, session: { steps: [] } });
    expect(storedSession?.checkpoint).toMatchObject({
      route: 'https://example.test/app',
      assetMime: 'image/png',
    });
    const preActionHash = storedSession?.checkpoint?.assetHash;
    expect(preActionHash).toMatch(/^[a-f0-9]{64}$/u);

    const action = await handleMessage(
      {
        type: 'capture-action',
        title: 'Choose Invite member',
        target: {
          accessibleName: 'Invite member',
          role: 'button',
          selectors: ["getByRole('button', { name: 'Invite member' })"],
        },
      },
      sender,
    );

    expect(action).toMatchObject({
      ok: true,
      session: {
        steps: [
          {
            title: 'Choose Invite member',
            route: 'https://example.test/app',
            assetHash: preActionHash,
            target: { accessibleName: 'Invite member' },
          },
        ],
      },
    });
    expect(storedSession?.checkpoint).toBeUndefined();
    expect(chromeMock.tabs.captureVisibleTab).toHaveBeenCalledOnce();
  });

  it('refuses to label a post-action screenshot as before evidence', async () => {
    storedSession = { ...priorSession(), tabId: 42, status: 'recording', steps: [] };
    const { handleMessage } = await background();

    const response = await handleMessage(
      {
        type: 'capture-action',
        title: 'Choose Invite member',
        target: { accessibleName: 'Invite member', selectors: ['#invite'] },
      },
      { tab: { id: 42, active: true } } as chrome.runtime.MessageSender,
    );

    expect(response).toMatchObject({ ok: false, error: expect.stringContaining('pre-action') });
    expect(storedSession?.steps).toEqual([]);
    expect(chromeMock.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('preserves prior session evidence when the active tab is not recordable', async () => {
    chromeMock.tabs.query.mockResolvedValue([{ id: 42, url: 'chrome://settings' }]);
    const previous = storedSession;
    const { handleMessage } = await background();

    await expect(
      handleMessage({ type: 'start', title: 'New recording' }, {} as chrome.runtime.MessageSender),
    ).resolves.toMatchObject({ ok: false });

    expect(storedSession).toBe(previous);
    expect(assets.clearAssets).not.toHaveBeenCalled();
    expect(chromeMock.storage.session.set).not.toHaveBeenCalled();
  });

  it('preserves prior evidence when recorder injection fails', async () => {
    chromeMock.scripting.executeScript.mockRejectedValue(new Error('injection denied'));
    const previous = storedSession;
    const { handleMessage } = await background();

    await expect(
      handleMessage({ type: 'start', title: 'New recording' }, {} as chrome.runtime.MessageSender),
    ).rejects.toThrow('injection denied');

    expect(storedSession).toBe(previous);
    expect(assets.clearAssets).not.toHaveBeenCalled();
    expect(chromeMock.storage.session.set).not.toHaveBeenCalled();
  });

  it('rolls the session back when transactional asset clearing fails', async () => {
    assets.clearAssets.mockRejectedValueOnce(new Error('clear aborted'));
    const previous = storedSession;
    const { handleMessage } = await background();

    await expect(
      handleMessage({ type: 'start', title: 'New recording' }, {} as chrome.runtime.MessageSender),
    ).rejects.toThrow('clear aborted');

    expect(storedSession).toBe(previous);
    expect(chromeMock.storage.session.set).toHaveBeenCalledTimes(2);
  });
});
