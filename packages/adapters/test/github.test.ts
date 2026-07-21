import { describe, expect, it } from 'vitest';
import { buildGitHubCheckPayloads, buildGitHubSummary } from '../src/index.js';

describe('GitHub payload builders', () => {
  it('maps dimensions and severities to a deterministic failed Check payload', () => {
    const changes = [
      {
        dimension: 'privacy' as const,
        severity: 'blocked' as const,
        summary: 'Secret | remains visible',
        sceneId: 'invite',
        stepId: 'email',
        path: 'scenes/invite/scene.yaml',
        startLine: 42,
      },
    ];
    const [payload] = buildGitHubCheckPayloads({
      headSha: '0123456789abcdef0123456789abcdef01234567',
      changes,
    });
    expect(payload?.conclusion).toBe('failure');
    expect(payload?.output.annotations[0]).toMatchObject({
      annotation_level: 'failure',
      path: 'scenes/invite/scene.yaml',
      start_line: 42,
      end_line: 42,
    });
    expect(buildGitHubSummary(changes)).toContain('Secret \\| remains visible');
  });

  it('chunks annotations at the GitHub API limit without network side effects', () => {
    const changes = Array.from({ length: 101 }, (_, index) => ({
      dimension: 'visual' as const,
      severity: 'changed' as const,
      summary: `Pixel change ${index}`,
      sceneId: 'checkout',
      stepId: `step-${index}`,
    }));
    const payloads = buildGitHubCheckPayloads({ headSha: 'abcdef1', changes });
    expect(payloads.map((payload) => payload.output.annotations.length)).toEqual([50, 50, 1]);
    expect(payloads.every((payload) => payload.conclusion === 'neutral')).toBe(true);
  });

  it('returns a successful, annotation-free payload for a clean review', () => {
    const [payload] = buildGitHubCheckPayloads({ headSha: 'abcdef1', changes: [] });
    expect(payload?.conclusion).toBe('success');
    expect(payload?.output.annotations).toEqual([]);
  });
});
