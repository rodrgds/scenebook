import { readFile } from 'node:fs/promises';
import { basename, dirname, relative } from 'node:path';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import sharp from 'sharp';
import { sha256, stableStringify } from '@scenebook/core';
import { canonicalJson, escapeHtml, escapeMarkdown, scriptJson, writeOutputFile } from './io.js';
import {
  mapPresentationRect,
  presentationAsset,
  renderPresentation,
  themeDeclarations,
} from './presentation.js';
import { absolutePublicationUrl, publicArtifactUrl, robotsDirective } from './public.js';
import { bundleViewerRuntime } from './viewer-bundle.js';
import type {
  NormalizedScene,
  NormalizedStep,
  PublicationPlan,
  SceneAdapterContext,
  SceneOutputAdapter,
} from './types.js';

const BASE_STYLES = `
:root{color-scheme:light;--paper:#f4f5f6;--ink:#1c1d1f;--muted:#5f646b;--accent:#a93621;--line:#d7dade;--card:#fff;--ok:#246a4b;--info:#315f9d;--radius:14px;font-family:var(--font-family,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif)}
*{box-sizing:border-box}html{background:var(--paper);color:var(--ink)}body{margin:0}a{color:inherit}a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:3px}a:active,button:active:not(:disabled),summary:active{filter:brightness(.84)}h1,h2,h3{font-family:var(--heading-font-family,inherit);text-wrap:balance}.shell{width:min(1120px,calc(100% - 32px));margin:0 auto;padding:40px 0 64px}.context,.step-meta{color:var(--muted);font-size:13px;font-weight:650;margin:0 0 8px}h1{font-size:clamp(32px,5vw,52px);line-height:1.06;letter-spacing:-.03em;margin:.2em 0}p{line-height:1.6;text-wrap:pretty}.muted{color:var(--muted);max-width:72ch}.status{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:999px;padding:7px 11px;font-size:13px;font-weight:650}.status:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--muted)}.status.automated:before,.status.configured:before{background:var(--info)}.stage{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:var(--radius);background:#111;isolation:isolate}.stage img{width:100%;height:auto;display:block}.comparison{display:grid;grid-template-columns:1fr 1fr;gap:2px}.comparison img{height:100%;object-fit:contain}.hotspot{position:absolute;min-width:44px;min-height:44px;border:3px solid white;border-radius:999px;background:var(--accent);box-shadow:0 0 0 6px color-mix(in srgb,var(--accent) 35%,transparent);transform:translate(-50%,-50%);cursor:pointer}.controls,.choices,.cta{display:flex;align-items:center;gap:10px;margin:16px 0;flex-wrap:wrap}.controls button,.choices a,.cta a,.cta button{align-items:center;border:1px solid var(--ink);background:var(--ink);color:white;border-radius:10px;display:inline-flex;min-height:44px;padding:10px 16px;font:inherit;font-weight:650;cursor:pointer;text-decoration:none}.controls button.secondary,.choices a{background:transparent;color:var(--ink)}button:disabled{opacity:.42;cursor:not-allowed}.progress{margin-inline-start:auto;font:500 13px/1 ui-monospace,monospace}.instruction{font-size:18px}.practice{background:color-mix(in srgb,var(--accent) 8%,transparent);border:1px solid color-mix(in srgb,var(--accent) 35%,var(--line));border-radius:10px;padding:12px}.transcript{border-top:1px solid var(--line);margin-top:28px;padding-top:18px}.transcript button{width:100%;min-height:44px;text-align:start;border:0;border-bottom:1px solid var(--line);background:transparent;color:inherit;padding:12px 4px;font:inherit;cursor:pointer}.transcript button[aria-current="step"]{color:var(--accent);font-weight:700}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr));gap:18px;margin-top:22px}.catalog-group{margin-top:40px}.catalog-group h2{font-size:30px;letter-spacing:-.02em;margin:.2em 0}.catalog-group .cards{margin-top:18px}.card{border:1px solid var(--line);border-radius:var(--radius);background:var(--card);overflow:hidden}.card img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#161513}.card-copy{padding:18px}.card h2{margin:10px 0 6px;font-size:20px}.card small{color:var(--muted)}.card-link{display:block;text-decoration:none}.card-link:hover h2{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}.search-wrap{display:grid;gap:7px;margin-top:28px;max-width:520px}.search-wrap label{font-size:13px;font-weight:700}.search{width:100%;border:1px solid var(--line);border-radius:10px;background:var(--card);color:inherit;min-height:44px;padding:10px 13px;font:inherit}.empty-search{border:1px dashed var(--line);border-radius:var(--radius);color:var(--muted);margin-top:28px;padding:24px}.guide-step{margin:36px 0 52px}.guide-step img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:var(--radius)}.guide-step .comparison img{width:100%}.guide-links{display:flex;flex-wrap:wrap;gap:8px;padding:0;list-style:none}.guide-links a{align-items:center;border:1px solid var(--line);border-radius:10px;display:inline-flex;min-height:44px;padding:9px 12px;text-decoration:none}.guide-links a:hover{text-decoration:underline}.runtime-fallback{border:1px solid var(--line);border-radius:var(--radius);margin-top:28px;padding:20px}.runtime-fallback h2{margin-top:0}.runtime-fallback li+li{margin-top:14px}.runtime-fallback a{align-items:center;display:inline-flex;min-height:44px}@media(max-width:600px){.shell{width:min(100% - 20px,1120px);padding-top:24px}.progress{width:100%;margin-inline-start:0}.comparison{grid-template-columns:1fr}.attribution{align-items:flex-start;flex-direction:column;gap:4px}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
.cta form{display:grid;gap:12px;width:min(100%,34rem)}.cta label{display:grid;gap:6px;min-height:44px;width:100%;font-weight:600}.cta input:not([type=checkbox]){width:100%;min-height:44px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);padding:10px 12px;font:inherit}.cta-result{color:var(--muted);font-size:14px;margin:0}.cta-result[data-state=error]{color:#92291c}.cta-result[data-state=success]{color:var(--ok)}
.share-panel{border-top:1px solid var(--line);margin-top:36px;padding-top:18px}.share-panel summary{cursor:pointer;font-size:15px;font-weight:700;min-height:44px;padding:10px 0}.share-panel p{margin:4px 0 0}.share-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.share-links a,.remix-link{border:1px solid var(--line);border-radius:10px;display:inline-flex;min-height:44px;align-items:center;padding:9px 12px;text-decoration:none;font-size:13px;font-weight:650}.share-links a:hover,.remix-link:hover{text-decoration:underline}.share-links a.primary,.remix-link{background:var(--ink);border-color:var(--ink);color:white}.attribution{align-items:center;border-top:1px solid var(--line);color:var(--muted);display:flex;font-size:12px;justify-content:space-between;margin-top:42px;padding-top:18px}.card-actions{align-items:center;border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end;padding:12px 18px}.card-actions a{font-size:13px;font-weight:650}.catalog-footer{margin-top:54px}.sr-only{clip:rect(0,0,0,0);clip-path:inset(50%);height:1px;overflow:hidden;position:absolute;white-space:nowrap;width:1px}
.empty-search[hidden]{display:none}.empty-search p{margin-top:0}.empty-search button{background:transparent;border:1px solid var(--line);border-radius:10px;color:var(--ink);cursor:pointer;font:inherit;font-weight:650;min-height:44px;padding:9px 12px}
`;

function relativeAsset(fromFile: string, assetPath: string): string {
  const result = relative(dirname(fromFile), assetPath).replaceAll('\\', '/');
  return result.startsWith('.') ? result : `./${result}`;
}

