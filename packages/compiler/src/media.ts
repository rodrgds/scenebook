import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import sharp from 'sharp';
import { escapeHtml, writeOutputFile } from './io.js';
import { renderPresentation } from './presentation.js';
import type {
  CompilerToolchain,
  NormalizedStep,
  SceneAdapterContext,
  SceneOutputAdapter,
} from './types.js';

const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;
export const MAX_MOTION_DURATION_MS = 300_000;
export const MAX_MOTION_FRAMES = 2_400;
export const MAX_MOTION_FRAME_BYTES = 512 * 1024 * 1024;
export const MAX_MOTION_OUTPUT_BYTES = 256 * 1024 * 1024;
export const FFMPEG_TIMEOUT_MS = 300_000;
export const FFMPEG_PATH_ENV = 'SCENEBOOK_FFMPEG_PATH';
export const FFMPEG_EXPECTED_SHA256_ENV = 'SCENEBOOK_FFMPEG_EXPECTED_SHA256';
export const MAX_FFMPEG_BINARY_BYTES = 512 * 1024 * 1024;
const MAX_FFMPEG_VERSION_OUTPUT_BYTES = 64 * 1024;
const FFMPEG_PROBE_TIMEOUT_MS = 10_000;

export interface FfmpegToolchainBinding {
  /** Execution-only local path. This value must never enter publication output. */
  readonly executable: string;
  readonly manifest: CompilerToolchain;
}

function executableFile(path: string): string | null {
  try {
    const resolved = realpathSync(path);
    if (!statSync(resolved).isFile()) return null;
    accessSync(resolved, constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

export function ffmpegExecutable(environment: NodeJS.ProcessEnv = process.env): string | null {
  if (Object.hasOwn(environment, FFMPEG_PATH_ENV)) {
    const configured = environment[FFMPEG_PATH_ENV]?.trim() ?? '';
    if (!configured) {
      throw new Error(`${FFMPEG_PATH_ENV} is set but empty.`);
    }
    if (!isAbsolute(configured)) {
      throw new Error(
        `${FFMPEG_PATH_ENV} must be an absolute path to an executable ffmpeg binary; received ${JSON.stringify(configured)}.`,
      );
    }
    const executable = executableFile(configured);
    if (!executable) {
      throw new Error(
        `${FFMPEG_PATH_ENV} does not point to a regular executable file: ${configured}.`,
      );
    }
    return executable;
  }

  const executableName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  for (const directory of (environment.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const executable = executableFile(resolve(directory, executableName));
    if (executable) return executable;
  }
  return null;
}

function missingFfmpegError(): Error {
  return new Error(
    `FFmpeg is required for GIF, WebM, and MP4 exports. Install an ffmpeg executable on PATH or set ${FFMPEG_PATH_ENV} to its absolute path. Scenebook does not download an encoder automatically.`,
  );
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function boundedExecutableSha256(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('The resolved FFmpeg executable is not a regular file.');
    if (before.size > MAX_FFMPEG_BINARY_BYTES) {
      throw new Error(
        `The FFmpeg executable is ${before.size} bytes, exceeding the ${MAX_FFMPEG_BINARY_BYTES}-byte provenance limit.`,
      );
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - offset),
        offset,
      );
      if (bytesRead === 0) throw new Error('The FFmpeg executable changed while hashing.');
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    if ((await handle.read(probe, 0, 1, offset)).bytesRead !== 0) {
      throw new Error('The FFmpeg executable changed while hashing.');
    }
    const after = await handle.stat();
    const current = statSync(path);
    if (!sameFileIdentity(before, after) || !sameFileIdentity(after, current)) {
      throw new Error('The FFmpeg executable changed while hashing.');
    }
    return digest.digest('hex');
  } finally {
    await handle.close();
  }
}

async function ffmpegVersionOutput(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-version'], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value ?? '');
    };
    const append = (target: Buffer[], chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_FFMPEG_VERSION_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(
          new Error(
            `FFmpeg version output exceeds the ${MAX_FFMPEG_VERSION_OUTPUT_BYTES}-byte limit.`,
          ),
        );
        return;
      }
      target.push(bytes);
    };
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
    child.once('error', (error) =>
      finish(new Error(`Unable to inspect the configured FFmpeg executable: ${error.message}`)),
    );
    child.once('close', (code, signal) => {
      if (code !== 0) {
        finish(
          new Error(`FFmpeg provenance inspection failed (${signal ?? `exit ${String(code)}`}).`),
        );
        return;
      }
      const normalize = (chunks: readonly Buffer[]): string =>
        Buffer.concat(chunks)
          .toString('utf8')
          .replaceAll('\r\n', '\n')
          .replaceAll('\r', '\n')
          .trimEnd();
      const output = [normalize(stdout), normalize(stderr)].filter(Boolean).join('\n');
      if (!output) {
        finish(new Error('FFmpeg provenance inspection returned no version output.'));
        return;
      }
      finish(undefined, output);
    });
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`FFmpeg provenance inspection exceeded ${FFMPEG_PROBE_TIMEOUT_MS}ms.`));
    }, FFMPEG_PROBE_TIMEOUT_MS);
    deadline.unref();
  });
}

