import { z } from 'zod';

import {
  ARTIFACT_VERSION,
  ArtifactHashSchema,
  IdSchema,
  IsoDateTimeSchema,
  LocaleSchema,
  PrivacySummarySchema,
  ProducerSchema,
  RelativePathSchema,
  RepositoryRevisionSchema,
  SCHEMA_VERSION,
  SceneSourceRevisionSchema,
  Sha256Schema,
} from './common.js';
import {
  CompilerPublicationManifestSchema,
  PublicationFileSchema,
  PublicationInventorySchema,
  ReleasePublicationSchema,
} from './publication.js';

const LocalArtifactBaseShape = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  artifactVersion: z.literal(ARTIFACT_VERSION),
  id: IdSchema,
  projectId: IdSchema,
  createdAt: IsoDateTimeSchema,
  producer: ProducerSchema,
};

export const ExactArtifactBindingSchema = z
  .object({
    kind: z.enum([
      'run',
      'build',
      'review',
      'baseline',
      'publication-candidate',
      'approval-attestation',
      'publication-release',
      'publication-event',
    ]),
    id: IdSchema,
    revision: ArtifactHashSchema,
    path: RelativePathSchema.optional(),
  })
  .strict();

export const ApprovalAttestationSchema = z
  .object({
    ...LocalArtifactBaseShape,
    kind: z.literal('approval-attestation'),
    scope: z.enum(['visual', 'editorial', 'release', 'privacy-override']),
    decision: z.enum(['approved', 'rejected']),
    subject: ExactArtifactBindingSchema,
    sceneId: IdSchema.optional(),
    runTargetId: IdSchema.optional(),
    actorId: IdSchema,
    reason: z.string().trim().min(1).max(5_000).optional(),
    review: ExactArtifactBindingSchema.optional(),
  })
  .strict()
  .superRefine((attestation, context) => {
    if (attestation.review && attestation.review.kind !== 'review') {
      context.addIssue({
        code: 'custom',
        message: 'An approval review binding must identify a Review artifact',
        path: ['review', 'kind'],
      });
    }
    if (attestation.scope === 'visual') {
      if (attestation.subject.kind !== 'baseline') {
        context.addIssue({
          code: 'custom',
          message: 'Visual approval must bind an exact Baseline revision',
          path: ['subject', 'kind'],
        });
      }
      if (!attestation.sceneId || !attestation.runTargetId) {
        context.addIssue({
          code: 'custom',
          message: 'Visual approval requires its Scene and Run Target',
          path: ['sceneId'],
        });
      }
    }
    if (attestation.scope === 'editorial') {
      if (attestation.subject.kind !== 'publication-candidate') {
        context.addIssue({
          code: 'custom',
          message: 'Editorial approval must bind an exact publication candidate',
          path: ['subject', 'kind'],
        });
      }
      if (!attestation.sceneId || attestation.runTargetId) {
        context.addIssue({
          code: 'custom',
          message: 'Editorial approval requires one Scene and no Run Target',
          path: ['sceneId'],
        });
      }
    }
    if (attestation.scope === 'release') {
      if (attestation.subject.kind !== 'publication-candidate') {
        context.addIssue({
          code: 'custom',
          message: 'Release approval must bind an exact publication candidate',
          path: ['subject', 'kind'],
        });
      }
      if (attestation.sceneId || attestation.runTargetId) {
        context.addIssue({
          code: 'custom',
          message: 'Release approval applies to the complete candidate',
          path: ['sceneId'],
        });
      }
    }
    if (attestation.scope === 'privacy-override') {
      if (!['run', 'baseline'].includes(attestation.subject.kind)) {
        context.addIssue({
          code: 'custom',
          message: 'Privacy override must bind an exact Run or Baseline revision',
          path: ['subject', 'kind'],
        });
      }
      if (!attestation.reason || attestation.reason.length < 10) {
        context.addIssue({
          code: 'custom',
          message: 'Privacy override requires a meaningful reason',
          path: ['reason'],
        });
      }
    }
    if (attestation.decision === 'rejected' && !attestation.reason) {
      context.addIssue({
        code: 'custom',
        message: 'A rejecting attestation requires a reason',
        path: ['reason'],
      });
    }
  });

