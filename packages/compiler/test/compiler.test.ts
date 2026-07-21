import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, SceneSchema, parseSceneYaml, serializeSceneYaml } from '@scenebook/schema';
import { strFromU8, unzipSync } from 'fflate';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  compileScenes,
  loadSceneDirectory,
  normalizeScene,
  parseOutputFormats,
  themeDeclarations,
  validatePublicationDistribution,
  validateSceneGraph,
  type NormalizedScene,
  type PrivacyGate,
  type PublicationPlan,
} from '../src/index.js';
import { canonicalAssetIdentity } from '../src/compile.js';

const directories: string[] = [];
let previousFfmpegPath: string | undefined;
const passedPrivacy: PrivacyGate = async () => ({
  status: 'passed',
  scanner: 'test-ocr:1',
  findings: [],
});

beforeEach(async () => {
  previousFfmpegPath = process.env.SCENEBOOK_FFMPEG_PATH;
  if (previousFfmpegPath) return;
  const directory = await mkdtemp(join(tmpdir(), 'scenebook-test-ffmpeg-'));
  directories.push(directory);
  const executable = join(directory, 'ffmpeg.cjs');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
if (process.argv.includes('-version')) {
  process.stdout.write('ffmpeg version 7.1.1-test\\nconfiguration: --enable-libvpx --enable-libx264\\nlibavcodec 61.19.100\\n');
  process.exit(0);
}
const output = process.argv.at(-1);
if (!output) process.exit(2);
const bytes = output.endsWith('.gif')
  ? Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
  : output.endsWith('.webm')
    ? Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
    : Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
writeFileSync(output, bytes);
`,
    { mode: 0o755 },
  );
  await chmod(executable, 0o755);
  process.env.SCENEBOOK_FFMPEG_PATH = executable;
});

afterEach(async () => {
  if (previousFfmpegPath === undefined) delete process.env.SCENEBOOK_FFMPEG_PATH;
  else process.env.SCENEBOOK_FFMPEG_PATH = previousFfmpegPath;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  options: {
    readonly mask?: true | 'manual-blur' | 'locator-blur' | 'sensitive-blur';
    readonly id?: string;
    readonly slug?: string;
    readonly title?: string;
  } = {},
): Promise<{
  root: string;
  scene: string;
  output: string;
  rawHash: string;
  rawImage: Buffer;
}> {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-compiler-test-'));
  directories.push(root);
  const id = options.id ?? 'invite-member';
  const slug = options.slug ?? id;
  const scene = join(root, 'scenes', `${slug}.scene`);
  const output = join(root, 'dist');
  await mkdir(join(scene, 'assets'), { recursive: true });
  const image = await sharp({
    create: { width: 320, height: 180, channels: 4, background: '#eb4d2f' },
  })
    .png()
    .toBuffer();
  const hash = createHash('sha256').update(image).digest('hex');
  const assetPath = `assets/${hash}.png`;
  await writeFile(join(scene, assetPath), image);
  const asset = {
    sha256: hash,
    path: assetPath,
    mediaType: 'image/png',
    byteLength: image.byteLength,
    role: 'screenshot' as const,
    width: 320,
    height: 180,
  };
  const source = SceneSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id,
    slug,
    title: options.title ?? 'Invite a teammate',
    description: 'Add someone to the workspace.',
    tags: ['team-management'],
    steps: [
      {
        id: 'open-form',
        kind: 'browser',
        title: 'Open the invitation form',
        instruction: 'Choose Invite member.',
        altText: 'Workspace members page with Invite member highlighted',
        states: {
          before: {
            id: 'open-form-before',
            route: '/settings/members',
            screenshot: asset,
            viewport: { width: 320, height: 180 },
          },
        },
        target: {
          role: 'button',
          accessibleName: 'Invite member',
          normalizedRect: { x: 0.68, y: 0.15, width: 0.2, height: 0.12 },
        },
        presentation: { durationMs: 250, state: 'before' },
        ...(options.mask
          ? {
              masks: [
                {
                  id: 'sensitive-email',
                  mode: options.mask === true ? 'opaque' : 'blur',
                  source: options.mask === 'locator-blur' ? 'locator' : 'manual',
                  scope: 'publication',
                  rect: { x: 0, y: 0, width: 1, height: 1 },
                  classification:
                    options.mask === true || options.mask === 'sensitive-blur' ? 'email' : 'custom',
                },
              ],
            }
          : {}),
      },
    ],
    assets: [asset],
  });
  await writeFile(join(scene, 'scene.yaml'), serializeSceneYaml(source));
  return { root, scene, output, rawHash: hash, rawImage: image };
}

describe('compileScenes', () => {
  it('filters, groups, and orders a typed publication plan in catalog and evidence', async () => {
    const alpha = await fixture({ id: 'alpha', title: 'Alpha source title' });
    const beta = await fixture({ id: 'beta', title: 'Beta source title' });
    const unselected = await fixture({ id: 'unselected', title: 'Not in this Channel' });
    const plan: PublicationPlan = {
      format: 'scenebook-publication-plan',
      version: 1,
      selection: {
        mode: 'channel',
        projectId: 'product-stories',
        channelId: 'public-docs',
        collectionIds: ['start-here', 'advanced'],
      },
      title: 'Public documentation',
      description: 'Approved product guidance.',
      distribution: {
        seo: { index: false, follow: false },
        attribution: true,
        remix: true,
      },
      groups: [
        {
          id: 'start-here',
          slug: 'start-here',
          kind: 'collection',
          title: 'Start here',
          description: 'The first collection.',
          entries: [
            {
              sceneId: 'beta',
              title: 'Beta catalog override',
              description: 'Entry-specific catalog copy.',
            },
          ],
        },
        {
          id: 'advanced',
          slug: 'advanced',
          kind: 'collection',
          title: 'Advanced',
          description: 'The second collection.',
          entries: [{ sceneId: 'beta' }, { sceneId: 'alpha' }],
        },
      ],
      policy: {
        missingSceneEntry: 'error',
        duplicateScenePlacement: 'first-occurrence-wins',
        ungroupedScenes: 'exclude',
        channel: {
          requireCriticalPassing: true,
          requireVisualApproval: true,
          requireEditorialApproval: true,
          requireCompleteLocalization: false,
          publication: 'manual',
          nonCriticalFailure: 'block',
        },
      },
    };
    const result = await compileScenes({
      scenes: [alpha.scene, beta.scene, unselected.scene],
      outputDirectory: alpha.output,
      formats: ['catalog'],
      publicationPlan: plan,
      sourceDateEpoch: 0,
      privacyGate: passedPrivacy,
    });

    expect(result.manifest.scenes.map((scene) => scene.id)).toEqual(['beta', 'alpha']);
    expect(result.manifest.publication).toMatchObject({
      selection: {
        mode: 'channel',
        projectId: 'product-stories',
        channelId: 'public-docs',
        collectionIds: ['start-here', 'advanced'],
      },
      policy: {
        missingSceneEntry: 'error',
        duplicateScenePlacement: 'first-occurrence-wins',
        ungroupedScenes: 'exclude',
        channel: {
          requireCriticalPassing: true,
          requireVisualApproval: true,
          requireEditorialApproval: true,
          requireCompleteLocalization: false,
          publication: 'manual',
          nonCriticalFailure: 'block',
        },
      },
      groups: [
        { id: 'start-here', entries: [{ sceneId: 'beta' }] },
        { id: 'advanced', entries: [{ sceneId: 'alpha' }] },
      ],
    });
    expect(result.files).not.toContain('scenes/unselected/index.html');

    const catalog = await readFile(join(alpha.output, 'index.html'), 'utf8');
    expect(catalog).toContain('Public documentation');
    expect(catalog).toContain('Approved product guidance.');
    expect(catalog).toContain('The first collection.');
    expect(catalog).toContain('Beta catalog override');
    expect(catalog).toContain('Entry-specific catalog copy.');
    expect(catalog.indexOf('Start here')).toBeLessThan(catalog.indexOf('Advanced'));
    expect(catalog.indexOf('Beta catalog override')).toBeLessThan(
      catalog.indexOf('Alpha source title'),
    );
    expect(catalog).not.toContain('Not in this Channel');

    const evidence = JSON.parse(
      await readFile(join(alpha.output, 'scenes/beta/evidence.json'), 'utf8'),
    ) as { publication: PublicationPlan };
    expect(evidence.publication).toEqual(result.manifest.publication);
  });

  it('emits escaped SEO metadata, absolute share links, attribution, and an integrity-bound public remix', async () => {
    const source = await fixture({ mask: true, title: '<Launch & learn>' });
    const sourcePath = join(source.scene, 'scene.yaml');
    const document = parseYaml(await readFile(sourcePath, 'utf8')) as Record<string, unknown>;
    document.description = '"><\/script><script>alert("metadata")<\/script>';
    await writeFile(sourcePath, stringifyYaml(document));
    const plan: PublicationPlan = {
      format: 'scenebook-publication-plan',
      version: 1,
      selection: { mode: 'project', projectId: 'public-stories', collectionIds: [] },
      title: 'Product stories <public>',
      description: 'Learn the product without an account.',
      distribution: {
        baseUrl: 'https://stories.example.test/product/',
        customDomain: 'stories.example.test',
        seo: {
          index: true,
          follow: true,
          title: 'Acme product stories',
          description: 'Accessible product walkthroughs.',
        },
        attribution: true,
        remix: true,
      },
      groups: [],
      policy: {
        missingSceneEntry: 'error',
        duplicateScenePlacement: 'first-occurrence-wins',
        ungroupedScenes: 'include',
      },
    };
    const result = await compileScenes({
      scenes: [source.scene],
      outputDirectory: source.output,
      formats: ['catalog', 'iframe', 'readme-card', 'social-carousel'],
      publicationPlan: plan,
      sourceDateEpoch: 0,
      privacyGate: passedPrivacy,
    });

    const catalog = await readFile(join(source.output, 'index.html'), 'utf8');
    const page = await readFile(join(source.output, 'scenes/invite-member/index.html'), 'utf8');
    expect(catalog).toContain('<meta name="robots" content="index,follow">');
    expect(catalog).toContain(
      '<link rel="canonical" href="https://stories.example.test/product/">',
    );
    expect(catalog).toContain('Acme product stories');
    expect(catalog).toContain('Made with Scenebook');
    expect(catalog).toContain('Download editable Scene');
    expect(page).toContain(
      'href="https://stories.example.test/product/remix/invite-member.scene.zip"',
    );
    expect(page).toContain('twitter:card');
    expect(page).toContain('application/ld+json');
    expect(page).not.toContain('</script><script>alert("metadata")</script>');
    expect(page).toContain('&lt;Launch &amp; learn&gt;');

    const share = result.manifest.scenes[0]?.share;
    expect(share).toEqual(
      expect.objectContaining({
        page: 'https://stories.example.test/product/scenes/invite-member/index.html',
        standalone: 'https://stories.example.test/product/standalone/invite-member.html',
        embed: 'https://stories.example.test/product/embeds/invite-member.iframe.html',
        readme: 'https://stories.example.test/product/scenes/invite-member/README.md',
        ogImage: 'https://stories.example.test/product/social/invite-member-og.png',
        remixArchive: 'https://stories.example.test/product/remix/invite-member.scene.zip',
      }),
    );
    expect(share?.socialImages).toEqual([
      'https://stories.example.test/product/social/invite-member-square.png',
      'https://stories.example.test/product/social/invite-member-landscape.png',
    ]);

    const archive = unzipSync(await readFile(join(source.output, 'remix/invite-member.scene.zip')));
    const integrity = JSON.parse(strFromU8(archive['INTEGRITY.json']!)) as {
      entries: Array<{ path: string; sha256: string; bytes: number }>;
    };
    for (const entry of integrity.entries) {
      const bytes = archive[entry.path];
      expect(bytes, entry.path).toBeDefined();
      expect(bytes?.byteLength).toBe(entry.bytes);
      expect(createHash('sha256').update(bytes!).digest('hex')).toBe(entry.sha256);
    }
    const remix = parseSceneYaml(strFromU8(archive['scene.yaml']!));
    expect(remix.capability).toBe('captured');
    expect(remix.automation.level).toBe('none');
    expect(remix.steps.every((step) => step.actions.length === 0 && step.checks.length === 0)).toBe(
      true,
    );
    expect(
      remix.steps
        .flatMap((step) => Object.values(step.states))
        .every((state) => state?.route === '/'),
    ).toBe(true);
    expect(strFromU8(archive['scene.yaml']!)).not.toContain(source.rawHash);
    for (const asset of remix.assets) {
      expect(createHash('sha256').update(archive[asset.path]!).digest('hex')).toBe(asset.sha256);
    }
  });

  it('defaults static pages to noindex and zero analytics configuration', async () => {
    const { scene, output } = await fixture();
    await compileScenes({
      scenes: [scene],
      outputDirectory: output,
      formats: ['standalone-html'],
      privacyGate: passedPrivacy,
    });
    const html = await readFile(join(output, 'standalone/invite-member.html'), 'utf8');
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(html).toContain('"analytics": null');
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('/v1/public/workspaces/');
  });

  it('rejects insecure public analytics and CTA services outside loopback development', () => {
    const endpoint =
      'http://api.example.test/v1/public/workspaces/acme/projects/product/channels/public/analytics';
    const distribution = {
      seo: { index: false, follow: false },
      attribution: true,
      remix: true,
      analytics: { endpoint, releaseId: 'release-1', respectDoNotTrack: true },
    } as const;
    expect(() =>
      validatePublicationDistribution(
        distribution,
        {
          analytics: {
            endpoint,
            token: 'public-channel-token',
            releaseId: 'release-1',
            respectDoNotTrack: true,
          },
        },
        true,
      ),
    ).toThrow(/must use HTTPS/u);

    const ctaEndpoint =
      'http://api.example.test/v1/public/workspaces/acme/projects/product/channels/public/cta';
    expect(() =>
      validatePublicationDistribution(
        {
          seo: { index: false, follow: false },
          attribution: true,
          remix: true,
          cta: { endpoint: ctaEndpoint, releaseId: 'release-1' },
        },
        {
          cta: {
            endpoint: ctaEndpoint,
            token: 'public-channel-cta-token',
            releaseId: 'release-1',
          },
        },
        true,
      ),
    ).toThrow(/must use HTTPS/u);
  });

  it('writes byte-identical remix archives in different process timezones', () => {
    const moduleUrl = new URL('../src/remix-archive.ts', import.meta.url).href;
    const source = `
      import { deterministicRemixArchive } from ${JSON.stringify(moduleUrl)};
      const files = new Map([
        ['README.md', new TextEncoder().encode('# Public remix\\n')],
        ['scene.yaml', new TextEncoder().encode('schemaVersion: 1\\nid: public-remix\\n')],
      ]);
      process.stdout.write(Buffer.from(deterministicRemixArchive(files)).toString('base64'));
    `;
    const archive = (timezone: string) =>
      execFileSync(process.execPath, ['--eval', source], {
        encoding: 'utf8',
        env: { ...process.env, TZ: timezone },
      });

    expect(archive('UTC')).toBe(archive('America/Los_Angeles'));
  });

  it('keeps one canonical path and media type for each compiled asset digest', () => {
    const existing = {
      hash: 'a'.repeat(64),
      path: `assets/${'a'.repeat(64)}.png`,
      mediaType: 'image/png',
      bytes: 42,
      privacyBasis: 'structured',
    } as const;
    expect(
      canonicalAssetIdentity(existing, {
        ...existing,
        path: `assets/${'a'.repeat(64)}.bin`,
        privacyBasis: 'ocr',
      }),
    ).toEqual({ ...existing, privacyBasis: 'ocr' });
    expect(() =>
      canonicalAssetIdentity(existing, {
        ...existing,
        path: `assets/${'a'.repeat(64)}.webp`,
        mediaType: 'image/webp',
      }),
    ).toThrow(/conflicting media types image\/png and image\/webp/u);
  });

  it('fails closed for missing collection Scenes and empty Channel selections', async () => {
    const { scene, output } = await fixture();
    const base: PublicationPlan = {
      format: 'scenebook-publication-plan',
      version: 1,
      selection: {
        mode: 'channel',
        projectId: 'product-stories',
        channelId: 'public-docs',
        collectionIds: ['start-here'],
      },
      title: 'Public documentation',
      distribution: {
        seo: { index: false, follow: false },
        attribution: true,
        remix: true,
      },
      groups: [
        {
          id: 'start-here',
          slug: 'start-here',
          kind: 'collection',
          title: 'Start here',
          entries: [{ sceneId: 'missing-scene' }],
        },
      ],
      policy: {
        missingSceneEntry: 'error',
        duplicateScenePlacement: 'first-occurrence-wins',
        ungroupedScenes: 'exclude',
        channel: {
          requireCriticalPassing: true,
          requireVisualApproval: true,
          requireEditorialApproval: true,
          requireCompleteLocalization: false,
          publication: 'manual',
          nonCriticalFailure: 'block',
        },
      },
    };
    await expect(
      compileScenes({ scenes: [scene], outputDirectory: output, publicationPlan: base }),
    ).rejects.toThrow('references missing Scene missing-scene');
    await expect(
      compileScenes({
        scenes: [scene],
        outputDirectory: output,
        publicationPlan: {
          ...base,
          selection: { ...base.selection, collectionIds: [] },
          groups: [],
        },
      }),
    ).rejects.toThrow('Channel public-docs has no publishable Scenes');
  });

  it('atomically emits portable static, guide, launch, and evidence outputs', async () => {
    const { scene, output } = await fixture();
    const formats = [
      'catalog',
      'standalone-html',
      'web-component',
      'iframe',
      'markdown',
      'mdx',
      'html-guide',
      'readme-card',
      'og-image',
      'social-carousel',
      'pdf',
    ] as const;
    const result = await compileScenes({
      scenes: [scene],
      outputDirectory: output,
      formats,
      sourceDateEpoch: 0,
      privacyGate: passedPrivacy,
    });

    expect(result.manifest.privacy).toEqual({ status: 'passed', scanner: 'test-ocr:1' });
    expect(result.files).toEqual(
      expect.arrayContaining([
        'index.html',
        'manifest.json',
        'formats.json',
        'standalone/invite-member.html',
        'components/invite-member.js',
        'embeds/invite-member.iframe.html',
        'scenes/invite-member/guide.md',
        'scenes/invite-member/guide.mdx',
        'scenes/invite-member/guide.html',
        'scenes/invite-member/evidence.json',
        'scenes/invite-member/README.md',
        'social/invite-member-og.png',
        'social/invite-member-square.png',
        'exports/invite-member.pdf',
      ]),
    );
    expect(await readFile(join(output, 'standalone/invite-member.html'), 'utf8')).toContain(
      'application/json',
    );
    expect(
      (await readFile(join(output, 'exports/invite-member.pdf'))).subarray(0, 4).toString(),
    ).toBe('%PDF');

    const firstManifest = await readFile(join(output, 'manifest.json'), 'utf8');
    await writeFile(join(output, 'stale.txt'), 'must disappear');
    await compileScenes({
      scenes: [scene],
      outputDirectory: output,
      formats,
      sourceDateEpoch: 0,
      privacyGate: passedPrivacy,
    });
    expect(await readFile(join(output, 'manifest.json'), 'utf8')).toBe(firstManifest);
    await expect(readFile(join(output, 'stale.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed for unknown screenshot privacy and records an explicit local override', async () => {
    const { scene, output } = await fixture();
    await expect(
      compileScenes({ scenes: [scene], outputDirectory: output, formats: ['markdown'] }),
    ).rejects.toThrow('Privacy status is unknown');

    const result = await compileScenes({
      scenes: [scene],
      outputDirectory: output,
      formats: ['markdown'],
      allowUnscannedPrivacy: true,
    });
    expect(result.manifest.privacy.status).toBe('overridden');
    const evidence = JSON.parse(
      await readFile(join(output, 'scenes/invite-member/evidence.json'), 'utf8'),
    ) as { privacy: { overridden: boolean } };
    expect(evidence.privacy.overridden).toBe(true);
  });

  it('renders motion with an explicitly configured deterministic ffmpeg adapter', async () => {
    const { scene, output } = await fixture();
    const stillOnly = await compileScenes({
      scenes: [scene],
      outputDirectory: output,
      formats: ['markdown'],
      privacyGate: passedPrivacy,
      sourceDateEpoch: 0,
    });
    const result = await compileScenes({
      scenes: [scene],
      outputDirectory: output,
      formats: ['gif'],
      privacyGate: passedPrivacy,
      sourceDateEpoch: 0,
    });
    expect(result.files).toContain('exports/invite-member.gif');
    expect(result.manifest.toolchains).toEqual([
      expect.objectContaining({
        name: 'ffmpeg',
        binding: 'binary-and-version-output-sha256',
        version: '7.1.1-test',
        binarySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        versionOutputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
    const formats = JSON.parse(await readFile(join(output, 'formats.json'), 'utf8')) as {
      policy: { gif: { reproducibility: string } };
      toolchains: unknown[];
    };
    expect(formats.policy.gif.reproducibility).toBe('toolchain-bound');
    expect(formats.toolchains).toEqual(result.manifest.toolchains);
    expect(JSON.stringify(result.manifest)).not.toContain(process.env.SCENEBOOK_FFMPEG_PATH);
    expect(
      (await readFile(join(output, 'exports/invite-member.gif'))).subarray(0, 6).toString(),
    ).toMatch(/^GIF8[79]a$/u);
    expect(result.manifest.assets.map((asset) => asset.hash)).toEqual(
      stillOnly.manifest.assets.map((asset) => asset.hash),
    );
    const first = await readFile(join(output, 'exports/invite-member.gif'));
    await compileScenes({
      scenes: [scene],
      outputDirectory: output,
      formats: ['gif'],
      privacyGate: passedPrivacy,
      sourceDateEpoch: 0,
    });
    expect(await readFile(join(output, 'exports/invite-member.gif'))).toEqual(first);
  }, 30_000);

  it('publishes only opaque-masked derivatives and binds privacy to their hashes', async () => {
    const { scene, output, rawHash, rawImage } = await fixture({ mask: true });
    let assessedHashes: readonly string[] = [];
    const result = await compileScenes({
      scenes: [scene],
      outputDirectory: output,
      formats: ['standalone-html', 'markdown'],
      privacyGate: async (_loaded, publishedAssets, publication) => {
        assessedHashes = publishedAssets.map((asset) => asset.hash);
        return passedPrivacy(_loaded, publishedAssets, publication);
      },
    });
    expect(assessedHashes.length).toBeGreaterThan(0);
    expect(assessedHashes).not.toContain(rawHash);
    expect(result.manifest.assets.map((asset) => asset.hash)).not.toContain(rawHash);
    const manifest = await readFile(join(output, 'manifest.json'), 'utf8');
    const evidence = await readFile(join(output, 'scenes/invite-member/evidence.json'), 'utf8');
    expect(manifest).not.toContain(rawHash);
    expect(evidence).not.toContain(rawHash);
    for (const path of result.files) {
      const bytes = await readFile(join(output, path));
      expect(bytes.equals(rawImage), `raw bytes leaked as ${path}`).toBe(false);
    }
    const derivative = result.manifest.assets[0];
    expect(derivative).toBeDefined();
    const pixel = await sharp(join(output, derivative!.path)).raw().toBuffer();
    expect([...pixel].some((channel) => channel === 23)).toBe(true);
  });

  it('limits reversible blur to manual custom presentation regions', async () => {
    const allowed = await fixture({ mask: 'manual-blur' });
    await expect(
      compileScenes({
        scenes: [allowed.scene],
        outputDirectory: allowed.output,
        formats: ['standalone-html'],
        privacyGate: passedPrivacy,
      }),
    ).resolves.toBeDefined();

    for (const mask of ['locator-blur', 'sensitive-blur'] as const) {
      await expect(fixture({ mask })).rejects.toThrow(
        /Blur is limited to manual custom presentation regions/u,
      );
    }

    // Defend callers that construct a LoadedScene without entering through schema parsing.
    const blocked = await fixture({ mask: 'manual-blur' });
    const loaded = await loadSceneDirectory(blocked.scene);
    const candidate = loaded.scene.steps[0]?.masks[0];
    if (!candidate) throw new Error('Expected blur fixture mask.');
    candidate.source = 'locator';
    await expect(
      compileScenes({
        scenes: [loaded],
        outputDirectory: blocked.output,
        formats: ['standalone-html'],
        privacyGate: passedPrivacy,
      }),
    ).rejects.toThrow(/Blur is limited to manual custom presentation regions/u);
  });

  it('renders native-SVG launch copy into pixels for landscape and square art', async () => {
    const { scene, output } = await fixture();
    await compileScenes({
      scenes: [scene],
      outputDirectory: output,
      formats: ['og-image', 'social-carousel'],
      privacyGate: passedPrivacy,
    });
    for (const [path, extract] of [
      ['social/invite-member-og.png', { left: 60, top: 175, width: 420, height: 310 }],
      ['social/invite-member-square.png', { left: 70, top: 180, width: 940, height: 310 }],
    ] as const) {
      const { data, info } = await sharp(join(output, path)).extract(extract).raw().toBuffer({
        resolveWithObject: true,
      });
      let darkPixels = 0;
      for (let index = 0; index < data.length; index += info.channels) {
        if ((data[index] ?? 255) < 100 && (data[index + 1] ?? 255) < 100) darkPixels += 1;
      }
      expect(darkPixels, `${path} should contain rendered title glyphs`).toBeGreaterThan(300);
    }
  });

  it('assesses every content-addressed pixel derivative before all fourteen adapters finalize', async () => {
    const { scene, output } = await fixture();
    let assessed = new Set<string>();
    const formats = [
      'catalog',
      'standalone-html',
      'web-component',
      'iframe',
      'markdown',
      'mdx',
      'html-guide',
      'pdf',
      'mp4',
      'webm',
      'gif',
      'readme-card',
      'og-image',
      'social-carousel',
    ] as const;
    const result = await compileScenes({
      scenes: [scene],
      outputDirectory: output,
      formats,
      sourceDateEpoch: 0,
      privacyGate: async (loaded, publishedAssets, publication) => {
        assessed = new Set(publishedAssets.map((asset) => asset.hash));
        return passedPrivacy(loaded, publishedAssets, publication);
      },
    });
    expect([...assessed].sort()).toEqual(result.manifest.assets.map((asset) => asset.hash).sort());
    for (const socialPath of [
      'social/invite-member-og.png',
      'social/invite-member-square.png',
      'social/invite-member-landscape.png',
    ]) {
      const hash = createHash('sha256')
        .update(await readFile(join(output, socialPath)))
        .digest('hex');
      expect(assessed.has(hash), `${socialPath} must be assessed exactly`).toBe(true);
    }
  }, 30_000);

  it('applies requested locale fallback and authored theme tokens to public output', async () => {
    const { scene, output } = await fixture();
    const manifestPath = join(scene, 'scene.yaml');
    const document = parseYaml(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    document.defaultLocale = 'pt-PT';
    document.locales = [
      { locale: 'pt-PT', file: 'locales/pt-PT.yaml', label: 'Português', complete: true },
    ];
    document.theme = { file: 'theme.yaml', variables: {} };
    await mkdir(join(scene, 'locales'), { recursive: true });
    await writeFile(
      join(scene, 'locales/pt-PT.yaml'),
      stringifyYaml({
        scene: { title: 'Convidar colega', description: 'Adicionar alguém ao espaço.' },
        steps: {
          'open-form': {
            title: 'Abrir formulário',
            instruction: 'Escolha Convidar membro.',
          },
        },
      }),
    );
    await writeFile(
      join(scene, 'theme.yaml'),
      stringifyYaml({
        background: '#f0eee8',
        foreground: '#101010',
        accent: '#a52a2a',
        fontFamily: 'Inter, sans-serif',
        radius: 20,
      }),
    );
    await writeFile(manifestPath, stringifyYaml(document));
    const result = await compileScenes({
      scenes: [scene],
      outputDirectory: output,
      formats: ['standalone-html'],
      locale: 'pt-PT',
      privacyGate: passedPrivacy,
    });
    const html = await readFile(join(output, 'standalone/invite-member.html'), 'utf8');
    expect(result.manifest.scenes[0]?.locale).toBe('pt-PT');
    expect(html).toContain('lang="pt-PT"');
    expect(html).toContain('Convidar colega');
    expect(html).toContain('--paper:#f0eee8');
    expect(html).toContain('--radius:20px');
  });

  it('blocks secrets in localized, narrative, and catalog publication copy', async () => {
    const localized = await fixture();
    const localizedManifest = join(localized.scene, 'scene.yaml');
    const localizedDocument = parseYaml(await readFile(localizedManifest, 'utf8')) as Record<
      string,
      unknown
    >;
    localizedDocument.defaultLocale = 'pt-PT';
    localizedDocument.locales = [
      { locale: 'pt-PT', file: 'locales/pt-PT.yaml', label: 'Português', complete: true },
    ];
    await mkdir(join(localized.scene, 'locales'), { recursive: true });
    await writeFile(
      join(localized.scene, 'locales/pt-PT.yaml'),
      stringifyYaml({
        steps: {
          'open-form': { title: 'Token ghp_abcdefghijklmnopqrstuvwxyz123456' },
        },
      }),
    );
    await writeFile(localizedManifest, stringifyYaml(localizedDocument));
    await expect(
      compileScenes({
        scenes: [localized.scene],
        outputDirectory: localized.output,
        formats: ['og-image'],
        locale: 'pt-PT',
        allowUnscannedPrivacy: true,
      }),
    ).rejects.toThrow('Provider access token detected');

    const inlineLocale = await fixture();
    const inlineLocaleManifest = join(inlineLocale.scene, 'scene.yaml');
    const inlineLocaleDocument = parseYaml(await readFile(inlineLocaleManifest, 'utf8')) as Record<
      string,
      unknown
    >;
    inlineLocaleDocument.translations = {
      fr: {
        title: 'Internal token ghp_abcdefghijklmnopqrstuvwxyz123456',
        steps: {},
      },
    };
    await writeFile(inlineLocaleManifest, stringifyYaml(inlineLocaleDocument));
    await expect(
      compileScenes({
        scenes: [inlineLocale.scene],
        outputDirectory: inlineLocale.output,
        formats: ['markdown'],
        // French is not selected for rendering; portable inline copy still enters remix/source
        // surfaces and must remain in the structured privacy projection.
        locale: 'en',
        allowUnscannedPrivacy: true,
      }),
    ).rejects.toThrow('Provider access token detected');

    const narrative = await fixture();
    const narrativeManifest = join(narrative.scene, 'scene.yaml');
    const narrativeDocument = parseYaml(await readFile(narrativeManifest, 'utf8')) as Record<
      string,
      unknown
    >;
    narrativeDocument.narrativeFile = 'narrative.mdx';
    await writeFile(
      join(narrative.scene, 'narrative.mdx'),
      'Internal credential: sk-abcdefghijklmnopqrstuvwxyz123456',
    );
    await writeFile(narrativeManifest, stringifyYaml(narrativeDocument));
    await expect(
      compileScenes({
        scenes: [narrative.scene],
        outputDirectory: narrative.output,
        formats: ['markdown'],
        allowUnscannedPrivacy: true,
      }),
    ).rejects.toThrow('Provider access token detected');

    const catalog = await fixture();
    await expect(
      compileScenes({
        scenes: [catalog.scene],
        outputDirectory: catalog.output,
        formats: ['catalog'],
        allowUnscannedPrivacy: true,
        publicationPlan: {
          format: 'scenebook-publication-plan',
          version: 1,
          selection: {
            mode: 'project',
            projectId: 'catalog-copy',
            collectionIds: [],
          },
          title: 'Catalog',
          description: 'Internal credential: sk-abcdefghijklmnopqrstuvwxyz123456',
          distribution: {
            seo: { index: false, follow: false },
            attribution: true,
            remix: true,
          },
          groups: [],
          policy: {
            missingSceneEntry: 'error',
            duplicateScenePlacement: 'first-occurrence-wins',
            ungroupedScenes: 'include',
          },
        },
      }),
    ).rejects.toThrow('Provider access token detected');
  });
});

describe('parseOutputFormats', () => {
  it('normalizes legacy CLI aliases to the public schema names', () => {
    expect(parseOutputFormats(['interactive-html,guide-html,og'])).toEqual([
      'standalone-html',
      'html-guide',
      'og-image',
    ]);
    expect(() => parseOutputFormats(['not-real'])).toThrow('Unknown output format');
  });
});

describe('portable asset integrity', () => {
  it('rejects a scene.yaml symlink even when its target exists', async () => {
    const { root, scene } = await fixture();
    const manifestPath = join(scene, 'scene.yaml');
    const outside = join(root, 'outside-scene.yaml');
    await writeFile(outside, await readFile(manifestPath));
    await rm(manifestPath);
    await symlink(outside, manifestPath);
    await expect(loadSceneDirectory(scene)).rejects.toThrow(
      'scene.yaml must be a regular file and not a symbolic link',
    );
  });

  it('rejects oversized manifests and sidecars before unbounded allocation', async () => {
    const first = await fixture();
    await truncate(join(first.scene, 'scene.yaml'), 2 * 1024 * 1024);
    await expect(loadSceneDirectory(first.scene)).rejects.toThrow(
      'Scene manifest scene.yaml exceeds the 1048576-byte encoded input limit',
    );

    const second = await fixture();
    await writeFile(join(second.scene, 'narrative.mdx'), '');
    await truncate(join(second.scene, 'narrative.mdx'), 5 * 1024 * 1024);
    await expect(loadSceneDirectory(second.scene)).rejects.toThrow(
      'Scene narrative sidecar narrative.mdx exceeds the 4194304-byte encoded input limit',
    );
  });

  it('requires every explicitly declared narrative, theme, and locale sidecar', async () => {
    const narrativeFixture = await fixture();
    const narrativeDocument = parseYaml(
      await readFile(join(narrativeFixture.scene, 'scene.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    narrativeDocument.narrativeFile = 'copy/narrative.mdx';
    await writeFile(join(narrativeFixture.scene, 'scene.yaml'), stringifyYaml(narrativeDocument));
    await expect(loadSceneDirectory(narrativeFixture.scene)).rejects.toThrow(
      'Scene narrative sidecar is missing: copy/narrative.mdx',
    );

    const themeFixture = await fixture();
    const themeDocument = parseYaml(
      await readFile(join(themeFixture.scene, 'scene.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    themeDocument.theme = { file: 'themes/brand.yaml', variables: {} };
    await writeFile(join(themeFixture.scene, 'scene.yaml'), stringifyYaml(themeDocument));
    await expect(loadSceneDirectory(themeFixture.scene)).rejects.toThrow(
      'Scene theme sidecar is missing: themes/brand.yaml',
    );

    const localeFixture = await fixture();
    const localeDocument = parseYaml(
      await readFile(join(localeFixture.scene, 'scene.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    localeDocument.locales = [
      { locale: 'en', file: 'locales/en.yaml', label: 'English', complete: false },
    ];
    await writeFile(join(localeFixture.scene, 'scene.yaml'), stringifyYaml(localeDocument));
    await expect(loadSceneDirectory(localeFixture.scene)).rejects.toThrow(
      'Scene locale sidecar en is missing: locales/en.yaml',
    );
  });

  it('requires automation replays to be contained regular bounded files', async () => {
    const linked = await fixture();
    const outsideReplay = join(linked.root, 'outside-replay.ts');
    await writeFile(outsideReplay, 'export {};');
    await mkdir(join(linked.scene, 'automation'), { recursive: true });
    await symlink(outsideReplay, join(linked.scene, 'automation/replay.ts'));
    const linkedDocument = parseYaml(
      await readFile(join(linked.scene, 'scene.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    linkedDocument.automation = {
      level: 'none',
      framework: 'playwright',
      replayPath: 'automation/replay.ts',
    };
    await writeFile(join(linked.scene, 'scene.yaml'), stringifyYaml(linkedDocument));
    await expect(loadSceneDirectory(linked.scene)).rejects.toThrow(
      'Scene automation replay must not be a symbolic link',
    );

    const oversized = await fixture();
    await mkdir(join(oversized.scene, 'automation'), { recursive: true });
    await writeFile(join(oversized.scene, 'automation/replay.ts'), '');
    await truncate(join(oversized.scene, 'automation/replay.ts'), 9 * 1024 * 1024);
    const oversizedDocument = parseYaml(
      await readFile(join(oversized.scene, 'scene.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    oversizedDocument.automation = {
      level: 'none',
      framework: 'playwright',
      replayPath: 'automation/replay.ts',
    };
    await writeFile(join(oversized.scene, 'scene.yaml'), stringifyYaml(oversizedDocument));
    await expect(loadSceneDirectory(oversized.scene)).rejects.toThrow(
      'exceeds the 8388608-byte encoded input limit',
    );
  });

  it('rejects oversized encoded raster assets before decoding or hashing them', async () => {
    const { scene, rawHash } = await fixture();
    await truncate(join(scene, 'assets', `${rawHash}.png`), 65 * 1024 * 1024);
    await expect(loadSceneDirectory(scene)).rejects.toThrow(
      'exceeds the 67108864-byte encoded input limit',
    );
  });

  it('fails production loading when content-addressed raster bytes are tampered', async () => {
    const { scene, rawHash } = await fixture();
    const tampered = await sharp({
      create: { width: 320, height: 180, channels: 4, background: '#123456' },
    })
      .png()
      .toBuffer();
    await writeFile(join(scene, 'assets', `${rawHash}.png`), tampered);
    await expect(loadSceneDirectory(scene)).rejects.toThrow('Asset integrity mismatch');
  });

  it('rejects declared MIME spoofing even when the hash and filename still match', async () => {
    const { scene } = await fixture();
    const manifestPath = join(scene, 'scene.yaml');
    const document = parseYaml(await readFile(manifestPath, 'utf8')) as {
      assets: Array<{ mediaType: string }>;
      steps: Array<{ states: { before?: { screenshot?: { mediaType: string } } } }>;
    };
    document.assets[0]!.mediaType = 'image/jpeg';
    document.steps[0]!.states.before!.screenshot!.mediaType = 'image/jpeg';
    await writeFile(manifestPath, stringifyYaml(document));
    await expect(loadSceneDirectory(scene)).rejects.toThrow('does not match magic bytes image/png');
  });

  it('rejects SVG screenshot sources before parsing external vector resources', async () => {
    const { scene } = await fixture();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><image href="https://attacker.test/pixel.png"/></svg>',
    );
    const hash = createHash('sha256').update(svg).digest('hex');
    const relativePath = `assets/${hash}.svg`;
    await writeFile(join(scene, relativePath), svg);
    const manifestPath = join(scene, 'scene.yaml');
    const document = parseYaml(await readFile(manifestPath, 'utf8')) as {
      assets: Array<Record<string, unknown>>;
      steps: Array<{
        states: { before?: { screenshot?: Record<string, unknown> } };
      }>;
    };
    const replacement = {
      sha256: hash,
      path: relativePath,
      mediaType: 'image/svg+xml',
      byteLength: svg.byteLength,
      role: 'screenshot',
      width: 320,
      height: 180,
    };
    document.assets[0] = replacement;
    document.steps[0]!.states.before!.screenshot = replacement;
    await writeFile(manifestPath, stringifyYaml(document));
    await expect(loadSceneDirectory(scene)).rejects.toThrow('SVG/vector content');
  });
});

describe('themeDeclarations', () => {
  it('keeps plain theme tokens and rejects escaped or functional CSS injection', () => {
    const scene = {
      theme: {
        paper: '#fffdf8',
        accent: 'hsl(12 75% 52%)',
        font: 'Inter, ui-sans-serif, sans-serif',
        escaped: 'red\\3b background:url(https://attacker.test)',
        import: '@import "https://attacker.test"',
        expression: 'expression(alert(1))',
        calculated: 'calc(1px + 2px)',
      },
    } as unknown as NormalizedScene;
    const output = themeDeclarations(scene);
    expect(output).toContain('--paper:#fffdf8');
    expect(output).toContain('--accent:hsl(12 75% 52%)');
    expect(output).toContain('--font:Inter, ui-sans-serif, sans-serif');
    expect(output).not.toMatch(/attacker|expression|calc|escaped|import/u);
  });
});

describe('branch graph validation', () => {
  function branchScene(id: string, target: string): NormalizedScene {
    return normalizeScene(
      SceneSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        id,
        slug: id,
        title: id,
        steps: [
          {
            id: 'choose',
            kind: 'choice',
            title: 'Choose a route',
            choices: [{ id: 'continue', label: 'Continue', targetSceneId: target }],
          },
        ],
      }),
    );
  }

  it('rejects missing branch targets and cross-Scene loops', () => {
    expect(() => validateSceneGraph([branchScene('alpha', 'missing')])).toThrow(
      'unknown Scene missing',
    );
    expect(() =>
      validateSceneGraph([branchScene('alpha', 'beta'), branchScene('beta', 'alpha')]),
    ).toThrow('contains a loop');
  });
});