function expectedFfmpegSha256(environment: NodeJS.ProcessEnv): string | undefined {
  if (!Object.hasOwn(environment, FFMPEG_EXPECTED_SHA256_ENV)) return undefined;
  const expected = environment[FFMPEG_EXPECTED_SHA256_ENV]?.trim().toLowerCase() ?? '';
  if (!/^[a-f0-9]{64}$/u.test(expected)) {
    throw new Error(`${FFMPEG_EXPECTED_SHA256_ENV} must be exactly 64 hexadecimal characters.`);
  }
  return expected;
}

async function inspectFfmpegToolchain(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<FfmpegToolchainBinding> {
  const binarySha256 = await boundedExecutableSha256(executable);
  const expected = expectedFfmpegSha256(environment);
  if (expected && expected !== binarySha256) {
    throw new Error(
      `${FFMPEG_EXPECTED_SHA256_ENV} does not match the configured FFmpeg executable (expected ${expected}, received ${binarySha256}).`,
    );
  }
  const output = await ffmpegVersionOutput(executable, environment);
  const version = /^ffmpeg version ([A-Za-z0-9][A-Za-z0-9.+:_~-]{0,119})(?:\s|$)/u.exec(
    output,
  )?.[1];
  if (!version) {
    throw new Error('Unable to extract a safe FFmpeg version token from `ffmpeg -version`.');
  }
  return {
    executable,
    manifest: {
      name: 'ffmpeg',
      binding: 'binary-and-version-output-sha256',
      binarySha256,
      versionOutputSha256: createHash('sha256').update(output).digest('hex'),
      version,
    },
  };
}

export async function resolveFfmpegToolchain(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<FfmpegToolchainBinding> {
  const executable = ffmpegExecutable(environment);
  if (!executable) throw missingFfmpegError();
  return inspectFfmpegToolchain(executable, environment);
}

export async function verifyFfmpegToolchain(
  binding: FfmpegToolchainBinding,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const current = await inspectFfmpegToolchain(binding.executable, environment);
  if (
    current.manifest.binarySha256 !== binding.manifest.binarySha256 ||
    current.manifest.versionOutputSha256 !== binding.manifest.versionOutputSha256 ||
    current.manifest.version !== binding.manifest.version
  ) {
    throw new Error('The FFmpeg toolchain changed during compilation; publication was aborted.');
  }
}

export function executeFfmpeg(
  arguments_: readonly string[],
  options: { readonly executable?: string; readonly timeoutMs?: number } = {},
): Promise<void> {
  const executable = options.executable ?? ffmpegExecutable();
  if (!executable) throw missingFfmpegError();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    };
    const timeoutMs = options.timeoutMs ?? FFMPEG_TIMEOUT_MS;
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`ffmpeg exceeded its ${timeoutMs}ms execution deadline.`));
    }, timeoutMs);
    deadline.unref();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-12_000);
    });
    child.once('error', (error) =>
      finish(
        new Error(`Unable to start ffmpeg at ${JSON.stringify(executable)}: ${error.message}`),
      ),
    );
    child.once('close', (code, signal) => {
      if (code === 0) finish();
      else
        finish(new Error(`ffmpeg failed (${signal ?? `exit ${String(code)}`}): ${stderr.trim()}`));
    });
  });
}