function safeHref(value?: string): string | undefined {
  if (!value) return undefined;
  if (/^(?:https?:|mailto:)/iu.test(value)) return value;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  return undefined;
}

const RTL_LANGUAGES = new Set([
  'ar',
  'ckb',
  'dv',
  'fa',
  'he',
  'iw',
  'nqo',
  'ps',
  'sd',
  'ug',
  'ur',
  'yi',
]);
const RTL_SCRIPTS = new Set([
  'adlm',
  'arab',
  'hebr',
  'mand',
  'nkoo',
  'rohg',
  'samr',
  'syrc',
  'thaa',
]);

function localeDirection(locale: string): 'ltr' | 'rtl' {
  const parts = locale.toLowerCase().split('-');
  const explicitScript = parts.find((part) => /^[a-z]{4}$/u.test(part));
  let script = explicitScript;
  if (!script) {
    try {
      script = new Intl.Locale(locale).maximize().script?.toLowerCase();
    } catch {
      // Validated locales reach this path, but keep the static language fallback fail-safe.
    }
  }
  if (script) return RTL_SCRIPTS.has(script) ? 'rtl' : 'ltr';
  return RTL_LANGUAGES.has(parts[0] ?? '') ? 'rtl' : 'ltr';
}

function hasFormat(
  context: SceneAdapterContext,
  format: SceneAdapterContext['formats'][number],
): boolean {
  return context.formats.includes(format);
}

function sceneOutputPath(
  context: SceneAdapterContext,
  format: SceneAdapterContext['formats'][number],
  index = 0,
): string | undefined {
  const slug = context.scene.slug;
  const paths: Partial<Record<SceneAdapterContext['formats'][number], readonly string[]>> = {
    catalog: [`scenes/${slug}/index.html`],
    'standalone-html': [`standalone/${slug}.html`],
    'web-component': [`components/${slug}.js`],
    iframe: [`embeds/${slug}.iframe.html`],
    markdown: [`scenes/${slug}/guide.md`],
    mdx: [`scenes/${slug}/guide.mdx`],
    'html-guide': [`scenes/${slug}/guide.html`],
    pdf: [`exports/${slug}.pdf`],
    mp4: [`exports/${slug}.mp4`],
    webm: [`exports/${slug}.webm`],
    gif: [`exports/${slug}.gif`],
    'readme-card': [`scenes/${slug}/README.md`],
    'og-image': [`social/${slug}-og.png`],
    'social-carousel': [`social/${slug}-square.png`, `social/${slug}-landscape.png`],
    'remix-source': [`remix/${slug}.scene/scene.yaml`, `remix/${slug}.scene.zip`],
  };
  return hasFormat(context, format) ? paths[format]?.[index] : undefined;
}

function attribution(context: SceneAdapterContext, className = 'attribution'): string {
  return context.publication.distribution.attribution
    ? `<footer class="${className}"><span>Made with Scenebook</span></footer>`
    : '';
}

function capabilityPresentation(capability: string): {
  readonly className: string;
  readonly label: string;
} {
  if (capability === 'verified')
    return { className: 'automated', label: 'Automated checks configured' };
  if (capability === 'monitored')
    return { className: 'configured', label: 'Monitoring configured' };
  return { className: 'configured', label: 'Capture configured' };
}

function sceneMetadata(
  context: SceneAdapterContext,
  pagePath: string,
  options: { readonly kind?: 'interactive' | 'guide'; readonly canonicalPath?: string } = {},
): string {
  const description =
    context.scene.description ??
    `An interactive product story with ${context.scene.steps.length} steps.`;
  const title = `${context.scene.title} · ${context.publication.title}`;
  const canonicalPath = options.canonicalPath ?? pagePath;
  const canonical = absolutePublicationUrl(context.publication.distribution, canonicalPath);
  const imagePath = sceneOutputPath(context, 'og-image');
  const image = imagePath
    ? absolutePublicationUrl(context.publication.distribution, imagePath)
    : undefined;
  const remix = context.publication.distribution.remix
    ? sceneOutputPath(context, 'remix-source', 1)
    : undefined;
  const structured = {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: context.scene.title,
    description,
    inLanguage: context.scene.locale,
    ...(canonical ? { url: canonical } : {}),
    ...(image ? { image } : {}),
    step: context.scene.steps
      .filter(
        (step) =>
          !step.hidden &&
          (options.kind === 'guide' ? step.visibility.guide : step.visibility.interactive),
      )
      .map((step, index) => ({
        '@type': 'HowToStep',
        position: index + 1,
        name: step.title,
        ...((step.instruction ?? step.caption) ? { text: step.instruction ?? step.caption } : {}),
      })),
  };
  const remixHref = remix
    ? (absolutePublicationUrl(context.publication.distribution, remix) ??
      relativeAsset(pagePath, remix))
    : undefined;
  return `<meta name="description" content="${escapeHtml(description)}"><meta name="robots" content="${robotsDirective(context.publication.distribution)}"><meta property="og:type" content="article"><meta property="og:site_name" content="${escapeHtml(context.publication.title)}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:locale" content="${escapeHtml(context.scene.locale.replace('-', '_'))}">${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:url" content="${escapeHtml(canonical)}">` : ''}${image ? `<meta property="og:image" content="${escapeHtml(image)}"><meta property="og:image:alt" content="${escapeHtml(`${context.scene.title} preview`)}">` : ''}<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}">${image ? `<meta name="twitter:image" content="${escapeHtml(image)}">` : ''}${remixHref ? `<link rel="alternate" type="application/zip" title="Remix this Scene" href="${escapeHtml(remixHref)}">` : ''}<script type="application/ld+json">${scriptJson(structured)}</script>`;
}

function sceneSharePanel(context: SceneAdapterContext, pagePath: string): string {
  const candidates: Array<{
    label: string;
    format: SceneAdapterContext['formats'][number];
    index?: number;
    primary?: boolean;
  }> = [
    { label: 'Interactive page', format: 'catalog' },
    { label: 'Standalone HTML', format: 'standalone-html' },
    { label: 'Embed wrapper', format: 'iframe' },
    { label: 'Web Component', format: 'web-component' },
    { label: 'README card', format: 'readme-card' },
    { label: 'Open Graph image', format: 'og-image' },
    { label: 'Square social image', format: 'social-carousel', index: 0 },
    { label: 'Landscape social image', format: 'social-carousel', index: 1 },
    { label: 'Remix this Scene', format: 'remix-source', index: 1, primary: true },
  ];
  const links = candidates.flatMap((candidate) => {
    if (candidate.format === 'remix-source' && !context.publication.distribution.remix) return [];
    const path = sceneOutputPath(context, candidate.format, candidate.index ?? 0);
    const href = path
      ? (absolutePublicationUrl(context.publication.distribution, path) ??
        relativeAsset(pagePath, path))
      : undefined;
    return href
      ? [
          `<a${candidate.primary ? ' class="primary"' : ''} href="${escapeHtml(href)}"${candidate.format === 'remix-source' ? ' download' : ''}>${escapeHtml(candidate.label)}</a>`,
        ]
      : [];
  });
  return links.length
    ? `<details class="share-panel"><summary>Download or reuse</summary><p class="muted">Downloads reflect the assets and settings in this publication.</p><nav class="share-links" aria-label="Walkthrough downloads">${links.join('')}</nav></details>`
    : '';
}

