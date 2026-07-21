import sharp from 'sharp';

export interface ScreenshotFingerprint {
  readonly width: number;
  readonly height: number;
  /** 64-bit decoded-pixel fingerprint: 48 edge bits plus 16 mean-color bits. */
  readonly perceptualHash: string;
}

export async function fingerprintScreenshot(bytes: Uint8Array): Promise<ScreenshotFingerprint> {
  const image = sharp(bytes, { failOn: 'error', limitInputPixels: 100_000_000 });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('Screenshot decoder did not return positive dimensions.');
  }
  const flattened = image.clone().flatten({ background: '#ffffff' });
  const [pixels, mean] = await Promise.all([
    flattened
      .clone()
      .greyscale()
      .resize(7, 8, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer(),
    flattened
      .clone()
      .removeAlpha()
      .resize(1, 1, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer(),
  ]);
  if (pixels.byteLength !== 56 || mean.byteLength !== 3) {
    throw new Error(
      `Screenshot fingerprint expected 56 luminance and 3 color samples, received ${pixels.byteLength} and ${mean.byteLength}.`,
    );
  }
  let edgeHash = 0n;
  let bit = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 6; x += 1) {
      if (pixels[y * 7 + x]! > pixels[y * 7 + x + 1]!) edgeHash |= 1n << bit;
      bit += 1n;
    }
  }
  const red = mean[0]!;
  const green = mean[1]!;
  const blue = mean[2]!;
  const luminance = Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue);
  const colorSignature =
    ((red >>> 4) << 12) | ((green >>> 4) << 8) | ((blue >>> 4) << 4) | (luminance >>> 4);
  const hash = (edgeHash << 16n) | BigInt(colorSignature);
  return {
    width: metadata.width,
    height: metadata.height,
    perceptualHash: hash.toString(16).padStart(16, '0'),
  };
}
