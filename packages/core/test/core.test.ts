import { describe, expect, it } from 'vitest';

import { CanonicalArtifactSchema, SceneSchema } from '@scenebook/schema';

import {
  InvariantError,
  artifactHash,
  assertPathInside,
  assertSceneGraph,
  assertSceneInvariants,
  canonicalize,
  canonicalJsonHash,
  collectAssetReferences,
  collectSceneLinks,
  createDeterministicId,
  revisionOf,
  sceneSourceRevision,
  sha256,
  slugify,
  stableStringify,
} from '../src/index.js';

const HASH = 'a'.repeat(64);

function scene() {
  return SceneSchema.parse({
    schemaVersion: 1,
    id: 'welcome',
    title: 'Welcome',
    slug: 'welcome',
    steps: [
      {
        id: 'welcome-step',
        kind: 'browser',
        title: 'Welcome',
        states: {
          before: {
            id: 'welcome-before',
            route: '/',
            viewport: { width: 100, height: 100 },
            screenshot: {
              sha256: HASH,
              path: `assets/${HASH}.webp`,
              mediaType: 'image/webp',
              byteLength: 3,
              role: 'screenshot',
            },
          },
        },
      },
    ],
    assets: [
      {
        sha256: HASH,
        path: `assets/${HASH}.webp`,
        mediaType: 'image/webp',
        byteLength: 3,
        role: 'screenshot',
      },
    ],
  });
}

describe('canonical data and identifiers', () => {
  it('serializes JSON deterministically and normalizes negative zero', () => {
    const left = { z: [3, { b: true, a: -0 }], a: 'first' };
    const right = { a: 'first', z: [3, { a: 0, b: true }] };
    expect(stableStringify(left)).toBe(stableStringify(right));
    expect(canonicalize(left)).toEqual(canonicalize(right));
    expect(revisionOf(left)).toBe(revisionOf(right));
  });

  it('fails closed for undefined, non-finite, circular, and class values', () => {
    expect(() => stableStringify({ missing: undefined })).toThrow(InvariantError);
    expect(() => stableStringify({ value: Number.NaN })).toThrow(InvariantError);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => stableStringify(circular)).toThrow(InvariantError);
    expect(() => stableStringify(new Date())).toThrow(InvariantError);
  });

  it('generates stable hashes, slugs, and namespaced IDs', () => {
    expect(sha256('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(slugify('  Olá, Product Story!  ')).toBe('ola-product-story');
    expect(createDeterministicId('step', 'same')).toBe(createDeterministicId('step', 'same'));
    expect(createDeterministicId('step', 'same')).not.toBe(createDeterministicId('scene', 'same'));
  });

  it('hashes schema-normalized artifacts without transport whitespace', () => {
    const input = {
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'review-contract',
      projectId: 'project',
      createdAt: '2026-07-20T12:00:00.000Z',
      producer: { name: 'contract-test', version: '1.0.0' },
      kind: 'review',
      subject: { kind: 'run', id: 'run-contract', revision: HASH },
      status: 'open',
      changeState: 'passed',
      openedAt: '2026-07-20T12:00:00.000Z',
    };
    const artifact = CanonicalArtifactSchema.parse(input);
    expect(artifactHash(input)).toBe(canonicalJsonHash(artifact));
    expect(artifactHash(input)).not.toBe(sha256(`${stableStringify(artifact)}\n`));
    expect(() => artifactHash(scene())).toThrow();
  });
});

describe('Scene domain invariants', () => {
  it('derives Scene source revisions from the schema-normalized Scene', () => {
    const parsed = scene();
    expect(sceneSourceRevision(parsed)).toBe(canonicalJsonHash(SceneSchema.parse(parsed)));
  });

  it('collects and deduplicates content-addressed assets', () => {
    expect(collectAssetReferences(scene())).toHaveLength(1);
  });

  it('rejects conflicting references to the same immutable digest', () => {
    const input = scene();
    input.steps[0]!.states.before!.screenshot = {
      ...input.steps[0]!.states.before!.screenshot!,
      mediaType: 'image/png',
    };
    expect(() => collectAssetReferences(input)).toThrow(InvariantError);
  });

  it('rejects self-referential presentation branches', () => {
    const parsed = SceneSchema.parse({
      schemaVersion: 1,
      id: 'chooser',
      title: 'Choose',
      slug: 'choose',
      steps: [
        {
          id: 'choose-path',
          kind: 'choice',
          title: 'Choose a path',
          choices: [{ id: 'again', label: 'Again', targetSceneId: 'chooser' }],
        },
      ],
    });
    expect(() => assertSceneInvariants(parsed)).toThrow(InvariantError);
  });

  it('rejects dangling and cyclic cross-Scene presentation links', () => {
    const makeChoice = (id: string, targetSceneId: string) =>
      SceneSchema.parse({
        schemaVersion: 1,
        id,
        title: id,
        slug: id,
        steps: [
          {
            id: `${id}-choice`,
            kind: 'choice',
            title: 'Choose',
            choices: [{ id: `${id}-next`, label: 'Next', targetSceneId }],
          },
        ],
      });
    expect(() => assertSceneGraph([makeChoice('one', 'missing')])).toThrow('unknown Scene');
    expect(() => assertSceneGraph([makeChoice('one', 'two'), makeChoice('two', 'one')])).toThrow(
      'cycle',
    );
  });

  it('collects canonical CTA links and ignores a deprecated fallback when canonical CTAs exist', () => {
    const parsed = SceneSchema.parse({
      schemaVersion: 1,
      id: 'entry',
      title: 'Entry',
      slug: 'entry',
      steps: [
        {
          id: 'leave',
          kind: 'explanation',
          title: 'Choose a destination',
          ctas: [
            {
              id: 'canonical-destination',
              kind: 'view-scene',
              label: 'Canonical',
              targetSceneId: 'canonical-scene',
            },
          ],
          cta: {
            kind: 'view-scene',
            label: 'Deprecated',
            targetSceneId: 'deprecated-scene',
          },
        },
      ],
    });

    expect(collectSceneLinks(parsed)).toEqual(['canonical-scene']);
  });

  it('prevents path traversal while allowing the root itself', () => {
    expect(assertPathInside('/tmp/project', '/tmp/project/assets/a')).toBe('/tmp/project/assets/a');
    expect(assertPathInside('/tmp/project', '/tmp/project')).toBe('/tmp/project');
    expect(() => assertPathInside('/tmp/project', '/tmp/other')).toThrow();
  });
});
