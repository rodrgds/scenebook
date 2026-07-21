import { readFile } from 'node:fs/promises';
import { BuildArtifactSchema, type BuildArtifact } from '@scenebook/schema';
import { CliError } from './types.js';

export async function readCiBuildArtifact(path: string): Promise<BuildArtifact> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(
        `The Scenebook Playwright reporter did not produce a fresh build artifact at ${path}.`,
        2,
      );
    }
    throw error;
  }
  try {
    return BuildArtifactSchema.parse(JSON.parse(source));
  } catch (error) {
    throw new CliError(
      `The Scenebook Playwright reporter produced an invalid build artifact at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
}

export function ciSummary(build: BuildArtifact): string {
  return `## Scenebook\n\n- Status: **${build.status}**\n- Passed: ${build.summary.passed}\n- Changed: ${build.summary.changed}\n- Broken: ${build.summary.broken}\n- Blocked: ${build.summary.blocked}\n- Pending: ${build.summary.pending}\n`;
}

export function ciExitCode(build: BuildArtifact, runnerFailed = false): number {
  return build.status === 'passed' && !runnerFailed ? 0 : 2;
}
