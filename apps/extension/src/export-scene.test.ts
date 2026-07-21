import { unzipSync, strFromU8 } from 'fflate';
import { SceneSchema } from '@scenebook/schema';
import { parse } from 'yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecorderSession } from './protocol';

vi.mock('./asset-store', () => ({
  getAsset: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
}));

describe('portable recorder export', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a source archive without captured field values', async () => {
    const session: RecorderSession = {
      id: 'session-1',
      tabId: 123,
      sceneId: 'invite-member',
      title: 'Invite a member',
      startedAt: '2026-07-20T12:00:00.000Z',
      status: 'stopped',
      checks: [],
      steps: [
        {
          id: 'open-form',
          kind: 'capture',
          title: 'Open invitation form',
          caption: 'Choose Invite member.',
          createdAt: '2026-07-20T12:00:01.000Z',
          route: 'https://example.test/members',
          assetHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          assetMime: 'image/png',
          masks: [],
          viewport: { width: 1440, height: 900, devicePixelRatio: 2 },
          target: {
            accessibleName: 'Invite member',
            selectors: ["getByRole('button')"],
            visible: true,
            occluded: true,
          },
        },
      ],
    };

    const { createSceneArchive } = await import('./export-scene');
    const archive = unzipSync(await createSceneArchive(session));
    expect(Object.keys(archive)).toContain(
      'assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    );
    const yaml = strFromU8(archive['scene.yaml']!);
    expect(yaml).toContain('Invite a member');
    expect(yaml).not.toContain('inputValue');
    const scene = SceneSchema.parse(parse(yaml));
    expect(scene.capability).toBe('captured');
    expect(scene.automation.level).toBe('none');
    expect(scene.steps[0]?.target).toMatchObject({ visible: true, occluded: true });
    expect(scene.steps[0]?.actions).toMatchObject([
      {
        id: 'open-form-click',
        kind: 'click',
        target: { visible: true, occluded: true },
      },
    ]);
    expect(strFromU8(archive['automation/replay.ts']!)).toContain(
      'page.getByRole("button" as never, { name: "Invite member", exact: true })',
    );
    expect(strFromU8(archive['README.md']!)).toContain('unverified draft');
  });

  it('does not invent a replay file when a capture has no stable locator evidence', async () => {
    const session: RecorderSession = {
      id: 'session-2',
      tabId: 123,
      sceneId: 'visual-state',
      title: 'Visual state',
      startedAt: '2026-07-20T12:00:00.000Z',
      status: 'stopped',
      checks: [],
      steps: [
        {
          id: 'state',
          kind: 'capture',
          title: 'Review state',
          caption: 'Review the current state.',
          createdAt: '2026-07-20T12:00:01.000Z',
          route: 'https://example.test/state',
          assetHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          assetMime: 'image/png',
          masks: [],
          viewport: { width: 1440, height: 900, devicePixelRatio: 1 },
        },
      ],
    };

    const { createSceneArchive } = await import('./export-scene');
    const archive = unzipSync(await createSceneArchive(session));
    expect(archive['automation/replay.ts']).toBeUndefined();
    const scene = SceneSchema.parse(parse(strFromU8(archive['scene.yaml']!)));
    expect(scene.metadata.replayDraft).toBe(false);
  });

  it('redacts sensitive legacy Scene and Step titles again at export', async () => {
    const session: RecorderSession = {
      id: 'session-private-title',
      tabId: 123,
      sceneId: 'private-title',
      title: 'Invite private@example.test',
      startedAt: '2026-07-20T12:00:00.000Z',
      status: 'stopped',
      checks: [],
      steps: [
        {
          id: 'state',
          kind: 'capture',
          title: 'Use card 4111 1111 1111 1111',
          caption: 'Token sk-proj-abcdefghijklmnopqrstuvwxyz',
          createdAt: '2026-07-20T12:00:01.000Z',
          route: 'https://example.test/state',
          assetHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          assetMime: 'image/png',
          masks: [],
          viewport: { width: 1440, height: 900, devicePixelRatio: 1 },
        },
      ],
    };

    const { createSceneArchive } = await import('./export-scene');
    const archive = unzipSync(await createSceneArchive(session));
    const serialized = Object.values(archive)
      .filter((bytes) => bytes.byteLength < 100_000)
      .map((bytes) => strFromU8(bytes))
      .join('\n');
    expect(serialized).not.toContain('private@example.test');
    expect(serialized).not.toContain('4111 1111 1111 1111');
    expect(serialized).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz');
    expect(serialized).toContain('Invite [PRIVATE]');
    expect(serialized).toContain('Use card [PRIVATE]');
  });
});