interface PublishedStep {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly instruction?: string;
  readonly caption?: string;
  readonly altText?: string;
  readonly image: string;
  readonly secondaryImage?: string;
  readonly target?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly label?: string;
  };
  readonly autoAdvance: boolean;
  readonly durationMs: number;
  readonly transition: string;
  readonly practiceMode: boolean;
  readonly choices: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly targetSceneId: string;
    readonly targetStepId?: string;
    readonly href: string;
  }[];
  readonly ctas: readonly {
    readonly id: string;
    readonly variant: 'primary' | 'secondary';
    readonly kind: string;
    readonly label: string;
    readonly href?: string;
    readonly webhookId?: string;
    readonly fields: readonly {
      readonly id: string;
      readonly label: string;
      readonly type: 'email' | 'text' | 'checkbox';
      readonly required: boolean;
      readonly consent: boolean;
    }[];
  }[];
}

function branchHref(
  context: SceneAdapterContext,
  choice: NormalizedStep['choices'][number],
  location: 'standalone' | 'catalog' | 'component',
): string {
  const slug = context.sceneSlugs.get(choice.targetSceneId);
  if (!slug) throw new Error(`Unknown branch Scene ${choice.targetSceneId}.`);
  const anchor = choice.targetStepId ? `#step=${encodeURIComponent(choice.targetStepId)}` : '';
  if (location === 'standalone') return `${slug}.html${anchor}`;
  if (location === 'component') return `../standalone/${slug}.html${anchor}`;
  return `../${slug}/index.html${anchor}`;
}

function ctaHref(
  context: SceneAdapterContext,
  cta: NormalizedStep['ctas'][number],
  location: 'standalone' | 'catalog' | 'component',
): string | undefined {
  if (cta.kind === 'restart') return '#step=';
  if (cta.kind === 'view-scene' && cta.targetSceneId) {
    const slug = context.sceneSlugs.get(cta.targetSceneId);
    if (!slug) throw new Error(`Unknown CTA Scene ${cta.targetSceneId}.`);
    if (location === 'standalone') return `${slug}.html`;
    if (location === 'component') return `../standalone/${slug}.html`;
    return `../${slug}/index.html`;
  }
  return safeHref(cta.url);
}

async function publishedSteps(
  context: SceneAdapterContext,
  location: 'standalone' | 'catalog' | 'component',
  imageSource: (path: string) => Promise<string> | string,
): Promise<PublishedStep[]> {
  return Promise.all(
    context.scene.steps
      .filter((step) => !step.hidden && step.visibility.interactive)
      .map(async (step) => {
        const rendered = await renderPresentation(context, step, 'interactive');
        const imagePath = await presentationAsset(context, step, 'interactive');
        const secondaryPath = step.secondaryImageReference
          ? await presentationAsset(context, step, 'interactive', { secondary: true })
          : undefined;
        const target = step.target
          ? mapPresentationRect(step, step.target, rendered.contentWidth, rendered.contentHeight)
          : undefined;
        return {
          id: step.id,
          kind: step.kind,
          title: step.title,
          ...(step.instruction ? { instruction: step.instruction } : {}),
          ...(step.caption ? { caption: step.caption } : {}),
          ...(step.altText ? { altText: step.altText } : {}),
          image: await imageSource(imagePath),
          ...(secondaryPath ? { secondaryImage: await imageSource(secondaryPath) } : {}),
          ...(target
            ? {
                target: {
                  ...target,
                  ...(step.target?.label ? { label: step.target.label } : {}),
                },
              }
            : {}),
          autoAdvance: step.autoAdvance,
          durationMs: step.durationMs,
          transition: step.transition,
          practiceMode: step.practiceMode,
          choices: step.choices.map((choice) => ({
            id: choice.id,
            label: choice.label,
            ...(choice.description ? { description: choice.description } : {}),
            targetSceneId: choice.targetSceneId,
            ...(choice.targetStepId ? { targetStepId: choice.targetStepId } : {}),
            href: branchHref(context, choice, location),
          })),
          ctas: step.ctas.map((cta) => ({
            id: cta.id,
            variant: cta.variant,
            kind: cta.kind,
            label: cta.label,
            ...(ctaHref(context, cta, location) ? { href: ctaHref(context, cta, location) } : {}),
            ...(cta.webhookId ? { webhookId: cta.webhookId } : {}),
            fields: cta.fields,
          })),
        } satisfies PublishedStep;
      }),
  );
}

function viewerTheme(scene: NormalizedScene): Record<string, string | number> {
  const token = (name: string): string | undefined =>
    scene.theme[name] ?? scene.theme[`--${name}`] ?? scene.theme[`--sb-${name}`];
  const radius = Number.parseFloat(token('radius') ?? '');
  return {
    ...(token('accent') ? { accent: token('accent')! } : {}),
    ...(token('paper') ? { paper: token('paper')! } : {}),
    ...(token('ink') ? { ink: token('ink')! } : {}),
    ...(Number.isFinite(radius) ? { radius } : {}),
  };
}

function sceneColor(scene: NormalizedScene, name: string, fallback: string): string {
  const value = scene.theme[`--${name}`] ?? scene.theme[name];
  return value &&
    (/^#[a-f0-9]{3,8}$/iu.test(value) ||
      /^(?:rgb|hsl)a?\([\d\s,.%/-]+\)$/iu.test(value) ||
      /^[a-z]{3,20}$/iu.test(value))
    ? value
    : fallback;
}

function viewerScene(context: SceneAdapterContext, steps: readonly PublishedStep[]) {
  return {
    version: 1,
    id: context.scene.id,
    title: context.scene.title,
    ...(context.scene.description ? { description: context.scene.description } : {}),
    theme: viewerTheme(context.scene),
    steps: steps.map((step) => ({
      id: step.id,
      type:
        step.kind === 'browser' ? 'screen' : step.kind === 'explanation' ? 'separator' : step.kind,
      title: step.title,
      ...(step.instruction ? { instruction: step.instruction } : {}),
      ...(step.caption ? { caption: step.caption } : {}),
      ...(step.altText ? { alt: step.altText } : {}),
      image: step.image,
      ...(step.secondaryImage ? { secondaryImage: step.secondaryImage } : {}),
      frame: 'none',
      ...(step.target
        ? {
            hotspot: {
              x: step.target.x + step.target.width / 2,
              y: step.target.y + step.target.height / 2,
              width: step.target.width,
              height: step.target.height,
              label: step.target.label ?? 'Continue',
            },
          }
        : {}),
      durationMs: step.durationMs,
      autoAdvance: step.autoAdvance,
      transition: step.transition,
      practiceMode: step.practiceMode,
      choices: step.choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
        ...(choice.description ? { description: choice.description } : {}),
        sceneId: choice.targetSceneId,
        ...(choice.targetStepId ? { stepId: choice.targetStepId } : {}),
        href: choice.href,
      })),
      ctas: step.ctas.map((cta) => ({
        id: cta.id,
        label: cta.label,
        kind: cta.kind,
        ...(cta.href ? { href: cta.href } : {}),
        ...(cta.kind === 'restart' ? { event: 'restart' } : {}),
        variant: cta.variant,
        ...(cta.webhookId ? { webhookId: cta.webhookId } : {}),
        fields: cta.fields,
      })),
    })),
  };
}

