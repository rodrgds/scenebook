import { describe, expect, it } from 'vitest';

import {
  ApprovalAttestationSchema,
  ARTIFACT_VERSION,
  SCHEMA_VERSION,
  ScenebookConfigSchema,
} from '../src/index.js';

const HASH = 'a'.repeat(64);
const NOW = '2026-07-21T10:00:00.000Z';

function approval(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    artifactVersion: ARTIFACT_VERSION,
    id: 'approval-test',
    projectId: 'project',
    createdAt: NOW,
    producer: { name: '@scenebook/cli', version: '0.1.0' },
    kind: 'approval-attestation',
    scope: 'release',
    decision: 'approved',
    subject: { kind: 'publication-candidate', id: 'candidate-test', revision: HASH },
    actorId: 'reviewer',
    ...overrides,
  };
}

describe('local publication schemas', () => {
  it('requires approvals to bind the correct immutable subject class', () => {
    expect(ApprovalAttestationSchema.parse(approval()).subject.revision).toBe(HASH);
    expect(() =>
      ApprovalAttestationSchema.parse(
        approval({
          scope: 'visual',
          subject: { kind: 'publication-candidate', id: 'candidate-test', revision: HASH },
          sceneId: 'scene',
          runTargetId: 'target',
        }),
      ),
    ).toThrow('Visual approval must bind an exact Baseline revision');
  });

  it('keeps privacy overrides separate and requires an auditable reason', () => {
    expect(() =>
      ApprovalAttestationSchema.parse(
        approval({
          scope: 'privacy-override',
          subject: { kind: 'baseline', id: 'baseline-test', revision: HASH },
          reason: 'short',
        }),
      ),
    ).toThrow('Privacy override requires a meaningful reason');
  });

  it('prevents mutable output from overlapping immutable publication storage', () => {
    expect(() =>
      ScenebookConfigSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        project: {
          schemaVersion: SCHEMA_VERSION,
          id: 'project',
          name: 'Project',
          slug: 'project',
        },
        paths: {
          output: '.scenebook',
          cache: 'cache',
          baselines: 'baselines',
          publication: '.scenebook/publication',
        },
      }),
    ).toThrow('output and publication paths must not overlap');
  });
});
