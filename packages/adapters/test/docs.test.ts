import { describe, expect, it } from 'vitest';
import { assetUrl, buildDocsAdapter, DOCS_ADAPTERS, normalizeBasePath } from '../src/index.js';

describe('documentation adapters', () => {
  it.each(DOCS_ADAPTERS)('generates a manifest and integration files for %s', (adapter) => {
    const files = buildDocsAdapter({ adapter, basePath: '/team docs/product' });
    const manifestFile = files.find((file) => file.path === `.scenebook/${adapter}.json`);
    expect(manifestFile).toBeDefined();
    const manifest = JSON.parse(manifestFile!.content) as {
      adapter: string;
      basePath: string;
      catalogUrl: string;
      files: string[];
    };
    expect(manifest).toMatchObject({
      adapter,
      basePath: '/team%20docs/product',
      catalogUrl: '/team%20docs/product/scenebook/index.html',
    });
    expect(manifest.files.length).toBeGreaterThan(0);
    expect(files.map((file) => file.content).join('\n')).toContain(
      '/team%20docs/product/scenebook/index.html',
    );
  });

  it('encodes asset segments while preserving a safe root-relative base', () => {
    expect(normalizeBasePath('/')).toBe('/');
    expect(assetUrl('/docs/v2', 'scene cards/invite.png')).toBe(
      '/docs/v2/scene%20cards/invite.png',
    );
  });

  it('pins every third-party action in the generated GitHub Pages workflow', () => {
    const workflow = buildDocsAdapter({ adapter: 'github-pages' }).find(
      (file) => file.path === '.github/workflows/scenebook-pages.yml',
    );
    expect(workflow).toBeDefined();
    const actionReferences = [...workflow!.content.matchAll(/uses:\s+([^\s#]+)/gu)].map(
      (match) => match[1],
    );
    expect(actionReferences).toHaveLength(5);
    expect(actionReferences).toEqual(
      expect.arrayContaining([
        'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
        'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
        'actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b',
        'actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa',
        'actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e',
      ]),
    );
    expect(workflow!.content).toContain('persist-credentials: false');
    expect(workflow!.content).toContain('timeout-minutes: 20');
    expect(workflow!.content).not.toMatch(/uses:\s+[^\s]+@v\d+(?:\s|$)/u);
  });

  it.each([
    'https://host/docs',
    '//host/docs',
    'relative',
    '/docs/../secret',
    '/docs/%2e%2e/secret',
    '/docs/%252e%252e/secret',
    '/docs\\secret',
    '/docs?token=x',
    '/docs#fragment',
  ])('rejects an unsafe base path: %s', (basePath) => {
    expect(() => normalizeBasePath(basePath)).toThrow();
  });

  it.each(['/absolute.png', '../secret.png', '%2e%2e/secret.png', 'a\\b.png', 'x.png?raw=1'])(
    'rejects an unsafe asset path: %s',
    (path) => expect(() => assetUrl('/docs', path)).toThrow(),
  );
});