async function standaloneViewerRuntime(payload: unknown): Promise<string> {
  const source = `
import { registerScenebookPlayer } from '@scenebook/viewer';
const payload=${scriptJson(payload)};
registerScenebookPlayer();
const placeholder=document.getElementById('scenebook-player');
const player=document.createElement('scenebook-player');
for(const attribute of Array.from(placeholder.attributes))player.setAttribute(attribute.name,attribute.value);
placeholder.replaceWith(player);
const analytics=payload.analytics,ctaRuntime=payload.ctaRuntime,trackingSource=payload.source;
const parentOrigin=(()=>{try{const origin=new URL(document.referrer).origin;return origin==='null'?null:origin}catch{return null}})();
const bridgeDetail=(name,eventDetail)=>{
  if(name!=='scenebook:cta')return eventDetail;
  const {fields:_fields,webhookId:_webhookId,submissionId:_submissionId,cta:rawCta,...state}=eventDetail;
  const safeCta=rawCta&&typeof rawCta==='object'?{kind:rawCta.kind,label:rawCta.label}:null;
  return {...state,...(safeCta?{cta:safeCta}:{})};
};
const trackingAllowed=()=>Boolean(analytics)&&!(analytics.respectDoNotTrack&&(navigator.doNotTrack==='1'||navigator.globalPrivacyControl===true));
const uniqueId=prefix=>{const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return prefix+'-'+[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('')};
const track=(type,state)=>{
  if(!trackingAllowed())return;
  const body={schemaVersion:1,id:uniqueId('event'),releaseId:analytics.releaseId,sceneId:payload.scene.id,...(state?.stepId?{stepId:state.stepId}:{}),type,occurredAt:new Date().toISOString(),properties:{source:trackingSource,index:state?.index??0,total:state?.total??payload.scene.steps.length,progress:state?.progress??0}};
  void fetch(analytics.endpoint,{method:'POST',headers:{authorization:'Bearer '+analytics.token,'content-type':'application/json'},body:JSON.stringify(body),credentials:'omit',referrerPolicy:'no-referrer',keepalive:true,mode:'cors'}).catch(()=>{});
};
let started=false;
for(const name of ['scenebook:ready','scenebook:stepchange','scenebook:branch','scenebook:cta','scenebook:complete']){
  player.addEventListener(name,event=>{
    const detail=event.detail??{};
    if(window.parent!==window&&parentOrigin)window.parent.postMessage({source:'scenebook',type:name,detail:bridgeDetail(name,detail)},parentOrigin);
    if(name==='scenebook:ready')track('view',detail);
    else if(name==='scenebook:stepchange'){
      if(!started&&detail.source!=='restart'){started=true;track('start',detail)}
      track('step',detail);
      if(detail.stepId)history.replaceState(history.state,'','#step='+encodeURIComponent(detail.stepId));
    }else if(name==='scenebook:complete')track('complete',detail);
    else if(name==='scenebook:cta')track('cta',detail);
  });
}
const initialStep=new URLSearchParams(location.hash.slice(1)).get('step');
if(initialStep)player.setAttribute('step',initialStep);
player.formsDisabled=!ctaRuntime;
if(ctaRuntime)player.ctaSubmitter=async submission=>{
  const response=await fetch(ctaRuntime.endpoint,{method:'POST',headers:{authorization:'Bearer '+ctaRuntime.token,'content-type':'application/json'},body:JSON.stringify({id:submission.submissionId,releaseId:ctaRuntime.releaseId,sceneId:submission.sceneId,stepId:submission.stepId,ctaId:submission.ctaId,webhookId:submission.webhookId,fields:submission.fields}),credentials:'omit',referrerPolicy:'no-referrer',mode:'cors'});
  if(!response.ok)throw new Error('submission rejected');
};
player.scene=payload.scene;
document.getElementById('scenebook-runtime-fallback')?.remove();
window.addEventListener('hashchange',()=>{const step=new URLSearchParams(location.hash.slice(1)).get('step');if(step)player.setAttribute('step',step)});
`;
  return (await bundleViewerRuntime(source, 'iife')).replaceAll('</script', '<\\/script');
}

function interactiveRuntimeFallback(context: SceneAdapterContext, pagePath: string): string {
  const transcript = context.scene.steps
    .filter((step) => !step.hidden && step.visibility.interactive)
    .map((step, index) => {
      const prose = step.instruction ?? step.caption;
      return `<li><strong>Step ${index + 1}: ${escapeHtml(step.title)}</strong>${prose ? `<p>${escapeHtml(prose)}</p>` : ''}</li>`;
    })
    .join('');
  const guidePath = sceneOutputPath(context, 'html-guide');
  const guide = guidePath
    ? `<p><a href="${escapeHtml(relativeAsset(pagePath, guidePath))}">Open the step-by-step guide</a></p>`
    : '';
  return `<section class="runtime-fallback" id="scenebook-runtime-fallback" aria-labelledby="scenebook-runtime-fallback-title"><noscript><p>Interactive controls require JavaScript. The transcript remains available below.</p></noscript><h2 id="scenebook-runtime-fallback-title">Walkthrough transcript</h2><ol>${transcript}</ol>${guide}</section>`;
}

async function interactiveDocument(
  context: SceneAdapterContext,
  location: 'standalone' | 'catalog',
  imageSource: (path: string) => Promise<string> | string,
): Promise<string> {
  const steps = await publishedSteps(context, location, imageSource);
  const pagePath =
    location === 'standalone'
      ? `standalone/${context.scene.slug}.html`
      : `scenes/${context.scene.slug}/index.html`;
  const canonicalPath = hasFormat(context, 'catalog')
    ? `scenes/${context.scene.slug}/index.html`
    : pagePath;
  const payload = {
    scene: viewerScene(context, steps),
    analytics: context.publicAnalytics ?? null,
    ctaRuntime: context.publicCta ?? null,
    source: location,
  };
  const runtime = await standaloneViewerRuntime(payload);
  const capability = capabilityPresentation(context.scene.capability);
  return `<!doctype html><html lang="${escapeHtml(context.scene.locale)}" dir="${localeDirection(context.scene.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(`${context.scene.title} · ${context.publication.title}`)}</title>${sceneMetadata(context, pagePath, { canonicalPath })}<style>:root{${themeDeclarations(context.scene)}}${BASE_STYLES}scenebook-player{display:block;margin-top:28px}</style></head><body><main class="shell"><p class="context">Interactive walkthrough</p><h1>${escapeHtml(context.scene.title)}</h1>${context.scene.description ? `<p class="muted">${escapeHtml(context.scene.description)}</p>` : ''}<span class="status ${capability.className}">${capability.label}</span><section aria-label="Walkthrough"><scenebook-player id="scenebook-player" compact></scenebook-player>${interactiveRuntimeFallback(context, pagePath)}</section>${sceneSharePanel(context, pagePath)}${attribution(context)}</main><script>${runtime}</script></body></html>`;
}

interface GuideAsset {
  readonly primary: string;
  readonly primaryWidth: number;
  readonly primaryHeight: number;
  readonly secondary?: string;
  readonly secondaryWidth?: number;
  readonly secondaryHeight?: number;
}

async function guideAssets(
  context: SceneAdapterContext,
  outputPath: string,
): Promise<Map<string, GuideAsset>> {
  const assets = new Map<string, GuideAsset>();
  for (const step of context.scene.steps.filter(
    (candidate) => !candidate.hidden && candidate.visibility.guide,
  )) {
    const [primaryPath, primaryPresentation] = await Promise.all([
      presentationAsset(context, step, 'guide'),
      renderPresentation(context, step, 'guide'),
    ]);
    const primary = relativeAsset(outputPath, primaryPath);
    if (step.secondaryImageReference) {
      const [secondaryPath, secondaryPresentation] = await Promise.all([
        presentationAsset(context, step, 'guide', { secondary: true }),
        renderPresentation(context, step, 'guide', { secondary: true }),
      ]);
      assets.set(step.id, {
        primary,
        primaryWidth: primaryPresentation.width,
        primaryHeight: primaryPresentation.height,
        secondary: relativeAsset(outputPath, secondaryPath),
        secondaryWidth: secondaryPresentation.width,
        secondaryHeight: secondaryPresentation.height,
      });
      continue;
    }
    assets.set(step.id, {
      primary,
      primaryWidth: primaryPresentation.width,
      primaryHeight: primaryPresentation.height,
    });
  }
  return assets;
}

