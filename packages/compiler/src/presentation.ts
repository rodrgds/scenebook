import sharp, { type OverlayOptions } from 'sharp';
import { escapeHtml } from './io.js';
import type {
  NormalizedPoint,
  NormalizedRect,
  NormalizedScene,
  NormalizedStep,
  SceneAdapterContext,
} from './types.js';

export type PresentationFamily = 'interactive' | 'guide' | 'motion' | 'launch';

export interface RenderedPresentation {
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly crop: NormalizedRect;
}

const cache = new WeakMap<SceneAdapterContext, Map<string, Promise<RenderedPresentation>>>();

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function color(scene: NormalizedScene, name: string, fallback: string): string {
  const value = scene.theme[`--${name}`] ?? scene.theme[name];
  if (
    value &&
    (/^#[a-f0-9]{3,8}$/iu.test(value) ||
      /^(?:rgb|hsl)a?\([\d\s,.%/-]+\)$/iu.test(value) ||
      /^[a-z]{3,20}$/iu.test(value))
  ) {
    return value;
  }
  return fallback;
}

export function effectiveCrop(step: NormalizedStep): NormalizedRect {
  const base = step.crop?.rect ?? { x: 0, y: 0, width: 1, height: 1 };
  const zoom = step.crop?.zoom ?? 1;
  if (zoom <= 1) return base;
  const width = base.width / zoom;
  const height = base.height / zoom;
  const focal = step.crop?.focalPoint ?? {
    x: base.x + base.width / 2,
    y: base.y + base.height / 2,
  };
  return {
    x: clamp(focal.x - width / 2, base.x, base.x + base.width - width),
    y: clamp(focal.y - height / 2, base.y, base.y + base.height - height),
    width,
    height,
  };
}

function intersect(rect: NormalizedRect, crop: NormalizedRect): NormalizedRect | undefined {
  const left = Math.max(rect.x, crop.x);
  const top = Math.max(rect.y, crop.y);
  const right = Math.min(rect.x + rect.width, crop.x + crop.width);
  const bottom = Math.min(rect.y + rect.height, crop.y + crop.height);
  if (right <= left || bottom <= top) return undefined;
  return {
    x: (left - crop.x) / crop.width,
    y: (top - crop.y) / crop.height,
    width: (right - left) / crop.width,
    height: (bottom - top) / crop.height,
  };
}

function mapPoint(point: NormalizedPoint, crop: NormalizedRect): NormalizedPoint | undefined {
  if (
    point.x < crop.x ||
    point.y < crop.y ||
    point.x > crop.x + crop.width ||
    point.y > crop.y + crop.height
  ) {
    return undefined;
  }
  return { x: (point.x - crop.x) / crop.width, y: (point.y - crop.y) / crop.height };
}

function frameInsets(step: NormalizedStep): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  if (!step.frame || step.frame.kind === 'none') return { top: 0, right: 0, bottom: 0, left: 0 };
  if (step.frame.kind === 'device') return { top: 20, right: 20, bottom: 20, left: 20 };
  return { top: step.frame.showAddressBar ? 42 : 26, right: 2, bottom: 2, left: 2 };
}

export function mapPresentationRect(
  step: NormalizedStep,
  rect: NormalizedRect,
  contentWidth = 1,
  contentHeight = 1,
): NormalizedRect | undefined {
  const mapped = intersect(rect, effectiveCrop(step));
  if (!mapped) return undefined;
  const insets = frameInsets(step);
  const width = contentWidth + insets.left + insets.right;
  const height = contentHeight + insets.top + insets.bottom;
  return {
    x: (insets.left + mapped.x * contentWidth) / width,
    y: (insets.top + mapped.y * contentHeight) / height,
    width: (mapped.width * contentWidth) / width,
    height: (mapped.height * contentHeight) / height,
  };
}

export function cursorPointAt(step: NormalizedStep, timeMs?: number): NormalizedPoint | undefined {
  const cursor = step.cursor;
  if (!cursor?.visible) return undefined;
  const path = cursor.path;
  if (timeMs !== undefined && path.length > 0) {
    const after = path.findIndex((keyframe) => keyframe.atMs >= timeMs);
    if (after <= 0) return path[0]?.point;
    if (after < 0) return path.at(-1)?.point;
    const previous = path[after - 1];
    const next = path[after];
    if (!previous || !next) return previous?.point ?? next?.point;
    const distance = next.atMs - previous.atMs;
    const progress = distance <= 0 ? 1 : (timeMs - previous.atMs) / distance;
    return {
      x: previous.point.x + (next.point.x - previous.point.x) * progress,
      y: previous.point.y + (next.point.y - previous.point.y) * progress,
    };
  }
  return (
    cursor.position ??
    path.at(-1)?.point ??
    (step.target
      ? { x: step.target.x + step.target.width / 2, y: step.target.y + step.target.height / 2 }
      : undefined)
  );
}

