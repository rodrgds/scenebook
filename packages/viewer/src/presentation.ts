import type { CropPresentation } from './types.js';

export interface PresentationPoint {
  readonly x: number;
  readonly y: number;
}

export interface PresentationRect extends PresentationPoint {
  readonly width: number;
  readonly height: number;
}

function finite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function safePresentationZoom(value: number | undefined): number {
  return clamp(finite(value, 1), 1, 10);
}

export function safePresentationPoint(
  point: { readonly x?: number; readonly y?: number } | undefined,
  fallback: PresentationPoint = { x: 0.5, y: 0.5 },
): PresentationPoint {
  return {
    x: clamp(finite(point?.x, fallback.x), 0, 1),
    y: clamp(finite(point?.y, fallback.y), 0, 1),
  };
}

export function safePresentationRect(
  rect:
    | {
        readonly x?: number;
        readonly y?: number;
        readonly width?: number;
        readonly height?: number;
      }
    | undefined,
): PresentationRect {
  const origin = safePresentationPoint(rect, { x: 0, y: 0 });
  const width = clamp(finite(rect?.width, 0), 0, 1 - origin.x);
  const height = clamp(finite(rect?.height, 0), 0, 1 - origin.y);
  return { ...origin, width, height };
}

/** Matches the compiler's focal zoom crop for Studio/browser preview geometry. */
export function effectiveCrop(crop: CropPresentation | undefined): PresentationRect {
  const zoom = safePresentationZoom(crop?.zoom);
  const width = 1 / zoom;
  const height = 1 / zoom;
  const focal = safePresentationPoint(crop);
  return {
    x: clamp(focal.x - width / 2, 0, 1 - width),
    y: clamp(focal.y - height / 2, 0, 1 - height),
    width,
    height,
  };
}

export function mapPointToCrop(
  point: { readonly x?: number; readonly y?: number } | undefined,
  crop: PresentationRect,
): PresentationPoint | undefined {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
  const source = safePresentationPoint(point);
  if (
    source.x < crop.x ||
    source.y < crop.y ||
    source.x > crop.x + crop.width ||
    source.y > crop.y + crop.height
  ) {
    return undefined;
  }
  return {
    x: clamp((source.x - crop.x) / crop.width, 0, 1),
    y: clamp((source.y - crop.y) / crop.height, 0, 1),
  };
}

export function mapRectToCrop(
  rect:
    | {
        readonly x?: number;
        readonly y?: number;
        readonly width?: number;
        readonly height?: number;
      }
    | undefined,
  crop: PresentationRect,
): PresentationRect | undefined {
  if (!rect) return undefined;
  const source = safePresentationRect(rect);
  const left = Math.max(source.x, crop.x);
  const top = Math.max(source.y, crop.y);
  const right = Math.min(source.x + source.width, crop.x + crop.width);
  const bottom = Math.min(source.y + source.height, crop.y + crop.height);
  if (right <= left || bottom <= top) return undefined;
  return {
    x: clamp((left - crop.x) / crop.width, 0, 1),
    y: clamp((top - crop.y) / crop.height, 0, 1),
    width: clamp((right - left) / crop.width, 0, 1),
    height: clamp((bottom - top) / crop.height, 0, 1),
  };
}