async function guideMarkdown(
  context: SceneAdapterContext,
  path: string,
  mdx: boolean,
): Promise<string> {
  const assets = await guideAssets(context, path);
  const body = context.scene.steps
    .filter((step) => !step.hidden && step.visibility.guide)
    .map((step, index) => {
      const lines = [`## ${index + 1}. ${escapeMarkdown(step.title)}`];
      const prose = step.instruction ?? step.caption;
      if (prose) lines.push('', escapeMarkdown(prose));
      const stepAssets = assets.get(step.id);
      if (stepAssets) {
        lines.push('', `![${escapeMarkdown(step.altText ?? step.title)}](${stepAssets.primary})`);
        if (stepAssets.secondary)
          lines.push(
            '',
            `![${escapeMarkdown(`${step.altText ?? step.title} after`)}](${stepAssets.secondary})`,
          );
      }
      if (step.choices.length) {
        lines.push('', '**Choose:**');
        for (const choice of step.choices)
          lines.push(
            `- ${escapeMarkdown(choice.label)} → Scene \`${escapeMarkdown(choice.targetSceneId)}\`${choice.targetStepId ? `, Step \`${escapeMarkdown(choice.targetStepId)}\`` : ''}`,
          );
      }
      for (const cta of step.ctas)
        lines.push('', `**${escapeMarkdown(cta.label)}**${cta.url ? `: ${cta.url}` : ''}`);
      return lines.join('\n');
    })
    .join('\n\n');
  const header = mdx
    ? `---\ntitle: ${JSON.stringify(context.scene.title)}\nscenebookScene: ${JSON.stringify(context.scene.id)}\nlocale: ${JSON.stringify(context.scene.locale)}\n---`
    : `# ${escapeMarkdown(context.scene.title)}`;
  const editorial = mdx && context.loaded.narrative ? `${context.loaded.narrative.trim()}\n\n` : '';
  return `${header}\n\n${context.scene.description ? `${escapeMarkdown(context.scene.description)}\n\n` : ''}${editorial}${body}\n`;
}

async function guideDocument(context: SceneAdapterContext): Promise<string> {
  const path = `scenes/${context.scene.slug}/guide.html`;
  const assets = await guideAssets(context, path);
  const steps = context.scene.steps
    .filter((step) => !step.hidden && step.visibility.guide)
    .map((step, index) => {
      const stepAssets = assets.get(step.id);
      const media = stepAssets
        ? `<div class="${stepAssets.secondary ? 'comparison' : ''}"><img src="${escapeHtml(stepAssets.primary)}" alt="${escapeHtml(step.altText ?? step.title)}" width="${stepAssets.primaryWidth}" height="${stepAssets.primaryHeight}" loading="lazy">${stepAssets.secondary ? `<img src="${escapeHtml(stepAssets.secondary)}" alt="${escapeHtml(`${step.altText ?? step.title} after`)}" width="${stepAssets.secondaryWidth}" height="${stepAssets.secondaryHeight}" loading="lazy">` : ''}</div>`
        : '';
      const choices = step.choices.length
        ? `<ul class="guide-links">${step.choices.map((choice) => `<li><a href="${escapeHtml(branchHref(context, choice, 'catalog'))}">${escapeHtml(choice.label)}</a></li>`).join('')}</ul>`
        : '';
      const ctas = step.ctas.length
        ? `<ul class="guide-links">${step.ctas
            .map((cta) => {
              const href =
                cta.kind === 'restart' || cta.kind === 'form'
                  ? `./index.html#step=${encodeURIComponent(step.id)}`
                  : ctaHref(context, cta, 'catalog');
              return href
                ? `<li><a href="${escapeHtml(href)}">${escapeHtml(cta.label)}</a></li>`
                : `<li>${escapeHtml(cta.label)}</li>`;
            })
            .join('')}</ul>`
        : '';
      return `<article class="guide-step" id="${escapeHtml(step.id)}"><p class="step-meta">Step ${index + 1}</p><h2>${escapeHtml(step.title)}</h2>${step.instruction || step.caption ? `<p>${escapeHtml(step.instruction ?? step.caption ?? '')}</p>` : ''}${media}${choices}${ctas}</article>`;
    })
    .join('');
  return `<!doctype html><html lang="${escapeHtml(context.scene.locale)}" dir="${localeDirection(context.scene.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(`${context.scene.title} · Guide`)}</title>${sceneMetadata(context, path, { kind: 'guide' })}<style>:root{${themeDeclarations(context.scene)}}${BASE_STYLES}</style></head><body><main class="shell"><p class="context">Step-by-step guide</p><h1>${escapeHtml(context.scene.title)}</h1>${context.scene.description ? `<p class="muted">${escapeHtml(context.scene.description)}</p>` : ''}${steps}${sceneSharePanel(context, path)}${attribution(context)}</main></body></html>`;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const paragraphs = text.replace(/\r/gu, '').split('\n');
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    let line = '';
    for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    if (!paragraph.trim()) lines.push('');
  }
  return lines;
}

function drawLines(
  page: PDFPage,
  lines: readonly string[],
  options: {
    x: number;
    y: number;
    font: PDFFont;
    size: number;
    lineHeight: number;
    color?: ReturnType<typeof rgb>;
    maxLines?: number;
  },
): number {
  const selected = lines.slice(0, options.maxLines ?? lines.length);
  selected.forEach((line, index) =>
    page.drawText(line, {
      x: options.x,
      y: options.y - index * options.lineHeight,
      font: options.font,
      size: options.size,
      color: options.color,
    }),
  );
  return options.y - selected.length * options.lineHeight;
}

async function pdfGuide(context: SceneAdapterContext): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle(context.scene.title);
  document.setAuthor('Scenebook');
  document.setCreator('Scenebook compiler');
  document.setProducer('Scenebook compiler');
  const epoch = new Date(context.generatedAt);
  document.setCreationDate(epoch);
  document.setModificationDate(epoch);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const visible = context.scene.steps.filter((step) => !step.hidden && step.visibility.guide);
  const total = Math.max(1, visible.length);
  for (const [index, step] of visible.entries()) {
    const page = document.addPage([595.28, 841.89]);
    page.drawText(context.scene.title.slice(0, 90), {
      x: 42,
      y: 800,
      size: 10,
      font: regular,
      color: rgb(0.42, 0.4, 0.36),
    });
    page.drawText(step.kind.toUpperCase(), {
      x: 42,
      y: 766,
      size: 9,
      font: bold,
      color: rgb(0.92, 0.3, 0.18),
    });
    let cursor = drawLines(page, wrapText(`${index + 1}. ${step.title}`, bold, 23, 511), {
      x: 42,
      y: 738,
      font: bold,
      size: 23,
      lineHeight: 28,
      color: rgb(0.09, 0.08, 0.07),
      maxLines: 3,
    });
    const prose = step.instruction ?? step.caption ?? '';
    if (prose)
      cursor = drawLines(page, wrapText(prose, regular, 11.5, 511), {
        x: 42,
        y: cursor - 7,
        font: regular,
        size: 11.5,
        lineHeight: 16,
        color: rgb(0.23, 0.22, 0.2),
        maxLines: 7,
      });
    cursor -= 15;
    const rendered = await renderPresentation(context, step, 'guide');
    await context.putAsset(rendered.buffer, {
      extension: '.png',
      mediaType: 'image/png',
      sourceStepId: step.id,
      requiresOcr: Boolean(step.imageReference),
    });
    const image = await document.embedPng(rendered.buffer);
    const availableHeight = Math.max(220, cursor - 76);
    const scaled = image.scaleToFit(511, availableHeight);
    page.drawImage(image, {
      x: 42 + (511 - scaled.width) / 2,
      y: cursor - scaled.height,
      width: scaled.width,
      height: scaled.height,
    });
    if (step.ctas[0])
      page.drawText(
        step.ctas
          .map((cta) => cta.label)
          .join(' · ')
          .slice(0, 70),
        {
          x: 42,
          y: 52,
          size: 10,
          font: bold,
          color: rgb(0.92, 0.3, 0.18),
        },
      );
    page.drawLine({
      start: { x: 42, y: 34 },
      end: { x: 553, y: 34 },
      thickness: 0.5,
      color: rgb(0.83, 0.8, 0.75),
    });
    page.drawText(`${index + 1} / ${total}`, {
      x: 512,
      y: 18,
      size: 8,
      font: regular,
      color: rgb(0.42, 0.4, 0.36),
    });
  }
  if (!visible.length) document.addPage([595.28, 841.89]);
  return document.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false,
  });
}

