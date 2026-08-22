import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compileScenes, type PrivacyGate } from '@scenebook/compiler';
import { parseProjectYaml, parseSceneYaml, serializeSceneYaml } from '@scenebook/schema';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import { demoScene } from '../src/lib/demo';
import { cloneScene } from '../src/lib/model';
import {
  defaultProject,
  exportProjectYaml,
  exportProjectZip,
  exportSceneYaml,
  exportSceneZip,
  importPortableBytes,
  PortableFileError,
  readScreenshotFile,
} from '../src/lib/portable';
import { releaseLocalMediaUrls } from '../src/lib/scene-library';

const PASSIVE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const passedPrivacy: PrivacyGate = async () => ({
  status: 'passed',
  scanner: 'studio-portable-integration:1',
  findings: [],
});

function rasterScene() {
  const scene = cloneScene(demoScene);
  for (const step of scene.steps) if (step.image) step.image = PASSIVE_PNG;
  return scene;
}

async function referencedSidecarArchive() {
  const initial = await exportSceneZip(rasterScene());
  const files = unzipSync(initial.bytes);
  const canonical = parseSceneYaml(strFromU8(files['scene.yaml']!));
  canonical.capability = 'verified';
  canonical.defaultLocale = 'pt-PT';
  canonical.narrativeFile = 'narrative.mdx';
  canonical.theme = { file: 'theme.yaml', variables: {} };
  canonical.locales = [
    { locale: 'pt-PT', file: 'locales/pt-PT.yaml', label: 'Português', complete: true },
  ];
  canonical.automation = {
    level: 'verified',
    framework: 'playwright',
    replayPath: 'automation/replay.ts',
  };
  files['scene.yaml'] = strToU8(serializeSceneYaml(canonical));
  const sidecars = {
    'narrative.mdx': Uint8Array.from([0xef, 0xbb, 0xbf, ...strToU8('# Exact narrative\r\n')]),
    'theme.yaml': strToU8('accent: "#c2412d"\r\nradius: 17\r\n'),
    'locales/pt-PT.yaml': strToU8('title: "Convite"\nsteps: {}\n'),
    'automation/replay.ts': strToU8(
      "import { test } from '@playwright/test';\r\n\r\ntest('recorded draft', async ({ page }) => {\r\n  await page.goto('https://example.test/');\r\n});\r\n",
    ),
  };
  Object.assign(files, sidecars);
  return { files, sidecars };
}