interface MotionSample {
  readonly timeMs?: number;
  readonly duration: number;
  readonly transitionProgress: number;
}

export interface MotionPlanEntry {
  readonly step: NormalizedStep;
  readonly samples: readonly MotionSample[];
}

export function planMotion(steps: readonly NormalizedStep[]): readonly MotionPlanEntry[] {
  const durationMs = steps.reduce((total, step) => total + step.durationMs, 0);
  if (durationMs > MAX_MOTION_DURATION_MS) {
    throw new Error(
      `Motion export duration ${durationMs}ms exceeds the ${MAX_MOTION_DURATION_MS}ms limit.`,
    );
  }
  let totalFrames = 0;
  return steps.map((step) => {
    const cursorAnimated = Boolean(
      step.cursor?.visible && (step.cursor.path.length > 1 || step.cursor.clickAtMs !== undefined),
    );
    const samples: MotionSample[] = [];
    const cursorFrameCount = cursorAnimated
      ? Math.max(1, Math.ceil((step.durationMs / 1000) * 12))
      : 0;
    const transitionMs = Math.min(500, step.durationMs);
    const transitionFrameCount =
      !cursorAnimated && step.transition !== 'none'
        ? Math.max(1, Math.ceil((transitionMs / 1000) * 12))
        : 0;
    const frameCount =
      cursorFrameCount || transitionFrameCount + (step.durationMs > transitionMs ? 1 : 0) || 1;
    totalFrames += frameCount;
    if (totalFrames > MAX_MOTION_FRAMES) {
      throw new Error(
        `Motion export requires ${totalFrames} frames, exceeding the ${MAX_MOTION_FRAMES}-frame limit.`,
      );
    }
    if (cursorAnimated) {
      for (let frameIndex = 0; frameIndex < cursorFrameCount; frameIndex += 1) {
        const timeMs = Math.min(
          step.durationMs,
          Math.round((frameIndex / Math.max(1, cursorFrameCount - 1)) * step.durationMs),
        );
        samples.push({
          timeMs,
          duration: step.durationMs / 1000 / cursorFrameCount,
          transitionProgress: step.transition === 'none' ? 1 : Math.min(1, timeMs / 500),
        });
      }
    } else if (step.transition !== 'none') {
      for (let frameIndex = 0; frameIndex < transitionFrameCount; frameIndex += 1) {
        samples.push({
          duration: transitionMs / 1000 / transitionFrameCount,
          transitionProgress: (frameIndex + 1) / transitionFrameCount,
        });
      }
      if (step.durationMs > transitionMs) {
        samples.push({
          duration: (step.durationMs - transitionMs) / 1000,
          transitionProgress: 1,
        });
      }
    } else samples.push({ duration: step.durationMs / 1000, transitionProgress: 1 });
    return { step, samples };
  });
}

export async function readMotionOutput(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new Error(`Motion encoder output is not a regular file: ${path}.`);
    if (metadata.size > MAX_MOTION_OUTPUT_BYTES) {
      throw new Error(
        `Motion encoder output is ${metadata.size} bytes, exceeding the ${MAX_MOTION_OUTPUT_BYTES}-byte limit.`,
      );
    }
    const output = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < output.length) {
      const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
      if (bytesRead === 0) throw new Error(`Motion encoder output changed while reading: ${path}.`);
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    if ((await handle.read(probe, 0, 1, offset)).bytesRead !== 0) {
      throw new Error(`Motion encoder output changed while reading: ${path}.`);
    }
    return output;
  } finally {
    await handle.close();
  }
}

