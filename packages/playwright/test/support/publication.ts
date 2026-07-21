import { canonicalJsonHash, sha256, stableStringify } from '@scenebook/core';
import type { UploadTokenService } from '@scenebook/server';
import { Zip, ZipDeflate } from 'fflate';

interface RequestApp {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

export interface PublicationFixtureOptions {
  readonly app: RequestApp;
  readonly uploadTokens: UploadTokenService;
  readonly now: Date;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly commit: string;
  readonly ref: string;
  readonly workflowRef: string;
  readonly tokenId: string;
  readonly uploadKey: string;
  readonly sceneId: string;
  readonly sourceRevision: string;
  readonly bytes: Uint8Array;
}

function archive(files: readonly { path: string }[], bytesByPath: ReadonlyMap<string, Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let failure: unknown;
  const zip = new Zip((error, bytes) => {
    if (error) failure = error;
    else chunks.push(bytes);
  });
  for (const file of files) {
    const entry = new ZipDeflate(file.path, { level: 9 });
    entry.mtime = new Date(1980, 0, 1, 0, 0, 0, 0);
    entry.os = 3;
    entry.attrs = (0o100644 << 16) >>> 0;
    zip.add(entry);
    entry.push(bytesByPath.get(file.path)!, true);
  }
  zip.end();
  if (failure) throw failure;
  return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function requireStatus(response: Response | Promise<Response>, status: number) {
  const resolved = await response;
  if (resolved.status !== status) {
    throw new Error(
      `Publication fixture request failed: ${resolved.status} ${await resolved.text()}`,
    );
  }
  return resolved;
}

export async function finalizePublicationFixture(options: PublicationFixtureOptions) {
  const token = await options.uploadTokens.issue(
    {
      workspaceId: options.workspaceId,
      projectId: options.projectId,
      repository: options.repository,
      commit: options.commit,
      ref: options.ref,
      workflowRef: options.workflowRef,
      permissions: ['artifact:write'],
      expiresAt: Math.floor(options.now.getTime() / 1_000) + 300,
      tokenId: options.tokenId,
    },
    Math.floor(options.now.getTime() / 1_000),
  );
  const outputPath = `scenes/${options.sceneId}/index.html`;
  const outputFile = {
    path: outputPath,
    sha256: sha256(options.bytes),
    byteLength: options.bytes.byteLength,
    mediaType: 'text/html',
  } as const;
  const compilerManifestBytes = new TextEncoder().encode(
    `${stableStringify({
      format: 'scenebook-catalog',
      version: 1,
      privacy: { status: 'passed', scanner: 'fixture' },
      scenes: [
        {
          id: options.sceneId,
          slug: options.sceneId,
          sourceHash: options.sourceRevision,
          locale: 'en',
          evidence: `scenes/${options.sceneId}/evidence.json`,
          outputs: { catalog: [outputPath] },
        },
      ],
    })}\n`,
  );
  const compilerManifestFile = {
    path: 'manifest.json',
    sha256: sha256(compilerManifestBytes),
    byteLength: compilerManifestBytes.byteLength,
    mediaType: 'application/json',
  } as const;
  const evidencePath = `scenes/${options.sceneId}/evidence.json`;
  const evidenceBytes = new TextEncoder().encode('{}\n');
  const files = [
    compilerManifestFile,
    outputFile,
    {
      path: evidencePath,
      sha256: sha256(evidenceBytes),
      byteLength: evidenceBytes.byteLength,
      mediaType: 'application/json',
    } as const,
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const archiveBytes = archive(
    files,
    new Map([
      ['manifest.json', compilerManifestBytes],
      [outputPath, options.bytes],
      [evidencePath, evidenceBytes],
    ]),
  );
  const archiveObject = {
    sha256: sha256(archiveBytes),
    byteLength: archiveBytes.byteLength,
    mediaType: 'application/zip',
  } as const;
  const treeHash = canonicalJsonHash({ files });
  const inventoryBytes = new TextEncoder().encode(
    `${stableStringify({
      format: 'scenebook-publication-archive',
      version: 1,
      archive: archiveObject,
      treeHash,
      byteLength: files.reduce((total, file) => total + file.byteLength, 0),
      compilerManifest: compilerManifestFile,
      files,
    })}\n`,
  );
  const inventoryObject = {
    sha256: sha256(inventoryBytes),
    byteLength: inventoryBytes.byteLength,
    mediaType: 'application/json',
  } as const;
  const compilerManifestObject = {
    sha256: compilerManifestFile.sha256,
    byteLength: compilerManifestFile.byteLength,
    mediaType: 'application/json',
  } as const;
  const objects = [archiveObject, inventoryObject, compilerManifestObject];
  const begin = await requireStatus(
    options.app.request('/v1/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': options.uploadKey,
      },
      body: JSON.stringify({ objects }),
    }),
    201,
  );
  const uploadId = ((await begin.json()) as { upload: { id: string } }).upload.id;
  for (const [object, bytes] of [
    [archiveObject, archiveBytes],
    [inventoryObject, inventoryBytes],
    [compilerManifestObject, compilerManifestBytes],
  ] as const) {
    await requireStatus(
      options.app.request(`/v1/uploads/${uploadId}/objects/${object.sha256}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': object.mediaType },
        body: bytes.slice().buffer,
      }),
      200,
    );
  }
  const publication = {
    archive: archiveObject,
    inventory: inventoryObject,
    compilerManifest: compilerManifestObject,
    treeHash,
  };
  const manifest = {
    schemaVersion: 1,
    objects,
    metadata: { publication },
  };
  await requireStatus(
    options.app.request(`/v1/uploads/${uploadId}/finalize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ manifest }),
    }),
    200,
  );
  return {
    uploadId,
    manifestHash: canonicalJsonHash(manifest),
    publication,
    output: {
      format: 'catalog' as const,
      locale: 'en',
      entrypoint: outputPath,
      asset: { ...outputFile, role: 'document' as const },
    },
  };
}