describe('portable Studio files', () => {
  it('exports validated Blob-backed screenshots without base64-hydrating editor state', async () => {
    const payload = PASSIVE_PNG.slice(PASSIVE_PNG.indexOf(',') + 1);
    const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
    const scene = rasterScene();
    scene.steps[0]!.image = await readScreenshotFile(
      new File([bytes], 'local.png', { type: 'image/png' }),
    );

    const output = await exportSceneZip(scene);
    expect(Object.keys(unzipSync(output.bytes)).some((path) => path.startsWith('assets/'))).toBe(
      true,
    );
    expect(scene.steps[0]!.image).toMatch(/^blob:/u);
    releaseLocalMediaUrls(scene);
  });

  it('round-trips a complete Scene ZIP with assets, masks, choices, and CTAs', async () => {
    const exported = await exportSceneZip(rasterScene());
    const files = unzipSync(exported.bytes);
    expect(Object.keys(files)).toContain('scene.yaml');
    expect(Object.keys(files).some((path) => path.startsWith('assets/'))).toBe(true);

    const canonical = parseSceneYaml(strFromU8(files['scene.yaml']!));
    expect(canonical.id).toBe(demoScene.id);
    expect(canonical.assets.length).toBeGreaterThan(0);
    expect(canonical.capability).toBe('captured');

    const imported = await importPortableBytes(exported.bytes, exported.filename);
    expect(imported.kind).toBe('scene');
    expect(imported.scenes[0]!.steps).toHaveLength(demoScene.steps.length);
    expect(imported.scenes[0]!.steps[1]!.masks[0]!.label).toBe('Email address redacted');
    expect(imported.scenes[0]!.steps[2]!.choices[0]!.sceneId).toBe('invite-member-access');
    expect(imported.scenes[0]!.steps.at(-1)!.image).toMatch(/^data:image\/png;base64,/u);
    expect(imported.scenes[0]!.steps.at(-1)!.ctas).toHaveLength(2);
  });

  it('bundles validated same-origin screenshots used by the included example', async () => {
    const payload = PASSIVE_PNG.slice(PASSIVE_PNG.indexOf(',') + 1);
    const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }),
      );
    try {
      const exported = await exportSceneZip(cloneScene(demoScene));
      const files = unzipSync(exported.bytes);
      const canonical = parseSceneYaml(strFromU8(files['scene.yaml']!));
      expect(canonical.assets).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledWith('/demo/members.png', {
        credentials: 'same-origin',
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('fetches remote screenshots without credentials and bundles them into a self-contained ZIP', async () => {
    const scene = rasterScene();
    scene.steps[0]!.image = 'https://assets.example.test/product.png';
    const payload = PASSIVE_PNG.slice(PASSIVE_PNG.indexOf(',') + 1);
    const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }),
      );
    try {
      const exported = await exportSceneZip(scene);
      expect(fetchMock).toHaveBeenCalledWith('https://assets.example.test/product.png', {
        credentials: 'omit',
        mode: 'cors',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
      });
      const files = unzipSync(exported.bytes);
      const canonical = parseSceneYaml(strFromU8(files['scene.yaml']!));
      expect(canonical.steps[0]!.states.before?.screenshot?.path).toMatch(
        /^assets\/[a-f0-9]{64}\.png$/u,
      );
      expect(canonical.metadata.scenebookStudioRemoteImages).toBeUndefined();
      const imported = await importPortableBytes(exported.bytes, exported.filename);
      expect(imported.scenes[0]!.steps[0]!.image).toMatch(/^data:image\/png;base64,/u);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    ['Scene ZIP', exportSceneZip],
    ['Scene YAML', exportSceneYaml],
  ])('fails %s export when a remote screenshot cannot be made portable', async (_, exporter) => {
    const scene = rasterScene();
    scene.steps[0]!.image = 'https://assets.example.test/private.png';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('CORS denied'));
    try {
      await expect(exporter(scene)).rejects.toMatchObject({
        code: 'missing-asset',
        issues: [expect.stringMatching(/Step open-members: CORS denied/iu)],
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('round-trips standalone Scene YAML through integrity-checked inline assets', async () => {
    const exported = await exportSceneYaml(rasterScene());
    const canonical = parseSceneYaml(strFromU8(exported.bytes));
    expect(canonical.metadata.scenebookStudioInlineAssets).toBeTypeOf('object');

    const imported = await importPortableBytes(exported.bytes, exported.filename);
    expect(imported.scenes[0]!.steps[0]!.image).toMatch(/^data:image\/png;base64,/iu);
  });

  it('exports authored annotation geometry and cursor motion without fixed placeholders', async () => {
    const source = rasterScene();
    const step = source.steps[0]!;
    step.annotations = [
      {
        id: 'authored-callout',
        kind: 'callout',
        x: 0.34,
        y: 0.26,
        width: 0.28,
        height: 0.13,
        text: 'Authored callout',
        color: '#0369a1',
      },
      {
        id: 'authored-spotlight',
        kind: 'spotlight',
        x: 0.62,
        y: 0.43,
        width: 0.21,
        height: 0.18,
        text: 'Authored spotlight',
        color: '#7c3aed',
      },
      {
        id: 'authored-arrow',
        kind: 'arrow',
        fromX: 0.12,
        fromY: 0.74,
        x: 0.76,
        y: 0.31,
        text: 'Authored arrow',
        color: '#237a57',
      },
    ];
    step.cursor = {
      x: 0.76,
      y: 0.31,
      visible: true,
      click: true,
      clickAtMs: 1_050,
      style: 'pointer',
      path: [
        { atMs: 0, x: 0.2, y: 0.72 },
        { atMs: 800, x: 0.76, y: 0.31 },
      ],
    };

    const exported = await exportSceneYaml(source);
    const canonical = parseSceneYaml(strFromU8(exported.bytes));
    expect(canonical.steps[0]!.presentation.annotations).toEqual([
      {
        id: 'open-members-hotspot',
        kind: 'hotspot',
        rect: { x: 0.8235, y: 0.14450000000000002, width: 0.045, height: 0.045 },
        label: 'Invite member',
      },
      {
        id: 'authored-callout',
        kind: 'callout',
        rect: { x: 0.2, y: 0.195, width: 0.28, height: 0.13 },
        text: 'Authored callout',
        color: '#0369a1',
      },
      {
        id: 'authored-spotlight',
        kind: 'spotlight',
        rect: { x: 0.515, y: 0.33999999999999997, width: 0.21, height: 0.18 },
        text: 'Authored spotlight',
        color: '#7c3aed',
      },
      {
        id: 'authored-arrow',
        kind: 'arrow',
        from: { x: 0.12, y: 0.74 },
        to: { x: 0.76, y: 0.31 },
        text: 'Authored arrow',
        color: '#237a57',
      },
    ]);
    expect(canonical.steps[0]!.presentation.cursor).toEqual({
      visible: true,
      position: { x: 0.76, y: 0.31 },
      path: [
        { atMs: 0, point: { x: 0.2, y: 0.72 } },
        { atMs: 800, point: { x: 0.76, y: 0.31 } },
      ],
      clickAtMs: 1_050,
      style: 'pointer',
    });
  });

  it('preserves Studio translation drafts across the canonical portable boundary', async () => {
    const source = rasterScene();
    source.translations = {
      'pt-PT': {
        title: 'Convidar um colega',
        steps: {
          'open-members': {
            title: 'Abrir o convite',
            instruction: 'Abra o diretório de membros.',
            alt: 'Diretório de membros com o botão de convite.',
          },
        },
      },
    };
    const exported = await exportSceneZip(source);
    const canonical = parseSceneYaml(strFromU8(unzipSync(exported.bytes)['scene.yaml']!));
    expect(canonical.translations['pt-PT']).toMatchObject({
      title: 'Convidar um colega',
      steps: {
        'open-members': {
          instruction: 'Abra o diretório de membros.',
          altText: 'Diretório de membros com o botão de convite.',
        },
      },
    });
    const imported = await importPortableBytes(exported.bytes, exported.filename);
    expect(imported.scenes[0]!.translations?.['pt-PT']?.title).toBe('Convidar um colega');
    expect(imported.scenes[0]!.translations?.['pt-PT']?.steps['open-members']?.instruction).toBe(
      'Abra o diretório de membros.',
    );
  });

  it('retains imported canonical choice and CTA translations that Studio does not edit', async () => {
    const initial = await exportSceneZip(rasterScene());
    const files = unzipSync(initial.bytes);
    const canonical = parseSceneYaml(strFromU8(files['scene.yaml']!));
    canonical.translations = {
      'pt-PT': {
        steps: {
          'choose-path': {
            choices: { member: { label: 'Acesso de membro' } },
            ctas: {},
          },
          'invitation-sent': {
            choices: {},
            ctas: { 'open-product': { label: 'Abrir o produto', fields: {} } },
          },
        },
      },
    };
    files['scene.yaml'] = strToU8(serializeSceneYaml(canonical));
    const imported = await importPortableBytes(zipSync(files), 'translated.scene.zip');
    imported.scenes[0]!.description = 'Unrelated Studio edit.';

    const exported = await exportSceneZip(imported.scenes[0]!);
    const result = parseSceneYaml(strFromU8(unzipSync(exported.bytes)['scene.yaml']!));
    expect(result.translations['pt-PT']!.steps['choose-path']!.choices.member!.label).toBe(
      'Acesso de membro',
    );
    expect(
      result.translations['pt-PT']!.steps['invitation-sent']!.ctas['open-product']!.label,
    ).toBe('Abrir o produto');
  });

  it('carries Studio locale, theme, and multi-CTA edits through ZIP into the compiler', async () => {
    const { files } = await referencedSidecarArchive();
    const imported = await importPortableBytes(zipSync(files), 'editable.scene.zip');
    const scene = imported.scenes[0]!;

    expect(scene.theme).toMatchObject({ accent: '#c2412d', radius: 17 });
    scene.steps = scene.steps.filter((step) =>
      ['open-members', 'invitation-sent'].includes(step.id),
    );
    scene.theme = {
      accent: '#155e75',
      paper: '#f4f1e8',
      ink: '#102a2e',
      radius: 23,
      frame: 'light',
    };
    scene.translations = {
      'pt-PT': {
        title: 'Convite editado no Studio',
        description: 'Uma tradução portátil e compilável.',
        steps: {
          'open-members': {
            title: 'Abrir membros',
            instruction: 'Escolha Convidar membro.',
            alt: 'Diretório de membros traduzido.',
          },
          'invitation-sent': { title: 'Convite enviado' },
        },
      },
    };
    const end = scene.steps.find((step) => step.id === 'invitation-sent')!;
    end.ctaEdited = true;
    end.ctas = [
      {
        id: 'read-guide',
        label: 'Ler o guia',
        kind: 'read-docs',
        href: 'https://docs.example.test/invitations',
        variant: 'primary',
      },
      {
        id: 'restart',
        label: 'Recomeçar',
        kind: 'restart',
        event: 'restart',
        variant: 'secondary',
      },
    ];

    const exported = await exportSceneZip(scene);
    const archive = unzipSync(exported.bytes);
    const canonical = parseSceneYaml(strFromU8(archive['scene.yaml']!));
    expect(canonical.translations['pt-PT']).toMatchObject({
      title: 'Convite editado no Studio',
      steps: { 'open-members': { altText: 'Diretório de membros traduzido.' } },
    });
    expect(canonical.steps.at(-1)!.ctas).toEqual([
      expect.objectContaining({ id: 'read-guide', label: 'Ler o guia', variant: 'primary' }),
      expect.objectContaining({ id: 'restart', label: 'Recomeçar', variant: 'secondary' }),
    ]);
    expect(canonical.theme?.variables).toMatchObject({
      accent: '#155e75',
      paper: '#f4f1e8',
      ink: '#102a2e',
      radius: '23',
      frame: 'light',
    });

    // The compiler contract is the canonical schema, not Studio's backward-compatibility metadata.
    delete canonical.metadata.scenebookStudioCtas;
    delete canonical.metadata.scenebookStudioTranslations;
    archive['scene.yaml'] = strToU8(serializeSceneYaml(canonical));
    const root = await mkdtemp(join(tmpdir(), 'scenebook-studio-compiler-'));
    try {
      const sourceDirectory = join(root, 'scene');
      const outputDirectory = join(root, 'dist');
      for (const [path, bytes] of Object.entries(archive)) {
        const absolutePath = join(sourceDirectory, path);
        if (path.endsWith('/')) {
          await mkdir(absolutePath, { recursive: true });
        } else {
          await mkdir(dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, bytes);
        }
      }
      await compileScenes({
        scenes: [sourceDirectory],
        outputDirectory,
        formats: ['standalone-html'],
        locale: 'pt-PT',
        privacyGate: passedPrivacy,
      });
      const html = await readFile(join(outputDirectory, 'standalone/invite-teammate.html'), 'utf8');
      expect(html).toContain('Convite editado no Studio');
      expect(html).toContain('Escolha Convidar membro.');
      expect(html).toContain('Ler o guia');
      expect(html).toContain('Recomeçar');
      expect(html).toContain('--accent:#155e75');
      expect(html).toContain('--paper:#f4f1e8');
      expect(html).toContain('--radius:23px');
      expect(html).not.toContain('--accent:#c2412d');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves every referenced sidecar byte through JSON storage, YAML, and ZIP export', async () => {
    const { files, sidecars } = await referencedSidecarArchive();
    const imported = await importPortableBytes(zipSync(files), 'sidecars.scene.zip');
    const stored = JSON.parse(
      JSON.stringify(imported.scenes[0]),
    ) as (typeof imported.scenes)[number];

    expect(stored.portableSource?.capability).toBe('verified');
    expect(stored.verified).toBeUndefined();
    expect(Object.keys(stored.portableSidecars ?? {}).sort()).toEqual(Object.keys(sidecars).sort());

    stored.title = 'Edited without touching sidecars';
    const yaml = await exportSceneYaml(stored);
    const reimported = await importPortableBytes(yaml.bytes, yaml.filename);
    const reexported = await exportSceneZip(reimported.scenes[0]!);
    const output = unzipSync(reexported.bytes);
    for (const [path, expected] of Object.entries(sidecars)) {
      expect(output[path]).toEqual(expected);
    }
  });

  it.each([
    ['narrative', 'narrative.mdx'],
    ['theme', 'theme.yaml'],
    ['locale', 'locales/pt-PT.yaml'],
    ['replay', 'automation/replay.ts'],
  ])('rejects a ZIP missing its referenced %s sidecar', async (_, missingPath) => {
    const { files } = await referencedSidecarArchive();
    delete files[missingPath];
    await expect(importPortableBytes(zipSync(files), 'missing-sidecar.zip')).rejects.toMatchObject({
      code: 'missing-sidecar',
      issues: [`Missing sidecar: ${missingPath}`],
    });
  });

  it('retains an extension-style replay draft even before it is promoted to automation', async () => {
    const initial = await exportSceneZip(rasterScene());
    const files = unzipSync(initial.bytes);
    const canonical = parseSceneYaml(strFromU8(files['scene.yaml']!));
    canonical.metadata = {
      ...canonical.metadata,
      recorder: 'browser-extension',
      replayDraft: true,
    };
    files['scene.yaml'] = strToU8(serializeSceneYaml(canonical));
    const replay = strToU8(
      "import { test } from '@playwright/test';\n\ntest('extension draft', async ({ page }) => {\n  await page.getByRole('button', { name: 'Invite' }).click();\n});\n",
    );
    files['automation/replay.ts'] = replay;

    const imported = await importPortableBytes(zipSync(files), 'extension.scene.zip');
    const reexported = await exportSceneZip(cloneScene(imported.scenes[0]!));
    expect(unzipSync(reexported.bytes)['automation/replay.ts']).toEqual(replay);
  });

  it('preserves an imported form CTA exactly across unrelated Studio edits', async () => {
    const initial = await exportSceneZip(rasterScene());
    const importedFiles = unzipSync(initial.bytes);
    const canonical = parseSceneYaml(strFromU8(importedFiles['scene.yaml']!));
    const formCta = {
      kind: 'form' as const,
      label: 'Request access',
      webhookId: 'access-request',
      fields: [
        {
          id: 'work-email',
          label: 'Work email',
          type: 'email' as const,
          required: true,
          consent: false,
        },
        {
          id: 'updates-consent',
          label: 'I agree to receive access updates',
          type: 'checkbox' as const,
          required: true,
          consent: true,
        },
      ],
    };
    canonical.steps.at(-1)!.ctas = [];
    canonical.steps.at(-1)!.cta = formCta;
    importedFiles['scene.yaml'] = strToU8(serializeSceneYaml(canonical));

    const imported = await importPortableBytes(zipSync(importedFiles), 'form-cta.zip');
    const editor = imported.scenes[0]!;
    editor.description = 'An unrelated narrative edit.';
    expect(editor.steps.at(-1)!.ctas[0]).toMatchObject({
      kind: 'form',
      webhookId: 'access-request',
      fields: formCta.fields,
    });
    expect(editor.steps.at(-1)!.ctaEdited).toBe(false);

    const reexported = await exportSceneZip(editor);
    const resultFiles = unzipSync(reexported.bytes);
    const result = parseSceneYaml(strFromU8(resultFiles['scene.yaml']!));
    expect(result.steps.at(-1)!.cta).toEqual(formCta);
  });

  it('preserves rich presentation and privacy source across unrelated Studio edits', async () => {
    const initial = await exportSceneZip(rasterScene());
    const files = unzipSync(initial.bytes);
    const canonical = parseSceneYaml(strFromU8(files['scene.yaml']!));
    const step = canonical.steps[0]!;
    step.states.after = { ...step.states.before!, id: `${step.id}-after` };
    step.presentation.state = 'both';
    step.presentation.frame = {
      kind: 'device',
      preset: 'iphone-15-pro',
      title: 'Signed-in workspace',
      showAddressBar: false,
    };
    step.presentation.crop = {
      rect: { x: 0.08, y: 0.12, width: 0.76, height: 0.7 },
      focalPoint: { x: 0.62, y: 0.44 },
      zoom: 1.8,
    };
    step.presentation.cursor = {
      visible: true,
      position: { x: 0.74, y: 0.28 },
      path: [
        { atMs: 0, point: { x: 0.32, y: 0.65 } },
        { atMs: 720, point: { x: 0.74, y: 0.28 } },
      ],
      clickAtMs: 875,
      style: 'dot',
    };
    step.presentation.annotations = [
      {
        id: 'rich-hotspot',
        kind: 'hotspot',
        rect: { x: 0.65, y: 0.18, width: 0.18, height: 0.12 },
        label: 'Open invite',
        color: '#b83b24',
      },
      {
        id: 'rich-arrow',
        kind: 'arrow',
        from: { x: 0.18, y: 0.72 },
        to: { x: 0.66, y: 0.31 },
        text: 'Follow this direction',
        color: '#237a57',
      },
      {
        id: 'rich-spotlight',
        kind: 'spotlight',
        rect: { x: 0.4, y: 0.24, width: 0.27, height: 0.19 },
        label: 'Important region',
        color: '#7c3aed',
      },
      {
        id: 'rich-callout',
        kind: 'text',
        rect: { x: 0.11, y: 0.13, width: 0.31, height: 0.14 },
        text: 'Exact imported text annotation',
        color: '#0369a1',
      },
    ];
    step.masks = [
      {
        id: 'classified-mask',
        mode: 'opaque',
        source: 'locator',
        scope: 'capture',
        locator: '[data-private="email"]',
        rect: { x: 0.14, y: 0.21, width: 0.36, height: 0.08 },
        reason: 'Work email',
        classification: 'email',
      },
      {
        id: 'unresolved-mask',
        mode: 'opaque',
        source: 'locator',
        scope: 'both',
        locator: '[data-private="token"]',
        reason: 'Resolve again during replay',
        classification: 'token',
      },
    ];
    files['scene.yaml'] = strToU8(serializeSceneYaml(canonical));

    const imported = await importPortableBytes(zipSync(files), 'rich.scene.zip');
    const editor = imported.scenes[0]!;
    editor.description = 'Only this narrative field changed.';
    const exported = await exportSceneZip(editor);
    const result = parseSceneYaml(strFromU8(unzipSync(exported.bytes)['scene.yaml']!));
    const resultStep = result.steps[0]!;

    expect(resultStep.presentation.state).toBe('both');
    expect(resultStep.presentation.frame).toEqual(step.presentation.frame);
    expect(resultStep.presentation.crop).toEqual(step.presentation.crop);
    expect(resultStep.presentation.cursor).toEqual(step.presentation.cursor);
    expect(resultStep.presentation.annotations).toEqual(step.presentation.annotations);
    expect(resultStep.masks).toEqual(step.masks);
  });

  it('exports manual presentation blur metadata and rejects blur for sensitive masks', async () => {
    const scene = rasterScene();
    scene.steps[0]!.masks.push({
      id: 'presentation-blur',
      mode: 'blur',
      source: 'manual',
      scope: 'publication',
      classification: 'custom',
      x: 0.12,
      y: 0.18,
      width: 0.24,
      height: 0.09,
      label: 'De-emphasized account total',
    });

    const exported = await exportSceneYaml(scene);
    const result = parseSceneYaml(strFromU8(exported.bytes));
    expect(result.steps[0]!.masks[0]).toMatchObject({
      id: 'presentation-blur',
      mode: 'blur',
      source: 'manual',
      scope: 'publication',
      classification: 'custom',
      reason: 'De-emphasized account total',
    });

    scene.steps[0]!.masks[0]!.classification = 'email';
    await expect(exportSceneYaml(scene)).rejects.toThrow(
      /Blur is only available for manual presentation regions/u,
    );
    scene.steps[0]!.masks[0]!.classification = 'custom';
    scene.steps[0]!.masks[0]!.source = 'locator';
    await expect(exportSceneYaml(scene)).rejects.toThrow(
      /Blur is only available for manual presentation regions/u,
    );
  });

  it('exports explicitly edited form and view-Scene CTA fields', async () => {
    const formScene = rasterScene();
    const end = formScene.steps.at(-1)!;
    end.ctaEdited = true;
    end.ctas = [
      {
        id: 'request-demo',
        label: 'Request a demo',
        kind: 'form',
        webhookId: 'demo-request',
        fields: [
          {
            id: 'email',
            label: 'Email',
            type: 'email',
            required: true,
            consent: false,
          },
        ],
        variant: 'primary',
      },
    ];
    const formExport = await exportSceneYaml(formScene);
    expect(parseSceneYaml(strFromU8(formExport.bytes)).steps.at(-1)!.cta).toEqual({
      kind: 'form',
      label: 'Request a demo',
      webhookId: 'demo-request',
      fields: [
        {
          id: 'email',
          label: 'Email',
          type: 'email',
          required: true,
          consent: false,
        },
      ],
    });

    end.ctas = [
      {
        id: 'next-scene',
        label: 'Continue the tour',
        kind: 'view-scene',
        targetSceneId: 'advanced-tour',
        fields: [],
        variant: 'primary',
      },
    ];
    const sceneExport = await exportSceneYaml(formScene);
    expect(parseSceneYaml(strFromU8(sceneExport.bytes)).steps.at(-1)!.cta).toEqual({
      kind: 'view-scene',
      label: 'Continue the tour',
      targetSceneId: 'advanced-tour',
      fields: [],
    });
  });

  it('exports and imports a multi-Scene project archive', async () => {
    const second = rasterScene();
    second.id = 'invite-teammate-copy';
    second.title = 'Invite a teammate copy';
    second.portableSource = undefined;
    const scenes = [rasterScene(), second];
    const project = defaultProject(scenes);
    const exported = await exportProjectZip(scenes, project);
    const files = unzipSync(exported.bytes);
    expect(
      parseProjectYaml(strFromU8(files['project.yaml']!)).collections[0]!.entries,
    ).toHaveLength(2);
    expect(Object.keys(files)).toContain('scenes/invite-teammate/scene.yaml');
    expect(Object.keys(files)).toContain('scenes/invite-teammate-copy/scene.yaml');

    const imported = await importPortableBytes(exported.bytes, exported.filename);
    expect(imported.kind).toBe('project');
    expect(imported.project?.name).toBe('Local workspace');
    expect(imported.scenes.map((scene) => scene.id).sort()).toEqual([
      'invite-teammate',
      'invite-teammate-copy',
    ]);
  });

  it('imports project YAML honestly as configuration without invented Scenes', async () => {
    const project = defaultProject([demoScene]);
    const exported = exportProjectYaml(project);
    const imported = await importPortableBytes(exported.bytes, exported.filename);
    expect(imported.kind).toBe('project');
    expect(imported.scenes).toEqual([]);
    expect(imported.warnings[0]).toMatch(/configuration only/iu);
  });

  it('rejects path traversal before expanding an archive', async () => {
    const archive = zipSync({ '../scene.yaml': strToU8('schemaVersion: 1') });
    await expect(importPortableBytes(archive, 'unsafe.zip')).rejects.toMatchObject({
      code: 'invalid-archive',
    });
  });

  it('rejects a screenshot whose bytes do not match its digest', async () => {
    const exported = await exportSceneZip(rasterScene());
    const files = unzipSync(exported.bytes);
    const assetPath = Object.keys(files).find((path) => path.startsWith('assets/'))!;
    files[assetPath] = Uint8Array.from(files[assetPath]!, (value, index) =>
      index === 0 ? value ^ 0xff : value,
    );
    const corrupt = zipSync(files);
    await expect(importPortableBytes(corrupt, 'corrupt.zip')).rejects.toMatchObject({
      code: 'corrupt-asset',
    });
  });

  it('returns actionable diagnostics for malformed and incomplete source', async () => {
    await expect(
      importPortableBytes(strToU8('schemaVersion: 99\nid: future\n'), 'future.yaml'),
    ).rejects.toBeInstanceOf(PortableFileError);

    const exported = await exportSceneZip(rasterScene());
    const files = unzipSync(exported.bytes);
    for (const path of Object.keys(files)) if (path.startsWith('assets/')) delete files[path];
    await expect(importPortableBytes(zipSync(files), 'missing-assets.zip')).rejects.toMatchObject({
      code: 'missing-asset',
    });
  });

  it('preflights advertised expansion before decompression', async () => {
    const archive = zipSync({ 'scene.yaml': strToU8('schemaVersion: 1') });
    const central = archive.findIndex(
      (_, index) =>
        archive[index] === 0x50 &&
        archive[index + 1] === 0x4b &&
        archive[index + 2] === 0x01 &&
        archive[index + 3] === 0x02,
    );
    expect(central).toBeGreaterThan(0);
    const advertised = 251 * 1024 * 1024;
    for (let index = 0; index < 4; index += 1) {
      archive[central + 24 + index] = (advertised >>> (index * 8)) & 0xff;
    }
    await expect(importPortableBytes(archive, 'advertised-bomb.zip')).rejects.toMatchObject({
      code: 'invalid-archive',
    });
  });

  it.each([
    [
      'SVG',
      (() => {
        const scene = rasterScene();
        scene.steps[0]!.image = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')}`;
        return scene;
      })(),
      'invalid-file',
    ],
    [
      'HTML',
      (() => {
        const scene = rasterScene();
        scene.steps[0]!.image = `data:text/html;base64,${btoa('<html><script>alert(1)</script></html>')}`;
        return scene;
      })(),
      'invalid-file',
    ],
    [
      'HTML disguised as PNG',
      (() => {
        const scene = rasterScene();
        scene.steps[0]!.image = `data:image/png;base64,${btoa('<html>not a png</html>')}`;
        return scene;
      })(),
      'corrupt-asset',
    ],
  ])('rejects active or deceptive %s screenshot content', async (_, scene, code) => {
    await expect(exportSceneZip(scene)).rejects.toMatchObject({ code });
  });
});