function wrappedSvgText(value: string, y: number): string {
  const words = value.replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= 92 || !current) current = candidate;
    else {
      lines.push(current);
      current = word;
    }
    if (lines.length === 2) break;
  }
  if (lines.length < 2 && current) lines.push(current);
  return lines
    .slice(0, 2)
    .map(
      (line, index) =>
        `<text x="48" y="${y + index * 23}" font-family="Arial,sans-serif" font-size="18" fill="#706c64">${escapeHtml(line)}</text>`,
    )
    .join('');
}

async function renderFrame(
  context: SceneAdapterContext,
  step: NormalizedStep,
  timeMs?: number,
  transitionProgress = 1,
): Promise<Buffer> {
  const presentation = await renderPresentation(context, step, 'motion', { timeMs });
  const image = await sharp(presentation.buffer)
    .resize({
      width: FRAME_WIDTH - 96,
      height: FRAME_HEIGHT - 188,
      fit: 'contain',
      background: '#141310',
    })
    .png()
    .toBuffer();
  const metadata = await sharp(image).metadata();
  const title = escapeHtml(step.title);
  const caption = step.instruction ?? step.caption ?? '';
  const overlay = Buffer.from(
    `<svg width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f7f3ea"/><rect x="48" y="42" width="8" height="8" rx="4" fill="#eb4d2f"/><text x="68" y="52" font-family="monospace" font-weight="700" font-size="16" fill="#171512" letter-spacing="2">SCENEBOOK</text><text x="48" y="92" font-family="Arial,sans-serif" font-weight="700" font-size="30" fill="#171512">${title}</text>${wrappedSvgText(caption, 122)}<rect x="48" y="164" width="1184" height="508" rx="14" fill="#141310"/></svg>`,
  );
  const left = metadata.width ? Math.round((FRAME_WIDTH - metadata.width) / 2) : 0;
  const top = metadata.height ? 164 + Math.round((508 - metadata.height) / 2) : 0;
  const frame = await sharp({
    create: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 4, background: '#f7f3ea' },
  })
    .composite([{ input: overlay }, { input: image, left, top }])
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  const progress = Math.min(1, Math.max(0, transitionProgress));
  if (step.transition === 'none' || progress >= 1) return frame;
  if (step.transition === 'fade') {
    return sharp(frame)
      .composite([
        {
          input: {
            create: {
              width: FRAME_WIDTH,
              height: FRAME_HEIGHT,
              channels: 4,
              background: { r: 247, g: 243, b: 234, alpha: 1 - progress },
            },
          },
        },
      ])
      .png()
      .toBuffer();
  }
  if (step.transition === 'slide') {
    return sharp({
      create: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 4, background: '#f7f3ea' },
    })
      .composite([{ input: frame, left: Math.round((1 - progress) * 90), top: 0 }])
      .png()
      .toBuffer();
  }
  const scale = 0.94 + progress * 0.06;
  const width = Math.round(FRAME_WIDTH * scale);
  const height = Math.round(FRAME_HEIGHT * scale);
  const zoomed = await sharp(frame).resize(width, height).png().toBuffer();
  return sharp({
    create: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 4, background: '#f7f3ea' },
  })
    .composite([
      {
        input: zoomed,
        left: Math.round((FRAME_WIDTH - width) / 2),
        top: Math.round((FRAME_HEIGHT - height) / 2),
      },
    ])
    .png()
    .toBuffer();
}

function concatPath(path: string): string {
  return path.replaceAll("'", "'\\''");
}

