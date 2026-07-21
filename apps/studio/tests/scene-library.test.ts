import { describe, expect, it, vi } from 'vitest';

import { demoScene } from '../src/lib/demo';
import { cloneScene } from '../src/lib/model';
import {
  LocalStorageRecoveryJournal,
  MemoryRecoveryJournal,
  MemorySceneStorage,
  ScenePayloadIntegrityError,
  SceneLibrary,
  SceneStorageError,
  STUDIO_DATABASE_VERSION,
  coalesceMaintenanceSceneIds,
  compactStoredSceneRecord,
  createBlankScene,
  hydrateStoredSceneRecords,
  hydrateStoredSceneRecord,
  releaseLocalMediaUrls,
  settlePostCommitMaintenance,
  summarizeStoredSceneRecord,
  upgradeStudioDatabaseSchema,
} from '../src/lib/scene-library';
import type { SceneBatchWrite, StoredProjectRecord } from '../src/lib/scene-library';
import type {
  ScenePayloadRecord,
  ScenePayloadReference,
  StoredSceneRecord,
} from '../src/lib/scene-library';

function library() {
  return new SceneLibrary(new MemorySceneStorage(), new MemoryRecoveryJournal());
}

function storedScene(scene = createBlankScene('payload-test', 'Payload test')): StoredSceneRecord {
  return { id: scene.id, scene, savedAt: 1_700_000_000_000, revision: 1 };
}

function payloadResolver(payloads: readonly ScenePayloadRecord[]) {
  const byIdentity = new Map(
    payloads.map((payload) => [`${payload.sha256}\u0000${payload.mediaType}`, payload]),
  );
  return async (reference: ScenePayloadReference) =>
    byIdentity.get(`${reference.sha256}\u0000${reference.mediaType}`);
}

describe('IndexedDB schema upgrades', () => {
  it('repairs pre-release v6 pagination indexes idempotently in v7', () => {
    const sceneIndexes = new Set(['savedAt']);
    const versionIndexes = new Set<string>();
    const sceneCreateIndex = vi.fn((name: string) => sceneIndexes.add(name));
    const versionCreateIndex = vi.fn((name: string) => versionIndexes.add(name));
    const stores = new Map<string, unknown>([
      [
        'scenes',
        {
          indexNames: { contains: (name: string) => sceneIndexes.has(name) },
          createIndex: sceneCreateIndex,
        },
      ],
      [
        'scene-versions',
        {
          indexNames: { contains: (name: string) => versionIndexes.has(name) },
          createIndex: versionCreateIndex,
        },
      ],
      ['projects', {}],
      ['scene-payloads', {}],
    ]);
    const database = {
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore: vi.fn(),
    } as unknown as IDBDatabase;
    const transaction = {
      objectStore: (name: string) => stores.get(name),
    } as unknown as IDBTransaction;

    expect(STUDIO_DATABASE_VERSION).toBe(7);
    upgradeStudioDatabaseSchema(database, transaction);
    expect(sceneCreateIndex).toHaveBeenCalledWith('savedAtId', ['savedAt', 'id']);
    expect(versionCreateIndex).toHaveBeenCalledWith('sceneId', 'id');

    upgradeStudioDatabaseSchema(database, transaction);
    expect(sceneCreateIndex).toHaveBeenCalledTimes(1);
    expect(versionCreateIndex).toHaveBeenCalledTimes(1);
    expect(database.createObjectStore).not.toHaveBeenCalled();
  });
});

