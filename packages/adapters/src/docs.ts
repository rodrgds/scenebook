export const DOCS_ADAPTERS = [
  'fumadocs',
  'docusaurus',
  'vitepress',
  'starlight',
  'nextra',
  'mintlify',
  'github-pages',
] as const;

export type DocsAdapterId = (typeof DOCS_ADAPTERS)[number];

export interface GeneratedAdapterFile {
  readonly path: string;
  readonly content: string;
}

export interface DocsAdapterManifest {
  readonly schemaVersion: 1;
  readonly adapter: DocsAdapterId;
  readonly basePath: string;
  readonly catalogUrl: string;
  readonly files: readonly string[];
}

function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new Error(`Invalid percent encoding in path segment: ${segment}`);
  }
}

function assertSegment(segment: string): void {
  const decoded = decodedSegment(segment);
  const decodedTwice = decoded.includes('%') ? decodedSegment(decoded) : decoded;
  if (
    !segment ||
    [decoded, decodedTwice].some(
      (value) =>
        value === '.' ||
        value === '..' ||
        value.includes('/') ||
        value.includes('\\') ||
        /[\u0000-\u001f\u007f]/u.test(value),
    )
  ) {
    throw new Error(`Unsafe path segment: ${JSON.stringify(segment)}`);
  }
}

export function normalizeBasePath(value = '/'): string {
  if (!value.startsWith('/') || value.startsWith('//')) {
    throw new Error('Documentation basePath must be a root-relative path.');
  }
  if (/[\\?#\u0000-\u001f\u007f]/u.test(value) || /^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    throw new Error('Documentation basePath contains unsafe characters.');
  }
  const parts = value.split('/').filter(Boolean);
  parts.forEach(assertSegment);
  return parts.length
    ? `/${parts.map((part) => encodeURIComponent(decodedSegment(part))).join('/')}`
    : '/';
}

export function assetUrl(basePath: string, relativePath: string): string {
  const base = normalizeBasePath(basePath);
  if (
    !relativePath ||
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    /[\\?#\u0000-\u001f\u007f]/u.test(relativePath)
  ) {
    throw new Error('Asset path must be a safe relative POSIX path.');
  }
  const parts = relativePath.split('/');
  parts.forEach(assertSegment);
  const encoded = parts.map((part) => encodeURIComponent(decodedSegment(part))).join('/');
  return `${base === '/' ? '' : base}/${encoded}`;
}

function manifestFile(
  adapter: DocsAdapterId,
  basePath: string,
  files: readonly GeneratedAdapterFile[],
): GeneratedAdapterFile {
  const manifest: DocsAdapterManifest = {
    schemaVersion: 1,
    adapter,
    basePath,
    catalogUrl: assetUrl(basePath, 'scenebook/index.html'),
    files: files.map((file) => file.path).sort(),
  };
  return { path: `.scenebook/${adapter}.json`, content: `${JSON.stringify(manifest, null, 2)}\n` };
}

function frameworkFiles(adapter: DocsAdapterId, catalogUrl: string): GeneratedAdapterFile[] {
  const url = JSON.stringify(catalogUrl);
  switch (adapter) {
    case 'fumadocs':
      return [
        {
          path: 'components/scenebook.tsx',
          content: `import type { ComponentProps } from 'react';\nexport function Scenebook(props: Omit<ComponentProps<'iframe'>, 'src'>) { return <iframe title="Scenebook" loading="lazy" {...props} src={${url}} />; }\n`,
        },
      ];
    case 'docusaurus':
      return [
        {
          path: 'src/components/Scenebook/index.tsx',
          content: `import React from 'react';\nexport default function Scenebook(): JSX.Element { return <iframe title="Scenebook" loading="lazy" src={${url}} style={{width:'100%',minHeight:640,border:0}} />; }\n`,
        },
        {
          path: 'scenebook.docusaurus.json',
          content: `${JSON.stringify({ staticDirectories: ['static'], copyTo: 'static/scenebook' }, null, 2)}\n`,
        },
      ];
    case 'vitepress':
      return [
        {
          path: '.vitepress/theme/Scenebook.vue',
          content: `<template><iframe title="Scenebook" loading="lazy" :src="catalog" /></template>\n<script setup lang="ts">const catalog = ${url}</script>\n<style scoped>iframe{width:100%;min-height:640px;border:0}</style>\n`,
        },
        {
          path: '.vitepress/theme/scenebook.ts',
          content: `import Scenebook from './Scenebook.vue';\nexport function registerScenebook(app: { component(name: string, value: unknown): void }) { app.component('Scenebook', Scenebook); }\n`,
        },
      ];
    case 'starlight':
      return [
        {
          path: 'src/components/Scenebook.astro',
          content: `---\ninterface Props { title?: string }\nconst { title = 'Scenebook' } = Astro.props\n---\n<iframe {title} loading="lazy" src=${url}></iframe>\n<style>iframe{width:100%;min-height:640px;border:0}</style>\n`,
        },
      ];
    case 'nextra':
      return [
        {
          path: 'components/Scenebook.tsx',
          content: `export function Scenebook() { return <iframe title="Scenebook" loading="lazy" src={${url}} style={{width:'100%',minHeight:640,border:0}} />; }\n`,
        },
      ];
    case 'mintlify':
      return [
        {
          path: 'snippets/scenebook.mdx',
          content: `<iframe title="Scenebook" loading="lazy" src=${url} style={{ width: '100%', minHeight: 640, border: 0 }} />\n`,
        },
        {
          path: 'scenebook.mint.json',
          content: `${JSON.stringify({ copy: { from: 'scenebook-dist', to: 'scenebook' } }, null, 2)}\n`,
        },
      ];
    case 'github-pages':
      return [
        { path: '.nojekyll', content: '' },
        {
          path: '.github/workflows/scenebook-pages.yml',
          content: `name: Scenebook Pages\non:\n  push:\n    branches: [main]\npermissions:\n  contents: read\n  pages: write\n  id-token: write\nconcurrency:\n  group: pages\n  cancel-in-progress: true\njobs:\n  deploy:\n    environment:\n      name: github-pages\n      url: \${{ steps.deployment.outputs.page_url }}\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n        with:\n          persist-credentials: false\n      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0\n        with:\n          bun-version: 1.3.3\n      - run: bun install --frozen-lockfile\n      - run: bun run build\n      - uses: actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b # v5.0.0\n      - uses: actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa # v3.0.1\n        with:\n          path: scenebook-dist\n      - id: deployment\n        uses: actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e # v4.0.5\n`,
        },
      ];
  }
}

export function buildDocsAdapter(options: {
  readonly adapter: DocsAdapterId;
  readonly basePath?: string;
}): readonly GeneratedAdapterFile[] {
  if (!DOCS_ADAPTERS.includes(options.adapter))
    throw new Error(`Unsupported docs adapter: ${String(options.adapter)}`);
  const basePath = normalizeBasePath(options.basePath);
  const files = frameworkFiles(options.adapter, assetUrl(basePath, 'scenebook/index.html'));
  return [...files, manifestFile(options.adapter, basePath, files)].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}