async function renderMedia(
  context: SceneAdapterContext,
  format: 'gif' | 'webm' | 'mp4',
): Promise<string> {
  const visibleSteps = context.scene.steps.filter((step) => !step.hidden && step.visibility.motion);
  if (visibleSteps.length === 0)
    throw new Error(`Cannot render ${format}: Scene ${context.scene.id} has no visible steps.`);
  const plan = planMotion(visibleSteps);
  const temporary = await mkdtemp(join(tmpdir(), 'scenebook-media-'));
  try {
    const frames: string[] = [];
    const durations: number[] = [];
    let totalFrameBytes = 0;
    for (const { step, samples } of plan) {
      for (const sample of samples) {
        const frame = join(temporary, `${String(frames.length).padStart(5, '0')}.png`);
        const frameBytes = await renderFrame(
          context,
          step,
          sample.timeMs,
          sample.transitionProgress,
        );
        totalFrameBytes += frameBytes.byteLength;
        if (totalFrameBytes > MAX_MOTION_FRAME_BYTES) {
          throw new Error(
            `Motion frames exceed the ${MAX_MOTION_FRAME_BYTES}-byte aggregate limit.`,
          );
        }
        // Frames are encoder inputs derived from the already-masked presentation, not public
        // outputs. Keep them inside the private temporary directory so a motion export does not
        // permanently ship hundreds or thousands of otherwise unreferenced PNGs.
        await writeFile(frame, frameBytes, { mode: 0o600 });
        frames.push(frame);
        durations.push(sample.duration);
      }
    }
    const concat = frames
      .flatMap((frame, index) => [
        `file '${concatPath(frames[index] ?? '')}'`,
        `duration ${(durations[index] ?? 1 / 12).toFixed(6)}`,
      ])
      .concat(`file '${concatPath(frames.at(-1) ?? '')}'`)
      .join('\n');
    const concatFile = join(temporary, 'frames.txt');
    const encoded = join(temporary, `output.${format}`);
    await writeFile(concatFile, `${concat}\n`);

    const common = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatFile,
      '-an',
      '-map_metadata',
      '-1',
    ];
    if (format === 'gif') {
      await executeFfmpeg(
        [
          ...common,
          '-vf',
          'fps=15,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
          '-loop',
          '0',
          '-fs',
          String(MAX_MOTION_OUTPUT_BYTES),
          '-y',
          encoded,
        ],
        { executable: context.ffmpegExecutable },
      );
    } else if (format === 'webm') {
      await executeFfmpeg(
        [
          ...common,
          '-r',
          '30',
          '-c:v',
          'libvpx-vp9',
          '-pix_fmt',
          'yuv420p',
          '-crf',
          '30',
          '-b:v',
          '0',
          '-row-mt',
          '1',
          '-fflags',
          '+bitexact',
          '-fs',
          String(MAX_MOTION_OUTPUT_BYTES),
          '-y',
          encoded,
        ],
        { executable: context.ffmpegExecutable },
      );
    } else {
      await executeFfmpeg(
        [
          ...common,
          '-r',
          '30',
          '-c:v',
          'libx264',
          '-preset',
          'medium',
          '-crf',
          '20',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          '-fflags',
          '+bitexact',
          '-flags:v',
          '+bitexact',
          '-fs',
          String(MAX_MOTION_OUTPUT_BYTES),
          '-y',
          encoded,
        ],
        { executable: context.ffmpegExecutable },
      );
    }
    return writeOutputFile(
      context.outputDirectory,
      `exports/${context.scene.slug}.${format}`,
      await readMotionOutput(encoded),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function mediaAdapter(format: 'gif' | 'webm' | 'mp4'): SceneOutputAdapter {
  return {
    format,
    async render(context) {
      return [await renderMedia(context, format)];
    },
  };
}

export const gifAdapter = mediaAdapter('gif');
export const webmAdapter = mediaAdapter('webm');
export const mp4Adapter = mediaAdapter('mp4');
