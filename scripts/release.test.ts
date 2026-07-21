import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AGPL_LICENSE,
  APACHE_LICENSE,
  deriveReleaseMetadata,
  discoverPublicPackages,
  expectedLicense,
  metadataMatches,
  readManifest,
  topologicalPackageOrder,
  workspaceRoot,
  type PackageManifest,
  type ReleasePackage,
} from './release-packages';
import { assertPublishEnvironment } from './publish-release';

describe('public release packages', () => {
  it('discovers the complete split-license package set in dependency order', async () => {
    const packages = await discoverPublicPackages();
    expect(packages.map((item) => item.manifest.name).toSorted()).toEqual([
      '@scenebook/adapters',
      '@scenebook/artifact',
      '@scenebook/cli',
      '@scenebook/compiler',
      '@scenebook/core',
      '@scenebook/diff',
      '@scenebook/playwright',
      '@scenebook/policy',
      '@scenebook/privacy',
      '@scenebook/schema',
      '@scenebook/server',
      '@scenebook/viewer',
    ]);
    const indexes = new Map(packages.map((item, index) => [item.manifest.name, index]));
    for (const item of packages) {
      expect(item.manifest.license).toBe(expectedLicense(item.manifest.name));
      for (const name of Object.keys(item.manifest.dependencies ?? {})) {
        if (indexes.has(name))
          expect(indexes.get(name)).toBeLessThan(indexes.get(item.manifest.name)!);
      }
    }
  });

  it('keeps exact official license texts and package-local copies', async () => {
    const apache = await readFile(join(workspaceRoot, 'LICENSE-APACHE'));
    const agpl = await readFile(join(workspaceRoot, 'LICENSE-AGPL'));
    expect(createHash('sha256').update(apache).digest('hex')).toBe(
      'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    );
    expect(createHash('sha256').update(agpl).digest('hex')).toBe(
      '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0',
    );
    for (const item of await discoverPublicPackages()) {
      const expected = item.manifest.license === AGPL_LICENSE ? agpl : apache;
      expect(await readFile(join(item.directory, 'LICENSE'))).toEqual(expected);
      expect(item.manifest.files).toEqual(
        expect.arrayContaining(['dist', 'src', 'README.md', 'LICENSE']),
      );
      expect(item.manifest.publishConfig).toEqual({ access: 'public', provenance: true });
    }
  });

  it('ships rebuildable server source and migrations under AGPL-3.0-only', async () => {
    const server = (await discoverPublicPackages()).find(
      (item) => item.manifest.name === '@scenebook/server',
    )!;
    expect(server.manifest.license).toBe(AGPL_LICENSE);
    expect(server.manifest.files).toEqual(
      expect.arrayContaining(['src', 'migrations', 'tsconfig.json', 'tsconfig.build.json']),
    );
    expect(server.manifest.dependencies).toMatchObject({ yaml: '2.9.0' });
    expect(
      await readFile(join(server.directory, 'migrations', '0009_custom_domains.sql'), 'utf8'),
    ).toContain('CREATE TABLE IF NOT EXISTS custom_domains');
    const rootConfig = JSON.parse(await readFile(join(workspaceRoot, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: Record<string, unknown>;
    };
    const serverConfig = JSON.parse(
      await readFile(join(server.directory, 'tsconfig.json'), 'utf8'),
    ) as { compilerOptions: Record<string, unknown> };
    for (const [option, value] of Object.entries(rootConfig.compilerOptions)) {
      expect(serverConfig.compilerOptions[option], `server tsconfig ${option}`).toEqual(value);
    }
  });

  it('does not pull an auto-downloaded GPL FFmpeg binary into Apache packages', async () => {
    const packages = await discoverPublicPackages();
    for (const item of packages) {
      expect(item.manifest.dependencies ?? {}).not.toHaveProperty('ffmpeg-static');
    }
    expect(await readFile(join(workspaceRoot, 'bun.lock'), 'utf8')).not.toContain('ffmpeg-static');
  });

  it('fails closed when a future public package has no explicit license assignment', () => {
    expect(() => expectedLicense('@scenebook/unreviewed')).toThrow(
      'No release license mapping is configured',
    );
  });
});

describe('release metadata', () => {
  const item: Pick<ReleasePackage, 'relativeDirectory'> = {
    relativeDirectory: 'packages/schema',
  };

  it('derives package metadata only from explicit root values', () => {
    const root: PackageManifest = {
      name: 'fixture',
      version: '1.0.0',
      repository: { type: 'git', url: 'https://github.com/octocat/Hello-World.git' },
      homepage: 'https://github.com/octocat/Hello-World',
      bugs: { url: 'https://github.com/octocat/Hello-World/issues' },
    };
    const metadata = deriveReleaseMetadata(root, item);
    expect(metadata).toEqual({
      repository: {
        type: 'git',
        url: 'https://github.com/octocat/Hello-World.git',
        directory: 'packages/schema',
      },
      homepage: 'https://github.com/octocat/Hello-World',
      bugs: { url: 'https://github.com/octocat/Hello-World/issues' },
    });
    expect(metadataMatches({ ...root, ...metadata }, metadata)).toBe(true);
  });

  it('rejects absent, placeholder, credentialed, or non-HTTPS release metadata', () => {
    const base: PackageManifest = { name: 'fixture', version: '1.0.0' };
    expect(() => deriveReleaseMetadata(base, item)).toThrow('repository is missing');
    expect(() =>
      deriveReleaseMetadata(
        {
          ...base,
          repository: 'https://example.com/todo.git',
          homepage: 'https://github.com/octocat/Hello-World',
          bugs: 'https://github.com/octocat/Hello-World/issues',
        },
        item,
      ),
    ).toThrow('placeholder');
    expect(() =>
      deriveReleaseMetadata(
        {
          ...base,
          repository: 'http://github.com/octocat/Hello-World.git',
          homepage: 'https://github.com/octocat/Hello-World',
          bugs: 'https://github.com/octocat/Hello-World/issues',
        },
        item,
      ),
    ).toThrow('public HTTPS');
    expect(() =>
      deriveReleaseMetadata(
        {
          ...base,
          repository: 'https://user:secret@github.com/octocat/Hello-World.git',
          homepage: 'https://github.com/octocat/Hello-World',
          bugs: 'https://github.com/octocat/Hello-World/issues',
        },
        item,
      ),
    ).toThrow('credential-free');
  });
});

describe('publish guard', () => {
  const validEnvironment: NodeJS.ProcessEnv = {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: 'a'.repeat(40),
    SCENEBOOK_RELEASE_CONFIRM: 'PUBLISH',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions-oidc.test/request',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'ephemeral-token',
    NPM_CONFIG_PROVENANCE: 'true',
  };

  it('requires the protected manual GitHub OIDC publication context', () => {
    expect(() => assertPublishEnvironment(validEnvironment)).not.toThrow();
    for (const key of [
      'GITHUB_ACTIONS',
      'GITHUB_REF',
      'GITHUB_SHA',
      'SCENEBOOK_RELEASE_CONFIRM',
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'NPM_CONFIG_PROVENANCE',
    ]) {
      expect(() => assertPublishEnvironment({ ...validEnvironment, [key]: undefined })).toThrow();
    }
  });

  it('rejects long-lived npm credentials', () => {
    expect(() => assertPublishEnvironment({ ...validEnvironment, NPM_TOKEN: 'secret' })).toThrow(
      'Long-lived npm tokens are rejected',
    );
    expect(() =>
      assertPublishEnvironment({ ...validEnvironment, NODE_AUTH_TOKEN: 'secret' }),
    ).toThrow('Long-lived npm tokens are rejected');
  });
});

describe('package ordering', () => {
  it('fails closed on an internal dependency cycle', () => {
    const make = (name: string, dependency: string): ReleasePackage => ({
      directory: name,
      relativeDirectory: name,
      manifestPath: `${name}/package.json`,
      manifest: {
        name,
        version: '1.0.0',
        license: APACHE_LICENSE,
        dependencies: { [dependency]: 'workspace:*' },
      },
    });
    expect(() =>
      topologicalPackageOrder([
        make('@scenebook/a', '@scenebook/b'),
        make('@scenebook/b', '@scenebook/a'),
      ]),
    ).toThrow('dependency cycle');
  });

  it('never fabricates metadata when owner-controlled root values are absent', async () => {
    const root = await readManifest(join(workspaceRoot, 'package.json'));
    if (!root.repository) {
      expect(() => deriveReleaseMetadata(root, { relativeDirectory: 'packages/schema' })).toThrow(
        'repository is missing',
      );
    } else {
      expect(() =>
        deriveReleaseMetadata(root, { relativeDirectory: 'packages/schema' }),
      ).not.toThrow();
    }
  });
});