export const CandidateRunBindingSchema = z
  .object({
    runTargetId: IdSchema,
    required: z.boolean(),
    run: ExactArtifactBindingSchema.optional(),
    reviews: z.array(ExactArtifactBindingSchema).max(10_000).default([]),
    status: z.enum(['passed', 'failed', 'blocked', 'cancelled', 'skipped']).optional(),
    changeState: z.enum(['passed', 'changed', 'broken', 'blocked']).optional(),
    privacy: PrivacySummarySchema.optional(),
    fresh: z.boolean().default(false),
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.run && binding.run.kind !== 'run') {
      context.addIssue({
        code: 'custom',
        message: 'Candidate Run binding must identify a Run artifact',
        path: ['run', 'kind'],
      });
    }
    for (const [index, review] of binding.reviews.entries()) {
      if (review.kind !== 'review') {
        context.addIssue({
          code: 'custom',
          message: 'Candidate review binding must identify a Review artifact',
          path: ['reviews', index, 'kind'],
        });
      }
    }
    const complete = binding.run && binding.status && binding.changeState && binding.privacy;
    if (Boolean(binding.run) !== Boolean(complete)) {
      context.addIssue({
        code: 'custom',
        message: 'Run status, change state, and privacy must accompany an exact Run binding',
        path: ['run'],
      });
    }
    if (binding.fresh && !binding.run) {
      context.addIssue({
        code: 'custom',
        message: 'Only an exact Run binding can be marked fresh',
        path: ['fresh'],
      });
    }
  });

export const PublicationCandidateSceneSchema = z
  .object({
    sceneId: IdSchema,
    slug: z.string().min(1).max(100),
    criticality: z.enum(['low', 'normal', 'important', 'critical']),
    sourceRevision: SceneSourceRevisionSchema,
    narrativeRevision: Sha256Schema.optional(),
    themeRevision: Sha256Schema.optional(),
    localeRevisions: z.record(LocaleSchema, Sha256Schema),
    localizationComplete: z.boolean(),
    runs: z.array(CandidateRunBindingSchema).max(10_000),
    files: z.array(PublicationFileSchema).min(1).max(20_000),
  })
  .strict();

