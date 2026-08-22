import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '@scenebook/core';
import { unzipSync, zipSync } from 'fflate';

import { FileSystemObjectStore, type ImmutableObjectStore } from '../src/object-store.js';
import { MemoryControlPlaneRepository } from '../src/testing.js';
import {
  createWorkspaceZipStream,
  prepareWorkspaceExport,
  WorkspaceExportLimitError,
} from '../src/workspace-export.js';

const roots: string[] = [];
const NOW = '2026-07-20T12:00:00.000Z';
const limits = {
  maxActiveUploadsPerTenant: 20,
  maxActiveUploadsGlobal: 20,
  maxActiveBytesPerTenant: 100_000,
  maxActiveBytesGlobal: 100_000,
};
const exportByteLimits = {
  maxMetadataBytes: 10 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function readBody(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function upload(
  repository: MemoryControlPlaneRepository,
  store: FileSystemObjectStore,
  id: string,
  mediaType: string,
  bytes: Uint8Array,
  sourceRepository = 'acme/product',
) {
  const object = { sha256: sha256(bytes), byteLength: bytes.byteLength, mediaType };
  await repository.beginUpload({
    id,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    repository: sourceRepository,
    commit: 'a'.repeat(40),
    ref: 'refs/heads/main',
    idempotencyKey: id,
    requestHash: sha256(id),
    objects: [object],
    now: NOW,
    expiresAt: '2026-07-20T13:00:00.000Z',
    limits,
  });
  const staged = await store.putStaged(id, object.sha256, bytes, mediaType);
  await repository.markObjectStaged(id, object.sha256, mediaType, staged.key, NOW);
  const final = await store.promote(staged, 'workspace-1');
  await repository.finalizeUpload(id, sha256(`manifest:${id}`), [final], NOW);
  return final;
}

describe('portable workspace export', () => {
  it('streams an integrity inventory, permitted assets, withheld entries, and no credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-workspace-export-'));
    roots.push(root);
    const repository = new MemoryControlPlaneRepository();
    const store = new FileSystemObjectStore(root);
    await repository.createWorkspace({
      id: 'workspace-1',
      slug: 'acme',
      name: 'Acme',
      now: NOW,
    });
    await repository.createProject({
      id: 'project-1',
      workspaceId: 'workspace-1',
      slug: 'product',
      name: 'Product',
      now: NOW,
    });
    const screenshot = await upload(
      repository,
      store,
      'upload-screenshot',
      'image/png',
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwO0GQAAAABJRU5ErkJggg==',
        'base64',
      ),
      'scenebook-studio',
    );
    const withheld = await upload(
      repository,
      store,
      'upload-private-debug',
      'text/plain',
      new TextEncoder().encode('local debug payload'),
    );
    repository.verificationBaselines.set('baseline-1', {
      id: 'baseline-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sceneId: 'scene-1',
      sourceRevision: 'b'.repeat(64),
      sourceRunId: 'run-1',
      sourceRunHash: 'c'.repeat(64),
      artifactHash: 'd'.repeat(64),
      idempotencyKey: 'baseline-1',
      requestHash: 'e'.repeat(64),
      recordedBy: 'reviewer-1',
      recordedAt: NOW,
      baseline: {
        states: [{ screenshot, privacy: { status: 'clear' } }],
      },
    } as never);
    repository.verificationRunners.set('runner-1', {
      id: 'runner-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      name: 'Private runner',
      tokenHash: 'super-secret-token-hash',
      scheduleIds: [],
      createdBy: 'owner-1',
      createdAt: NOW,
      expiresAt: '2027-07-20T12:00:00.000Z',
    });
    await repository.bindRepository({
      id: 'repository-binding-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      repository: 'acme/product',
      workflowRefPattern: 'refs/heads/*',
      createdAt: NOW,
    });
    await repository.putGitHubInstallationBinding({
      id: 'github-installation-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      repositoryBindingId: 'repository-binding-1',
      installationId: '12345',
      githubRepositoryId: '67890',
      defaultBranch: 'main',
      createdBy: 'owner-1',
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    });
    await repository.putStudioWorkspace({
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      writes: [
        {
          expectedRevision: 0,
          record: {
            id: 'hosted-studio-scene',
            scene: { id: 'hosted-studio-scene', version: 1, title: 'Hosted working draft' },
            savedAt: Date.parse(NOW),
            revision: 1,
            storageVersion: 4,
            payloadRefs: [
              {
                slot: 'step-image',
                key: 'step-1',
                sha256: screenshot.sha256,
                mediaType: screenshot.mediaType,
                byteLength: screenshot.byteLength,
                representation: 'binary-data-uri',
              },
            ],
          },
        },
      ],
      actorId: 'owner-1',
      now: NOW,
    });

    const value = await prepareWorkspaceExport({
      repository,
      objectStore: store,
      workspaceId: 'workspace-1',
      createdAt: NOW,
      maxRecords: 1_000,
      maxAssets: 100,
      maxAssetBytes: 10_000,
      ...exportByteLimits,
    });
    const files = unzipSync(await readBody(value.body));
    expect(Object.keys(files).sort()).toEqual([
      `assets/${screenshot.sha256}.${Buffer.from('image/png').toString('base64url')}`,
      'manifest.json',
      'restoration.json',
      'workspace.json',
    ]);
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as {
      manifestHash: string;
      assets: Array<{ sha256: string; disposition: string; reason: string }>;
    };
    expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest).toMatchObject({ restoration: { restorable: true } });
    expect(manifest.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sha256: screenshot.sha256, disposition: 'included' }),
        expect.objectContaining({ sha256: withheld.sha256, disposition: 'withheld' }),
      ]),
    );
    const records = new TextDecoder().decode(files['workspace.json']);
    expect(records).toContain('Private runner');
    expect(records).not.toContain('super-secret-token-hash');
    expect(records).not.toContain('analyticsTokenHash');
    expect(records).not.toContain('finalKey');
    expect(records).toContain('github-installation-1');
    expect(records).toContain('12345');
    expect(records).toContain('hosted-studio-scene');
    expect(records).toContain('Hosted working draft');
  });

  it('exports a restorable graph for Scene assets, State screenshots, and every Release publication object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-workspace-restore-'));
    roots.push(root);
    const repository = new MemoryControlPlaneRepository();
    const store = new FileSystemObjectStore(root);
    await repository.createWorkspace({ id: 'workspace-1', slug: 'acme', name: 'Acme', now: NOW });
    await repository.createProject({
      id: 'project-1',
      workspaceId: 'workspace-1',
      slug: 'product',
      name: 'Product',
      now: NOW,
    });
    const sceneAsset = await upload(
      repository,
      store,
      'upload-scene-asset',
      'text/plain',
      new TextEncoder().encode('authored Scene asset'),
    );
    const stateScreenshot = await upload(
      repository,
      store,
      'upload-scene-state',
      'image/png',
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwO0GQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const archive = await upload(
      repository,
      store,
      'upload-release-archive',
      'application/zip',
      zipSync({ 'index.html': new TextEncoder().encode('<h1>Published</h1>') }),
    );
    const publicationInventory = await upload(
      repository,
      store,
      'upload-release-inventory',
      'application/json',
      new TextEncoder().encode('{"format":"inventory"}'),
    );
    const compilerManifest = await upload(
      repository,
      store,
      'upload-release-compiler',
      'application/json',
      new TextEncoder().encode('{"format":"compiler"}'),
    );
    const privacyExcluded = await upload(
      repository,
      store,
      'upload-private-scene-asset',
      'text/plain',
      new TextEncoder().encode('privacy warning asset'),
    );
    const privacy = {
      status: 'clear',
      scannedAt: NOW,
      scannerVersion: '1.0.0',
      counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
      findings: [],
    };
    repository.revisions.set('project-1\0scene-1\0revision-1', {
      id: 'scene-revision-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sceneId: 'scene-1',
      revision: 'revision-1',
      scene: {
        id: 'scene-1',
        assets: [sceneAsset],
        steps: [
          {
            id: 'step-1',
            states: { before: { id: 'state-1', screenshot: stateScreenshot } },
          },
        ],
      },
      privacy,
      createdBy: 'owner-1',
      createdAt: NOW,
    } as never);
    repository.revisions.set('project-1\0scene-private\0revision-private', {
      id: 'scene-revision-private',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sceneId: 'scene-private',
      revision: 'revision-private',
      scene: { id: 'scene-private', assets: [privacyExcluded], steps: [] },
      privacy: { ...privacy, status: 'warning' },
      createdBy: 'owner-1',
      createdAt: NOW,
    } as never);
    repository.channels.set('channel-1', {
      id: 'channel-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      slug: 'public',
      name: 'Public',
      kind: 'public-catalog',
      policy: {},
      webhookIds: [],
      analyticsTokenHash: 'a'.repeat(64),
      sequence: 1,
      currentReleaseId: 'release-1',
      createdAt: NOW,
    } as never);
    repository.releases.set('release-1', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      idempotencyKey: 'release-1',
      requestHash: 'b'.repeat(64),
      release: {
        id: 'release-1',
        channelId: 'channel-1',
        sequence: 1,
        scenes: [
          {
            sceneId: 'scene-1',
            outputs: [{ format: 'html-guide', asset: sceneAsset }],
          },
        ],
        publication: { archive, inventory: publicationInventory, compilerManifest },
      },
    } as never);

    const value = await prepareWorkspaceExport({
      repository,
      objectStore: store,
      workspaceId: 'workspace-1',
      createdAt: NOW,
      maxRecords: 1_000,
      maxAssets: 100,
      maxAssetBytes: 1_000_000,
      ...exportByteLimits,
    });
    const files = unzipSync(await readBody(value.body));
    const expected = [sceneAsset, stateScreenshot, archive, publicationInventory, compilerManifest];
    for (const object of expected) {
      const path = `assets/${object.sha256}.${Buffer.from(object.mediaType).toString('base64url')}`;
      expect(files[path]).toBeDefined();
      expect(sha256(files[path]!)).toBe(object.sha256);
    }
    expect(
      files[
        `assets/${privacyExcluded.sha256}.${Buffer.from(privacyExcluded.mediaType).toString('base64url')}`
      ],
    ).toBeUndefined();
    const restoration = JSON.parse(new TextDecoder().decode(files['restoration.json'])) as {
      restorable: boolean;
      objects: Array<{ sha256: string; referencedBy: string[] }>;
      privacyExclusions: Array<{ sha256: string; reason: string }>;
      missingReferences: Array<{ sha256: string; referencedBy: string[]; reason: string }>;
    };
    expect(restoration.restorable).toBe(false);
    expect(restoration.objects.map((object) => object.sha256).sort()).toEqual(
      expected.map((object) => object.sha256).sort(),
    );
    expect(
      restoration.objects.find((object) => object.sha256 === publicationInventory.sha256)
        ?.referencedBy,
    ).toContain('release:release-1:publication:inventory');
    expect(
      restoration.objects.find((object) => object.sha256 === compilerManifest.sha256)?.referencedBy,
    ).toContain('release:release-1:publication:compiler-manifest');
    expect(restoration.privacyExclusions).toContainEqual(
      expect.objectContaining({
        sha256: privacyExcluded.sha256,
        reason: 'referenced object is excluded by the immutable record privacy policy',
      }),
    );
    expect(restoration.missingReferences).toEqual([
      expect.objectContaining({
        sha256: privacyExcluded.sha256,
        referencedBy: ['scene:scene-private:revision-private:asset:warning'],
      }),
    ]);
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as {
      members: Array<{ path: string; sha256: string }>;
      restoration: {
        restorable: boolean;
        requiredObjectCount: number;
        includedObjectCount: number;
        missingObjectCount: number;
      };
    };
    expect(manifest.restoration).toMatchObject({
      restorable: false,
      requiredObjectCount: 6,
      includedObjectCount: 5,
      missingObjectCount: 1,
    });
    for (const member of manifest.members) {
      expect(sha256(files[member.path]!)).toBe(member.sha256);
    }
  });

  it('pulls ZIP input on demand and cancels the active object iterator', async () => {
    let reads = 0;
    let returned = false;
    const object = {
      key: 'workspaces/workspace-1/objects/'.padEnd(120, 'a'),
      sha256: 'a'.repeat(64),
      byteLength: 64 * 1024 * 100,
      mediaType: 'application/octet-stream',
    };
    const store = {
      readStream: async function* () {
        try {
          while (true) {
            reads += 1;
            yield new Uint8Array(64 * 1024);
          }
        } finally {
          returned = true;
        }
      },
    } as unknown as ImmutableObjectStore;
    const stream = createWorkspaceZipStream([{ path: 'assets/large.bin', object }], store);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reads).toBeLessThanOrEqual(1);
    const reader = stream.getReader();
    for (let index = 0; index < 4 && reads === 0; index += 1) {
      expect((await reader.read()).done).toBe(false);
    }
    expect(reads).toBeGreaterThan(0);
    const readsAtCancel = reads;
    await reader.cancel('client disconnected');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(returned).toBe(true);
    expect(reads).toBeLessThanOrEqual(readsAtCancel + 1);
  });

  it('fails closed before streaming when bounded asset limits would truncate the inventory', async () => {
    const repository = new MemoryControlPlaneRepository();
    await repository.createWorkspace({ id: 'workspace-1', slug: 'acme', name: 'Acme', now: NOW });
    await repository.createProject({
      id: 'project-1',
      workspaceId: 'workspace-1',
      slug: 'product',
      name: 'Product',
      now: NOW,
    });
    const store = new FileSystemObjectStore(
      await mkdtemp(join(tmpdir(), 'scenebook-workspace-export-limit-')),
    );
    roots.push(store.root);
    await upload(repository, store, 'upload-1', 'text/plain', new TextEncoder().encode('one'));
    await upload(repository, store, 'upload-2', 'text/plain', new TextEncoder().encode('two'));
    await expect(
      prepareWorkspaceExport({
        repository,
        objectStore: store,
        workspaceId: 'workspace-1',
        createdAt: NOW,
        maxRecords: 1_000,
        maxAssets: 1,
        maxAssetBytes: 10_000,
        ...exportByteLimits,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceExportLimitError>>({ kind: 'assets' }),
    );
  });

  it('rejects oversized valid metadata and exact total ZIP size before returning a stream', async () => {
    class MetadataRepository extends MemoryControlPlaneRepository {
      listProjectsCalls = 0;

      override async listProjects(workspaceId: string, limit: number) {
        this.listProjectsCalls += 1;
        return super.listProjects(workspaceId, limit);
      }
    }
    const repository = new MetadataRepository();
    await repository.createWorkspace({ id: 'workspace-1', slug: 'acme', name: 'Acme', now: NOW });
    await repository.createProject({
      id: 'project-1',
      workspaceId: 'workspace-1',
      slug: 'product',
      name: 'Product',
      now: NOW,
    });
    await repository.appendAudit({
      id: 'audit-large-metadata',
      workspaceId: 'workspace-1',
      actorId: 'owner-1',
      action: 'workspace.metadata-recorded',
      targetType: 'workspace',
      targetId: 'workspace-1',
      requestId: 'request-large-metadata',
      metadata: { report: 'x'.repeat(32 * 1024) },
      createdAt: NOW,
    });
    const store = new FileSystemObjectStore(
      await mkdtemp(join(tmpdir(), 'scenebook-workspace-export-metadata-limit-')),
    );
    roots.push(store.root);
    await expect(
      prepareWorkspaceExport({
        repository,
        objectStore: store,
        workspaceId: 'workspace-1',
        createdAt: NOW,
        maxRecords: 1_000,
        maxAssets: 100,
        maxAssetBytes: 10_000,
        maxMetadataBytes: 4 * 1024,
        maxTotalBytes: 100 * 1024 * 1024,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceExportLimitError>>({ kind: 'metadata-bytes' }),
    );
    expect(repository.listProjectsCalls).toBe(0);

    repository.audits.length = 0;
    await expect(
      prepareWorkspaceExport({
        repository,
        objectStore: store,
        workspaceId: 'workspace-1',
        createdAt: NOW,
        maxRecords: 1_000,
        maxAssets: 100,
        maxAssetBytes: 10_000,
        maxMetadataBytes: 10 * 1024 * 1024,
        maxTotalBytes: 1_024,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceExportLimitError>>({ kind: 'total-bytes' }),
    );
  });
});
