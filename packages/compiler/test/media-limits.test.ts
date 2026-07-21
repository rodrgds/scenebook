import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_MOTION_OUTPUT_BYTES,
  FFMPEG_EXPECTED_SHA256_ENV,
  executeFfmpeg,
  ffmpegExecutable,
  planMotion,
  readMotionOutput,
  resolveFfmpegToolchain,
} from '../src/media.js';
import type { NormalizedStep } from '../src/types.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function step(id: string, durationMs: number, animated = false): NormalizedStep {
  return {
    id,
    kind: 'instruction',
    title: id,
    durationMs,
    annotations: [],
    masks: [],
    autoAdvance: false,
    transition: 'none',
    practiceMode: false,
    choices: [],
    ctas: [],
    hidden: false,
    visibility: { interactive: true, guide: true, motion: true, launchMedia: true },
    ...(animated
      ? {
          cursor: {
            visible: true,
            path: [
              { atMs: 0, point: { x: 0, y: 0 } },
              { atMs: durationMs, point: { x: 1, y: 1 } },
            ],
            style: 'default' as const,
          },
        }
      : {}),
  };
}

describe('motion resource limits', () => {
  it('rejects excessive authored duration before rendering', () => {
    expect(() =>
      planMotion([step('one', 120_000), step('two', 120_000), step('three', 120_000)]),
    ).toThrow('duration 360000ms exceeds');
  });

  it('rejects excessive animation frames before rendering', () => {
    expect(() => planMotion([step('one', 120_000, true), step('two', 120_000, true)])).toThrow(
      'exceeding the 2400-frame limit',
    );
  });

  it('kills an encoder process that exceeds its deadline', async () => {
    await expect(
      executeFfmpeg(['-e', 'setInterval(() => {}, 1000)'], {
        executable: process.execPath,
        timeoutMs: 50,
      }),
    ).rejects.toThrow('exceeded its 50ms execution deadline');
  });

  it('fails with actionable setup guidance instead of downloading an encoder', () => {
    const previousPath = process.env.PATH;
    const previousExplicitPath = process.env.SCENEBOOK_FFMPEG_PATH;
    process.env.PATH = '';
    delete process.env.SCENEBOOK_FFMPEG_PATH;
    try {
      expect(() => executeFfmpeg([])).toThrow(
        'Install an ffmpeg executable on PATH or set SCENEBOOK_FFMPEG_PATH',
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousExplicitPath === undefined) delete process.env.SCENEBOOK_FFMPEG_PATH;
      else process.env.SCENEBOOK_FFMPEG_PATH = previousExplicitPath;
    }
  });

  it.skipIf(process.platform === 'win32')(
    'resolves an explicit absolute executable before the system PATH',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'scenebook-ffmpeg-resolution-'));
      temporaryDirectories.push(directory);
      const explicit = join(directory, 'pinned-ffmpeg');
      const system = join(directory, 'ffmpeg');
      await Promise.all([
        writeFile(explicit, '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
        writeFile(system, '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
      ]);
      await Promise.all([chmod(explicit, 0o755), chmod(system, 0o755)]);

      expect(ffmpegExecutable({ SCENEBOOK_FFMPEG_PATH: explicit, PATH: directory })).toBe(
        realpathSync(explicit),
      );
      expect(ffmpegExecutable({ PATH: directory })).toBe(realpathSync(system));
    },
  );

  it('rejects empty, relative, missing, and non-file explicit encoder paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scenebook-ffmpeg-invalid-'));
    temporaryDirectories.push(directory);
    expect(() => ffmpegExecutable({ SCENEBOOK_FFMPEG_PATH: '' })).toThrow('set but empty');
    expect(() => ffmpegExecutable({ SCENEBOOK_FFMPEG_PATH: 'ffmpeg' })).toThrow(
      'must be an absolute path',
    );
    expect(() => ffmpegExecutable({ SCENEBOOK_FFMPEG_PATH: join(directory, 'missing') })).toThrow(
      'does not point to a regular executable file',
    );
    expect(() => ffmpegExecutable({ SCENEBOOK_FFMPEG_PATH: directory })).toThrow(
      'does not point to a regular executable file',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'records a path-free exact toolchain binding and enforces an operator-pinned digest',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'scenebook-ffmpeg-provenance-'));
      temporaryDirectories.push(directory);
      const executable = join(directory, 'reviewed-ffmpeg');
      const contents =
        '#!/bin/sh\nif [ "$1" = "-version" ]; then\n  printf "ffmpeg version 7.1.1-reviewed\\nconfiguration: --enable-libvpx\\nlibavcodec 61.19.100\\n"\n  exit 0\nfi\nexit 0\n';
      await writeFile(executable, contents, { mode: 0o755 });
      await chmod(executable, 0o755);
      const hash = createHash('sha256').update(contents).digest('hex');
      const binding = await resolveFfmpegToolchain({
        ...process.env,
        SCENEBOOK_FFMPEG_PATH: executable,
        [FFMPEG_EXPECTED_SHA256_ENV]: hash,
      });

      expect(binding.executable).toBe(realpathSync(executable));
      expect(binding.manifest).toEqual({
        name: 'ffmpeg',
        binding: 'binary-and-version-output-sha256',
        binarySha256: hash,
        versionOutputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        version: '7.1.1-reviewed',
      });
      expect(JSON.stringify(binding.manifest)).not.toContain(directory);

      await expect(
        resolveFfmpegToolchain({
          ...process.env,
          SCENEBOOK_FFMPEG_PATH: executable,
          [FFMPEG_EXPECTED_SHA256_ENV]: '0'.repeat(64),
        }),
      ).rejects.toThrow('does not match the configured FFmpeg executable');
      await expect(
        resolveFfmpegToolchain({
          ...process.env,
          SCENEBOOK_FFMPEG_PATH: executable,
          [FFMPEG_EXPECTED_SHA256_ENV]: '',
        }),
      ).rejects.toThrow('must be exactly 64 hexadecimal characters');
    },
  );

  it('rejects oversized sparse encoder output before allocating it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scenebook-media-limit-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'oversized.mp4');
    const handle = await open(path, 'w');
    await handle.truncate(MAX_MOTION_OUTPUT_BYTES + 1);
    await handle.close();
    await expect(readMotionOutput(path)).rejects.toThrow('exceeding the 268435456-byte limit');
  });
});
