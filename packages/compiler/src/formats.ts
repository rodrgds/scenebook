import type { FormatPolicy, OutputFormat } from './types.js';

export const FORMAT_POLICY: Readonly<Record<OutputFormat, FormatPolicy>> = {
  catalog: {
    description: 'Searchable, static, account-free catalog containing every selected Scene.',
    deterministic: true,
    reproducibility: 'self-contained',
    networkIndependent: true,
    containsExecutableCode: true,
    mayContainSensitivePixels: true,
    requiresFfmpeg: false,
  },
  'standalone-html': {
    description: 'One self-contained interactive walkthrough HTML document per Scene.',
    deterministic: true,
    reproducibility: 'self-contained',
    networkIndependent: true,
    containsExecutableCode: true,
    mayContainSensitivePixels: true,
    requiresFfmpeg: false,
  },
  'web-component': {
    description: 'Framework-neutral custom-element module with a portable Scene payload.',
    deterministic: true,
    reproducibility: 'self-contained',
    networkIndependent: true,
    containsExecutableCode: true,
    mayContainSensitivePixels: true,
    requiresFfmpeg: false,
  },
  iframe: {
    description: 'Drop-in iframe embed snippet targeting the standalone Scene output.',
    deterministic: true,
    reproducibility: 'self-contained',
    networkIndependent: true,
    containsExecutableCode: true,
    mayContainSensitivePixels: false,
    requiresFfmpeg: false,
  },
  markdown: {
    description: 'Portable Markdown guide with copied, content-addressed image assets.',
    deterministic: true,
    reproducibility: 'self-contained',
    networkIndependent: true,
    containsExecutableCode: false,
    mayContainSensitivePixels: true,
    requiresFfmpeg: false,
  },
  mdx: {
    description: 'Framework-neutral MDX guide; no framework-specific runtime is required.',
    deterministic: true,
    reproducibility: 'self-contained',
    networkIndependent: true,
    containsExecutableCode: false,
    mayContainSensitivePixels: true,
    requiresFfmpeg: false,
  },
  'html-guide': {
    description: 'Accessible, print-ready standalone HTML guide.',
    deterministic: true,
    reproducibility: 'self-contained',
    networkIndependent: true,
    containsExecutableCode: false,
    mayContainSensitivePixels: true,
    requiresFfmpeg: false,
  },
  'readme-card': {
    description: 'README-ready Markdown card linking to the Scene.',
    deterministic: true,
    reproducibility: 'self-contained',
    networkIndependent: true,
    containsExecutableCode: false,
    mayContainSensitivePixels: true,
    requiresFfmpeg: false,
  },
  'og-image': {
    description: '1200x630 Open Graph image rendered from redacted Scene evidence.',
    deterministic: true,
    reproducibility: 'self-contained',
    networkIndependent: true,
    containsExecutableCode: false,
    mayContainSensitivePixels: true,
    requiresFfmpeg: false,
  },
  'social-carousel': {
    description: 'Deterministic square and widescreen social-launch artwork.',
    deterministic: true,
    reproducibility: 'self-contained',
    networkIndependent: true,
    containsExecutableCode: false,
    mayContainSensitivePixels: true,
    requiresFfmpeg: false,
  },
  pdf: {
    description: 'Portable paginated guide with embedded evidence and no external URLs.',
    deterministic: true,
    reproducibility: 'self-contained',
    networkIndependent: true,
    containsExecutableCode: false,
    mayContainSensitivePixels: true,
    requiresFfmpeg: false,
  },
  gif: {
    description: 'Looping launch preview rendered from authored timing and cursor targets.',
    deterministic: true,
    reproducibility: 'toolchain-bound',
    networkIndependent: true,
    containsExecutableCode: false,
    mayContainSensitivePixels: true,
    requiresFfmpeg: true,
  },
  webm: {
    description: 'Web-optimized VP9 walkthrough rendered without audio or metadata.',
    deterministic: true,
    reproducibility: 'toolchain-bound',
    networkIndependent: true,
    containsExecutableCode: false,
    mayContainSensitivePixels: true,
    requiresFfmpeg: true,
  },
  mp4: {
    description: 'H.264 launch video rendered without audio or identifying metadata.',
    deterministic: true,
    reproducibility: 'toolchain-bound',
    networkIndependent: true,
    containsExecutableCode: false,
    mayContainSensitivePixels: true,
    requiresFfmpeg: true,
  },
  'remix-source': {
    description:
      'Portable public remix source with flattened redacted assets, integrity inventory, and Studio-ready ZIP.',
    deterministic: true,
    reproducibility: 'self-contained',
    networkIndependent: true,
    containsExecutableCode: false,
    mayContainSensitivePixels: true,
    requiresFfmpeg: false,
  },
};

export const DEFAULT_FORMATS = Object.freeze(Object.keys(FORMAT_POLICY) as OutputFormat[]);

const FORMAT_ALIASES: Readonly<Record<string, OutputFormat>> = {
  'interactive-html': 'standalone-html',
  'guide-html': 'html-guide',
  html: 'html-guide',
  readme: 'readme-card',
  og: 'og-image',
  social: 'social-carousel',
};

export function parseOutputFormats(values: readonly string[]): OutputFormat[] {
  const requested = values.flatMap((value) => value.split(',')).map((value) => value.trim());
  if (requested.length === 0 || requested.includes('all')) return [...DEFAULT_FORMATS];

  const result = new Set<OutputFormat>();
  for (const value of requested) {
    const normalized = FORMAT_ALIASES[value] ?? value;
    if (!(normalized in FORMAT_POLICY)) {
      throw new Error(
        `Unknown output format "${value}". Expected one of: ${Object.keys(FORMAT_POLICY).join(', ')}`,
      );
    }
    result.add(normalized as OutputFormat);
  }
  return [...result];
}
