import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT_VERSION, BuildArtifactSchema, SCHEMA_VERSION } from '@scenebook/schema';
import { ciExitCode, ciSummary, readCiBuildArtifact } from '../src/ci.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function changedBuild() {
  return BuildArtifactSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    artifactVersion: ARTIFACT_VERSION,
    id: 'build-test',
    projectId: 'project-test',
    kind: 'build',
    createdAt: '2026-07-20T00:00:00.000Z',
    producer: { name: '@scenebook/playwright', version: '0.1.0' },
    repository: {
      provider: 'generic',
      repository: 'example/scenebook',
      commit: '0123456789abcdef',
      dirty: false,
    },
    trigger: 'local',
    status: 'changed',
    expectedRunPlan: [{ sceneId: 'scene-test', runTargetId: 'target-test' }],
    runs: [],
    startedAt: '2026-07-20T00:00:00.000Z',
    endedAt: '2026-07-20T00:00:01.000Z',
    summary: { total: 1, passed: 0, changed: 1, broken: 0, blocked: 0, pending: 0 },
  });
}

describe('CI reporter artifact handling', () => {
  it('fails clearly when the reporter produced no fresh artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scenebook-ci-'));
    directories.push(directory);
    await expect(readCiBuildArtifact(join(directory, 'build.json'))).rejects.toThrow(
      'did not produce a fresh build artifact',
    );
  });

  it('reports changed runs and returns a failing CI exit', () => {
    const build = changedBuild();
    expect(ciSummary(build)).toContain('- Changed: 1');
    expect(ciExitCode(build)).toBe(2);
  });
});