export const PublicationCandidateSchema = z
  .object({
    ...LocalArtifactBaseShape,
    kind: z.literal('publication-candidate'),
    channelId: IdSchema,
    collectionId: IdSchema.optional(),
    sourceBuild: ExactArtifactBindingSchema,
    repository: RepositoryRevisionSchema,
    publication: ReleasePublicationSchema,
    inventory: PublicationInventorySchema,
    compilerManifest: CompilerPublicationManifestSchema,
    reviews: z.array(ExactArtifactBindingSchema).max(100_000).default([]),
    scenes: z.array(PublicationCandidateSceneSchema).min(1).max(100_000),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.sourceBuild.kind !== 'build') {
      context.addIssue({
        code: 'custom',
        message: 'Publication candidate must bind an exact Build artifact',
        path: ['sourceBuild', 'kind'],
      });
    }
    for (const [index, review] of candidate.reviews.entries()) {
      if (review.kind !== 'review') {
        context.addIssue({
          code: 'custom',
          message: 'Candidate review references must bind Review artifacts',
          path: ['reviews', index, 'kind'],
        });
      }
    }
    if (
      candidate.publication.treeHash !== candidate.inventory.treeHash ||
      candidate.publication.archive.sha256 !== candidate.inventory.archive.sha256 ||
      candidate.publication.archive.byteLength !== candidate.inventory.archive.byteLength
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Candidate publication descriptors must match its exact inventory',
        path: ['publication'],
      });
    }
    const manifestScenes = new Map(
      candidate.compilerManifest.scenes.map((scene) => [scene.id, scene]),
    );
    const sceneIds = new Set<string>();
    for (const [index, scene] of candidate.scenes.entries()) {
      if (sceneIds.has(scene.sceneId)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate candidate Scene: ${scene.sceneId}`,
          path: ['scenes', index, 'sceneId'],
        });
      }
      sceneIds.add(scene.sceneId);
      const compiled = manifestScenes.get(scene.sceneId);
      if (
        !compiled ||
        compiled.sourceHash !== scene.sourceRevision ||
        compiled.slug !== scene.slug
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Candidate Scene must match the exact compiler manifest Scene revision',
          path: ['scenes', index],
        });
      }
    }
    if (sceneIds.size !== manifestScenes.size) {
      context.addIssue({
        code: 'custom',
        message: 'Candidate and compiler manifest must contain the same Scenes',
        path: ['scenes'],
      });
    }
  });

export const BaselinePointerSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    kind: z.literal('baseline-pointer'),
    projectId: IdSchema,
    sceneId: IdSchema,
    runTargetId: IdSchema,
    baseline: ExactArtifactBindingSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .refine((pointer) => pointer.baseline.kind === 'baseline', {
    message: 'Baseline pointer must bind a Baseline artifact',
    path: ['baseline', 'kind'],
  });

export const CandidatePointerSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    kind: z.literal('candidate-pointer'),
    projectId: IdSchema,
    channelId: IdSchema,
    candidate: ExactArtifactBindingSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .refine((pointer) => pointer.candidate.kind === 'publication-candidate', {
    message: 'Candidate pointer must bind a publication candidate',
    path: ['candidate', 'kind'],
  });

export const PublicationReleaseSceneSchema = z
  .object({
    sceneId: IdSchema,
    action: z.enum(['include-candidate', 'carry-forward']),
    revision: SceneSourceRevisionSchema,
    runs: z.array(ExactArtifactBindingSchema).max(10_000),
    reviews: z.array(ExactArtifactBindingSchema).max(10_000),
    baselines: z.array(ExactArtifactBindingSchema).max(10_000),
    files: z.array(PublicationFileSchema).min(1).max(20_000),
    localeRevisions: z.record(LocaleSchema, Sha256Schema),
  })
  .strict()
  .superRefine((scene, context) => {
    for (const [index, run] of scene.runs.entries()) {
      if (run.kind !== 'run') {
        context.addIssue({
          code: 'custom',
          message: 'Release Run binding must identify a Run artifact',
          path: ['runs', index, 'kind'],
        });
      }
    }
    for (const [index, review] of scene.reviews.entries()) {
      if (review.kind !== 'review') {
        context.addIssue({
          code: 'custom',
          message: 'Release Review binding must identify a Review artifact',
          path: ['reviews', index, 'kind'],
        });
      }
    }
    for (const [index, baseline] of scene.baselines.entries()) {
      if (baseline.kind !== 'baseline') {
        context.addIssue({
          code: 'custom',
          message: 'Release Baseline binding must identify a Baseline artifact',
          path: ['baselines', index, 'kind'],
        });
      }
    }
  });

export const PublicationReleaseSchema = z
  .object({
    ...LocalArtifactBaseShape,
    kind: z.literal('publication-release'),
    channelId: IdSchema,
    sequence: z.number().int().positive(),
    sourceCandidate: ExactArtifactBindingSchema,
    sourceBuild: ExactArtifactBindingSchema,
    publication: ReleasePublicationSchema,
    scenes: z.array(PublicationReleaseSceneSchema).min(1).max(100_000),
    approvals: z.array(ExactArtifactBindingSchema).min(1).max(100_000),
    policyDecisionHash: Sha256Schema,
    publishedAt: IsoDateTimeSchema,
    supersedes: ExactArtifactBindingSchema.optional(),
  })
  .strict()
  .superRefine((release, context) => {
    if (release.sourceCandidate.kind !== 'publication-candidate') {
      context.addIssue({
        code: 'custom',
        message: 'Release must bind an exact publication candidate',
        path: ['sourceCandidate', 'kind'],
      });
    }
    if (release.sourceBuild.kind !== 'build') {
      context.addIssue({
        code: 'custom',
        message: 'Release must bind an exact Build',
        path: ['sourceBuild', 'kind'],
      });
    }
    if (release.supersedes && release.supersedes.kind !== 'publication-release') {
      context.addIssue({
        code: 'custom',
        message: 'supersedes must bind a publication Release',
        path: ['supersedes', 'kind'],
      });
    }
    for (const [index, approval] of release.approvals.entries()) {
      if (approval.kind !== 'approval-attestation') {
        context.addIssue({
          code: 'custom',
          message: 'Release approval references must bind immutable approval attestations',
          path: ['approvals', index, 'kind'],
        });
      }
    }
  });

export const PublicationEventSchema = z
  .object({
    ...LocalArtifactBaseShape,
    kind: z.literal('publication-event'),
    action: z.enum(['published', 'rolled-back']),
    channelId: IdSchema,
    sequence: z.number().int().positive(),
    release: ExactArtifactBindingSchema,
    previousRelease: ExactArtifactBindingSchema.optional(),
    sourceCandidate: ExactArtifactBindingSchema.optional(),
    actorId: IdSchema,
    destination: z.string().min(1).max(2_000),
    treeHash: Sha256Schema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.release.kind !== 'publication-release') {
      context.addIssue({
        code: 'custom',
        message: 'Publication event must bind a Release',
        path: ['release', 'kind'],
      });
    }
    if (event.previousRelease && event.previousRelease.kind !== 'publication-release') {
      context.addIssue({
        code: 'custom',
        message: 'Previous publication binding must identify a Release',
        path: ['previousRelease', 'kind'],
      });
    }
    if (event.sourceCandidate && event.sourceCandidate.kind !== 'publication-candidate') {
      context.addIssue({
        code: 'custom',
        message: 'Publication source must identify a candidate',
        path: ['sourceCandidate', 'kind'],
      });
    }
  });

export const ChannelPointerSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    kind: z.literal('channel-pointer'),
    projectId: IdSchema,
    channelId: IdSchema,
    publicationSequence: z.number().int().positive(),
    release: ExactArtifactBindingSchema,
    event: ExactArtifactBindingSchema,
    destination: z.string().min(1).max(2_000),
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((pointer, context) => {
    if (pointer.release.kind !== 'publication-release') {
      context.addIssue({
        code: 'custom',
        message: 'Channel pointer must bind a Release',
        path: ['release', 'kind'],
      });
    }
    if (pointer.event.kind !== 'publication-event') {
      context.addIssue({
        code: 'custom',
        message: 'Channel pointer must bind a publication event',
        path: ['event', 'kind'],
      });
    }
  });

export type ApprovalAttestation = z.infer<typeof ApprovalAttestationSchema>;
export type BaselinePointer = z.infer<typeof BaselinePointerSchema>;
export type CandidatePointer = z.infer<typeof CandidatePointerSchema>;
export type ChannelPointer = z.infer<typeof ChannelPointerSchema>;
export type ExactArtifactBinding = z.infer<typeof ExactArtifactBindingSchema>;
export type PublicationCandidate = z.infer<typeof PublicationCandidateSchema>;
export type PublicationCandidateScene = z.infer<typeof PublicationCandidateSceneSchema>;
export type PublicationEvent = z.infer<typeof PublicationEventSchema>;
export type PublicationRelease = z.infer<typeof PublicationReleaseSchema>;
export type PublicationReleaseScene = z.infer<typeof PublicationReleaseSceneSchema>;