describe('content-addressed Scene payload codec', () => {
  it('deduplicates embedded bytes across slots and revisions while keeping records compact', async () => {
    const scene = createBlankScene('large-payload', 'Large payload');
    const dataUri = `data:image/png;base64,${'A'.repeat(2_000_000)}`;
    scene.steps[0]!.image = dataUri;
    scene.steps.push({ ...structuredClone(scene.steps[0]!), id: 'step-2', image: dataUri });
    scene.portableAssets = { 'assets/screen.png': dataUri };
    const first = await compactStoredSceneRecord(storedScene(scene));
    scene.description = 'A later autosave changes only metadata.';
    const second = await compactStoredSceneRecord({
      ...storedScene(scene),
      savedAt: 1_700_000_001_000,
      revision: 2,
    });

    expect(first.payloads).toHaveLength(1);
    expect(first.record.payloadRefs).toHaveLength(3);
    expect(second.payloads).toHaveLength(1);
    expect(second.payloads[0]!.sha256).toBe(first.payloads[0]!.sha256);
    expect(second.payloads[0]!.mediaType).toBe(first.payloads[0]!.mediaType);
    expect(JSON.stringify(first.record)).not.toContain('AAAAAA');
    expect(JSON.stringify(first.record).length).toBeLessThan(10_000);
    expect(first.payloads[0]!.byteLength).toBeGreaterThan(1_000_000);
  });

  it('keeps true first/final catalog previews and deduplicates identical endpoint media', async () => {
    const scene = createBlankScene('catalog-endpoints', 'Catalog endpoints');
    scene.steps[0]!.image = 'data:image/png;base64,Zmlyc3Q=';
    scene.steps.push({
      ...structuredClone(scene.steps[0]!),
      id: 'final',
      image: 'data:image/png;base64,ZmluYWw=',
    });
    const compacted = await compactStoredSceneRecord(storedScene(scene));
    const resolve = vi.fn(payloadResolver(compacted.payloads));
    const summary = await summarizeStoredSceneRecord(compacted.record, true, resolve);

    expect(summary.firstImage).toMatch(/^blob:/u);
    expect(summary.finalImage).toMatch(/^blob:/u);
    expect(summary.finalImage).not.toBe(summary.firstImage);
    expect(summary.screenStepCount).toBe(2);
    expect(summary.screenAssetCount).toBe(2);
    expect(summary.automationLevel).toBe('none');
    expect(summary.checkCount).toBe(0);
    expect(summary.publicationStatus).toBe('draft');
    expect(summary.audiences).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(2);
    releaseLocalMediaUrls(summary);

    scene.steps[1]!.image = scene.steps[0]!.image;
    const shared = await compactStoredSceneRecord(storedScene(scene));
    const sharedResolve = vi.fn(payloadResolver(shared.payloads));
    const sharedSummary = await summarizeStoredSceneRecord(shared.record, true, sharedResolve);
    expect(sharedSummary.finalImage).toBe(sharedSummary.firstImage);
    expect(sharedResolve).toHaveBeenCalledOnce();
    releaseLocalMediaUrls(sharedSummary);
  });

  it('round-trips exact UTF-8/data-URI values and leaves remote URLs inline', async () => {
    const scene = createBlankScene('exact-round-trip', 'Exact round trip');
    const exactDataUri = 'data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMSAxIj48L3N2Zz4=';
    scene.steps[0]!.image = exactDataUri;
    scene.steps.push({
      ...structuredClone(scene.steps[0]!),
      id: 'remote-step',
      image: 'https://cdn.example.test/product.png?version=2',
    });
    scene.portableAssets = {
      'assets/exact.svg': exactDataUri,
      'assets/remote.png': 'https://cdn.example.test/archive.png',
    };
    scene.portableSidecars = { 'narrative.md': 'Olá — exact Unicode text' };
    const source = storedScene(scene);
    const compacted = await compactStoredSceneRecord(source);
    const hydrated = await hydrateStoredSceneRecord(
      compacted.record,
      payloadResolver(compacted.payloads),
    );

    expect(hydrated.scene.steps[0]!.image).toMatch(/^blob:/u);
    expect(hydrated.scene.portableAssets?.['assets/exact.svg']).toBe(
      hydrated.scene.steps[0]!.image,
    );
    expect(hydrated.scene.portableSidecars?.['narrative.md']).toBe('Olá — exact Unicode text');
    expect(compacted.record.scene.steps[1]!.image).toBe(
      'https://cdn.example.test/product.png?version=2',
    );
    expect(compacted.record.scene.portableAssets?.['assets/remote.png']).toBe(
      'https://cdn.example.test/archive.png',
    );
    releaseLocalMediaUrls(hydrated);
  });

  it('uses media type as part of immutable identity for otherwise identical blob bytes', async () => {
    const scene = createBlankScene('media-identity', 'Media identity');
    scene.steps[0]!.image = 'blob:image-png';
    scene.steps.push({ ...structuredClone(scene.steps[0]!), id: 'jpeg', image: 'blob:image-jpeg' });
    const compacted = await compactStoredSceneRecord(storedScene(scene), async (url) => ({
      bytes: new Uint8Array([0, 1, 2, 3, 4]),
      mediaType: url.endsWith('png') ? 'image/png' : 'image/jpeg',
    }));
    const [first, second] = compacted.payloads;

    expect(compacted.payloads).toHaveLength(2);
    expect(first!.sha256).toBe(second!.sha256);
    expect(new Set(compacted.payloads.map((payload) => payload.mediaType))).toEqual(
      new Set(['image/png', 'image/jpeg']),
    );
    const hydrated = await hydrateStoredSceneRecord(
      compacted.record,
      payloadResolver(compacted.payloads),
    );
    expect(hydrated.scene.steps[0]!.image).toMatch(/^blob:/u);
    expect(hydrated.scene.steps[1]!.image).toMatch(/^blob:/u);
    expect(hydrated.scene.steps[0]!.image).not.toBe(hydrated.scene.steps[1]!.image);
    releaseLocalMediaUrls(hydrated);
  });

  it('addresses decoded media bytes rather than duplicating equivalent data-URI encodings', async () => {
    const scene = createBlankScene('equivalent-encodings', 'Equivalent encodings');
    scene.steps[0]!.image = 'data:text/plain;base64,aGVsbG8=';
    scene.portableAssets = { 'assets/hello.txt': 'data:text/plain,hello' };
    const compacted = await compactStoredSceneRecord(storedScene(scene));
    const hydrated = await hydrateStoredSceneRecord(
      compacted.record,
      payloadResolver(compacted.payloads),
    );

    expect(compacted.payloads).toHaveLength(1);
    expect(compacted.payloads[0]!.byteLength).toBe(5);
    expect(compacted.record.payloadRefs).toHaveLength(2);
    expect(hydrated.scene.steps[0]!.image).toMatch(/^blob:/u);
    expect(hydrated.scene.portableAssets?.['assets/hello.txt']).toBe(
      hydrated.scene.steps[0]!.image,
    );
    releaseLocalMediaUrls(hydrated);
  });

  it('fails closed for missing, corrupt, and conflicting payload references', async () => {
    const scene = createBlankScene('corrupt-payload', 'Corrupt payload');
    scene.steps[0]!.image = 'data:image/png;base64,aW1hZ2U=';
    const compacted = await compactStoredSceneRecord(storedScene(scene));

    await expect(
      hydrateStoredSceneRecord(compacted.record, async () => undefined),
    ).rejects.toBeInstanceOf(ScenePayloadIntegrityError);

    const corrupt = structuredClone(compacted.payloads[0]!);
    corrupt.bytes = new Uint8Array([1, 2, 3]).buffer;
    corrupt.byteLength = 3;
    await expect(
      hydrateStoredSceneRecord(compacted.record, async () => corrupt),
    ).rejects.toBeInstanceOf(ScenePayloadIntegrityError);

    const conflicting = structuredClone(compacted.record);
    conflicting.payloadRefs.push({
      ...conflicting.payloadRefs[0]!,
      key: conflicting.payloadRefs[0]!.key,
      mediaType: 'image/jpeg',
    });
    await expect(
      hydrateStoredSceneRecord(conflicting, payloadResolver(compacted.payloads)),
    ).rejects.toBeInstanceOf(SceneStorageError);
  });

  it('shares one Blob URL and one payload read across 100 revisions of a 25 MB-class asset', async () => {
    const scene = createBlankScene('shared-large-asset', 'Shared large asset');
    scene.steps[0]!.image = 'blob:pending-large-screenshot';
    const bytes = new Uint8Array(25 * 1024 * 1024 - 1);
    bytes.set([0x89, 0x50, 0x4e, 0x47]);
    const compacted = await compactStoredSceneRecord(storedScene(scene), async () => ({
      bytes,
      mediaType: 'image/png',
    }));
    const records = Array.from({ length: 100 }, (_, index) => ({
      ...structuredClone(compacted.record),
      savedAt: compacted.record.savedAt + index,
      revision: index + 1,
    }));
    const resolve = vi.fn(payloadResolver(compacted.payloads));
    const hydrated = await hydrateStoredSceneRecords(records, resolve);

    expect(resolve).toHaveBeenCalledOnce();
    expect(new Set(hydrated.map((record) => record.scene.steps[0]!.image)).size).toBe(1);
    expect(hydrated[0]!.scene.steps[0]!.image).toMatch(/^blob:/u);
    expect(compacted.payloads[0]!.byteLength).toBe(bytes.byteLength);
    releaseLocalMediaUrls(hydrated);
  });

  it('reads v3 inline records and applies opaque-only defaults to legacy masks', async () => {
    const scene = createBlankScene('legacy-inline', 'Legacy inline');
    scene.steps[0]!.image = 'data:image/png;base64,bGVnYWN5';
    scene.steps[0]!.masks = [
      {
        id: 'legacy-mask',
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
      } as never,
    ];
    const legacy = storedScene(scene);
    const resolver = vi.fn();
    const hydrated = await hydrateStoredSceneRecord(legacy, resolver);

    expect(hydrated.scene.steps[0]!.image).toBe(scene.steps[0]!.image);
    expect(hydrated.scene.steps[0]!.masks[0]).toMatchObject({
      mode: 'opaque',
      source: 'manual',
      scope: 'both',
      classification: 'custom',
    });
    expect(hydrated.scene.steps[0]!.masks[0]!.locator).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe('durable local Scene library', () => {
  it('keeps crash recovery bounded and hydrates omitted media from the durable revision', async () => {
    const journal = new LocalStorageRecoveryJournal();
    const scenes = new SceneLibrary(new MemorySceneStorage(), journal);
    const scene = await scenes.create('Large recovery');
    const durableImage = `data:image/png;base64,${'A'.repeat(2_000_000)}`;
    const unsavedImage = `data:image/png;base64,${'B'.repeat(2_000_000)}`;
    scene.steps[0]!.image = durableImage;
    scene.portableSource = { id: scene.id } as never;
    scene.portableAssets = { 'assets/screen.png': durableImage };
    scene.portableSidecars = {
      'narrative.md': `data:text/plain;base64,${'C'.repeat(2_000_000)}`,
    };
    await scenes.save(scene);

    scene.description = 'Unsaved text survives';
    scene.steps[0]!.image = unsavedImage;
    const written = scenes.writeRecovery(scene);
    const serialized = localStorage.getItem(`scenebook:recovery:${scene.id}`);

    expect(serialized).not.toBeNull();
    expect(serialized!.length).toBeLessThan(25_000);
    expect(serialized).not.toContain('AAAAAA');
    expect(serialized).not.toContain('BBBBBB');
    expect(serialized).not.toContain('CCCCCC');
    expect(written.omittedMedia).toEqual({
      imageStepIds: [scene.steps[0]!.id],
      portablePayload: true,
    });

    const loaded = await scenes.load(scene.id);
    expect(loaded.recovery?.scene.description).toBe('Unsaved text survives');
    expect(loaded.recovery?.scene.steps[0]!.image).toBe(durableImage);
    expect(loaded.recovery?.scene.portableSource).toEqual(scene.portableSource);
    expect(loaded.recovery?.scene.portableAssets).toEqual(scene.portableAssets);
    expect(loaded.recovery?.scene.portableSidecars).toEqual(scene.portableSidecars);
    expect(loaded.recovery?.omittedMedia).toEqual({
      imageStepIds: [scene.steps[0]!.id],
      portablePayload: true,
    });
  });

  it('creates stable unique IDs and persists revisions', async () => {
    const scenes = library();
    const first = await scenes.create('Release Tour');
    const second = await scenes.create('Release Tour');
    expect(first.id).toBe('release-tour');
    expect(second.id).toBe('release-tour-2');

    first.description = 'Updated';
    const record = await scenes.save(first);
    expect(record.revision).toBe(2);
    expect((await scenes.load(first.id)).scene?.description).toBe('Updated');
  });

  it('keeps a newer crash journal until that exact edit is durably saved', async () => {
    const scenes = library();
    const scene = await scenes.create('Recovery test');
    scene.title = 'Recovered title';
    const firstRecovery = scenes.writeRecovery(scene);
    scene.title = 'Newer title';
    const newerRecovery = scenes.writeRecovery(scene);

    await scenes.save(firstRecovery.scene, firstRecovery.token);
    expect((await scenes.load(scene.id)).recovery?.token).toBe(newerRecovery.token);

    await scenes.save(newerRecovery.scene, newerRecovery.token);
    expect((await scenes.load(scene.id)).recovery).toBeNull();
    expect((await scenes.load(scene.id)).scene?.title).toBe('Newer title');
  });

  it('keeps committed saves committed when post-commit pruning fails', async () => {
    expect(coalesceMaintenanceSceneIds(['one', 'two', 'one', 'three', 'two'])).toEqual([
      'one',
      'two',
      'three',
    ]);
    class PruneFailingStorage extends MemorySceneStorage {
      override async putBatch(
        writes: readonly SceneBatchWrite[],
        project?: StoredProjectRecord,
      ): Promise<void> {
        await super.putBatch(writes, project);
        await settlePostCommitMaintenance([
          Promise.reject(new SceneStorageError('Injected prune failure.', 'write')),
        ]);
      }
    }
    const scenes = new SceneLibrary(new PruneFailingStorage(), new MemoryRecoveryJournal());
    const scene = await scenes.create('Committed cleanup failure');
    scene.description = 'The second revision commits';
    expect((await scenes.save(scene)).revision).toBe(2);
    scene.description = 'A later save does not see a false conflict';
    expect((await scenes.save(scene)).revision).toBe(3);
    expect((await scenes.load(scene.id)).scene?.description).toBe(
      'A later save does not see a false conflict',
    );
  });

  it('retains immutable local revisions and restores an old snapshot as a new revision', async () => {
    const scenes = library();
    const scene = await scenes.create('Versioned scene');
    scene.title = 'Second title';
    await scenes.save(scene);
    scene.title = 'Third title';
    await scenes.save(scene);

    const versions = await scenes.listVersionSummaries(scene.id);
    expect(versions.items.map((version) => version.revision)).toEqual([3, 2, 1]);
    expect(versions.items[1]!.title).toBe('Second title');
    expect((await scenes.loadVersion(scene.id, 2))?.scene.title).toBe('Second title');

    const restored = await scenes.restoreVersion(scene.id, 1);
    expect(restored.revision).toBe(4);
    expect(restored.scene.title).toBe('Versioned scene');
    expect(
      (await scenes.listVersionSummaries(scene.id)).items.map((version) => version.revision),
    ).toEqual([4, 3, 2, 1]);
  });

  it('pages 100 revision summaries without loading any revision payload until selected', async () => {
    const storage = new MemorySceneStorage();
    const scenes = new SceneLibrary(storage, new MemoryRecoveryJournal());
    const scene = await scenes.create('Paged revisions');
    scene.steps[0]!.image = 'blob:shared-25mb-class-asset';
    for (let revision = 2; revision <= 100; revision += 1) {
      scene.description = `Revision ${revision}`;
      await scenes.save(scene);
    }
    const getVersion = vi.spyOn(storage, 'getVersion');
    const first = await scenes.listVersionSummaries(scene.id, { limit: 25 });
    const second = await scenes.listVersionSummaries(scene.id, {
      limit: 25,
      cursor: first.nextCursor,
    });

    expect(first.items).toHaveLength(25);
    expect(first.items[0]!.revision).toBe(100);
    expect(second.items[0]!.revision).toBe(75);
    expect(getVersion).not.toHaveBeenCalled();
    expect((await scenes.loadVersion(scene.id, 75))?.revision).toBe(75);
    expect(getVersion).toHaveBeenCalledOnce();
  });

  it('rejects stale cross-tab saves without replacing current data or history', async () => {
    const storage = new MemorySceneStorage();
    const firstTab = new SceneLibrary(storage, new MemoryRecoveryJournal());
    const secondTab = new SceneLibrary(storage, new MemoryRecoveryJournal());
    const created = await firstTab.create('Cross-tab Scene');
    const stale = (await secondTab.load(created.id)).scene!;

    created.description = 'Saved by the first tab';
    await firstTab.save(created);
    stale.description = 'Stale second-tab overwrite';
    secondTab.writeRecovery(stale);

    await expect(secondTab.save(stale)).rejects.toMatchObject({
      name: 'SceneRevisionConflictError',
      expectedRevision: 1,
      actualRevision: 2,
    });
    expect((await firstTab.load(created.id)).scene?.description).toBe('Saved by the first tab');
    expect(
      (await firstTab.listVersionSummaries(created.id)).items.map((item) => item.revision),
    ).toEqual([2, 1]);
    expect((await secondTab.load(created.id)).recovery?.scene.description).toBe(
      'Stale second-tab overwrite',
    );
  });

  it('duplicates presentation content without reusing the monitored source identity', async () => {
    const scenes = library();
    const source = cloneScene(demoScene);
    source.portableSource = { id: source.id } as never;
    await scenes.save(source);
    const copy = await scenes.duplicate(source);
    expect(copy.id).toBe('invite-teammate-copy');
    expect(copy.title).toBe('Invite a teammate copy');
    expect(copy.portableSource).toBeUndefined();
    expect(copy.steps).toEqual(source.steps);
  });

  it('renames imported conflicts and rewrites cross-Scene choices as one transaction plan', async () => {
    const scenes = library();
    await scenes.save(cloneScene(demoScene));
    const first = cloneScene(demoScene);
    const second = cloneScene(demoScene);
    second.id = 'invite-member-access';
    second.title = 'Member access';
    second.steps = second.steps.slice(0, 1);
    const imported = await scenes.importScenes([first, second], 'rename');
    expect(imported.renamed).toEqual([{ from: 'invite-teammate', to: 'invite-teammate-2' }]);
    expect(imported.imported[0]!.steps[2]!.choices[0]!.sceneId).toBe('invite-member-access');
    expect((await scenes.list()).map((scene) => scene.id)).toEqual(
      expect.arrayContaining(['invite-teammate', 'invite-teammate-2', 'invite-member-access']),
    );
  });

  it('rolls back every Scene and the project when a later write in an import batch conflicts', async () => {
    const storage = new MemorySceneStorage();
    const existing = createBlankScene('already-there', 'Already there');
    await storage.put(storedScene(existing), 0);
    const first = createBlankScene('new-scene', 'New Scene');
    const conflicting = createBlankScene('already-there', 'Stale replacement');
    const project: StoredProjectRecord = {
      id: 'atomic-project',
      project: {
        schemaVersion: 1,
        id: 'atomic-project',
        name: 'Atomic project',
        scenes: ['new-scene', 'already-there'],
        collections: [],
        channels: [],
      } as never,
      savedAt: 3,
    };

    await expect(
      storage.putBatch(
        [
          { record: storedScene(first), expectedRevision: 0 },
          { record: storedScene(conflicting), expectedRevision: 0 },
        ],
        project,
      ),
    ).rejects.toMatchObject({ name: 'SceneRevisionConflictError' });
    expect(await storage.get('new-scene')).toBeNull();
    expect((await storage.get('already-there'))?.scene.title).toBe('Already there');
    expect(await storage.getProject('atomic-project')).toBeNull();
  });

  it('deletes both the durable record and recovery journal', async () => {
    const scenes = library();
    const scene = await scenes.create('Disposable');
    scenes.writeRecovery(scene);
    await scenes.delete(scene.id);
    expect((await scenes.load(scene.id)).scene).toBeNull();
    expect((await scenes.load(scene.id)).recovery).toBeNull();
  });
});