function svgText(value: string): string {
  return escapeHtml(value.replace(/\s+/gu, ' ').trim());
}

function svgWrappedText(
  value: string,
  x: number,
  y: number,
  width: number,
  fontSize: number,
  lineHeight: number,
  maxLines: number,
  fill: string,
  weight: number,
  fontFamily = 'Arial,sans-serif',
): string {
  const maximumCharacters = Math.max(5, Math.floor(width / (fontSize * 0.54)));
  const lines: string[] = [];
  let current = '';
  for (const word of value.replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maximumCharacters || !current) current = candidate;
    else {
      lines.push(current);
      current = word;
    }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (lines.join(' ').length < value.trim().length && lines.length)
    lines[lines.length - 1] = `${lines.at(-1)}…`;
  return lines
    .slice(0, maxLines)
    .map(
      (line, index) =>
        `<text x="${x}" y="${y + index * lineHeight}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${weight}" fill="${fill}">${svgText(line)}</text>`,
    )
    .join('');
}

async function sceneArtwork(
  context: SceneAdapterContext,
  width: number,
  height: number,
): Promise<Buffer> {
  const step = context.scene.steps.find(
    (candidate) => !candidate.hidden && candidate.visibility.launchMedia,
  );
  const rendered = step ? await renderPresentation(context, step, 'launch') : undefined;
  const paper = sceneColor(context.scene, 'paper', '#f4f5f6');
  const ink = sceneColor(context.scene, 'ink', '#1c1d1f');
  const muted = sceneColor(context.scene, 'muted', '#5f646b');
  const square = height / width > 0.82;
  const margin = Math.round(width * 0.065);
  const screenshotBox = square
    ? {
        x: margin,
        y: Math.round(height * 0.51),
        width: width - margin * 2,
        height: Math.round(height * 0.41),
      }
    : {
        x: Math.round(width * 0.53),
        y: Math.round(height * 0.15),
        width: Math.round(width * 0.41),
        height: Math.round(height * 0.7),
      };
  const screenshot = rendered
    ? await sharp(rendered.buffer)
        .resize({
          width: screenshotBox.width,
          height: screenshotBox.height,
          fit: 'contain',
          background: ink,
        })
        .png()
        .toBuffer()
    : undefined;
  const titleX = margin;
  const titleY = square ? Math.round(height * 0.2) : Math.round(height * 0.35);
  const copyWidth = square ? width - margin * 2 : Math.round(width * 0.39);
  const titleSize = square ? Math.round(width * 0.065) : Math.round(width * 0.052);
  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${paper}"/><text x="${margin}" y="${Math.round(height * 0.108)}" fill="${ink}" font-family="Arial,sans-serif" font-size="${Math.round(width * 0.017)}" font-weight="700">Scenebook</text>${svgWrappedText(context.scene.title, titleX, titleY, copyWidth, titleSize, Math.round(titleSize * 1.02), square ? 3 : 4, ink, 800, 'Georgia,serif')}${svgWrappedText(context.scene.description ?? 'Interactive walkthrough', titleX, square ? Math.round(height * 0.41) : Math.round(height * 0.68), copyWidth, Math.round(width * 0.02), Math.round(width * 0.028), square ? 2 : 3, muted, 400)}<rect x="${screenshotBox.x}" y="${screenshotBox.y}" width="${screenshotBox.width}" height="${screenshotBox.height}" rx="18" fill="${ink}"/></svg>`,
  );
  return sharp({ create: { width, height, channels: 4, background: paper } })
    .composite(
      screenshot
        ? [{ input: overlay }, { input: screenshot, left: screenshotBox.x, top: screenshotBox.y }]
        : [{ input: overlay }],
    )
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
}

export const interactiveHtmlAdapter: SceneOutputAdapter = {
  format: 'standalone-html',
  async render(context) {
    const path = `standalone/${context.scene.slug}.html`;
    return [
      await writeOutputFile(
        context.outputDirectory,
        path,
        await interactiveDocument(
          context,
          'standalone',
          async (assetPath) =>
            `data:image/png;base64,${(await readFile(`${context.outputDirectory}/${assetPath}`)).toString('base64')}`,
        ),
      ),
    ];
  },
};

export const webComponentAdapter: SceneOutputAdapter = {
  format: 'web-component',
  async render(context) {
    const path = `components/${context.scene.slug}.js`;
    const steps = await publishedSteps(context, 'component', (assetPath) =>
      relativeAsset(path, assetPath),
    );
    const payload = viewerScene(context, steps);
    const source = `
import { ScenebookPlayerElement, registerScenebookPlayer } from '@scenebook/viewer';
const scene=${scriptJson(payload)};
const resolveModuleUrl=value=>{
  if(!value||/^(?:[a-z][a-z0-9+.-]*:|#)/iu.test(value)||value.startsWith('/'))return value;
  return new URL(value,import.meta.url).href;
};
for(const step of scene.steps){
  step.image=resolveModuleUrl(step.image);
  if(step.secondaryImage)step.secondaryImage=resolveModuleUrl(step.secondaryImage);
  for(const choice of step.choices??[])choice.href=resolveModuleUrl(choice.href);
  for(const cta of step.ctas??[])if(cta.href)cta.href=resolveModuleUrl(cta.href);
}
class ScenebookPlayer extends ScenebookPlayerElement{
  connectedCallback(){super.connectedCallback();if(!this.scene)this.scene=scene}
}
function mountScenebookPlayer(element){element.scene=scene;return element}
function mountDocumentPlayers(){
  for(const element of document.querySelectorAll('scenebook-player')){
    const requested=element.getAttribute('data-scene');
    if((!requested||requested===scene.id)&&!element.scene)mountScenebookPlayer(element);
  }
}
registerScenebookPlayer();
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountDocumentPlayers,{once:true});
else mountDocumentPlayers();
export{ScenebookPlayer,mountScenebookPlayer,scene};
`;
    const module = await bundleViewerRuntime(source, 'esm');
    return [await writeOutputFile(context.outputDirectory, path, module)];
  },
};