function svgText(value: string, limit = 120): string {
  return escapeHtml(value.replace(/\s+/gu, ' ').trim().slice(0, limit));
}

function svgLines(
  value: string,
  options: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly maxLines: number;
    readonly fill: string;
    readonly weight?: number;
    readonly fontFamily?: string;
  },
): string {
  const words = value.replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean);
  const averageCharacterWidth = options.fontSize * 0.54;
  const maximumCharacters = Math.max(4, Math.floor(options.width / averageCharacterWidth));
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maximumCharacters || !current) current = candidate;
    else {
      lines.push(current);
      current = word;
    }
    if (lines.length === options.maxLines) break;
  }
  if (lines.length < options.maxLines && current) lines.push(current);
  const consumed = lines.join(' ').length;
  if (consumed < value.replace(/\s+/gu, ' ').trim().length && lines.length) {
    lines[lines.length - 1] = `${lines.at(-1)?.replace(/[.,;:!?]?$/u, '') ?? ''}\u2026`;
  }
  return lines
    .slice(0, options.maxLines)
    .map(
      (line, index) =>
        `<text x="${options.x}" y="${options.y + index * options.lineHeight}" font-family="${options.fontFamily ?? 'Arial,sans-serif'}" font-size="${options.fontSize}" font-weight="${options.weight ?? 400}" fill="${options.fill}">${svgText(line, 180)}</text>`,
    )
    .join('');
}

