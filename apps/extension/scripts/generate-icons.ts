import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dir, '..');
const source = await readFile(resolve(root, 'public/icon.svg'));

for (const size of [16, 32, 48, 128]) {
  const bytes = await sharp(source).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
  await writeFile(resolve(root, `public/icon-${size}.png`), bytes);
}