export const iframeAdapter: SceneOutputAdapter = {
  format: 'iframe',
  async render(context) {
    const path = `embeds/${context.scene.slug}.iframe.html`;
    const source = relativeAsset(path, `standalone/${context.scene.slug}.html`);
    return [
      await writeOutputFile(
        context.outputDirectory,
        path,
        `<!doctype html><html lang="${escapeHtml(context.scene.locale)}" dir="${localeDirection(context.scene.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(context.scene.title)} embed</title><style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe id="scenebook-frame" title="${escapeHtml(context.scene.title)}" loading="lazy" allow="fullscreen"></iframe><script>
(()=>{
  const frame=document.getElementById('scenebook-frame');
  const source=${scriptJson(source)};
  const allowed=new Set(['scenebook:ready','scenebook:stepchange','scenebook:branch','scenebook:cta','scenebook:complete']);
  const parentOrigin=(()=>{try{const origin=new URL(document.referrer).origin;return origin==='null'?null:origin}catch{return null}})();
  const bridgeDetail=(name,detail)=>{
    if(name!=='scenebook:cta')return detail;
    const {fields:_fields,webhookId:_webhookId,submissionId:_submissionId,cta:rawCta,...state}=detail;
    const safeCta=rawCta&&typeof rawCta==='object'?{kind:rawCta.kind,label:rawCta.label}:null;
    return {...state,...(safeCta?{cta:safeCta}:{})};
  };
  window.addEventListener('message',event=>{
    if(event.source!==frame.contentWindow||event.origin!==location.origin)return;
    const message=event.data;
    if(!message||message.source!=='scenebook'||!allowed.has(message.type)||typeof message.detail!=='object'||message.detail===null)return;
    const safeMessage={...message,detail:bridgeDetail(message.type,message.detail)};
    frame.dispatchEvent(new CustomEvent(safeMessage.type,{bubbles:true,composed:true,detail:safeMessage.detail}));
    if(window.parent!==window&&parentOrigin)window.parent.postMessage(safeMessage,parentOrigin);
  });
  frame.src=source;
})();
</script></body></html>`,
      ),
    ];
  },
};

export const markdownAdapter: SceneOutputAdapter = {
  format: 'markdown',
  async render(context) {
    const path = `scenes/${context.scene.slug}/guide.md`;
    return [
      await writeOutputFile(
        context.outputDirectory,
        path,
        await guideMarkdown(context, path, false),
      ),
    ];
  },
};
export const mdxAdapter: SceneOutputAdapter = {
  format: 'mdx',
  async render(context) {
    const path = `scenes/${context.scene.slug}/guide.mdx`;
    return [
      await writeOutputFile(
        context.outputDirectory,
        path,
        await guideMarkdown(context, path, true),
      ),
    ];
  },
};
export const guideHtmlAdapter: SceneOutputAdapter = {
  format: 'html-guide',
  async render(context) {
    const path = `scenes/${context.scene.slug}/guide.html`;
    return [await writeOutputFile(context.outputDirectory, path, await guideDocument(context))];
  },
};

export async function renderEvidence(context: SceneAdapterContext): Promise<string> {
  const path = `scenes/${context.scene.slug}/evidence.json`;
  const stepAssets = new Map<string, string>();
  for (const step of context.scene.steps) {
    if (!step.hidden && Object.values(step.visibility).some(Boolean))
      stepAssets.set(step.id, await presentationAsset(context, step, 'guide'));
  }
  const scene = {
    ...context.scene,
    steps: context.scene.steps.map((step) => {
      const {
        imageReference: _imageReference,
        imageWidth: _imageWidth,
        imageHeight: _imageHeight,
        secondaryImageReference: _secondaryImageReference,
        secondaryImageWidth: _secondaryImageWidth,
        secondaryImageHeight: _secondaryImageHeight,
        ...safeStep
      } = step;
      const derivative = stepAssets.get(step.id);
      return { ...safeStep, ...(derivative ? { imageReference: derivative } : {}) };
    }),
  };
  const assets = [...context.publishedAssets.values()].map(
    ({ hash, mediaType, bytes, sourceStepIds, requiresOcr }) => ({
      hash,
      mediaType,
      bytes,
      sourceStepIds,
      privacyBasis: requiresOcr ? 'ocr' : 'structured',
    }),
  );
  const evidence = {
    format: 'scenebook-evidence',
    version: 1,
    generatedAt: context.generatedAt,
    publication: context.publication,
    scene,
    assets: assets.sort((a, b) => a.hash.localeCompare(b.hash)),
    provenance: {
      manifest: basename(context.loaded.manifestPath),
      assetKind: 'sanitized-publication-derivative',
    },
    revisions: {
      ...(context.loaded.narrative ? { narrative: sha256(context.loaded.narrative) } : {}),
      ...(context.loaded.theme ? { theme: sha256(stableStringify(context.loaded.theme)) } : {}),
      locales: Object.fromEntries(
        Object.entries(context.loaded.locales)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([locale, value]) => [locale, sha256(stableStringify(value))]),
      ),
    },
    privacy: {
      status: context.privacy.status,
      scanner: context.privacy.scanner,
      overridden: context.privacy.overridden,
      findings: context.privacy.findings,
    },
  };
  return writeOutputFile(context.outputDirectory, path, canonicalJson(evidence));
}

export const readmeAdapter: SceneOutputAdapter = {
  format: 'readme-card',
  async render(context) {
    const path = `scenes/${context.scene.slug}/README.md`;
    const pagePath = `standalone/${context.scene.slug}.html`;
    const imagePath = `social/${context.scene.slug}-og.png`;
    const page =
      absolutePublicationUrl(context.publication.distribution, pagePath) ??
      relativeAsset(path, pagePath);
    const image =
      absolutePublicationUrl(context.publication.distribution, imagePath) ??
      relativeAsset(path, imagePath);
    return [
      await writeOutputFile(
        context.outputDirectory,
        path,
        `## ${escapeMarkdown(context.scene.title)}\n\n[![${escapeMarkdown(context.scene.title)}](${image})](${page})\n\n[Open the interactive walkthrough](${page})${context.publication.distribution.attribution ? ' · Made with Scenebook.' : '.'}\n`,
      ),
    ];
  },
};
export const ogAdapter: SceneOutputAdapter = {
  format: 'og-image',
  async render(context) {
    const path = `social/${context.scene.slug}-og.png`;
    const artwork = await sceneArtwork(context, 1200, 630);
    const sourceStepId = context.scene.steps.find(
      (step) => !step.hidden && step.visibility.launchMedia,
    )?.id;
    if (sourceStepId)
      await context.putAsset(artwork, {
        extension: '.png',
        mediaType: 'image/png',
        sourceStepId,
        requiresOcr: Boolean(
          context.scene.steps.find((step) => step.id === sourceStepId)?.imageReference,
        ),
      });
    return [await writeOutputFile(context.outputDirectory, path, artwork)];
  },
};
export const socialAdapter: SceneOutputAdapter = {
  format: 'social-carousel',
  async render(context) {
    const square = `social/${context.scene.slug}-square.png`;
    const landscape = `social/${context.scene.slug}-landscape.png`;
    const squareArtwork = await sceneArtwork(context, 1080, 1080);
    const landscapeArtwork = await sceneArtwork(context, 1200, 675);
    const sourceStepId = context.scene.steps.find(
      (step) => !step.hidden && step.visibility.launchMedia,
    )?.id;
    if (sourceStepId) {
      await context.putAsset(squareArtwork, {
        extension: '.png',
        mediaType: 'image/png',
        sourceStepId,
        requiresOcr: Boolean(
          context.scene.steps.find((step) => step.id === sourceStepId)?.imageReference,
        ),
      });
      await context.putAsset(landscapeArtwork, {
        extension: '.png',
        mediaType: 'image/png',
        sourceStepId,
        requiresOcr: Boolean(
          context.scene.steps.find((step) => step.id === sourceStepId)?.imageReference,
        ),
      });
    }
    return [
      await writeOutputFile(context.outputDirectory, square, squareArtwork),
      await writeOutputFile(context.outputDirectory, landscape, landscapeArtwork),
    ];
  },
};
export const pdfAdapter: SceneOutputAdapter = {
  format: 'pdf',
  async render(context) {
    const path = `exports/${context.scene.slug}.pdf`;
    return [await writeOutputFile(context.outputDirectory, path, await pdfGuide(context))];
  },
};