function overlaySvg(
  context: SceneAdapterContext,
  step: NormalizedStep,
  width: number,
  height: number,
  timeMs?: number,
): Buffer | undefined {
  const crop = effectiveCrop(step);
  const elements: string[] = [];
  const accent = color(context.scene, 'accent', '#eb4d2f');
  for (const annotation of step.annotations) {
    const annotationColor =
      annotation.color && /^#[a-f0-9]{3,8}$/iu.test(annotation.color) ? annotation.color : accent;
    if (annotation.rect) {
      const rect = intersect(annotation.rect, crop);
      if (!rect) continue;
      const x = rect.x * width;
      const y = rect.y * height;
      const w = rect.width * width;
      const h = rect.height * height;
      if (annotation.kind === 'spotlight') {
        elements.push(
          `<path d="M0 0H${width}V${height}H0Z M${x} ${y}H${x + w}V${y + h}H${x}Z" fill="#000" fill-opacity=".5" fill-rule="evenodd"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="none" stroke="${annotationColor}" stroke-width="4"/>`,
        );
      } else if (annotation.kind === 'hotspot') {
        elements.push(
          `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${Math.max(12, w / 2)}" ry="${Math.max(12, h / 2)}" fill="none" stroke="${annotationColor}" stroke-width="5"/><ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${Math.max(17, w / 2 + 5)}" ry="${Math.max(17, h / 2 + 5)}" fill="none" stroke="${annotationColor}" stroke-opacity=".35" stroke-width="7"/>`,
        );
      } else {
        elements.push(
          `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${annotation.kind === 'text' ? '#171512' : 'none'}" fill-opacity=".88" stroke="${annotationColor}" stroke-width="4"/>`,
        );
        const annotationText = annotation.text ?? annotation.label;
        if (annotationText) {
          elements.push(
            `<text x="${x + 12}" y="${y + Math.min(h - 10, 28)}" fill="${annotation.kind === 'text' ? '#fff' : annotationColor}" font-family="Arial,sans-serif" font-size="18" font-weight="700">${svgText(annotationText, 80)}</text>`,
          );
        }
      }
    }
    if (annotation.kind === 'arrow' && annotation.from && annotation.to) {
      const from = mapPoint(annotation.from, crop);
      const to = mapPoint(annotation.to, crop);
      if (from && to) {
        elements.push(
          `<defs><marker id="arrow-${escapeHtml(annotation.id)}" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto"><path d="M0 0L12 6L0 12Z" fill="${annotationColor}"/></marker></defs><line x1="${from.x * width}" y1="${from.y * height}" x2="${to.x * width}" y2="${to.y * height}" stroke="${annotationColor}" stroke-width="5" marker-end="url(#arrow-${escapeHtml(annotation.id)})"/>`,
        );
      }
    }
  }

  const cursor = cursorPointAt(step, timeMs);
  const mappedCursor = cursor ? mapPoint(cursor, crop) : undefined;
  if (mappedCursor) {
    const x = mappedCursor.x * width;
    const y = mappedCursor.y * height;
    if (step.cursor?.style === 'dot') {
      elements.push(
        `<circle cx="${x}" cy="${y}" r="9" fill="#fff" stroke="#171512" stroke-width="3"/>`,
      );
    } else {
      elements.push(
        `<path d="M${x} ${y}L${x + 3} ${y + 25}L${x + 10} ${y + 18}L${x + 16} ${y + 32}L${x + 22} ${y + 29}L${x + 16} ${y + 16}L${x + 27} ${y + 15}Z" fill="#fff" stroke="#171512" stroke-width="2" stroke-linejoin="round"/>`,
      );
    }
    if (
      step.cursor?.clickAtMs !== undefined &&
      timeMs !== undefined &&
      Math.abs(step.cursor.clickAtMs - timeMs) <= 120
    ) {
      elements.push(
        `<circle cx="${x}" cy="${y}" r="26" fill="none" stroke="${accent}" stroke-width="6" opacity=".8"/>`,
      );
    }
  }
  if (elements.length === 0) return undefined;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${elements.join('')}</svg>`,
  );
}

async function applyMasks(
  input: Buffer,
  step: NormalizedStep,
  width: number,
  height: number,
): Promise<Buffer> {
  const crop = effectiveCrop(step);
  const composites: OverlayOptions[] = [];
  for (const mask of step.masks) {
    const rect = intersect(mask.rect, crop);
    if (!rect) continue;
    const left = clamp(Math.floor(rect.x * width), 0, width - 1);
    const top = clamp(Math.floor(rect.y * height), 0, height - 1);
    const maskWidth = clamp(Math.ceil(rect.width * width), 1, width - left);
    const maskHeight = clamp(Math.ceil(rect.height * height), 1, height - top);
    if (mask.mode === 'blur') {
      const blurred = await sharp(input)
        .extract({ left, top, width: maskWidth, height: maskHeight })
        .blur(18)
        .png()
        .toBuffer();
      composites.push({ input: blurred, left, top });
    } else {
      composites.push({
        input: {
          create: { width: maskWidth, height: maskHeight, channels: 4, background: '#171512' },
        },
        left,
        top,
      });
    }
  }
  return composites.length ? sharp(input).composite(composites).png().toBuffer() : input;
}

function cardSvg(context: SceneAdapterContext, step: NormalizedStep): Buffer {
  const paper = color(context.scene, 'paper', '#f4f5f6');
  const ink = color(context.scene, 'ink', '#1c1d1f');
  const muted = color(context.scene, 'muted', '#5f646b');
  const label =
    step.kind === 'separator' ? 'Section' : step.kind === 'end' ? 'Complete' : step.kind;
  const copy = step.instruction ?? step.caption ?? '';
  const cta = step.cta;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="${paper}"/><text x="88" y="90" font-family="Arial,sans-serif" font-size="20" font-weight="700" fill="${ink}">${svgText(label, 30)}</text>${svgLines(step.title, { x: 88, y: 245, width: 1040, fontSize: 68, lineHeight: 72, maxLines: 3, fill: ink, weight: 800, fontFamily: 'Georgia,serif' })}${svgLines(copy, { x: 88, y: 495, width: 940, fontSize: 28, lineHeight: 39, maxLines: 3, fill: muted })}${cta ? `<rect x="88" y="610" width="${Math.min(420, Math.max(180, cta.label.length * 17 + 60))}" height="58" rx="10" fill="${ink}"/><text x="118" y="648" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="${paper}">${svgText(cta.label, 42)}</text>` : ''}</svg>`,
  );
}

