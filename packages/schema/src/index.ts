export * from './artifacts.js';
export * from './common.js';
export * from './config.js';
export * from './local-publication.js';
export * from './migrate.js';
export * from './publication.js';
export * from './scene.js';
export * from './yaml.js';

import {
  BaselineSchema,
  BuildArtifactSchema,
  ReleaseSchema,
  ReviewSchema,
  RunArtifactSchema,
} from './artifacts.js';
import {
  ApprovalAttestationSchema,
  PublicationCandidateSchema,
  PublicationEventSchema,
  PublicationReleaseSchema,
} from './local-publication.js';

export const parseRunArtifact = RunArtifactSchema.parse.bind(RunArtifactSchema);
export const parseBuildArtifact = BuildArtifactSchema.parse.bind(BuildArtifactSchema);
export const parseBaseline = BaselineSchema.parse.bind(BaselineSchema);
export const parseRelease = ReleaseSchema.parse.bind(ReleaseSchema);
export const parseReview = ReviewSchema.parse.bind(ReviewSchema);
export const parsePublicationCandidate = PublicationCandidateSchema.parse.bind(
  PublicationCandidateSchema,
);
export const parseApprovalAttestation =
  ApprovalAttestationSchema.parse.bind(ApprovalAttestationSchema);
export const parsePublicationRelease =
  PublicationReleaseSchema.parse.bind(PublicationReleaseSchema);
export const parsePublicationEvent = PublicationEventSchema.parse.bind(PublicationEventSchema);