export async function renderCatalogIndex(
  outputDirectory: string,
  publication: PublicationPlan,
  scenes: readonly NormalizedScene[],
  thumbnails: ReadonlyMap<string, string>,
  formats: SceneAdapterContext['formats'],
): Promise<string> {
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const remixEnabled = publication.distribution.remix && formats.includes('remix-source');
  const groups = publication.groups
    .map((group) => {
      const cards = group.entries
        .map((entry) => {
          const scene = sceneById.get(entry.sceneId);
          if (!scene) {
            throw new Error(`Catalog group ${group.id} references missing Scene ${entry.sceneId}.`);
          }
          const title = entry.title ?? scene.title;
          const description = entry.description ?? scene.description;
          const asset = thumbnails.get(scene.id);
          const image = asset
            ? `<img src="${escapeHtml(asset)}" alt="" loading="lazy">`
            : '<div style="aspect-ratio:16/9;background:#171512"></div>';
          const page = publicArtifactUrl(
            publication.distribution,
            `scenes/${scene.slug}/index.html`,
          );
          const remix = publicArtifactUrl(
            publication.distribution,
            `remix/${scene.slug}.scene.zip`,
          );
          const capability = capabilityPresentation(scene.capability);
          const actions = remixEnabled
            ? `<div class="card-actions"><a class="remix-link" href="${escapeHtml(remix)}" download>Download editable Scene</a></div>`
            : '';
          return `<article class="card" lang="${escapeHtml(scene.locale)}" dir="${localeDirection(scene.locale)}" data-search="${escapeHtml(`${title} ${description ?? ''} ${scene.tags.join(' ')}`.toLowerCase())}"><a class="card-link" href="${escapeHtml(page)}">${image}<div class="card-copy"><span class="status ${capability.className}">${capability.label}</span><h2>${escapeHtml(title)}</h2>${description ? `<p class="muted">${escapeHtml(description)}</p>` : ''}<small>${scene.steps.filter((step) => !step.hidden && step.visibility.interactive).length} steps · ${escapeHtml(scene.locale.toUpperCase())} locale</small></div></a>${actions}</article>`;
        })
        .join('');
      if (!cards) return '';
      return `<section class="catalog-group" data-catalog-group id="collection-${escapeHtml(group.slug)}"><h2>${escapeHtml(group.title)}</h2>${group.description ? `<p class="muted">${escapeHtml(group.description)}</p>` : ''}<div class="cards">${cards}</div></section>`;
    })
    .join('');
  const contextLabel =
    publication.selection.mode === 'channel' || publication.selection.mode === 'channel-collection'
      ? 'Scenebook channel'
      : publication.selection.mode === 'collection'
        ? 'Scenebook collection'
        : 'Scenebook catalog';
  const description =
    publication.distribution.seo.description ??
    publication.description ??
    'Browse product walkthroughs.';
  const title = publication.distribution.seo.title ?? publication.title;
  const canonical = absolutePublicationUrl(publication.distribution, '');
  const firstScene = publication.groups
    .flatMap((group) => group.entries)
    .map((entry) => sceneById.get(entry.sceneId))
    .find(Boolean);
  const socialImage =
    firstScene && formats.includes('og-image')
      ? absolutePublicationUrl(publication.distribution, `social/${firstScene.slug}-og.png`)
      : undefined;
  const structured = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: title,
    description,
    itemListElement: publication.groups
      .flatMap((group) =>
        group.entries.flatMap((entry) => {
          const scene = sceneById.get(entry.sceneId);
          if (!scene) return [];
          const url = absolutePublicationUrl(
            publication.distribution,
            `scenes/${scene.slug}/index.html`,
          );
          return [
            {
              '@type': 'ListItem',
              position: 0,
              name: entry.title ?? scene.title,
              ...(url ? { url } : {}),
            },
          ];
        }),
      )
      .map((item, index) => ({ ...item, position: index + 1 })),
  };
  const attributionFooter = publication.distribution.attribution
    ? '<footer class="attribution catalog-footer"><span>Made with Scenebook</span></footer>'
    : '';
  return writeOutputFile(
    outputDirectory,
    'index.html',
    `<!doctype html><html lang="${escapeHtml(publication.locale ?? 'en')}" dir="${localeDirection(publication.locale ?? 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><meta name="robots" content="${robotsDirective(publication.distribution)}"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}">${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:url" content="${escapeHtml(canonical)}">` : ''}${socialImage ? `<meta property="og:image" content="${escapeHtml(socialImage)}"><meta property="og:image:alt" content="${escapeHtml(`${title} preview`)}">` : ''}<meta name="twitter:card" content="${socialImage ? 'summary_large_image' : 'summary'}"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}">${socialImage ? `<meta name="twitter:image" content="${escapeHtml(socialImage)}">` : ''}<script type="application/ld+json">${scriptJson(structured)}</script><style>${BASE_STYLES}</style></head><body><main class="shell"><p class="context">${contextLabel}</p><h1>${escapeHtml(publication.title)}</h1><p class="muted">${escapeHtml(description)}</p><div class="search-wrap"><label for="search">Search walkthroughs</label><input class="search" id="search" type="search" autocomplete="off" placeholder="Search by title or tag" aria-describedby="search-status"></div><p id="search-status" class="sr-only" aria-live="polite"></p><div id="search-empty" class="empty-search" hidden><p id="search-empty-text"></p><button id="clear-search" type="button">Clear search</button></div>${groups}${attributionFooter}</main><script>const input=document.getElementById('search'),status=document.getElementById('search-status'),empty=document.getElementById('search-empty'),emptyText=document.getElementById('search-empty-text'),clear=document.getElementById('clear-search');const update=()=>{const raw=input.value.trim(),query=raw.toLowerCase();let visible=0;document.querySelectorAll('[data-search]').forEach(card=>{card.hidden=!card.dataset.search.includes(query);if(!card.hidden)visible+=1});document.querySelectorAll('[data-catalog-group]').forEach(group=>group.hidden=![...group.querySelectorAll('[data-search]')].some(card=>!card.hidden));empty.hidden=visible!==0;emptyText.textContent=raw?'No walkthroughs match “'+raw+'”.':'No walkthroughs are available.';clear.hidden=!raw;status.textContent=visible+' walkthrough'+(visible===1?'':'s')+' shown'};input.addEventListener('input',update);clear.addEventListener('click',()=>{input.value='';update();input.focus()});update()</script></body></html>`,
  );
}

export async function renderCatalogScene(context: SceneAdapterContext): Promise<string> {
  const path = `scenes/${context.scene.slug}/index.html`;
  return writeOutputFile(
    context.outputDirectory,
    path,
    await interactiveDocument(context, 'catalog', (assetPath) => relativeAsset(path, assetPath)),
  );
}