async function render(
  context: SceneAdapterContext,
  step: NormalizedStep,
  family: PresentationFamily,
  timeMs?: number,
  secondary = false,
): Promise<RenderedPresentation> {
  const reference = secondary ? step.secondaryImageReference : step.imageReference;
  if (!reference) {
    const buffer = await sharp(cardSvg(context, step)).png().toBuffer();
    return {
      buffer,
      width: 1280,
      height: 720,
      contentWidth: 1280,
      contentHeight: 720,
      crop: { x: 0, y: 0, width: 1, height: 1 },
    };
  }
  const asset = context.loaded.assets.get(reference);
  if (!asset)
    throw new Error(
      `Scene ${context.scene.id} Step ${step.id} references missing asset ${reference}.`,
    );
  const metadata = await sharp(asset.sourcePath).metadata();
  if (!metadata.width || !metadata.height)
    throw new Error(`Cannot determine dimensions for ${reference}.`);
  const crop = effectiveCrop(step);
  const left = clamp(Math.floor(crop.x * metadata.width), 0, metadata.width - 1);
  const top = clamp(Math.floor(crop.y * metadata.height), 0, metadata.height - 1);
  const cropWidth = clamp(Math.ceil(crop.width * metadata.width), 1, metadata.width - left);
  const cropHeight = clamp(Math.ceil(crop.height * metadata.height), 1, metadata.height - top);
  let image: Buffer = await sharp(asset.sourcePath)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize({ width: 1600, height: 1000, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  const renderedMetadata = await sharp(image).metadata();
  const contentWidth = renderedMetadata.width ?? cropWidth;
  const contentHeight = renderedMetadata.height ?? cropHeight;
  image = await applyMasks(image, step, contentWidth, contentHeight);
  const overlay = overlaySvg(context, step, contentWidth, contentHeight, timeMs);
  if (overlay)
    image = await sharp(image)
      .composite([{ input: overlay }])
      .png()
      .toBuffer();

  const insets = frameInsets(step);
  if (insets.top || insets.right || insets.bottom || insets.left) {
    const paper = color(context.scene, 'paper', '#f7f3ea');
    image = await sharp(image)
      .extend({
        top: insets.top,
        right: insets.right,
        bottom: insets.bottom,
        left: insets.left,
        background: color(context.scene, 'ink', '#171512'),
      })
      .composite(
        step.frame?.kind === 'browser' && step.frame.showAddressBar
          ? [
              {
                input: Buffer.from(
                  `<svg width="${contentWidth + insets.left + insets.right}" height="${insets.top}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${paper}"/><circle cx="16" cy="20" r="5" fill="#eb4d2f"/><circle cx="33" cy="20" r="5" fill="#d0a215"/><circle cx="50" cy="20" r="5" fill="#2f7d57"/><text x="70" y="25" font-family="Arial,sans-serif" font-size="13" fill="#706c64">${svgText(step.frame.title ?? context.scene.title, 80)}</text></svg>`,
                ),
                left: 0,
                top: 0,
              },
            ]
          : [],
      )
      .png()
      .toBuffer();
  }
  const final = await sharp(image).metadata();
  return {
    buffer: image,
    width: final.width ?? contentWidth,
    height: final.height ?? contentHeight,
    contentWidth,
    contentHeight,
    crop,
  };
}

export function renderPresentation(
  context: SceneAdapterContext,
  step: NormalizedStep,
  family: PresentationFamily,
  options: { readonly timeMs?: number; readonly secondary?: boolean } = {},
): Promise<RenderedPresentation> {
  let contextCache = cache.get(context);
  if (!contextCache) {
    contextCache = new Map();
    cache.set(context, contextCache);
  }
  const key = `${step.id}:${family}:${options.timeMs ?? 'static'}:${options.secondary ? 'secondary' : 'primary'}`;
  const existing = contextCache.get(key);
  if (existing) return existing;
  const operation = render(context, step, family, options.timeMs, options.secondary ?? false);
  contextCache.set(key, operation);
  return operation;
}

export async function presentationAsset(
  context: SceneAdapterContext,
  step: NormalizedStep,
  family: PresentationFamily,
  options: { readonly secondary?: boolean } = {},
): Promise<string> {
  const rendered = await renderPresentation(context, step, family, options);
  return context.putAsset(rendered.buffer, {
    extension: '.png',
    mediaType: 'image/png',
    sourceStepId: step.id,
    requiresOcr: Boolean(options.secondary ? step.secondaryImageReference : step.imageReference),
  });
}

export function themeDeclarations(scene: NormalizedScene): string {
  const declarations: string[] = [];
  for (const [rawName, value] of Object.entries(scene.theme)) {
    const name = rawName.startsWith('--') ? rawName : `--${rawName}`;
    if (!/^--[a-z][a-z0-9-]{0,80}$/u.test(name)) continue;
    if (
      /[;{}<>\\@\u0000-\u001f\u007f]/u.test(value) ||
      /\/\*|\*\//u.test(value) ||
      /(?:url|expression|import|image-set|var|env)\s*\(/iu.test(value)
    ) {
      continue;
    }
    const safeColorFunction = /^(?:rgb|rgba|hsl|hsla)\([\d\s,.%+\-\/]+\)$/iu.test(value);
    if (/[()]/u.test(value) && !safeColorFunction) continue;
    if (!safeColorFunction && !/^[a-z0-9#\s.,%+\-/'"]+$/iu.test(value)) continue;
    declarations.push(`${name}:${value}`);
  }
  return declarations.join(';');
}
