import type { RgbaDiffMetrics } from './types.js';

export function hammingDistanceHex(left: string, right: string): number {
  if (!/^[a-f0-9]+$/iu.test(left) || !/^[a-f0-9]+$/iu.test(right) || left.length !== right.length) {
    throw new TypeError('Perceptual hashes must be equal-length hexadecimal strings');
  }
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = Number.parseInt(left[index] ?? '', 16);
    const rightValue = Number.parseInt(right[index] ?? '', 16);
    let bits = leftValue ^ rightValue;
    while (bits !== 0) {
      distance += bits & 1;
      bits >>>= 1;
    }
  }
  return distance;
}

export function compareRgbaImages(
  left: Uint8Array,
  right: Uint8Array,
  width: number,
  height: number,
  pixelThreshold = 0.1,
): RgbaDiffMetrics {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError('Image dimensions must be positive integers');
  }
  const expected = width * height * 4;
  if (left.byteLength !== expected || right.byteLength !== expected) {
    throw new RangeError(`Expected ${expected} RGBA bytes for each image`);
  }
  if (pixelThreshold < 0 || pixelThreshold > 1)
    throw new RangeError('pixelThreshold must be between 0 and 1');

  let changedPixels = 0;
  let deltaSum = 0;
  let maximumDelta = 0;
  const pixels = width * height;
  for (let offset = 0; offset < expected; offset += 4) {
    const red = Math.abs((left[offset] ?? 0) - (right[offset] ?? 0));
    const green = Math.abs((left[offset + 1] ?? 0) - (right[offset + 1] ?? 0));
    const blue = Math.abs((left[offset + 2] ?? 0) - (right[offset + 2] ?? 0));
    const alpha = Math.abs((left[offset + 3] ?? 0) - (right[offset + 3] ?? 0));
    const delta = Math.sqrt(red ** 2 + green ** 2 + blue ** 2 + alpha ** 2) / 510;
    deltaSum += delta;
    maximumDelta = Math.max(maximumDelta, delta);
    if (delta > pixelThreshold) changedPixels += 1;
  }
  return {
    changedPixels,
    changedRatio: changedPixels / pixels,
    meanDelta: deltaSum / pixels,
    maximumDelta,
  };
}
