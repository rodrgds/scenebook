import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { evaluateChannelPolicy, type SceneReadiness } from '@scenebook/policy';
import { classifyRunAgainstBaseline } from '@scenebook/diff';
import { scanScenePrivacy, scanStructuredValue } from '@scenebook/privacy';
import {
  canonicalStepCtas,
  CompilerPublicationManifestSchema,
  IdSchema,
  PublicationInventorySchema,
  ReleaseSchema,
  Sha256Schema,
  type PublicationFile,
  type Release,
  type ReleasePublication,
  type Step,
  type StepCta,
} from '@scenebook/schema';
import {
  artifactHash,
  canonicalJsonHash,
  sceneSourceRevision,
  sha256,
  stableStringify,
} from '@scenebook/core';
import { z, type ZodType } from 'zod';

import {
  AddReviewCommentRequestSchema,
  AddReviewDecisionRequestSchema,
  AnalyticsEventRequestSchema,
  AnalyticsFunnelQuerySchema,
  BeginUploadRequestSchema,
  BindGitHubInstallationRequestSchema,
  BindRepositoryRequestSchema,
  CancelVerificationJobRequestSchema,
  CompleteVerificationJobRequestSchema,
  CreateChannelRequestSchema,
  CreateCustomDomainRequestSchema,
  CreateIdentityApiTokenRequestSchema,
  CreateIdentityUserRequestSchema,
  CreatePortalGrantRequestSchema,
  CreatePrivateShareLinkRequestSchema,
  CreateProjectRequestSchema,
  CreateVerificationRunnerRequestSchema,
  CreateVerificationScheduleRequestSchema,
  CreateReviewRequestSchema,
  CreateSceneRevisionRequestSchema,
  CreateWorkspaceRequestSchema,
  CreateGitHubSourceChangeRequestSchema,
  CreateUserSessionRequestSchema,
  CtaSubmissionRequestSchema,
  CustomDomainMutationRequestSchema,
  FinalizeUploadRequestSchema,
  OidcExchangeRequestSchema,
  PutWorkspaceMembershipRequestSchema,
  PutStudioProjectRequestSchema,
  PutStudioWorkspaceRequestSchema,
  PromoteReleaseRequestSchema,
  RecordReviewApprovalRequestSchema,
  RecordVerificationBaselineRequestSchema,
  RecordVerificationBuildRequestSchema,
  RecordVerificationRunRequestSchema,
  ResumeVerificationScheduleRequestSchema,
  RollbackReleaseRequestSchema,
  RunnerClaimRequestSchema,
  RunnerLeaseRequestSchema,
  SetReviewAssigneesRequestSchema,
  SetReviewCommentResolutionRequestSchema,
  UpdateVerificationScheduleRequestSchema,
  ResolvePrivateShareRequestSchema,
  ReadGitHubSourceRequestSchema,
  RevokeGitHubInstallationRequestSchema,
} from './api-schemas.js';
import { IdentityTokenService, roleAllows } from './auth.js';
import { constantTimeEqual, HmacHasher, SecretBox, UploadTokenService } from './crypto.js';
import type {
  AnalyticsAggregateRow,
  AnalyticsEventRecord,
  ArtifactUploadRecord,
  AuditEventRecord,
  ChannelRecord,
  CustomDomainDesiredState,
  CustomDomainProvisioningObservation,
  CustomDomainRecord,
  IdentityApiTokenRecord,
  IdentityScope,
  PublicationLoginHandoffRecord,
  ReleasePromotionSceneEvidence,
  ReviewApprovalRecord,
  ReviewRecord,
  UploadTokenClaims,
  VerificationBaselineRecord,
  VerificationBuildRecord,
  VerificationRunnerRecord,
  VerificationRunRecord,
  UserSessionRecord,
} from './domain.js';
import type { ServerConfig } from './config.js';
import { HttpError, readJsonBody, readLimitedStream } from './http.js';
import type { Logger } from './logger.js';
import {
  isAllowedObjectMediaType,
  ObjectMediaPolicyError,
  ObjectMediaStreamValidator,
} from './media-policy.js';
import { artifactObjectIdentity } from './object-identity.js';
import { renderOperatorConsole } from './operator-console.js';
import { MetricsRegistry } from './metrics.js';
import {
  ObjectIntegrityError,
  type ImmutableObjectStore,
  type StoredObject,
} from './object-store.js';
import { matchesWorkflowRef, type GitHubOidcVerifier } from './oidc.js';
import {
  PublicationArchiveIntegrityError,
  verifyPublicationArchive,
} from './publication-archive.js';
import { boundedRouteScope, PerClientRateLimiter } from './rate-limit.js';
import {
  RepositoryCapacityError,
  RepositoryConflictError,
  RepositoryNotFoundError,
  type ControlPlaneRepository,
} from './repository.js';
import { UploadAdmissionController, UploadAdmissionError } from './upload-admission.js';
import type { WebhookDispatcher } from './webhook.js';
import { RunnerTokenService } from './runner-token.js';
import { manualJobIdentity, scheduleFreshness } from './schedule.js';
import {
  assertMatchingProvisioningObservation,
  customDomainChallengeName,
  customDomainStatusFromObservation,
  CustomDomainDnsError,
  type CustomDomainDnsResolver,
  CustomDomainHostnameError,
  type CustomDomainProvisioner,
  CustomDomainProvisionerError,
  DisabledCustomDomainProvisioner,
  hasExactCustomDomainDnsProof,
  makeCustomDomainChallengeValue,
  NodeCustomDomainDnsResolver,
  normalizeCustomDomainHostname,
} from './custom-domains.js';
import {
  DisabledGitHubSourceClient,
  GitHubSourceError,
  type GitHubCheckRunResult,
  type GitHubSourceClient,
} from './github-app.js';
import { EvidenceRetentionBusyError, type EvidenceRetentionWorker } from './evidence-retention.js';
import {
  prepareWorkspaceExport,
  WorkspaceExportIntegrityError,
  WorkspaceExportLimitError,
} from './workspace-export.js';

export interface AppVariables {
  requestId: string;
  authenticationActor?: string;
  artifactWriteClaims?: UploadTokenClaims;
  humanPrincipal?: HumanPrincipal;
  verificationRunner?: VerificationRunnerRecord;
}

interface HumanPrincipal {
  readonly userId: string;
  readonly credential: 'api-token' | 'session';
  readonly credentialId: string;
  readonly workspaceId: string;
  readonly scopes: readonly IdentityScope[];
  readonly projectId?: string;
  readonly channelId?: string;
}

export type AppEnvironment = { Variables: AppVariables };
type AppContext = Context<AppEnvironment>;
const CTA_EMAIL_VALUE_SCHEMA = z.string().trim().email().max(320);
const MAX_EVIDENCE_IMAGE_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_STUDIO_ASSET_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_STUDIO_DOCUMENT_BYTES = 8 * 1024 * 1024;
const CreatePublicationLoginHandoffRequestSchema = z.object({}).strict();
const ConsumePublicationLoginHandoffRequestSchema = z
  .object({
    credential: z.string().min(32).max(512),
    audienceOrigin: z
      .string()
      .url()
      .refine((value) => new URL(value).origin === value, 'Expected an exact URL origin'),
  })
  .strict();
type AnalyticsEventType = AnalyticsEventRecord['type'];
type AnalyticsCountMap = Record<AnalyticsEventType, number>;

interface AnalyticsCounts {
  readonly events: AnalyticsCountMap;
  readonly uniqueSubjects: AnalyticsCountMap;
}

function emptyAnalyticsCountMap(): AnalyticsCountMap {
  return { view: 0, start: 0, step: 0, complete: 0, cta: 0, error: 0 };
}

function emptyAnalyticsCounts(): AnalyticsCounts {
  return { events: emptyAnalyticsCountMap(), uniqueSubjects: emptyAnalyticsCountMap() };
}

function addAnalyticsCount(counts: AnalyticsCounts, row: AnalyticsAggregateRow): void {
  counts.events[row.type] = row.eventCount;
  counts.uniqueSubjects[row.type] = row.uniqueSubjectCount;
}

function analyticsRate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(6));
}

function analyticsSceneSummary(counts: AnalyticsCounts) {
  const views = counts.events.view;
  const starts = counts.events.start;
  const completions = counts.events.complete;
  return {
    events: counts.events,
    uniqueSubjects: counts.uniqueSubjects,
    rates: {
      startPerView: analyticsRate(starts, views),
      completionPerView: analyticsRate(completions, views),
      completionPerStart: analyticsRate(completions, starts),
      dropoffPerView: analyticsRate(Math.max(0, views - completions), views),
      ctaPerView: analyticsRate(counts.events.cta, views),
      errorPerView: analyticsRate(counts.events.error, views),
    },
  };
}

function analyticsStepSummary(counts: AnalyticsCounts, sceneViews: number) {
  // The built-in publisher emits `view` for the initial Step and `step` on
  // navigation, so their sum is the stable Step reach count.
  const reaches = counts.events.view + counts.events.step;
  return {
    events: counts.events,
    uniqueSubjects: counts.uniqueSubjects,
    reaches,
    rates: {
      reachPerSceneView: analyticsRate(reaches, sceneViews),
      completionPerReach: analyticsRate(counts.events.complete, reaches),
      dropoffPerReach: analyticsRate(Math.max(0, reaches - counts.events.complete), reaches),
      ctaPerReach: analyticsRate(counts.events.cta, reaches),
      errorPerReach: analyticsRate(counts.events.error, reaches),
    },
  };
}

export interface ControlPlaneAppDependencies {
  readonly repository: ControlPlaneRepository;
  readonly objectStore: ImmutableObjectStore;
  readonly oidcVerifier: GitHubOidcVerifier;
  readonly uploadTokens: UploadTokenService;
  readonly identityTokens: IdentityTokenService;
  readonly runnerTokens: RunnerTokenService;
  readonly hasher: HmacHasher;
  readonly secretBox: SecretBox;
  readonly webhooks: WebhookDispatcher;
  readonly logger: Logger;
  readonly metrics?: MetricsRegistry;
  readonly adminToken: string;
  readonly publicBaseUrl: string;
  readonly publicationBaseUrl: string;
  readonly maxJsonBytes: number;
  readonly maxObjectBytes: number;
  readonly uploadLimits: ServerConfig['uploadLimits'];
  readonly uploadTokenTtlSeconds: number;
  readonly identity: ServerConfig['identity'];
  readonly publicationLogin?: ServerConfig['publicationLogin'];
  readonly runnerLeaseSeconds: number;
  readonly rateLimit: ServerConfig['rateLimit'];
  readonly customDomains?: {
    readonly enabled: boolean;
    readonly routingTarget?: string;
    readonly dnsResolver?: CustomDomainDnsResolver;
    readonly provisioner?: CustomDomainProvisioner;
  };
  readonly githubSource?: GitHubSourceClient;
  readonly githubChangeLeaseSeconds?: number;
  readonly githubCheckReconcileTimeoutMs?: number;
  readonly evidenceRetention?: EvidenceRetentionWorker;
  readonly workspaceExport?: {
    readonly maxRecords: number;
    readonly maxAssets: number;
    readonly maxAssetBytes: number;
    readonly maxMetadataBytes: number;
    readonly maxTotalBytes: number;
  };
  readonly now?: () => Date;
  readonly id?: (prefix: string) => string;
}

function responseError(
  status: number,
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): Response {
  return new Response(
    JSON.stringify({
      error: { code, message, ...(details === undefined ? {} : { details }), requestId },
    }),
    { status, headers: { 'content-type': 'application/json; charset=UTF-8' } },
  );
}

function assertCtaFieldContract(
  step: Step,
  ctaId: string | undefined,
  webhookId: string,
  fields: Readonly<Record<string, boolean | string>>,
): StepCta {
  const ctas = canonicalStepCtas(step);
  if (ctas.length === 0) {
    throw new HttpError(422, 'cta_not_authored', 'The released Step does not define a CTA');
  }
  if (step.ctas.length > 0 && !ctaId) {
    throw new HttpError(
      422,
      'cta_id_required',
      'ctaId is required for a released Step with canonical CTAs',
    );
  }
  const cta = ctaId ? ctas.find((candidate) => candidate.id === ctaId) : ctas[0];
  if (!cta) {
    throw new HttpError(
      422,
      'cta_not_authored',
      'The selected CTA is not part of the released Step',
    );
  }
  if (cta.kind !== 'form') {
    throw new HttpError(422, 'cta_not_form', 'The selected released CTA is not a form');
  }
  if (!cta.webhookId || cta.webhookId !== webhookId) {
    throw new HttpError(
      422,
      'cta_webhook_mismatch',
      'The webhook does not match the released form CTA',
    );
  }
  const definitions = new Map(cta.fields.map((field) => [field.id, field]));
  const unknown = Object.keys(fields).find((fieldId) => !definitions.has(fieldId));
  if (unknown) {
    throw new HttpError(
      422,
      'cta_field_mismatch',
      `Field ${unknown} is not part of the released form CTA`,
    );
  }
  for (const field of cta.fields) {
    const present = Object.hasOwn(fields, field.id);
    if (!present) {
      if (field.required) {
        throw new HttpError(
          422,
          'cta_field_required',
          `Required CTA field is missing: ${field.id}`,
        );
      }
      continue;
    }
    const value = fields[field.id];
    if (field.type === 'checkbox') {
      if (typeof value !== 'boolean') {
        throw new HttpError(
          422,
          'cta_field_type_mismatch',
          `CTA field ${field.id} must be a checkbox value`,
        );
      }
      if (field.required && value !== true) {
        throw new HttpError(
          422,
          'cta_consent_required',
          `Required CTA consent was not granted: ${field.id}`,
        );
      }
      continue;
    }
    if (typeof value !== 'string') {
      throw new HttpError(422, 'cta_field_type_mismatch', `CTA field ${field.id} must be text`);
    }
    if (field.required && value.trim().length === 0) {
      throw new HttpError(422, 'cta_field_required', `Required CTA field is empty: ${field.id}`);
    }
    if (field.type === 'email' && !CTA_EMAIL_VALUE_SCHEMA.safeParse(value).success) {
      throw new HttpError(
        422,
        'cta_field_type_mismatch',
        `CTA field ${field.id} must be a valid email address`,
      );
    }
  }
  return cta;
}

function parseBearer(context: AppContext): string {
  const value = context.req.header('authorization');
  if (!value?.startsWith('Bearer ') || value.length <= 7) {
    throw new HttpError(401, 'authentication_required', 'A Bearer token is required');
  }
  return value.slice(7);
}

async function json<T>(context: AppContext, schema: ZodType<T>, maximumBytes: number): Promise<T> {
  const body = await readJsonBody(context.req.raw, maximumBytes);
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(422, 'validation_failed', 'Request validation failed', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

function idempotencyKey(context: AppContext): string {
  const value = context.req.header('idempotency-key');
  if (!value || value.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new HttpError(
      400,
      'idempotency_key_required',
      'A valid Idempotency-Key header is required',
    );
  }
  return value;
}

function actor(context: AppContext): string {
  // Authentication selects the principal. Never accept a caller-authored
  // identity header; per-user identity belongs in a signed/session credential.
  return context.get('authenticationActor') ?? 'admin';
}

function artifactIngestionScope(
  method: string,
  path: string,
): { readonly workspaceId: string; readonly projectId: string } | undefined {
  if (method !== 'POST') return undefined;
  const match =
    /^\/v1\/admin\/workspaces\/([^/]+)\/projects\/([^/]+)\/(?:scenes\/revisions|reviews|evidence\/(?:runs|builds))$/u.exec(
      path,
    );
  if (!match?.[1] || !match[2]) return undefined;
  return { workspaceId: match[1], projectId: match[2] };
}

interface HumanAuthorizationScope {
  readonly workspaceId: string;
  readonly projectId?: string;
  readonly channelId?: string;
  readonly permission: IdentityScope;
}

function humanAuthorizationScope(
  method: string,
  path: string,
): HumanAuthorizationScope | undefined {
  const match =
    /^\/v1\/admin\/workspaces\/([^/]+)(?:\/projects\/([^/]+))?(?:\/channels\/([^/]+))?/u.exec(path);
  if (!match?.[1]) return undefined;
  const workspaceId = match[1];
  const projectId = match[2];
  const channelId = match[3];
  let permission: IdentityScope;
  if (/\/audit$/u.test(path)) permission = 'audit:read';
  else if (/\/(?:export|retention\/run)$/u.test(path)) permission = 'workspace:admin';
  else if (/\/memberships(?:\/|$)/u.test(path)) permission = 'workspace:admin';
  else if (/\/api-tokens(?:\/|$)/u.test(path)) permission = 'workspace:read';
  else if (!projectId) permission = method === 'GET' ? 'workspace:read' : 'workspace:admin';
  else if (/\/analytics\/funnel$/u.test(path)) permission = 'analytics:read';
  else if (/\/github\/installations(?:\/|$)/u.test(path))
    permission = method === 'GET' ? 'project:read' : 'workspace:admin';
  else if (/\/runners(?:\/|$)/u.test(path)) permission = 'runner:admin';
  else if (/\/(?:schedules|verification-jobs)(?:\/|$)/u.test(path))
    permission = method === 'GET' ? 'schedule:read' : 'schedule:write';
  else if (/\/(?:reviews|reviewers)(?:\/|$)|\/evidence\/approvals(?:\/|$)/u.test(path))
    permission = method === 'GET' ? 'review:read' : 'review:write';
  else if (/\/channels\/[^/]+\/(?:releases|rollback)$/u.test(path))
    permission = method === 'GET' ? 'channel:read' : 'release:write';
  else if (/\/portal\/(?:grants|share-links)(?:\/|$)/u.test(path)) permission = 'channel:write';
  else if (/\/channels(?:\/|$)/u.test(path))
    permission = method === 'GET' ? 'channel:read' : 'channel:write';
  else permission = method === 'GET' ? 'project:read' : 'project:write';
  return {
    workspaceId,
    ...(projectId ? { projectId } : {}),
    ...(channelId ? { channelId } : {}),
    permission,
  };
}

function githubRefName(ref: string): string {
  for (const prefix of ['refs/heads/', 'refs/tags/', 'refs/pull/']) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return ref;
}

function ensureEvidenceProvenance(
  claims: UploadTokenClaims,
  repository: {
    readonly provider: string;
    readonly repository: string;
    readonly commit: string;
    readonly branch?: string;
    readonly ref?: string;
    readonly dirty?: boolean;
  },
): void {
  if (
    repository.provider !== 'github' ||
    repository.repository !== claims.repository ||
    repository.commit !== claims.commit ||
    repository.ref !== claims.ref ||
    repository.branch !== githubRefName(claims.ref) ||
    repository.dirty !== false
  ) {
    throw new HttpError(
      403,
      'evidence_provenance_mismatch',
      'Evidence repository, commit, ref, or dirty state does not match the OIDC credential',
    );
  }
}

function numberQuery(context: AppContext, name: string, fallback: number, maximum: number): number {
  const raw = context.req.query(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new HttpError(
      400,
      'invalid_query',
      `${name} must be an integer between 0 and ${maximum}`,
    );
  }
  return value;
}

function studioSceneCursor(
  value: string | undefined,
): { savedAt: number; sceneId: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid cursor');
    const candidate = parsed as { savedAt?: unknown; sceneId?: unknown };
    if (
      !Number.isSafeInteger(candidate.savedAt) ||
      Number(candidate.savedAt) < 0 ||
      !IdSchema.safeParse(candidate.sceneId).success
    ) {
      throw new Error('invalid cursor');
    }
    return { savedAt: Number(candidate.savedAt), sceneId: String(candidate.sceneId) };
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'Hosted Studio catalog cursor is invalid');
  }
}

function encodeStudioSceneCursor(value: { savedAt: number; id: string }): string {
  return Buffer.from(JSON.stringify({ savedAt: value.savedAt, sceneId: value.id })).toString(
    'base64url',
  );
}

function requiredParam(context: AppContext, name: string): string {
  const value = context.req.param(name);
  if (!value)
    throw new HttpError(400, 'missing_route_parameter', `Missing route parameter ${name}`);
  return value;
}

function safeRequestId(value: string | undefined): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/u.test(value) ? value : `req-${randomUUID()}`;
}

function trustedClientAddress(context: AppContext): string {
  const realAddress = context.req.header('x-real-ip')?.trim();
  if (realAddress && isIP(realAddress)) return realAddress;
  const forwardedAddress = context.req.header('x-forwarded-for')?.split(',', 1)[0]?.trim();
  return forwardedAddress && isIP(forwardedAddress) ? forwardedAddress : 'unknown';
}

function uploadObject(record: {
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly stagingKey?: string;
}): StoredObject {
  if (!record.stagingKey)
    throw new RepositoryConflictError(`Object ${record.sha256} was not staged`);
  return {
    key: record.stagingKey,
    sha256: record.sha256,
    byteLength: record.byteLength,
    mediaType: record.mediaType,
  };
}

function ensureUploadBinding(
  claims: UploadTokenClaims,
  upload: {
    workspaceId: string;
    projectId: string;
    repository: string;
    commit: string;
    ref: string;
  },
): void {
  if (
    upload.workspaceId !== claims.workspaceId ||
    upload.projectId !== claims.projectId ||
    upload.repository.toLowerCase() !== claims.repository.toLowerCase() ||
    upload.commit !== claims.commit ||
    upload.ref !== claims.ref
  ) {
    throw new HttpError(403, 'token_scope_mismatch', 'Upload token is not bound to this upload');
  }
}

function exactManifestObjects(
  expected: readonly { sha256: string; byteLength: number; mediaType: string }[],
  actual: readonly { sha256: string; byteLength: number; mediaType: string }[],
): boolean {
  if (expected.length !== actual.length) return false;
  const byIdentity = new Map(
    actual.map((object) => [artifactObjectIdentity(object.sha256, object.mediaType), object]),
  );
  if (byIdentity.size !== actual.length) return false;
  return expected.every((object) => {
    const candidate = byIdentity.get(artifactObjectIdentity(object.sha256, object.mediaType));
    return candidate?.byteLength === object.byteLength && candidate.mediaType === object.mediaType;
  });
}

function validateReleaseAgainstPolicy(
  release: Release,
  readiness: readonly SceneReadiness[],
  channelId: string,
): void {
  if (release.channelId !== channelId) {
    throw new HttpError(422, 'channel_mismatch', 'Release channelId must match the route');
  }
  const releaseSceneIds = new Set(release.scenes.map((scene) => scene.sceneId));
  const readinessIds = new Set(readiness.map((scene) => scene.sceneId));
  if (releaseSceneIds.size !== release.scenes.length || readinessIds.size !== readiness.length) {
    throw new HttpError(422, 'duplicate_scene', 'Release and readiness Scene IDs must be unique');
  }
  if (
    releaseSceneIds.size !== readinessIds.size ||
    [...releaseSceneIds].some((sceneId) => !readinessIds.has(sceneId))
  ) {
    throw new HttpError(
      422,
      'readiness_mismatch',
      'Readiness must cover exactly the Scenes in the Release',
    );
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}

function comparableReviewChanges(
  changes: readonly {
    readonly source?: unknown;
    readonly [key: string]: unknown;
  }[],
): unknown {
  return changes.map(({ source: _source, ...change }) => change);
}

type ReleasePublicationSubject = {
  readonly manifestHash: string;
  readonly publication: ReleasePublication;
  readonly scenes: readonly Pick<
    Release['scenes'][number],
    'sceneId' | 'sourceRevision' | 'outputs'
  >[];
};

function sameObjectSpec(
  left: { readonly sha256: string; readonly byteLength: number; readonly mediaType: string },
  right: { readonly sha256: string; readonly byteLength: number; readonly mediaType: string },
): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.byteLength === right.byteLength &&
    left.mediaType === right.mediaType
  );
}

function releaseFormatForCompilerOutput(
  format: string,
): Release['scenes'][number]['outputs'][number]['format'] | undefined {
  if (format === 'remix-source') return 'source';
  if (
    [
      'catalog',
      'standalone-html',
      'web-component',
      'iframe',
      'markdown',
      'mdx',
      'html-guide',
      'pdf',
      'mp4',
      'webm',
      'gif',
      'readme-card',
      'og-image',
      'social-carousel',
    ].includes(format)
  ) {
    return format as Release['scenes'][number]['outputs'][number]['format'];
  }
  return undefined;
}

function runStatus(record: VerificationRunRecord): SceneReadiness['status'] {
  const run = record.run;
  const selected = run.attempts.find((attempt) => attempt.id === run.selectedAttemptId);
  if (run.privacy.status === 'blocked' || run.privacy.status === 'quarantined') return 'blocked';
  if (selected?.states.some((state) => ['blocked', 'quarantined'].includes(state.privacy.status))) {
    return 'blocked';
  }
  const executionStatuses = [
    ...(selected?.actions.map((action) => action.status) ?? []),
    ...(selected?.checks.map((check) => check.status) ?? []),
  ];
  if (executionStatuses.includes('blocked')) return 'blocked';
  if (executionStatuses.includes('failed')) return 'broken';
  if (executionStatuses.some((status) => status !== 'passed')) return 'unverified';
  if (run.status === 'blocked') return 'blocked';
  if (run.status === 'failed') return 'broken';
  if (run.status === 'cancelled' || run.status === 'skipped') return 'unverified';
  if (run.changeState === 'blocked') return 'blocked';
  if (run.changeState === 'broken') return 'broken';
  return run.changeState === 'changed' ? 'changed' : 'passed';
}

function approvalIsBound(
  approval: ReviewApprovalRecord | undefined,
  kind: 'visual' | 'editorial' | 'release',
  subjectKind: ReviewApprovalRecord['subjectKind'],
  subjectId: string,
  subjectRevision: string,
): boolean {
  return (
    approval?.approval.kind === kind &&
    approval.approval.decision === 'approved' &&
    approval.subjectKind === subjectKind &&
    approval.subjectId === subjectId &&
    approval.subjectRevision === subjectRevision &&
    approval.approval.revision === subjectRevision &&
    approval.approval.actorId === approval.recordedBy &&
    approval.artifactHash ===
      canonicalJsonHash({
        subjectKind: approval.subjectKind,
        subjectId: approval.subjectId,
        approval: approval.approval,
      })
  );
}

function buildReferencesRun(build: VerificationBuildRecord, run: VerificationRunRecord): boolean {
  const reference = build.build.runs.find(
    (candidate) =>
      candidate.sceneId === run.sceneId && candidate.runTargetId === run.run.runTargetId,
  );
  return (
    reference?.run?.kind === 'run' &&
    reference.run.id === run.id &&
    reference.run.sha256 === run.artifactHash &&
    reference.status === run.run.status &&
    reference.changeState === run.run.changeState &&
    build.artifactHash === artifactHash(build.build) &&
    run.artifactHash === artifactHash(run.run) &&
    stableStringify(build.build.repository) === stableStringify(run.run.repository)
  );
}

function baselineStateFromRun(
  state: VerificationRunRecord['run']['attempts'][number]['states'][number],
): Readonly<Record<string, unknown>> {
  return {
    sceneId: state.sceneId,
    stepId: state.stepId,
    phase: state.phase,
    stateId: state.id,
    screenshot: state.screenshot,
    screenshotHash: state.screenshotHash,
    ...(state.perceptualHash ? { perceptualHash: state.perceptualHash } : {}),
    route: state.route,
    viewport: state.viewport,
    ...(state.target ? { target: state.target } : {}),
    ...(state.semantic ? { semantic: state.semantic } : {}),
    privacy: state.privacy,
  };
}

export function createControlPlaneApp(
  dependencies: ControlPlaneAppDependencies,
): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>();
  const now = dependencies.now ?? (() => new Date());
  const makeId = dependencies.id ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const metrics = dependencies.metrics ?? new MetricsRegistry();
  const limiter = new PerClientRateLimiter({
    operationLimit: dependencies.rateLimit.requests,
    aggregateLimit: dependencies.rateLimit.aggregateRequests,
    windowMs: dependencies.rateLimit.windowMs,
    now: () => now().getTime(),
  });
  const uploadAdmission = new UploadAdmissionController(dependencies.uploadLimits);
  const customDomains = {
    enabled: dependencies.customDomains?.enabled ?? false,
    routingTarget: dependencies.customDomains?.routingTarget,
    dnsResolver: dependencies.customDomains?.dnsResolver ?? new NodeCustomDomainDnsResolver(),
    provisioner: dependencies.customDomains?.provisioner ?? new DisabledCustomDomainProvisioner(),
  };
  const githubSource = dependencies.githubSource ?? new DisabledGitHubSourceClient();
  const githubChangeLeaseMs = (dependencies.githubChangeLeaseSeconds ?? 120) * 1_000;
  const githubCheckReconcileTimeoutMs = Math.max(
    10,
    Math.min(dependencies.githubCheckReconcileTimeoutMs ?? 60_000, 60_000),
  );

  const auditRecord = (
    context: AppContext,
    input: Omit<AuditEventRecord, 'id' | 'requestId' | 'createdAt' | 'ipHash'>,
  ): AuditEventRecord => {
    const requestId = context.get('requestId');
    const address =
      context.req.header('x-real-ip') ??
      context.req.header('x-forwarded-for')?.split(',', 1)[0]?.trim();
    return {
      id: makeId('audit'),
      ...input,
      requestId,
      ...(address ? { ipHash: dependencies.hasher.hash(address, 'audit-ip') } : {}),
      createdAt: now().toISOString(),
    };
  };

  const audit = async (
    context: AppContext,
    input: Omit<AuditEventRecord, 'id' | 'requestId' | 'createdAt' | 'ipHash'>,
  ): Promise<void> => {
    await dependencies.repository.appendAudit(auditRecord(context, input));
  };

  const authenticateHumanBearer = async (bearer: string): Promise<HumanPrincipal | undefined> => {
    const current = now();
    const apiTokenId = dependencies.identityTokens.apiTokenId(bearer);
    if (apiTokenId) {
      const token = await dependencies.repository.getIdentityApiToken(apiTokenId);
      const suppliedHash = dependencies.identityTokens.hashApiToken(bearer);
      const storedHash = token?.tokenHash ?? '0'.repeat(64);
      const hashMatches = constantTimeEqual(suppliedHash, storedHash);
      if (
        !token ||
        token.revokedAt ||
        new Date(token.expiresAt).getTime() <= current.getTime() ||
        !hashMatches
      ) {
        throw new HttpError(
          401,
          'invalid_identity_token',
          'Identity credential is invalid or expired',
        );
      }
      const user = await dependencies.repository.getUser(token.userId);
      if (!user || user.disabledAt)
        throw new HttpError(
          401,
          'invalid_identity_token',
          'Identity credential is invalid or expired',
        );
      if (
        !token.lastUsedAt ||
        current.getTime() - new Date(token.lastUsedAt).getTime() >= 300_000
      ) {
        await dependencies.repository.touchIdentityApiToken(token.id, current.toISOString());
      }
      return {
        userId: token.userId,
        credential: 'api-token',
        credentialId: token.id,
        workspaceId: token.workspaceId,
        scopes: token.scopes,
        ...(token.projectId ? { projectId: token.projectId } : {}),
        ...(token.channelId ? { channelId: token.channelId } : {}),
      };
    }
    let claims;
    try {
      claims = await dependencies.identityTokens.verifySession(
        bearer,
        Math.floor(current.getTime() / 1_000),
      );
    } catch {
      return undefined;
    }
    const session = await dependencies.repository.getUserSession(claims.sessionId);
    const user = await dependencies.repository.getUser(claims.userId);
    const sourceToken = session
      ? await dependencies.repository.getIdentityApiToken(session.sourceTokenId)
      : undefined;
    if (
      !session ||
      session.userId !== claims.userId ||
      session.revokedAt ||
      new Date(session.expiresAt).getTime() <= current.getTime() ||
      Math.floor(new Date(session.expiresAt).getTime() / 1_000) !== claims.expiresAt ||
      !sourceToken ||
      sourceToken.userId !== session.userId ||
      sourceToken.workspaceId !== session.workspaceId ||
      sourceToken.projectId !== session.projectId ||
      sourceToken.channelId !== session.channelId ||
      stableStringify(sourceToken.scopes) !== stableStringify(session.scopes) ||
      sourceToken.revokedAt ||
      new Date(sourceToken.expiresAt).getTime() <= current.getTime() ||
      !user ||
      user.disabledAt
    ) {
      throw new HttpError(
        401,
        'invalid_identity_token',
        'Identity credential is invalid or expired',
      );
    }
    return {
      userId: session.userId,
      credential: 'session',
      credentialId: session.id,
      workspaceId: session.workspaceId,
      scopes: session.scopes,
      ...(session.projectId ? { projectId: session.projectId } : {}),
      ...(session.channelId ? { channelId: session.channelId } : {}),
    };
  };

  const setHumanPrincipal = (context: AppContext, principal: HumanPrincipal): void => {
    context.set('humanPrincipal', principal);
    context.set('authenticationActor', principal.userId);
  };

  const authenticateVerificationRunner = async (
    bearer: string,
  ): Promise<VerificationRunnerRecord> => {
    const runnerId = dependencies.runnerTokens.id(bearer);
    const runner = runnerId
      ? await dependencies.repository.getVerificationRunner(runnerId)
      : undefined;
    const suppliedHash = dependencies.runnerTokens.hash(bearer);
    const storedHash = runner?.tokenHash ?? '0'.repeat(64);
    if (
      !runner ||
      runner.revokedAt ||
      new Date(runner.expiresAt).getTime() <= now().getTime() ||
      !constantTimeEqual(suppliedHash, storedHash)
    ) {
      throw new HttpError(
        401,
        'invalid_runner_token',
        'Verification Runner credential is invalid or expired',
      );
    }
    return runner;
  };

  const authorizeHuman = async (
    principal: HumanPrincipal,
    scope: HumanAuthorizationScope | undefined,
  ): Promise<void> => {
    if (!scope)
      throw new HttpError(403, 'operator_required', 'This operation requires the operator token');
    if (
      principal.workspaceId !== scope.workspaceId ||
      (principal.projectId && principal.projectId !== scope.projectId) ||
      (principal.channelId && principal.channelId !== scope.channelId) ||
      !principal.scopes.includes(scope.permission)
    ) {
      throw new HttpError(403, 'insufficient_scope', 'Credential is not scoped to this operation');
    }
    const membership = await dependencies.repository.getWorkspaceMembership(
      scope.workspaceId,
      principal.userId,
    );
    if (!membership || membership.revokedAt || !roleAllows(membership.role, scope.permission)) {
      throw new HttpError(
        403,
        'membership_required',
        'Workspace membership does not allow this operation',
      );
    }
  };

  const operatorAuthentication: MiddlewareHandler<AppEnvironment> = async (context, next) => {
    if (!constantTimeEqual(parseBearer(context), dependencies.adminToken))
      throw new HttpError(401, 'invalid_operator_token', 'Operator token is invalid');
    context.set('authenticationActor', 'admin');
    await next();
  };

  const humanAuthentication: MiddlewareHandler<AppEnvironment> = async (context, next) => {
    const principal = await authenticateHumanBearer(parseBearer(context));
    if (!principal)
      throw new HttpError(
        401,
        'invalid_identity_token',
        'Identity credential is invalid or expired',
      );
    setHumanPrincipal(context, principal);
    await next();
  };

  const runnerAuthentication: MiddlewareHandler<AppEnvironment> = async (context, next) => {
    const runner = await authenticateVerificationRunner(parseBearer(context));
    context.set('verificationRunner', runner);
    context.set('authenticationActor', `runner:${runner.id}`);
    await next();
  };

  const adminAuthentication: MiddlewareHandler<AppEnvironment> = async (context, next) => {
    const bearer = parseBearer(context);
    if (constantTimeEqual(bearer, dependencies.adminToken)) {
      context.set('authenticationActor', 'admin');
      await next();
      return;
    }
    const principal = await authenticateHumanBearer(bearer);
    if (principal) {
      await authorizeHuman(
        principal,
        humanAuthorizationScope(context.req.method, context.req.path),
      );
      setHumanPrincipal(context, principal);
      await next();
      return;
    }
    const scope = artifactIngestionScope(context.req.method, context.req.path);
    if (!scope)
      throw new HttpError(401, 'invalid_admin_token', 'Administrative credential is invalid');
    let claims: UploadTokenClaims;
    try {
      claims = await dependencies.uploadTokens.verify(bearer, Math.floor(now().getTime() / 1_000));
    } catch {
      throw new HttpError(401, 'invalid_upload_token', 'Upload token is invalid or expired');
    }
    if (claims.permissions.length !== 1 || claims.permissions[0] !== 'artifact:write') {
      throw new HttpError(
        403,
        'insufficient_upload_scope',
        'Upload token does not grant artifact:write',
      );
    }
    if (claims.workspaceId !== scope.workspaceId || claims.projectId !== scope.projectId) {
      throw new HttpError(
        403,
        'token_scope_mismatch',
        'Upload token is not bound to this Workspace and Project',
      );
    }
    context.set('authenticationActor', 'github-actions');
    context.set('artifactWriteClaims', claims);
    await next();
  };

  const verifyUploadToken = async (context: AppContext): Promise<UploadTokenClaims> => {
    try {
      return await dependencies.uploadTokens.verify(
        parseBearer(context),
        Math.floor(now().getTime() / 1_000),
      );
    } catch {
      throw new HttpError(401, 'invalid_upload_token', 'Upload token is invalid or expired');
    }
  };

  const requireFinalizedEvidenceObject = async (
    context: AppContext,
    claims: UploadTokenClaims,
    envelope: unknown,
  ): Promise<ArtifactUploadRecord> => {
    const uploadId = context.req.header('x-scenebook-upload-id');
    if (!uploadId || !IdSchema.safeParse(uploadId).success) {
      throw new HttpError(
        400,
        'evidence_upload_required',
        'A valid X-Scenebook-Upload-Id header is required for OIDC evidence ingestion',
      );
    }
    const upload = await dependencies.repository.getUpload(uploadId);
    if (!upload) throw new HttpError(422, 'unknown_evidence_upload', 'Evidence upload not found');
    ensureUploadBinding(claims, upload);
    if (upload.status !== 'finalized') {
      throw new HttpError(
        409,
        'evidence_upload_not_finalized',
        'Evidence must be finalized before it can be recorded',
      );
    }
    const bytes = Buffer.from(`${stableStringify(envelope)}\n`);
    const digest = sha256(bytes);
    const object = upload.objects.find(
      (candidate) =>
        candidate.sha256 === digest &&
        candidate.byteLength === bytes.byteLength &&
        candidate.mediaType === 'application/json' &&
        candidate.status === 'finalized' &&
        candidate.finalKey,
    );
    if (!object?.finalKey) {
      throw new HttpError(
        422,
        'evidence_object_missing',
        'The finalized upload does not contain the exact evidence request',
      );
    }
    if (
      !(await dependencies.objectStore.verify({
        key: object.finalKey,
        sha256: object.sha256,
        byteLength: object.byteLength,
        mediaType: object.mediaType,
      }))
    ) {
      throw new HttpError(
        503,
        'evidence_object_unavailable',
        'The immutable evidence object failed storage verification',
      );
    }
    return upload;
  };

  const requireConfiguredWebhook = (webhookId: string) => {
    try {
      return dependencies.webhooks.get(webhookId);
    } catch {
      throw new HttpError(422, 'unknown_webhook', 'Webhook is not configured');
    }
  };

  const assertReleasePublicationAvailable = async (
    workspaceId: string,
    projectId: string,
    release: ReleasePublicationSubject,
    provenance:
      { readonly repository: string; readonly commit: string } | { readonly uploadId: string },
  ): Promise<ArtifactUploadRecord> => {
    const upload =
      'uploadId' in provenance
        ? await dependencies.repository.getUpload(provenance.uploadId)
        : await dependencies.repository.getFinalizedUploadByManifest(
            workspaceId,
            projectId,
            provenance.repository,
            provenance.commit,
            release.manifestHash,
          );
    if (
      !upload ||
      upload.workspaceId !== workspaceId ||
      upload.projectId !== projectId ||
      upload.status !== 'finalized' ||
      upload.manifestHash !== release.manifestHash ||
      ('repository' in provenance &&
        (upload.repository.toLowerCase() !== provenance.repository.toLowerCase() ||
          upload.commit !== provenance.commit))
    )
      throw new HttpError(
        422,
        'unknown_manifest',
        'Release manifest was not finalized by an authenticated upload',
      );
    const objects = new Map(
      upload.objects.map((object) => [
        artifactObjectIdentity(object.sha256, object.mediaType),
        object,
      ]),
    );

    const finalizedObject = (
      expected: ReleasePublication['archive' | 'inventory' | 'compilerManifest'],
      label: string,
    ): StoredObject => {
      const record = objects.get(artifactObjectIdentity(expected.sha256, expected.mediaType));
      if (
        !record ||
        record.status !== 'finalized' ||
        !record.finalKey ||
        !sameObjectSpec(record, expected)
      ) {
        throw new HttpError(
          422,
          'publication_object_mismatch',
          `The finalized upload does not contain the exact ${label} object`,
        );
      }
      return {
        key: record.finalKey,
        sha256: record.sha256,
        byteLength: record.byteLength,
        mediaType: record.mediaType,
      };
    };

    const archiveObject = finalizedObject(release.publication.archive, 'publication archive');
    const inventoryObject = finalizedObject(release.publication.inventory, 'publication inventory');
    const compilerManifestObject = finalizedObject(
      release.publication.compilerManifest,
      'compiler manifest',
    );
    const readJsonObject = async <Value>(
      stored: StoredObject,
      schema: ZodType<Value>,
      label: string,
    ): Promise<Value> => {
      let bytes: Uint8Array;
      try {
        bytes = await dependencies.objectStore.read(stored);
      } catch {
        throw new HttpError(
          503,
          'publication_metadata_unavailable',
          `The immutable ${label} failed storage verification`,
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new HttpError(
          422,
          'publication_metadata_invalid',
          `The ${label} is not valid UTF-8 JSON`,
        );
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw new HttpError(
          422,
          'publication_metadata_invalid',
          `The ${label} does not match the supported typed schema`,
        );
      }
      return parsed.data;
    };

    const inventory = await readJsonObject(
      inventoryObject,
      PublicationInventorySchema,
      'publication inventory',
    );
    const compilerManifest = await readJsonObject(
      compilerManifestObject,
      CompilerPublicationManifestSchema,
      'compiler manifest',
    );
    const inventoryManifestSpec = {
      sha256: inventory.compilerManifest.sha256,
      byteLength: inventory.compilerManifest.byteLength,
      mediaType: inventory.compilerManifest.mediaType,
    };
    if (
      !sameObjectSpec(inventory.archive, release.publication.archive) ||
      !sameObjectSpec(inventoryManifestSpec, release.publication.compilerManifest) ||
      inventory.treeHash !== release.publication.treeHash ||
      canonicalJsonHash({ files: inventory.files }) !== inventory.treeHash
    ) {
      throw new HttpError(
        422,
        'publication_integrity_mismatch',
        'Publication archive, inventory, compiler manifest, or tree hash binding is inconsistent',
      );
    }
    const archiveSource = async function* (): AsyncGenerator<Uint8Array> {
      if (dependencies.objectStore.readStream) {
        yield* dependencies.objectStore.readStream(archiveObject);
      } else {
        yield await dependencies.objectStore.read(archiveObject);
      }
    };
    try {
      await verifyPublicationArchive(archiveSource(), inventory);
    } catch (error) {
      if (error instanceof PublicationArchiveIntegrityError) {
        throw new HttpError(
          422,
          'publication_archive_mismatch',
          'Publication archive members or deterministic ZIP metadata do not match the inventory',
        );
      }
      throw new HttpError(
        503,
        'publication_archive_unavailable',
        'The immutable publication archive failed storage verification',
      );
    }

    const inventoryByPath = new Map(inventory.files.map((file) => [file.path, file]));
    const releaseByScene = new Map(release.scenes.map((scene) => [scene.sceneId, scene]));
    if (
      releaseByScene.size !== release.scenes.length ||
      compilerManifest.scenes.length !== release.scenes.length ||
      compilerManifest.scenes.some((scene) => !releaseByScene.has(scene.id))
    ) {
      throw new HttpError(
        422,
        'release_manifest_mismatch',
        'Release Scenes must match the exact compiler publication Scene set',
      );
    }
    const claimedCompilerPaths = new Set<string>();
    for (const compilerScene of compilerManifest.scenes) {
      const releaseScene = releaseByScene.get(compilerScene.id)!;
      if (releaseScene.sourceRevision !== compilerScene.sourceHash) {
        throw new HttpError(
          422,
          'release_manifest_mismatch',
          `Release Scene ${compilerScene.id} does not match the compiled source revision`,
        );
      }
      const evidenceFile = inventoryByPath.get(compilerScene.evidence);
      if (
        !evidenceFile ||
        evidenceFile.mediaType !== 'application/json' ||
        evidenceFile.byteLength === 0 ||
        claimedCompilerPaths.has(compilerScene.evidence)
      ) {
        throw new HttpError(
          422,
          'publication_integrity_mismatch',
          `Compiler evidence is not an exact, uniquely owned inventory object: ${compilerScene.evidence}`,
        );
      }
      claimedCompilerPaths.add(compilerScene.evidence);
      const expectedOutputs = new Map<
        string,
        { readonly format: string; readonly path: string; readonly file: PublicationFile }
      >();
      for (const [compilerFormat, paths] of Object.entries(compilerScene.outputs)) {
        const releaseFormat = releaseFormatForCompilerOutput(compilerFormat);
        if (!releaseFormat) {
          throw new HttpError(
            422,
            'publication_metadata_invalid',
            `Unsupported compiler output format: ${compilerFormat}`,
          );
        }
        for (const path of paths) {
          const file = inventoryByPath.get(path);
          if (!file || claimedCompilerPaths.has(path)) {
            throw new HttpError(
              422,
              'publication_integrity_mismatch',
              `Compiler output is absent or owned more than once in the publication inventory: ${path}`,
            );
          }
          claimedCompilerPaths.add(path);
          expectedOutputs.set(`${releaseFormat}\0${path}`, {
            format: releaseFormat,
            path,
            file,
          });
        }
      }
      if (
        expectedOutputs.size !== releaseScene.outputs.length ||
        new Set(
          releaseScene.outputs.map((output) => `${output.format}\0${output.entrypoint ?? ''}`),
        ).size !== releaseScene.outputs.length
      ) {
        throw new HttpError(
          422,
          'release_manifest_mismatch',
          `Release Scene ${compilerScene.id} must contain the exact compiled output set`,
        );
      }
      for (const output of releaseScene.outputs) {
        const expected = expectedOutputs.get(`${output.format}\0${output.entrypoint ?? ''}`);
        if (
          !expected ||
          output.entrypoint !== expected.path ||
          output.asset.path !== expected.file.path ||
          output.asset.sha256 !== expected.file.sha256 ||
          output.asset.byteLength !== expected.file.byteLength ||
          output.asset.mediaType !== expected.file.mediaType ||
          output.locale !== compilerScene.locale ||
          output.asset.width !== undefined ||
          output.asset.height !== undefined ||
          output.asset.durationMs !== undefined
        ) {
          throw new HttpError(
            422,
            'release_manifest_mismatch',
            `Release output does not match compiler and inventory truth: ${compilerScene.id}/${output.format}`,
          );
        }
      }
    }
    return upload;
  };

  app.use('*', async (context, next) => {
    const started = now().getTime();
    const requestId = safeRequestId(context.req.header('x-request-id'));
    context.set('requestId', requestId);
    context.header('x-request-id', requestId);
    context.header('x-content-type-options', 'nosniff');
    context.header('referrer-policy', 'no-referrer');
    const sourceAddress = trustedClientAddress(context);
    const clientKey = dependencies.hasher.hash(sourceAddress, 'rate-limit-client');
    const decision = limiter.consume(
      clientKey,
      boundedRouteScope(context.req.method, context.req.path),
    );
    context.header('ratelimit-limit', String(decision.limit));
    context.header('ratelimit-remaining', String(decision.remaining));
    context.header('ratelimit-reset', String(Math.ceil(decision.resetAt / 1_000)));
    context.header('x-ratelimit-aggregate-limit', String(decision.aggregate.limit));
    context.header('x-ratelimit-aggregate-remaining', String(decision.aggregate.remaining));
    try {
      if (!decision.allowed) {
        metrics.increment('scenebook_rate_limit_rejections_total', 'Rate-limited HTTP requests', {
          scope: decision.limitedBy ?? 'operation',
        });
        return context.json(
          {
            error: {
              code: 'rate_limited',
              message: 'Too many requests',
              requestId,
            },
          },
          429,
        );
      }
      await next();
    } finally {
      const route = context.req.routePath || 'unmatched';
      metrics.increment('scenebook_http_requests_total', 'HTTP requests handled', {
        method: context.req.method,
        route,
        status: String(context.res.status),
      });
      metrics.gauge(
        'scenebook_http_last_duration_ms',
        'Duration of the last HTTP request',
        Math.max(0, now().getTime() - started),
        {
          method: context.req.method,
          route,
        },
      );
    }
  });

  app.onError((error, context) => {
    const requestId = context.get('requestId') || 'unknown';
    if (error instanceof HttpError) {
      return responseError(error.status, error.code, error.message, requestId, error.details);
    }
    if (error instanceof RepositoryNotFoundError)
      return responseError(404, 'not_found', error.message, requestId);
    if (error instanceof RepositoryConflictError)
      return responseError(409, 'conflict', error.message, requestId);
    if (error instanceof CustomDomainHostnameError)
      return responseError(422, 'invalid_custom_domain_hostname', error.message, requestId);
    if (error instanceof CustomDomainDnsError)
      return responseError(503, error.code, error.message, requestId);
    if (error instanceof CustomDomainProvisionerError) {
      const status =
        error.code === 'provisioner_unavailable' || error.code === 'provisioner_disabled'
          ? 503
          : 502;
      return responseError(status, error.code, error.message, requestId);
    }
    if (error instanceof GitHubSourceError) {
      const status =
        error.code === 'github_app_disabled'
          ? 503
          : error.code === 'github_not_found'
            ? 404
            : error.code === 'github_rate_limited'
              ? 429
              : error.code === 'github_unavailable'
                ? 503
                : error.code === 'github_auth_failed'
                  ? 403
                  : error.code === 'github_commit_mismatch' ||
                      error.code === 'github_blob_mismatch' ||
                      error.code === 'github_branch_collision' ||
                      error.code === 'github_patch_conflict' ||
                      error.code === 'github_lease_lost'
                    ? 409
                    : 502;
      return responseError(status, error.code, error.message, requestId, {
        retryable: error.retryable,
      });
    }
    if (error instanceof RepositoryCapacityError) {
      metrics.increment(
        'scenebook_upload_admission_rejections_total',
        'Artifact upload admission rejections',
        { kind: 'active', scope: error.scope, resource: error.resource },
      );
      return responseError(
        error.scope === 'tenant' ? 429 : 503,
        'upload_capacity_exhausted',
        error.message,
        requestId,
      );
    }
    if (error instanceof UploadAdmissionError) {
      metrics.increment(
        'scenebook_upload_admission_rejections_total',
        'Artifact upload admission rejections',
        { kind: 'concurrent', scope: error.scope, resource: error.resource },
      );
      return responseError(
        error.scope === 'tenant' ? 429 : 503,
        'upload_concurrency_exhausted',
        error.message,
        requestId,
      );
    }
    if (error instanceof z.ZodError) {
      return responseError(
        422,
        'invalid_state_transition',
        'Requested state transition is invalid',
        requestId,
        {
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      );
    }
    const databaseCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (databaseCode === '23505')
      return responseError(409, 'unique_conflict', 'Resource already exists', requestId);
    if (databaseCode === '23503')
      return responseError(
        422,
        'reference_not_found',
        'A referenced resource does not exist',
        requestId,
      );
    if (databaseCode === '23514')
      return responseError(
        422,
        'constraint_violation',
        'Request violates a data constraint',
        requestId,
      );
    dependencies.logger.error('Unhandled control-plane request error', {
      requestId,
      method: context.req.method,
      path: context.req.path,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    metrics.increment('scenebook_http_errors_total', 'Unhandled HTTP errors');
    return responseError(500, 'internal_error', 'An unexpected error occurred', requestId);
  });

  app.notFound((context) =>
    responseError(404, 'route_not_found', 'Route not found', context.get('requestId')),
  );

  app.get('/healthz', (context) => context.json({ status: 'ok' }));
  app.get('/readyz', async (context) => {
    try {
      await Promise.all([dependencies.repository.health(), dependencies.objectStore.health()]);
      return context.json({ status: 'ready' });
    } catch (error) {
      dependencies.logger.warn('Readiness check failed', { error });
      return context.json({ status: 'not-ready' }, 503);
    }
  });
  app.get('/metrics', (context) =>
    context.text(metrics.render(), 200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    }),
  );

  app.get('/console', (context) => {
    const nonce = randomUUID().replace(/-/gu, '');
    context.header('cache-control', 'no-store');
    context.header('cross-origin-opener-policy', 'same-origin');
    context.header('cross-origin-resource-policy', 'same-origin');
    context.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    context.header(
      'content-security-policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
    return context.html(renderOperatorConsole(nonce));
  });

  app.use('/v1/operator/*', operatorAuthentication);
  app.use('/v1/admin/*', adminAuthentication);
  app.use('/v1/runner/*', runnerAuthentication);
  app.use('/v1/auth/me', humanAuthentication);
  app.use('/v1/auth/sessions/current', humanAuthentication);

  const boundedExpiry = (value: string, maximumSeconds: number, label: string): string => {
    const expiry = new Date(value);
    const remaining = expiry.getTime() - now().getTime();
    if (
      !Number.isFinite(expiry.getTime()) ||
      remaining < 60_000 ||
      remaining > maximumSeconds * 1_000
    ) {
      throw new HttpError(
        422,
        'expiry_out_of_range',
        `${label} expiry must be at least one minute and no more than ${maximumSeconds} seconds from now`,
      );
    }
    return expiry.toISOString();
  };

  const issueApiToken = async (
    userId: string,
    workspaceId: string,
    body: z.infer<typeof CreateIdentityApiTokenRequestSchema>,
  ): Promise<{
    readonly credential: string;
    readonly token: Omit<IdentityApiTokenRecord, 'tokenHash'>;
  }> => {
    const user = await dependencies.repository.getUser(userId);
    if (!user || user.disabledAt) throw new RepositoryNotFoundError('Active User not found');
    if (!(await dependencies.repository.getWorkspace(workspaceId)))
      throw new RepositoryNotFoundError('Workspace not found');
    if (body.projectId && !(await dependencies.repository.getProject(workspaceId, body.projectId)))
      throw new RepositoryNotFoundError('Project not found');
    if (
      body.channelId &&
      (!body.projectId ||
        !(await dependencies.repository.getChannel(workspaceId, body.projectId, body.channelId)))
    ) {
      throw new RepositoryNotFoundError('Channel not found');
    }
    const id = makeId('token');
    const generated = dependencies.identityTokens.createApiToken(id);
    const value = await dependencies.repository.createIdentityApiToken({
      id,
      userId,
      workspaceId,
      name: body.name,
      tokenHash: generated.tokenHash,
      scopes: body.scopes,
      ...(body.projectId ? { projectId: body.projectId } : {}),
      ...(body.channelId ? { channelId: body.channelId } : {}),
      createdAt: now().toISOString(),
      expiresAt: boundedExpiry(
        body.expiresAt,
        dependencies.identity.apiTokenMaxTtlSeconds,
        'API token',
      ),
    });
    const { tokenHash: _tokenHash, ...safe } = value;
    return { credential: generated.token, token: safe };
  };

  app.post('/v1/operator/users', async (context) => {
    const body = await json(context, CreateIdentityUserRequestSchema, dependencies.maxJsonBytes);
    const value = await dependencies.repository.createUser({
      id: body.id ?? makeId('user'),
      email: body.email,
      displayName: body.displayName,
      now: now().toISOString(),
    });
    await audit(context, {
      actorId: 'admin',
      action: 'identity.user-created',
      targetType: 'user',
      targetId: value.id,
      metadata: {},
    });
    return context.json({ user: value }, 201);
  });

  app.get('/v1/operator/users/:userId', async (context) => {
    const user = await dependencies.repository.getUser(requiredParam(context, 'userId'));
    if (!user) throw new RepositoryNotFoundError('User not found');
    return context.json({ user });
  });

  app.delete('/v1/operator/users/:userId', async (context) => {
    const userId = requiredParam(context, 'userId');
    if (!(await dependencies.repository.disableUser(userId, now().toISOString())))
      throw new RepositoryNotFoundError('Active User not found');
    await audit(context, {
      actorId: 'admin',
      action: 'identity.user-disabled',
      targetType: 'user',
      targetId: userId,
      metadata: {},
    });
    return context.body(null, 204);
  });

  const putMembership = async (context: AppContext, workspaceId: string) => {
    const body = await json(
      context,
      PutWorkspaceMembershipRequestSchema,
      dependencies.maxJsonBytes,
    );
    const principal = context.get('humanPrincipal');
    if (principal?.userId === body.userId && body.role !== 'owner') {
      throw new HttpError(
        409,
        'owner_self_change_forbidden',
        'An Owner cannot demote their own membership; use another Owner or the operator',
      );
    }
    const timestamp = now().toISOString();
    const value = await dependencies.repository.putWorkspaceMembership({
      workspaceId,
      userId: body.userId,
      role: body.role,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await audit(context, {
      workspaceId,
      actorId: actor(context),
      action: 'membership.put',
      targetType: 'workspace-membership',
      targetId: body.userId,
      metadata: { role: body.role },
    });
    return context.json({ membership: value }, 201);
  };

  app.put('/v1/operator/workspaces/:workspaceId/memberships', (context) =>
    putMembership(context, requiredParam(context, 'workspaceId')),
  );
  app.put('/v1/admin/workspaces/:workspaceId/memberships', (context) =>
    putMembership(context, requiredParam(context, 'workspaceId')),
  );

  const listMemberships = async (context: AppContext, workspaceId: string) => {
    const memberships = await dependencies.repository.listWorkspaceMemberships(
      workspaceId,
      numberQuery(context, 'limit', 100, 500),
    );
    const values = await Promise.all(
      memberships.map(async (membership) => ({
        membership,
        user: (await dependencies.repository.getUser(membership.userId)) ?? null,
      })),
    );
    return context.json({ memberships: values });
  };

  app.get('/v1/operator/workspaces/:workspaceId/memberships', (context) =>
    listMemberships(context, requiredParam(context, 'workspaceId')),
  );
  app.get('/v1/admin/workspaces/:workspaceId/memberships', (context) =>
    listMemberships(context, requiredParam(context, 'workspaceId')),
  );

  const revokeMembership = async (context: AppContext, workspaceId: string, userId: string) => {
    const principal = context.get('humanPrincipal');
    if (principal?.userId === userId) {
      throw new HttpError(
        409,
        'owner_self_change_forbidden',
        'An Owner cannot revoke their own membership; use another Owner or the operator',
      );
    }
    const revoked = await dependencies.repository.revokeWorkspaceMembership(
      workspaceId,
      userId,
      now().toISOString(),
    );
    if (!revoked) throw new RepositoryNotFoundError('Active Workspace membership not found');
    await audit(context, {
      workspaceId,
      actorId: actor(context),
      action: 'membership.revoked',
      targetType: 'workspace-membership',
      targetId: userId,
      metadata: {},
    });
    return context.body(null, 204);
  };

  app.delete('/v1/operator/workspaces/:workspaceId/memberships/:userId', (context) =>
    revokeMembership(
      context,
      requiredParam(context, 'workspaceId'),
      requiredParam(context, 'userId'),
    ),
  );
  app.delete('/v1/admin/workspaces/:workspaceId/memberships/:userId', (context) =>
    revokeMembership(
      context,
      requiredParam(context, 'workspaceId'),
      requiredParam(context, 'userId'),
    ),
  );

  app.post('/v1/operator/workspaces/:workspaceId/users/:userId/api-tokens', async (context) => {
    const body = await json(
      context,
      CreateIdentityApiTokenRequestSchema,
      dependencies.maxJsonBytes,
    );
    const userId = requiredParam(context, 'userId');
    if (body.userId && body.userId !== userId)
      throw new HttpError(422, 'user_mismatch', 'Token userId must match the route');
    const value = await issueApiToken(userId, requiredParam(context, 'workspaceId'), body);
    await audit(context, {
      workspaceId: value.token.workspaceId,
      actorId: actor(context),
      action: 'identity.api-token-created',
      targetType: 'identity-api-token',
      targetId: value.token.id,
      metadata: { userId, scopes: value.token.scopes },
    });
    return context.json(value, 201);
  });

  app.post('/v1/admin/workspaces/:workspaceId/api-tokens', async (context) => {
    const body = await json(
      context,
      CreateIdentityApiTokenRequestSchema,
      dependencies.maxJsonBytes,
    );
    const principal = context.get('humanPrincipal');
    if (!principal)
      throw new HttpError(
        403,
        'human_identity_required',
        'The operator token cannot create a personal token on this route',
      );
    if (body.userId && body.userId !== principal.userId)
      throw new HttpError(403, 'user_mismatch', 'Users may create only their own API tokens');
    if (body.scopes.some((scope) => !principal.scopes.includes(scope)))
      throw new HttpError(
        403,
        'scope_escalation',
        'A new token cannot exceed the current credential',
      );
    const workspaceId = requiredParam(context, 'workspaceId');
    const membership = await dependencies.repository.getWorkspaceMembership(
      workspaceId,
      principal.userId,
    );
    if (
      !membership ||
      membership.revokedAt ||
      body.scopes.some((scope) => !roleAllows(membership.role, scope))
    )
      throw new HttpError(403, 'scope_escalation', 'A new token cannot exceed the current role');
    const value = await issueApiToken(principal.userId, workspaceId, body);
    await audit(context, {
      workspaceId,
      actorId: principal.userId,
      action: 'identity.api-token-created',
      targetType: 'identity-api-token',
      targetId: value.token.id,
      metadata: { userId: principal.userId, scopes: value.token.scopes },
    });
    return context.json(value, 201);
  });

  const listApiTokens = async (context: AppContext, workspaceId: string, userId: string) => {
    const values = await dependencies.repository.listIdentityApiTokens(
      workspaceId,
      userId,
      numberQuery(context, 'limit', 100, 500),
    );
    return context.json({
      tokens: values.map(({ tokenHash: _tokenHash, ...value }) => value),
    });
  };

  app.get('/v1/operator/workspaces/:workspaceId/users/:userId/api-tokens', (context) =>
    listApiTokens(context, requiredParam(context, 'workspaceId'), requiredParam(context, 'userId')),
  );
  app.get('/v1/admin/workspaces/:workspaceId/api-tokens', (context) => {
    const principal = context.get('humanPrincipal');
    if (!principal)
      throw new HttpError(
        403,
        'human_identity_required',
        'The operator token cannot list personal tokens on this route',
      );
    return listApiTokens(context, requiredParam(context, 'workspaceId'), principal.userId);
  });

  const revokeApiToken = async (
    context: AppContext,
    workspaceId: string,
    userId: string,
    tokenId: string,
  ) => {
    const token = await dependencies.repository.getIdentityApiToken(tokenId);
    if (!token || token.workspaceId !== workspaceId || token.userId !== userId)
      throw new RepositoryNotFoundError('API token not found');
    if (
      !(await dependencies.repository.revokeIdentityApiToken(tokenId, userId, now().toISOString()))
    )
      throw new RepositoryNotFoundError('Active API token not found');
    await audit(context, {
      workspaceId,
      actorId: actor(context),
      action: 'identity.api-token-revoked',
      targetType: 'identity-api-token',
      targetId: tokenId,
      metadata: { userId },
    });
    return context.body(null, 204);
  };

  app.delete('/v1/operator/workspaces/:workspaceId/users/:userId/api-tokens/:tokenId', (context) =>
    revokeApiToken(
      context,
      requiredParam(context, 'workspaceId'),
      requiredParam(context, 'userId'),
      requiredParam(context, 'tokenId'),
    ),
  );

  app.delete('/v1/admin/workspaces/:workspaceId/api-tokens/:tokenId', (context) => {
    const principal = context.get('humanPrincipal');
    if (!principal)
      throw new HttpError(
        403,
        'human_identity_required',
        'The operator token cannot revoke a personal token on this route',
      );
    return revokeApiToken(
      context,
      requiredParam(context, 'workspaceId'),
      principal.userId,
      requiredParam(context, 'tokenId'),
    );
  });

  app.post('/v1/auth/sessions', async (context) => {
    await json(context, CreateUserSessionRequestSchema, dependencies.maxJsonBytes);
    const principal = await authenticateHumanBearer(parseBearer(context));
    if (!principal || principal.credential !== 'api-token')
      throw new HttpError(401, 'api_token_required', 'A valid API token is required');
    const source = await dependencies.repository.getIdentityApiToken(principal.credentialId);
    if (!source || source.revokedAt)
      throw new HttpError(401, 'api_token_required', 'A valid API token is required');
    const createdAt = now();
    const expiresAt = new Date(
      Math.min(
        createdAt.getTime() + dependencies.identity.sessionTtlSeconds * 1_000,
        new Date(source.expiresAt).getTime(),
      ),
    ).toISOString();
    const session: UserSessionRecord = {
      id: makeId('session'),
      userId: principal.userId,
      sourceTokenId: source.id,
      workspaceId: principal.workspaceId,
      scopes: principal.scopes,
      ...(principal.projectId ? { projectId: principal.projectId } : {}),
      ...(principal.channelId ? { channelId: principal.channelId } : {}),
      createdAt: createdAt.toISOString(),
      expiresAt,
    };
    await dependencies.repository.createUserSession(session);
    const credential = await dependencies.identityTokens.issueSession(
      session,
      Math.floor(createdAt.getTime() / 1_000),
    );
    return context.json({ credential, session }, 201);
  });

  app.get('/v1/auth/me', async (context) => {
    const principal = context.get('humanPrincipal')!;
    const user = await dependencies.repository.getUser(principal.userId);
    if (!user) throw new RepositoryNotFoundError('User not found');
    const membership = await dependencies.repository.getWorkspaceMembership(
      principal.workspaceId,
      principal.userId,
    );
    return context.json({ user, principal, membership: membership ?? null });
  });

  app.delete('/v1/auth/sessions/current', async (context) => {
    const principal = context.get('humanPrincipal')!;
    if (principal.credential !== 'session')
      throw new HttpError(409, 'session_required', 'Current credential is not a Session');
    await dependencies.repository.revokeUserSession(
      principal.credentialId,
      principal.userId,
      now().toISOString(),
    );
    return context.body(null, 204);
  });

  app.use('/v1/public/*', async (context, next) => {
    context.header('access-control-allow-origin', '*');
    context.header('access-control-allow-headers', 'authorization, content-type');
    context.header('access-control-allow-methods', 'POST, OPTIONS');
    context.header('access-control-max-age', '86400');
    if (context.req.method === 'OPTIONS') return context.body(null, 204);
    await next();
  });

  app.post('/v1/admin/workspaces', async (context) => {
    const body = await json(context, CreateWorkspaceRequestSchema, dependencies.maxJsonBytes);
    const value = await dependencies.repository.createWorkspace({
      id: body.id ?? makeId('workspace'),
      slug: body.slug,
      name: body.name,
      now: now().toISOString(),
    });
    await audit(context, {
      workspaceId: value.id,
      actorId: actor(context),
      action: 'workspace.created',
      targetType: 'workspace',
      targetId: value.id,
      metadata: { slug: value.slug },
    });
    return context.json({ workspace: value }, 201);
  });

  app.get('/v1/admin/workspaces/:workspaceId', async (context) => {
    const value = await dependencies.repository.getWorkspace(context.req.param('workspaceId'));
    if (!value) throw new RepositoryNotFoundError('Workspace not found');
    return context.json({ workspace: value });
  });

  app.post('/v1/admin/workspaces/:workspaceId/projects', async (context) => {
    const workspaceId = context.req.param('workspaceId');
    const body = await json(context, CreateProjectRequestSchema, dependencies.maxJsonBytes);
    const value = await dependencies.repository.createProject({
      id: body.id ?? makeId('project'),
      workspaceId,
      slug: body.slug,
      name: body.name,
      now: now().toISOString(),
    });
    await audit(context, {
      workspaceId,
      actorId: actor(context),
      action: 'project.created',
      targetType: 'project',
      targetId: value.id,
      metadata: { slug: value.slug },
    });
    return context.json({ project: value }, 201);
  });

  app.get('/v1/admin/workspaces/:workspaceId/projects', async (context) => {
    const projects = await dependencies.repository.listProjects(
      requiredParam(context, 'workspaceId'),
      numberQuery(context, 'limit', 100, 500),
    );
    return context.json({ projects });
  });

  app.get('/v1/admin/workspaces/:workspaceId/projects/:projectId', async (context) => {
    const value = await dependencies.repository.getProject(
      context.req.param('workspaceId'),
      context.req.param('projectId'),
    );
    if (!value) throw new RepositoryNotFoundError('Project not found');
    return context.json({ project: value });
  });

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/studio/scenes',
    async (context) => {
      const limit = numberQuery(context, 'limit', 24, 50);
      const before = studioSceneCursor(context.req.query('cursor'));
      const records = await dependencies.repository.listStudioSceneDocuments({
        workspaceId: requiredParam(context, 'workspaceId'),
        projectId: requiredParam(context, 'projectId'),
        limit: limit + 1,
        ...(before ? { before } : {}),
      });
      const page = records.slice(0, limit);
      const last = page.at(-1);
      return context.json({
        records: page,
        nextCursor:
          records.length > limit && last
            ? encodeStudioSceneCursor({ savedAt: last.savedAt, id: last.id })
            : null,
      });
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/studio/scenes/:sceneId',
    async (context) => {
      const record = await dependencies.repository.getStudioSceneDocument(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        requiredParam(context, 'sceneId'),
      );
      if (!record) throw new RepositoryNotFoundError('Hosted Studio Scene not found');
      return context.json({ record });
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/studio/scenes/:sceneId/versions',
    async (context) => {
      const before = context.req.query('beforeRevision');
      const beforeRevision = before === undefined ? undefined : Number(before);
      if (
        beforeRevision !== undefined &&
        (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1)
      ) {
        throw new HttpError(
          400,
          'invalid_revision_cursor',
          'Hosted Studio revision cursor is invalid',
        );
      }
      const limit = numberQuery(context, 'limit', 24, 50);
      const records = await dependencies.repository.listStudioSceneVersions({
        workspaceId: requiredParam(context, 'workspaceId'),
        projectId: requiredParam(context, 'projectId'),
        sceneId: requiredParam(context, 'sceneId'),
        limit: limit + 1,
        ...(beforeRevision ? { beforeRevision } : {}),
      });
      const page = records.slice(0, limit);
      return context.json({
        records: page,
        nextRevision:
          records.length > limit && page.length ? (page.at(-1)?.revision ?? null) : null,
      });
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/studio/scenes/:sceneId/versions/:revision',
    async (context) => {
      const revision = Number(requiredParam(context, 'revision'));
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new HttpError(400, 'invalid_revision', 'Hosted Studio revision is invalid');
      }
      const record = await dependencies.repository.getStudioSceneVersion(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        requiredParam(context, 'sceneId'),
        revision,
      );
      if (!record) throw new RepositoryNotFoundError('Hosted Studio Scene revision not found');
      return context.json({ record });
    },
  );

  app.put(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/studio/scenes',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const body = await json(context, PutStudioWorkspaceRequestSchema, MAX_STUDIO_DOCUMENT_BYTES);
      if (body.project && body.project.document.project.id !== projectId) {
        throw new HttpError(
          422,
          'project_mismatch',
          'Hosted Studio Project id must match the route',
        );
      }
      if (scanStructuredValue(body, { blockAt: 'high', now }).status === 'blocked') {
        throw new HttpError(
          422,
          'privacy_blocked',
          'Hosted Studio working state contains sensitive material that cannot be persisted',
        );
      }
      const value = await dependencies.repository.putStudioWorkspace({
        workspaceId,
        projectId,
        writes: body.writes,
        ...(body.project ? { project: body.project } : {}),
        actorId: actor(context),
        now: now().toISOString(),
      });
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'studio.scenes-saved',
        targetType: 'studio-project',
        targetId: projectId,
        metadata: {
          sceneIds: value.records.map((record) => record.id),
          revisions: value.records.map((record) => record.revision),
          projectUpdated: Boolean(value.project),
        },
      });
      return context.json(value);
    },
  );

  app.delete(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/studio/scenes/:sceneId',
    async (context) => {
      const expectedRevision = Number(context.req.query('expectedRevision'));
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new HttpError(
          400,
          'expected_revision_required',
          'A valid expectedRevision query is required',
        );
      }
      const workspaceId = requiredParam(context, 'workspaceId');
      const sceneId = requiredParam(context, 'sceneId');
      const deleted = await dependencies.repository.deleteStudioSceneDocument({
        workspaceId,
        projectId: requiredParam(context, 'projectId'),
        sceneId,
        expectedRevision,
      });
      if (!deleted) {
        throw new RepositoryConflictError('Hosted Studio Scene changed before deletion');
      }
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'studio.scene-deleted',
        targetType: 'studio-scene',
        targetId: sceneId,
        metadata: { expectedRevision },
      });
      return context.body(null, 204);
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/studio/project',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const [document, project] = await Promise.all([
        dependencies.repository.getStudioProjectDocument(workspaceId, projectId),
        dependencies.repository.getProject(workspaceId, projectId),
      ]);
      if (!project) throw new RepositoryNotFoundError('Project not found');
      return context.json({ document: document ?? null, project });
    },
  );

  app.put(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/studio/project',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const body = await json(context, PutStudioProjectRequestSchema, MAX_STUDIO_DOCUMENT_BYTES);
      if (body.document.project.id !== projectId) {
        throw new HttpError(
          422,
          'project_mismatch',
          'Hosted Studio Project id must match the route',
        );
      }
      if (scanStructuredValue(body, { blockAt: 'high', now }).status === 'blocked') {
        throw new HttpError(
          422,
          'privacy_blocked',
          'Hosted Studio Project settings contain sensitive material that cannot be persisted',
        );
      }
      const document = await dependencies.repository.putStudioProjectDocument({
        workspaceId,
        projectId,
        ...body,
        actorId: actor(context),
        now: now().toISOString(),
      });
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'studio.project-saved',
        targetType: 'studio-project',
        targetId: projectId,
        metadata: { revision: document.revision },
      });
      return context.json({ document });
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/repositories',
    async (context) => {
      const workspaceId = context.req.param('workspaceId');
      const projectId = context.req.param('projectId');
      const body = await json(context, BindRepositoryRequestSchema, dependencies.maxJsonBytes);
      const value = await dependencies.repository.bindRepository({
        id: makeId('repository'),
        workspaceId,
        projectId,
        repository: body.repository,
        workflowRefPattern: body.workflowRefPattern,
        createdAt: now().toISOString(),
      });
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'repository.bound',
        targetType: 'repository',
        targetId: value.id,
        metadata: { repository: value.repository, workflowRefPattern: value.workflowRefPattern },
      });
      return context.json({ repository: value }, 201);
    },
  );

  app.get('/v1/admin/workspaces/:workspaceId/projects/:projectId/repositories', async (context) => {
    const repositories = await dependencies.repository.listRepositoryBindings(
      requiredParam(context, 'workspaceId'),
      requiredParam(context, 'projectId'),
      numberQuery(context, 'limit', 100, 500),
    );
    return context.json({ repositories });
  });

  const activeGitHubInstallation = async (
    workspaceId: string,
    projectId: string,
    installationBindingId: string,
  ) => {
    const installation = await dependencies.repository.getGitHubInstallationBinding(
      workspaceId,
      projectId,
      installationBindingId,
    );
    if (!installation) throw new RepositoryNotFoundError('GitHub installation binding not found');
    if (installation.revokedAt)
      throw new HttpError(
        403,
        'github_installation_revoked',
        'GitHub installation binding has been revoked',
      );
    const repository = await dependencies.repository.getRepositoryBindingById(
      workspaceId,
      projectId,
      installation.repositoryBindingId,
    );
    if (!repository) throw new RepositoryNotFoundError('Repository binding not found');
    const live = await githubSource.inspectInstallation({
      installationId: installation.installationId,
      repository: repository.repository,
    });
    if (
      live.repositoryId !== installation.githubRepositoryId ||
      live.repository.toLowerCase() !== repository.repository.toLowerCase()
    ) {
      throw new GitHubSourceError(
        'github_repository_mismatch',
        'GitHub installation no longer resolves the bound repository',
      );
    }
    return { installation, repository };
  };

  const githubCheckScope = async (
    workspaceId: string,
    projectId: string,
    repositoryName: string,
  ) => {
    const repository = await dependencies.repository.getRepositoryBinding(
      workspaceId,
      projectId,
      repositoryName,
    );
    if (!repository) return undefined;
    const installation =
      await dependencies.repository.getActiveGitHubInstallationBindingForRepository(
        workspaceId,
        projectId,
        repository.id,
      );
    if (!installation) return undefined;
    return activeGitHubInstallation(workspaceId, projectId, installation.id);
  };

  const githubCheckExternalId = (
    workspaceId: string,
    projectId: string,
    repository: string,
    commitSha: string,
    buildId: string,
    buildArtifactHash: string,
    reviewIdentity: string,
  ): string =>
    `scenebook:${sha256(
      `${workspaceId}\0${projectId}\0${repository.toLowerCase()}\0${commitSha}\0${buildId}\0${buildArtifactHash}\0${reviewIdentity}`,
    )}`;

  const ensureGitHubCheck = async (input: {
    workspaceId: string;
    projectId: string;
    repository: string;
    commitSha: string;
    buildId: string;
    buildArtifactHash: string;
    reviewIdentity: string;
    status: 'in_progress' | 'completed';
    conclusion?: 'success' | 'failure' | 'cancelled';
    title: string;
    summary: string;
  }): Promise<GitHubCheckRunResult | undefined> => {
    const scope = await githubCheckScope(input.workspaceId, input.projectId, input.repository);
    if (!scope) return undefined;
    if (!/^[a-f0-9]{40}$/u.test(input.commitSha)) {
      throw new GitHubSourceError(
        'github_commit_mismatch',
        'GitHub Check Runs require the exact 40-character repository commit SHA',
      );
    }
    const externalId = githubCheckExternalId(
      input.workspaceId,
      input.projectId,
      scope.repository.repository,
      input.commitSha,
      input.buildId,
      input.buildArtifactHash,
      input.reviewIdentity,
    );
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new GitHubSourceError(
            'github_unavailable',
            'GitHub Check reconciliation exceeded its end-to-end deadline',
            true,
          ),
        ),
      githubCheckReconcileTimeoutMs,
    );
    timeout.unref?.();
    try {
      return await dependencies.repository.withGitHubCheckRunLock(
        `${scope.installation.installationId}\0${scope.repository.repository.toLowerCase()}\0${input.commitSha}\0${externalId}`,
        () =>
          githubSource.ensureCheckRun({
            installationId: scope.installation.installationId,
            repository: scope.repository.repository,
            state: {
              externalId,
              commitSha: input.commitSha,
              status: input.status,
              ...(input.conclusion ? { conclusion: input.conclusion } : {}),
              title: input.title,
              summary: input.summary,
              detailsUrl: new URL('/console', dependencies.publicBaseUrl).toString(),
            },
            signal: controller.signal,
          }),
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  const syncGitHubCheckForBuild = async (
    workspaceId: string,
    projectId: string,
    build: VerificationBuildRecord,
    review?: ReviewRecord,
  ): Promise<GitHubCheckRunResult | undefined> => {
    if (build.build.repository.provider !== 'github') return undefined;
    if (build.build.status === 'changed' && !review) return undefined;
    const reviewHash = review ? canonicalJsonHash(review.review) : undefined;
    const reviewIdentity = canonicalJsonHash(
      review
        ? {
            id: review.review.id,
            subject: review.review.subject,
            openedAt: review.review.openedAt,
            producer: review.review.producer,
          }
        : { kind: 'no-review', buildId: build.id, revision: build.artifactHash },
    );
    let status: 'in_progress' | 'completed';
    let conclusion: 'success' | 'failure' | 'cancelled' | undefined;
    if (build.build.status === 'failed' || build.build.status === 'blocked') {
      status = 'completed';
      conclusion = 'failure';
    } else if (build.build.status === 'cancelled') {
      status = 'completed';
      conclusion = 'cancelled';
    } else if (review?.review.status === 'approved') {
      status = 'completed';
      conclusion = 'success';
    } else if (
      review?.review.status === 'changes-requested' ||
      review?.review.status === 'rejected'
    ) {
      status = 'completed';
      conclusion = 'failure';
    } else if (review?.review.status === 'closed') {
      status = 'completed';
      conclusion = 'cancelled';
    } else if (build.build.status === 'changed' || review?.review.status === 'open') {
      status = 'in_progress';
    } else {
      status = 'completed';
      conclusion = 'success';
    }
    const reviewLine = review
      ? ` Review ${review.review.id} is ${review.review.status} (${reviewHash}).`
      : build.build.status === 'changed'
        ? ' Human review is required before this Check can complete.'
        : '';
    return ensureGitHubCheck({
      workspaceId,
      projectId,
      repository: build.build.repository.repository,
      commitSha: build.build.repository.commit,
      buildId: build.id,
      buildArtifactHash: build.artifactHash,
      reviewIdentity,
      status,
      ...(conclusion ? { conclusion } : {}),
      title:
        status === 'in_progress'
          ? 'Scenebook verification is awaiting review'
          : conclusion === 'success'
            ? 'Scenebook verification passed'
            : conclusion === 'cancelled'
              ? 'Scenebook verification was cancelled'
              : 'Scenebook verification failed',
      summary: `Build ${build.id} is ${build.build.status} (${build.artifactHash}).${reviewLine}`,
    });
  };

  const syncGitHubCheckForReview = async (
    workspaceId: string,
    projectId: string,
    review: ReviewRecord,
  ): Promise<GitHubCheckRunResult | undefined> => {
    if (review.review.subject.kind !== 'build') return undefined;
    const build = await dependencies.repository.getVerificationBuild(
      workspaceId,
      projectId,
      review.review.subject.id,
    );
    if (!build || build.artifactHash !== review.review.subject.revision) {
      throw new RepositoryConflictError(
        'Review no longer resolves its exact immutable Build for GitHub Check synchronization',
      );
    }
    return syncGitHubCheckForBuild(workspaceId, projectId, build, review);
  };

  const startGitHubChangeLeaseHeartbeat = (input: {
    workspaceId: string;
    projectId: string;
    changeId: string;
    leaseId: string;
    initialRequestStartedAt: number;
    initialLeaseExpiresAt: string;
  }) => {
    const controller = new AbortController();
    const heartbeatMs = Math.max(10, Math.floor(githubChangeLeaseMs / 3));
    const watchdogMs = Math.max(10, Math.floor(githubChangeLeaseMs * 0.8));
    let stopped = false;
    let loss: GitHubSourceError | undefined;
    let inFlight: Promise<void> | undefined;
    let watchdog: ReturnType<typeof setTimeout>;

    const lose = (error?: unknown): GitHubSourceError => {
      const value =
        error instanceof GitHubSourceError && error.code === 'github_lease_lost'
          ? error
          : new GitHubSourceError(
              'github_lease_lost',
              'GitHub source change lease ownership was lost',
            );
      if (!stopped && !loss) {
        loss = value;
        controller.abort(value);
        clearTimeout(watchdog);
      }
      return loss ?? value;
    };

    const armWatchdog = (requestStartedAt: number, leaseExpiresAt: string): void => {
      clearTimeout(watchdog);
      if (stopped || loss) return;
      const requestBudget = watchdogMs - (performance.now() - requestStartedAt);
      const repositoryBudget = (new Date(leaseExpiresAt).getTime() - Date.now()) * 0.8;
      const delay = Math.floor(Math.min(requestBudget, repositoryBudget));
      if (!Number.isFinite(delay) || delay <= 0) {
        lose();
        return;
      }
      watchdog = setTimeout(() => lose(), delay);
      watchdog.unref?.();
    };

    const renew = async (): Promise<void> => {
      if (stopped) return;
      if (loss || controller.signal.aborted) throw lose(loss);
      const requestStartedAt = performance.now();
      let renewed: Awaited<ReturnType<typeof dependencies.repository.renewGitHubSourceChangeLease>>;
      try {
        renewed = await dependencies.repository.renewGitHubSourceChangeLease({
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          changeId: input.changeId,
          leaseId: input.leaseId,
          leaseDurationMs: githubChangeLeaseMs,
        });
      } catch (error) {
        throw lose(error);
      }
      if (!renewed.leaseExpiresAt) throw lose();
      if (!stopped && !loss) armWatchdog(requestStartedAt, renewed.leaseExpiresAt);
    };

    const renewOnce = (): Promise<void> => {
      if (!inFlight) {
        inFlight = renew().finally(() => {
          inFlight = undefined;
        });
      }
      return inFlight;
    };

    armWatchdog(input.initialRequestStartedAt, input.initialLeaseExpiresAt);
    const interval = setInterval(() => {
      void renewOnce().catch((error) => lose(error));
    }, heartbeatMs);
    interval.unref?.();

    return {
      signal: controller.signal,
      async assertLease(): Promise<void> {
        if (loss || controller.signal.aborted) throw lose(loss);
        await renewOnce();
        if (loss || controller.signal.aborted) throw lose(loss);
      },
      error(): GitHubSourceError | undefined {
        return loss;
      },
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        clearInterval(interval);
        clearTimeout(watchdog);
        await inFlight?.catch(() => undefined);
      },
    };
  };

  const safeGitHubChange = (
    change: Awaited<ReturnType<typeof dependencies.repository.getGitHubSourceChange>>,
  ) => {
    if (!change) throw new RepositoryNotFoundError('GitHub source change not found');
    return {
      id: change.id,
      status: change.status,
      baseCommitSha: change.baseCommitSha,
      baseBlobSha: change.baseBlobSha,
      patchHash: change.patchHash,
      branch: change.branch,
      attempts: change.attempts,
      createdAt: change.createdAt,
      updatedAt: change.updatedAt,
      ...(change.headCommitSha ? { headCommitSha: change.headCommitSha } : {}),
      ...(change.headBlobSha ? { headBlobSha: change.headBlobSha } : {}),
      ...(change.pullRequestNumber
        ? { pullRequestNumber: change.pullRequestNumber, pullRequestUrl: change.pullRequestUrl }
        : {}),
      ...(change.issueNumber ? { issueNumber: change.issueNumber, issueUrl: change.issueUrl } : {}),
      ...(change.failureCode ? { failureCode: change.failureCode } : {}),
      evidenceBinding: change.evidenceBinding,
    };
  };

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/github/installations',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const body = await json(
        context,
        BindGitHubInstallationRequestSchema,
        dependencies.maxJsonBytes,
      );
      const repository = await dependencies.repository.getRepositoryBindingById(
        workspaceId,
        projectId,
        body.repositoryBindingId,
      );
      if (!repository) throw new RepositoryNotFoundError('Repository binding not found');
      const live = await githubSource.inspectInstallation({
        installationId: body.installationId,
        repository: repository.repository,
      });
      if (live.repository.toLowerCase() !== repository.repository.toLowerCase()) {
        throw new GitHubSourceError(
          'github_repository_mismatch',
          'GitHub installation repository does not match the repository binding',
        );
      }
      const current = now().toISOString();
      const value = await dependencies.repository.putGitHubInstallationBinding({
        id: makeId('github-installation'),
        workspaceId,
        projectId,
        repositoryBindingId: repository.id,
        installationId: body.installationId,
        githubRepositoryId: live.repositoryId,
        defaultBranch: live.defaultBranch,
        createdBy: actor(context),
        createdAt: current,
        updatedAt: current,
        version: 1,
      });
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'github-installation.bound',
        targetType: 'github-installation',
        targetId: value.id,
        metadata: {
          projectId,
          repositoryBindingId: repository.id,
          githubRepositoryId: value.githubRepositoryId,
        },
      });
      return context.json(
        {
          installation: {
            id: value.id,
            repositoryBindingId: value.repositoryBindingId,
            githubRepositoryId: value.githubRepositoryId,
            defaultBranch: value.defaultBranch,
            createdAt: value.createdAt,
            updatedAt: value.updatedAt,
            version: value.version,
          },
        },
        201,
      );
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/github/installations',
    async (context) => {
      const values = await dependencies.repository.listGitHubInstallationBindings(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        numberQuery(context, 'limit', 100, 500),
      );
      return context.json({
        installations: values.map((value) => ({
          id: value.id,
          repositoryBindingId: value.repositoryBindingId,
          githubRepositoryId: value.githubRepositoryId,
          defaultBranch: value.defaultBranch,
          version: value.version,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt,
          ...(value.revokedAt ? { revokedAt: value.revokedAt } : {}),
        })),
      });
    },
  );

  app.delete(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/github/installations/:installationBindingId',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const body = await json(
        context,
        RevokeGitHubInstallationRequestSchema,
        dependencies.maxJsonBytes,
      );
      const value = await dependencies.repository.revokeGitHubInstallationBinding({
        workspaceId,
        projectId,
        bindingId: requiredParam(context, 'installationBindingId'),
        expectedVersion: body.expectedVersion,
        now: now().toISOString(),
      });
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'github-installation.revoked',
        targetType: 'github-installation',
        targetId: value.id,
        metadata: { projectId, repositoryBindingId: value.repositoryBindingId },
      });
      return context.json({
        installation: {
          id: value.id,
          repositoryBindingId: value.repositoryBindingId,
          version: value.version,
          revokedAt: value.revokedAt,
        },
      });
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/github/source/read',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const body = await json(context, ReadGitHubSourceRequestSchema, dependencies.maxJsonBytes);
      const { installation, repository } = await activeGitHubInstallation(
        workspaceId,
        projectId,
        body.installationBindingId,
      );
      const source = await githubSource.readSource({
        installationId: installation.installationId,
        repository: repository.repository,
        commitSha: body.commitSha,
        path: body.path,
      });
      context.header('cache-control', 'no-store');
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'github-source.read',
        targetType: 'github-installation',
        targetId: installation.id,
        metadata: {
          projectId,
          commitSha: source.commitSha,
          blobSha: source.blobSha,
          byteLength: source.byteLength,
          pathHash: dependencies.hasher.hash(body.path, 'github-source-path'),
        },
      });
      return context.json({ source });
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/github/changes',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const key = idempotencyKey(context);
      const body = await json(
        context,
        CreateGitHubSourceChangeRequestSchema,
        dependencies.maxJsonBytes,
      );
      const { installation, repository } = await activeGitHubInstallation(
        workspaceId,
        projectId,
        body.installationBindingId,
      );
      const evidenceBinding: Record<string, string> = {};
      if (body.evidence?.runId) {
        const run = await dependencies.repository.getVerificationRun(
          workspaceId,
          projectId,
          body.evidence.runId,
        );
        if (!run || run.artifactHash !== body.evidence.runArtifactHash)
          throw new HttpError(
            422,
            'evidence_binding_mismatch',
            'Run evidence binding is not exact',
          );
        evidenceBinding.runId = run.id;
        evidenceBinding.runArtifactHash = run.artifactHash;
      }
      if (body.evidence?.buildId) {
        const build = await dependencies.repository.getVerificationBuild(
          workspaceId,
          projectId,
          body.evidence.buildId,
        );
        if (!build || build.artifactHash !== body.evidence.buildArtifactHash)
          throw new HttpError(
            422,
            'evidence_binding_mismatch',
            'Build evidence binding is not exact',
          );
        evidenceBinding.buildId = build.id;
        evidenceBinding.buildArtifactHash = build.artifactHash;
      }
      if (body.evidence?.reviewId) {
        const review = await dependencies.repository.getReview(
          workspaceId,
          projectId,
          body.evidence.reviewId,
        );
        const reviewHash = review ? canonicalJsonHash(review.review) : undefined;
        if (!review || reviewHash !== body.evidence.reviewHash)
          throw new HttpError(
            422,
            'evidence_binding_mismatch',
            'Review evidence binding is not exact',
          );
        evidenceBinding.reviewId = review.review.id;
        evidenceBinding.reviewHash = reviewHash!;
      }
      const requestHash = canonicalJsonHash({
        projectId,
        body,
        repositoryBindingId: repository.id,
        githubRepositoryId: installation.githubRepositoryId,
        evidenceBinding,
      });
      const changeId = `github-change-${sha256(`${workspaceId}\0${key}`).slice(0, 24)}`;
      const current = now();
      const leaseId = makeId('github-lease');
      const claimStartedAt = performance.now();
      const claim = await dependencies.repository.claimGitHubSourceChange({
        record: {
          id: changeId,
          workspaceId,
          projectId,
          installationBindingId: installation.id,
          idempotencyKey: key,
          requestHash,
          status: 'pending',
          path: body.path,
          baseCommitSha: body.baseCommitSha,
          baseBlobSha: body.expectedBlobSha,
          patchHash: canonicalJsonHash(body.operations),
          branch: `scenebook/${changeId}`,
          title: body.title,
          createReviewIssue: body.createReviewIssue,
          evidenceBinding,
          createdBy: actor(context),
          createdAt: current.toISOString(),
          updatedAt: current.toISOString(),
          attempts: 0,
        },
        leaseId,
        leaseDurationMs: githubChangeLeaseMs,
      });
      if (!claim.claimed) {
        if (claim.record.status === 'succeeded')
          return context.json({ change: safeGitHubChange(claim.record) });
        throw new HttpError(
          409,
          'github_change_in_progress',
          'This GitHub source change is already being processed',
        );
      }
      let completed: NonNullable<
        Awaited<ReturnType<typeof dependencies.repository.getGitHubSourceChange>>
      >;
      const heartbeat = startGitHubChangeLeaseHeartbeat({
        workspaceId,
        projectId,
        changeId,
        leaseId,
        initialRequestStartedAt: claimStartedAt,
        initialLeaseExpiresAt: claim.record.leaseExpiresAt!,
      });
      try {
        const result = await githubSource.applyChange({
          changeId,
          installationId: installation.installationId,
          repository: repository.repository,
          defaultBranch: installation.defaultBranch,
          baseCommitSha: body.baseCommitSha,
          expectedBlobSha: body.expectedBlobSha,
          path: body.path,
          operations: body.operations,
          title: body.title,
          createReviewIssue: body.createReviewIssue,
          ...(Object.keys(evidenceBinding).length > 0 ? { evidence: evidenceBinding } : {}),
          signal: heartbeat.signal,
          assertLease: heartbeat.assertLease,
        });
        await heartbeat.assertLease();
        completed = await dependencies.repository.completeGitHubSourceChange({
          workspaceId,
          projectId,
          changeId,
          leaseId,
          result,
        });
        await heartbeat.stop();
      } catch (error) {
        let reportedError: unknown = heartbeat.error() ?? error;
        await heartbeat.stop();
        let failureCode =
          reportedError instanceof GitHubSourceError ? reportedError.code : 'unexpected';
        try {
          await dependencies.repository.failGitHubSourceChange({
            workspaceId,
            projectId,
            changeId,
            leaseId,
            failureCode,
          });
        } catch (failureError) {
          if (failureError instanceof RepositoryConflictError) {
            reportedError = new GitHubSourceError(
              'github_lease_lost',
              'GitHub source change lease ownership was lost',
            );
            failureCode = 'github_lease_lost';
          } else {
            throw failureError;
          }
        }
        await audit(context, {
          workspaceId,
          actorId: actor(context),
          action: 'github-source.change-failed',
          targetType: 'github-source-change',
          targetId: changeId,
          metadata: {
            projectId,
            repositoryBindingId: repository.id,
            failureCode,
            patchHash: canonicalJsonHash(body.operations),
            pathHash: dependencies.hasher.hash(body.path, 'github-source-path'),
          },
        });
        throw reportedError;
      } finally {
        await heartbeat.stop();
      }
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'github-source.change-succeeded',
        targetType: 'github-source-change',
        targetId: changeId,
        metadata: {
          projectId,
          repositoryBindingId: repository.id,
          baseCommitSha: completed.baseCommitSha,
          baseBlobSha: completed.baseBlobSha,
          headCommitSha: completed.headCommitSha,
          headBlobSha: completed.headBlobSha,
          patchHash: completed.patchHash,
          pathHash: dependencies.hasher.hash(body.path, 'github-source-path'),
          pullRequestNumber: completed.pullRequestNumber,
          issueNumber: completed.issueNumber,
          evidenceBinding,
        },
      });
      return context.json({ change: safeGitHubChange(completed) }, 201);
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/github/changes/:changeId',
    async (context) => {
      const change = await dependencies.repository.getGitHubSourceChange(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        requiredParam(context, 'changeId'),
      );
      context.header('cache-control', 'no-store');
      return context.json({ change: safeGitHubChange(change) });
    },
  );

  const scheduleResponse = (
    schedule: Awaited<ReturnType<typeof dependencies.repository.getVerificationSchedule>>,
  ) => {
    if (!schedule) throw new RepositoryNotFoundError('Verification Schedule not found');
    return { ...schedule, freshness: scheduleFreshness(schedule, now()) };
  };

  const runnerResponse = (runner: VerificationRunnerRecord) => {
    const { tokenHash: _tokenHash, ...safe } = runner;
    return safe;
  };

  app.post('/v1/admin/workspaces/:workspaceId/projects/:projectId/schedules', async (context) => {
    const workspaceId = requiredParam(context, 'workspaceId');
    const projectId = requiredParam(context, 'projectId');
    const body = await json(
      context,
      CreateVerificationScheduleRequestSchema,
      dependencies.maxJsonBytes,
    );
    const binding = await dependencies.repository.getRepositoryBindingById(
      workspaceId,
      projectId,
      body.repositoryBindingId,
    );
    if (!binding) throw new RepositoryNotFoundError('Repository binding not found');
    const current = now();
    const nextDueAt = body.startsAt ? new Date(body.startsAt) : current;
    if (
      nextDueAt.getTime() < current.getTime() ||
      nextDueAt.getTime() > current.getTime() + 31_536_000_000
    ) {
      throw new HttpError(
        422,
        'schedule_start_out_of_range',
        'Schedule startsAt must be between now and one year from now',
      );
    }
    const timestamp = current.toISOString();
    const value = await dependencies.repository.createVerificationSchedule({
      id: body.id ?? makeId('schedule'),
      workspaceId,
      projectId,
      repositoryBindingId: binding.id,
      name: body.name,
      sourceRef: body.sourceRef,
      environmentId: body.environmentId,
      runTargetIds: body.runTargetIds,
      intervalSeconds: body.intervalSeconds,
      freshnessTargetSeconds: body.freshnessTargetSeconds,
      maxRuntimeSeconds: body.maxRuntimeSeconds,
      maxAttempts: body.maxAttempts,
      status: 'active',
      nextDueAt: nextDueAt.toISOString(),
      createdBy: actor(context),
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    });
    await audit(context, {
      workspaceId,
      actorId: actor(context),
      action: 'verification.schedule-created',
      targetType: 'verification-schedule',
      targetId: value.id,
      metadata: {
        projectId,
        repositoryBindingId: binding.id,
        repository: binding.repository,
        sourceRef: value.sourceRef,
        environmentId: value.environmentId,
        runTargetIds: value.runTargetIds,
        intervalSeconds: value.intervalSeconds,
      },
    });
    return context.json({ schedule: scheduleResponse(value) }, 201);
  });

  app.get('/v1/admin/workspaces/:workspaceId/projects/:projectId/schedules', async (context) => {
    const schedules = await dependencies.repository.listVerificationSchedules(
      requiredParam(context, 'workspaceId'),
      requiredParam(context, 'projectId'),
      numberQuery(context, 'limit', 100, 500),
    );
    return context.json({ schedules: schedules.map((schedule) => scheduleResponse(schedule)) });
  });

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/schedules/:scheduleId',
    async (context) => {
      const schedule = await dependencies.repository.getVerificationSchedule(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        requiredParam(context, 'scheduleId'),
      );
      return context.json({ schedule: scheduleResponse(schedule) });
    },
  );

  app.patch(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/schedules/:scheduleId',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const scheduleId = requiredParam(context, 'scheduleId');
      const body = await json(
        context,
        UpdateVerificationScheduleRequestSchema,
        dependencies.maxJsonBytes,
      );
      const current = await dependencies.repository.getVerificationSchedule(
        workspaceId,
        projectId,
        scheduleId,
      );
      if (!current) throw new RepositoryNotFoundError('Verification Schedule not found');
      if (
        (body.freshnessTargetSeconds ?? current.freshnessTargetSeconds) <
        (body.intervalSeconds ?? current.intervalSeconds)
      ) {
        throw new HttpError(
          422,
          'freshness_target_invalid',
          'freshnessTargetSeconds cannot be shorter than intervalSeconds',
        );
      }
      const { expectedVersion, ...patch } = body;
      const value = await dependencies.repository.updateVerificationSchedule({
        workspaceId,
        projectId,
        scheduleId,
        expectedVersion,
        patch,
        now: now().toISOString(),
      });
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'verification.schedule-updated',
        targetType: 'verification-schedule',
        targetId: value.id,
        metadata: { projectId, previousVersion: expectedVersion, version: value.version },
      });
      return context.json({ schedule: scheduleResponse(value) });
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/schedules/:scheduleId/pause',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const value = await dependencies.repository.setVerificationScheduleStatus({
        workspaceId,
        projectId: requiredParam(context, 'projectId'),
        scheduleId: requiredParam(context, 'scheduleId'),
        status: 'paused',
        now: now().toISOString(),
      });
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'verification.schedule-paused',
        targetType: 'verification-schedule',
        targetId: value.id,
        metadata: { version: value.version },
      });
      return context.json({ schedule: scheduleResponse(value) });
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/schedules/:scheduleId/resume',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const body = await json(
        context,
        ResumeVerificationScheduleRequestSchema,
        dependencies.maxJsonBytes,
      );
      const current = now();
      const nextDueAt = body.nextDueAt ? new Date(body.nextDueAt) : current;
      if (
        nextDueAt.getTime() < current.getTime() ||
        nextDueAt.getTime() > current.getTime() + 31_536_000_000
      ) {
        throw new HttpError(
          422,
          'schedule_resume_out_of_range',
          'Resume nextDueAt must be between now and one year from now',
        );
      }
      const value = await dependencies.repository.setVerificationScheduleStatus({
        workspaceId,
        projectId: requiredParam(context, 'projectId'),
        scheduleId: requiredParam(context, 'scheduleId'),
        status: 'active',
        nextDueAt: nextDueAt.toISOString(),
        now: current.toISOString(),
      });
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'verification.schedule-resumed',
        targetType: 'verification-schedule',
        targetId: value.id,
        metadata: { nextDueAt: value.nextDueAt, version: value.version },
      });
      return context.json({ schedule: scheduleResponse(value) });
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/schedules/:scheduleId/trigger',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const scheduleId = requiredParam(context, 'scheduleId');
      const schedule = await dependencies.repository.getVerificationSchedule(
        workspaceId,
        projectId,
        scheduleId,
      );
      if (!schedule) throw new RepositoryNotFoundError('Verification Schedule not found');
      const binding = await dependencies.repository.getRepositoryBindingById(
        workspaceId,
        projectId,
        schedule.repositoryBindingId,
      );
      if (!binding) throw new RepositoryNotFoundError('Repository binding not found');
      const key = idempotencyKey(context);
      const identity = manualJobIdentity(schedule.id, key);
      const timestamp = now().toISOString();
      const value = await dependencies.repository.createManualVerificationJob({
        id: identity.id,
        workspaceId,
        projectId,
        scheduleId,
        reason: 'manual',
        state: 'queued',
        idempotencyKey: `manual:${key}`,
        execution: {
          protocolVersion: 1,
          repository: binding.repository,
          sourceRef: schedule.sourceRef,
          environmentId: schedule.environmentId,
          runTargetIds: schedule.runTargetIds,
          expectedBuildId: identity.expectedBuildId,
        },
        dueAt: timestamp,
        availableAt: timestamp,
        attempts: 0,
        maxAttempts: schedule.maxAttempts,
        createdBy: actor(context),
        createdAt: timestamp,
      });
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'verification.job-manually-triggered',
        targetType: 'verification-job',
        targetId: value.id,
        metadata: {
          scheduleId,
          idempotencyKey: key,
          expectedBuildId: value.execution.expectedBuildId,
        },
      });
      return context.json({ job: value }, 201);
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/verification-jobs',
    async (context) => {
      const scheduleId = context.req.query('scheduleId');
      if (scheduleId && !IdSchema.safeParse(scheduleId).success)
        throw new HttpError(400, 'invalid_query', 'scheduleId must be a valid identifier');
      const jobs = await dependencies.repository.listVerificationJobs(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        scheduleId,
        numberQuery(context, 'limit', 100, 500),
      );
      return context.json({ jobs });
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/verification-jobs/:jobId',
    async (context) => {
      const job = await dependencies.repository.getVerificationJob(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        requiredParam(context, 'jobId'),
      );
      if (!job) throw new RepositoryNotFoundError('Verification Job not found');
      return context.json({ job });
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/verification-jobs/:jobId/cancel',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const body = await json(
        context,
        CancelVerificationJobRequestSchema,
        dependencies.maxJsonBytes,
      );
      const result = {
        outcome: 'runner-failed' as const,
        failureCode: 'cancelled' as const,
        failureDetail: body.reason,
      };
      const value = await dependencies.repository.cancelVerificationJob({
        workspaceId,
        projectId: requiredParam(context, 'projectId'),
        jobId: requiredParam(context, 'jobId'),
        result,
        resultHash: canonicalJsonHash(result),
        now: now().toISOString(),
      });
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'verification.job-cancelled',
        targetType: 'verification-job',
        targetId: value.id,
        metadata: { scheduleId: value.scheduleId, reason: body.reason },
      });
      return context.json({ job: value });
    },
  );

  app.post('/v1/admin/workspaces/:workspaceId/projects/:projectId/runners', async (context) => {
    const workspaceId = requiredParam(context, 'workspaceId');
    const projectId = requiredParam(context, 'projectId');
    const body = await json(
      context,
      CreateVerificationRunnerRequestSchema,
      dependencies.maxJsonBytes,
    );
    const expiresAt = boundedExpiry(
      body.expiresAt,
      dependencies.identity.apiTokenMaxTtlSeconds,
      'Verification Runner credential',
    );
    for (const scheduleId of body.scheduleIds) {
      if (
        !(await dependencies.repository.getVerificationSchedule(workspaceId, projectId, scheduleId))
      )
        throw new RepositoryNotFoundError(`Verification Schedule not found: ${scheduleId}`);
    }
    const runnerId = body.id ?? makeId('runner');
    const credential = dependencies.runnerTokens.create(runnerId);
    const value = await dependencies.repository.createVerificationRunner({
      id: runnerId,
      workspaceId,
      projectId,
      name: body.name,
      tokenHash: credential.tokenHash,
      scheduleIds: [...body.scheduleIds].sort(),
      createdBy: actor(context),
      createdAt: now().toISOString(),
      expiresAt,
    });
    await audit(context, {
      workspaceId,
      actorId: actor(context),
      action: 'verification.runner-created',
      targetType: 'verification-runner',
      targetId: value.id,
      metadata: { projectId, scheduleIds: value.scheduleIds, expiresAt: value.expiresAt },
    });
    return context.json({ runner: runnerResponse(value), credential: credential.token }, 201);
  });

  app.get('/v1/admin/workspaces/:workspaceId/projects/:projectId/runners', async (context) => {
    const runners = await dependencies.repository.listVerificationRunners(
      requiredParam(context, 'workspaceId'),
      requiredParam(context, 'projectId'),
      numberQuery(context, 'limit', 100, 500),
    );
    return context.json({ runners: runners.map(runnerResponse) });
  });

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/runners/:runnerId/rotate-token',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const runnerId = requiredParam(context, 'runnerId');
      const credential = dependencies.runnerTokens.create(runnerId);
      const value = await dependencies.repository.rotateVerificationRunnerToken({
        workspaceId,
        projectId,
        runnerId,
        tokenHash: credential.tokenHash,
        now: now().toISOString(),
      });
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'verification.runner-token-rotated',
        targetType: 'verification-runner',
        targetId: value.id,
        metadata: { projectId },
      });
      return context.json({ runner: runnerResponse(value), credential: credential.token });
    },
  );

  app.delete(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/runners/:runnerId',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const runnerId = requiredParam(context, 'runnerId');
      const revoked = await dependencies.repository.revokeVerificationRunner({
        workspaceId,
        projectId: requiredParam(context, 'projectId'),
        runnerId,
        now: now().toISOString(),
      });
      if (!revoked) throw new RepositoryNotFoundError('Active Verification Runner not found');
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'verification.runner-revoked',
        targetType: 'verification-runner',
        targetId: runnerId,
        metadata: {},
      });
      return context.body(null, 204);
    },
  );

  app.post('/v1/runner/jobs/claim', async (context) => {
    await json(context, RunnerClaimRequestSchema, dependencies.maxJsonBytes);
    const runner = context.get('verificationRunner');
    if (!runner) throw new HttpError(401, 'runner_required', 'Verification Runner is required');
    const timestamp = now().toISOString();
    const job = await dependencies.repository.claimVerificationJob({
      runnerId: runner.id,
      now: timestamp,
      leaseId: makeId('lease'),
      leaseSeconds: dependencies.runnerLeaseSeconds,
    });
    if (!job) return context.body(null, 204);
    await audit(context, {
      workspaceId: runner.workspaceId,
      actorId: `runner:${runner.id}`,
      action: 'verification.job-claimed',
      targetType: 'verification-job',
      targetId: job.id,
      metadata: {
        scheduleId: job.scheduleId,
        attempt: job.attempts,
        leaseExpiresAt: job.leaseExpiresAt,
        deadlineAt: job.deadlineAt,
      },
    });
    return context.json({ job });
  });

  app.post('/v1/runner/jobs/:jobId/heartbeat', async (context) => {
    const body = await json(context, RunnerLeaseRequestSchema, dependencies.maxJsonBytes);
    const runner = context.get('verificationRunner');
    if (!runner) throw new HttpError(401, 'runner_required', 'Verification Runner is required');
    const job = await dependencies.repository.renewVerificationJobLease({
      runnerId: runner.id,
      jobId: requiredParam(context, 'jobId'),
      leaseId: body.leaseId,
      now: now().toISOString(),
      leaseSeconds: dependencies.runnerLeaseSeconds,
    });
    return context.json({ job });
  });

  app.post('/v1/runner/jobs/:jobId/complete', async (context) => {
    const body = await json(
      context,
      CompleteVerificationJobRequestSchema,
      dependencies.maxJsonBytes,
    );
    const runner = context.get('verificationRunner');
    if (!runner) throw new HttpError(401, 'runner_required', 'Verification Runner is required');
    const jobId = requiredParam(context, 'jobId');
    const job = await dependencies.repository.getVerificationJob(
      runner.workspaceId,
      runner.projectId,
      jobId,
    );
    if (!job || !runner.scheduleIds.includes(job.scheduleId))
      throw new RepositoryNotFoundError('Verification Job not found');
    let result;
    if (body.outcome === 'verified') {
      if (body.buildId !== job.execution.expectedBuildId) {
        throw new HttpError(
          422,
          'unexpected_verification_build',
          'Runner completion must reference the server-assigned Build ID',
        );
      }
      const build = await dependencies.repository.getVerificationBuild(
        runner.workspaceId,
        runner.projectId,
        body.buildId,
      );
      if (!build) throw new RepositoryNotFoundError('Verification Build evidence not found');
      const artifact = build.build;
      const runTargetIds = new Set(artifact.expectedRunPlan.map((entry) => entry.runTargetId));
      const exactTargets =
        runTargetIds.size === job.execution.runTargetIds.length &&
        job.execution.runTargetIds.every((id) => runTargetIds.has(id));
      const expectedTrigger = job.reason === 'schedule' ? 'schedule' : 'manual';
      if (
        artifact.id !== job.execution.expectedBuildId ||
        artifact.projectId !== runner.projectId ||
        artifact.repository.repository.toLowerCase() !== job.execution.repository.toLowerCase() ||
        artifact.repository.ref !== job.execution.sourceRef ||
        artifact.trigger !== expectedTrigger ||
        artifact.completeness !== 'complete' ||
        !artifact.endedAt ||
        new Date(artifact.startedAt).getTime() < new Date(job.createdAt).getTime() ||
        !exactTargets ||
        ['pending', 'running'].includes(artifact.status)
      ) {
        throw new HttpError(
          422,
          'verification_build_mismatch',
          'Build evidence does not match the leased execution contract',
        );
      }
      result = {
        outcome: 'verified' as const,
        buildId: build.id,
        buildArtifactHash: build.artifactHash,
        buildStatus: artifact.status as 'passed' | 'changed' | 'failed' | 'blocked' | 'cancelled',
      };
    } else {
      result = {
        outcome: 'runner-failed' as const,
        failureCode: body.failureCode,
        failureDetail: body.failureDetail,
      };
    }
    const value = await dependencies.repository.completeVerificationJob({
      runnerId: runner.id,
      jobId,
      leaseId: body.leaseId,
      result,
      resultHash: canonicalJsonHash(result),
      now: now().toISOString(),
    });
    await audit(context, {
      workspaceId: runner.workspaceId,
      actorId: `runner:${runner.id}`,
      action: 'verification.job-completed',
      targetType: 'verification-job',
      targetId: value.id,
      metadata: {
        scheduleId: value.scheduleId,
        state: value.state,
        outcome: result.outcome,
        ...(result.outcome === 'verified'
          ? { buildId: result.buildId, buildStatus: result.buildStatus }
          : { failureCode: result.failureCode }),
      },
    });
    return context.json({ job: value });
  });

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/scenes/revisions',
    async (context) => {
      const workspaceId = context.req.param('workspaceId');
      const projectId = context.req.param('projectId');
      const body = await json(context, CreateSceneRevisionRequestSchema, dependencies.maxJsonBytes);
      const claims = context.get('artifactWriteClaims');
      const ingestionKey = claims ? idempotencyKey(context) : undefined;
      const serverPrivacy = scanScenePrivacy(body.scene, { blockAt: 'high', now });
      if (
        serverPrivacy.status === 'blocked' ||
        body.privacy.status === 'blocked' ||
        body.privacy.status === 'quarantined'
      ) {
        throw new HttpError(422, 'privacy_blocked', 'Scene failed the privacy gate', {
          findingCount: serverPrivacy.findings.length + body.privacy.findings.length,
        });
      }
      if (claims && (serverPrivacy.status !== 'clear' || body.privacy.status !== 'clear')) {
        throw new HttpError(
          422,
          'evidence_privacy_not_clear',
          'OIDC Scene ingestion requires a server-validated clear privacy report',
        );
      }
      const upload = claims
        ? await requireFinalizedEvidenceObject(context, claims, body)
        : undefined;
      const revision = sceneSourceRevision(body.scene);
      const value = await dependencies.repository.createSceneRevision({
        id: makeId('revision'),
        workspaceId,
        projectId,
        scene: body.scene,
        revision,
        privacy: body.privacy,
        createdBy: actor(context),
        now: now().toISOString(),
      });
      if (
        stableStringify(value.scene) !== stableStringify(body.scene) ||
        stableStringify(value.privacy) !== stableStringify(body.privacy)
      ) {
        throw new RepositoryConflictError(
          'Scene revision already exists with different privacy evidence',
        );
      }
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'scene.revision-created',
        targetType: 'scene-revision',
        targetId: value.id,
        metadata: {
          sceneId: value.sceneId,
          revision,
          ...(ingestionKey ? { idempotencyKey: ingestionKey } : {}),
          ...(upload
            ? { uploadId: upload.id, repository: upload.repository, commit: upload.commit }
            : {}),
        },
      });
      return context.json({ revision: value }, 201);
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/scenes/:sceneId/revisions',
    async (context) => {
      const values = await dependencies.repository.listSceneRevisions(
        context.req.param('workspaceId'),
        context.req.param('projectId'),
        context.req.param('sceneId'),
        numberQuery(context, 'limit', 50, 500),
      );
      return context.json({ revisions: values });
    },
  );

  app.get('/v1/admin/workspaces/:workspaceId/projects/:projectId/scenes', async (context) => {
    const scenes = await dependencies.repository.listSceneHeads(
      requiredParam(context, 'workspaceId'),
      requiredParam(context, 'projectId'),
      numberQuery(context, 'limit', 100, 500),
    );
    return context.json({ scenes });
  });

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/scenes/:sceneId/revisions/:revision',
    async (context) => {
      const value = await dependencies.repository.getSceneRevision(
        context.req.param('workspaceId'),
        context.req.param('projectId'),
        context.req.param('sceneId'),
        context.req.param('revision'),
      );
      if (!value) throw new RepositoryNotFoundError('Scene revision not found');
      return context.json({ revision: value });
    },
  );

  app.post('/v1/admin/workspaces/:workspaceId/projects/:projectId/reviews', async (context) => {
    const workspaceId = context.req.param('workspaceId');
    const projectId = context.req.param('projectId');
    const body = await json(context, CreateReviewRequestSchema, dependencies.maxJsonBytes);
    if (body.review.projectId !== projectId)
      throw new HttpError(422, 'project_mismatch', 'Review projectId must match the route');
    if (
      body.review.status !== 'open' ||
      body.review.closedAt !== undefined ||
      body.review.decisions.length > 0 ||
      body.review.comments.length > 0 ||
      body.review.assignedTo.length > 0
    ) {
      throw new HttpError(
        422,
        'review_must_start_open',
        'A Review must be opened empty; authenticated endpoints add assignees, comments, and decisions',
      );
    }
    if (scanStructuredValue(body.review, { blockAt: 'high', now }).status === 'blocked') {
      throw new HttpError(
        422,
        'privacy_blocked',
        'Review evidence contains sensitive material that cannot enter immutable storage',
      );
    }
    const subject =
      body.review.subject.kind === 'run'
        ? await dependencies.repository.getVerificationRun(
            workspaceId,
            projectId,
            body.review.subject.id,
          )
        : body.review.subject.kind === 'build'
          ? await dependencies.repository.getVerificationBuild(
              workspaceId,
              projectId,
              body.review.subject.id,
            )
          : await dependencies.repository.getRelease(
              workspaceId,
              projectId,
              body.review.subject.id,
            );
    const subjectRevision =
      subject && 'artifactHash' in subject
        ? subject.artifactHash
        : subject && 'release' in subject
          ? artifactHash(subject.release)
          : undefined;
    if (!subject || subjectRevision !== body.review.subject.revision)
      throw new HttpError(
        422,
        'review_subject_mismatch',
        'Review subject must resolve to the exact persisted artifact revision',
      );
    if (body.review.subject.kind === 'run') {
      const run = subject as VerificationRunRecord;
      const baseline = body.review.baseline
        ? await dependencies.repository.getVerificationBaseline(
            workspaceId,
            projectId,
            body.review.baseline.id,
          )
        : undefined;
      if (
        body.review.baseline &&
        (!baseline ||
          body.review.baseline.kind !== 'baseline' ||
          baseline.artifactHash !== body.review.baseline.sha256 ||
          baseline.sceneId !== run.sceneId ||
          baseline.baseline.runTargetId !== run.run.runTargetId)
      ) {
        throw new HttpError(
          422,
          'review_baseline_mismatch',
          'Review Baseline must resolve to the exact approved Scene and Run Target evidence',
        );
      }
      const diff = classifyRunAgainstBaseline(run.run, baseline?.baseline);
      if (
        diff.state !== body.review.changeState ||
        stableStringify(comparableReviewChanges(diff.changes)) !==
          stableStringify(comparableReviewChanges(body.review.changes))
      ) {
        throw new HttpError(
          422,
          'review_diff_mismatch',
          'Review change state or changes do not match deterministic Run/Baseline evidence',
        );
      }
      if (
        body.review.baselineCandidate &&
        (body.review.baselineCandidate.kind !== 'run' ||
          body.review.baselineCandidate.id !== run.id ||
          body.review.baselineCandidate.sha256 !== run.artifactHash)
      ) {
        throw new HttpError(
          422,
          'review_candidate_mismatch',
          'Review Baseline candidate must bind the exact subject Run',
        );
      }
    } else if (body.review.subject.kind === 'build') {
      const build = subject as VerificationBuildRecord;
      const expectedState =
        build.build.summary.blocked > 0
          ? 'blocked'
          : build.build.summary.broken > 0 || build.build.summary.pending > 0
            ? 'broken'
            : build.build.summary.changed > 0
              ? 'changed'
              : 'passed';
      if (body.review.changeState !== expectedState) {
        throw new HttpError(
          422,
          'review_build_state_mismatch',
          'Review change state does not match immutable Build evidence',
        );
      }
    }
    const claims = context.get('artifactWriteClaims');
    if (claims) {
      if (scanStructuredValue(body.review, { blockAt: 'high', now }).status !== 'clear') {
        throw new HttpError(
          422,
          'evidence_privacy_not_clear',
          'OIDC Review ingestion requires server-validated clear structured evidence',
        );
      }
      await requireFinalizedEvidenceObject(context, claims, body);
    }
    const existing = await dependencies.repository.getReview(
      workspaceId,
      projectId,
      body.review.id,
    );
    if (existing) {
      if (stableStringify(existing.review) !== stableStringify(body.review)) {
        throw new RepositoryConflictError('Review already exists with different evidence');
      }
      await syncGitHubCheckForReview(workspaceId, projectId, existing);
      return context.json(existing);
    }
    const value = await dependencies.repository.createReview(workspaceId, projectId, body.review);
    const checkRun = await syncGitHubCheckForReview(workspaceId, projectId, value);
    await audit(context, {
      workspaceId,
      actorId: actor(context),
      action: 'review.created',
      targetType: 'review',
      targetId: value.review.id,
      metadata: {
        subjectKind: value.review.subject.kind,
        subjectId: value.review.subject.id,
        ...(checkRun ? { checkRunId: checkRun.id, checkRunStatus: checkRun.status } : {}),
      },
    });
    return context.json(value, 201);
  });

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/reviews/:reviewId',
    async (context) => {
      const value = await dependencies.repository.getReview(
        context.req.param('workspaceId'),
        context.req.param('projectId'),
        context.req.param('reviewId'),
      );
      if (!value) throw new RepositoryNotFoundError('Review not found');
      return context.json(value);
    },
  );

  app.get('/v1/admin/workspaces/:workspaceId/projects/:projectId/reviews', async (context) => {
    const reviews = await dependencies.repository.listReviews(
      requiredParam(context, 'workspaceId'),
      requiredParam(context, 'projectId'),
      numberQuery(context, 'limit', 100, 500),
    );
    return context.json({ reviews });
  });

  app.get('/v1/admin/workspaces/:workspaceId/projects/:projectId/reviewers', async (context) => {
    const workspaceId = requiredParam(context, 'workspaceId');
    const projectId = requiredParam(context, 'projectId');
    if (!(await dependencies.repository.getProject(workspaceId, projectId))) {
      throw new RepositoryNotFoundError('Project not found');
    }
    const memberships = await dependencies.repository.listWorkspaceMemberships(
      workspaceId,
      numberQuery(context, 'limit', 100, 500),
    );
    const reviewers = (
      await Promise.all(
        memberships
          .filter(
            (membership) =>
              !membership.revokedAt && ['owner', 'editor', 'reviewer'].includes(membership.role),
          )
          .map(async (membership) => {
            const user = await dependencies.repository.getUser(membership.userId);
            return user && !user.disabledAt
              ? { id: user.id, displayName: user.displayName, role: membership.role }
              : undefined;
          }),
      )
    )
      .filter((reviewer) => reviewer !== undefined)
      .sort(
        (left, right) =>
          left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
      );
    return context.json({ reviewers });
  });

  app.put(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/reviews/:reviewId/assignees',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const reviewId = requiredParam(context, 'reviewId');
      const body = await json(context, SetReviewAssigneesRequestSchema, dependencies.maxJsonBytes);
      const assignedTo = [...body.assignedTo].sort();
      const expectedAssignedTo = [...body.expectedAssignedTo].sort();
      for (const userId of assignedTo) {
        const [membership, user] = await Promise.all([
          dependencies.repository.getWorkspaceMembership(workspaceId, userId),
          dependencies.repository.getUser(userId),
        ]);
        if (
          !membership ||
          membership.revokedAt ||
          membership.role === 'viewer' ||
          !user ||
          user.disabledAt
        ) {
          throw new HttpError(
            422,
            'review_assignee_ineligible',
            `Review assignee is not an active reviewer: ${userId}`,
          );
        }
      }
      const value = await dependencies.repository.setReviewAssignees(
        workspaceId,
        projectId,
        reviewId,
        expectedAssignedTo,
        assignedTo,
      );
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'review.assignees-updated',
        targetType: 'review',
        targetId: reviewId,
        metadata: { previous: expectedAssignedTo, assignedTo },
      });
      return context.json(value);
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/reviews/:reviewId/comments',
    async (context) => {
      const workspaceId = context.req.param('workspaceId');
      const projectId = context.req.param('projectId');
      const reviewId = context.req.param('reviewId');
      const body = await json(context, AddReviewCommentRequestSchema, dependencies.maxJsonBytes);
      const privacy = scanStructuredValue({ body: body.body }, { blockAt: 'high', now });
      if (privacy.status === 'blocked')
        throw new HttpError(422, 'privacy_blocked', 'Review comment contains sensitive material');
      const value = await dependencies.repository.addReviewComment(
        workspaceId,
        projectId,
        reviewId,
        {
          ...body,
          id: body.id ?? makeId('comment'),
          actorId: actor(context),
          createdAt: now().toISOString(),
        },
      );
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'review.comment-added',
        targetType: 'review',
        targetId: reviewId,
        metadata: { commentId: value.review.comments.at(-1)?.id },
      });
      return context.json(value, 201);
    },
  );

  app.put(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/reviews/:reviewId/comments/:commentId/resolution',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const reviewId = requiredParam(context, 'reviewId');
      const commentId = requiredParam(context, 'commentId');
      const body = await json(
        context,
        SetReviewCommentResolutionRequestSchema,
        dependencies.maxJsonBytes,
      );
      const actorId = actor(context);
      const resolvedAt = body.status === 'resolved' ? now().toISOString() : undefined;
      const value = await dependencies.repository.setReviewCommentResolution(
        workspaceId,
        projectId,
        reviewId,
        commentId,
        body.expectedResolvedAt,
        resolvedAt ? { resolvedAt, resolvedBy: actorId } : {},
      );
      await audit(context, {
        workspaceId,
        actorId,
        action: body.status === 'resolved' ? 'review.comment-resolved' : 'review.comment-reopened',
        targetType: 'review',
        targetId: reviewId,
        metadata: { commentId, previousResolvedAt: body.expectedResolvedAt, resolvedAt },
      });
      return context.json(value);
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/reviews/:reviewId/decisions',
    async (context) => {
      const workspaceId = context.req.param('workspaceId');
      const projectId = context.req.param('projectId');
      const reviewId = context.req.param('reviewId');
      const body = await json(context, AddReviewDecisionRequestSchema, dependencies.maxJsonBytes);
      if (scanStructuredValue(body, { blockAt: 'high', now }).status === 'blocked') {
        throw new HttpError(
          422,
          'privacy_blocked',
          'Review decision contains sensitive material that cannot enter immutable storage',
        );
      }
      const actorId = actor(context);
      const value = await dependencies.repository.addReviewDecision(
        workspaceId,
        projectId,
        reviewId,
        {
          ...body,
          id: body.id ?? makeId('decision'),
          actorId,
          createdAt: now().toISOString(),
        },
      );
      const checkRun = await syncGitHubCheckForReview(workspaceId, projectId, value);
      await audit(context, {
        workspaceId,
        actorId,
        action: `review.${body.decision}`,
        targetType: 'review',
        targetId: reviewId,
        metadata: {
          decision: body.decision,
          changeId: body.changeId,
          ...(checkRun
            ? {
                checkRunId: checkRun.id,
                checkRunStatus: checkRun.status,
                ...(checkRun.conclusion ? { checkRunConclusion: checkRun.conclusion } : {}),
              }
            : {}),
        },
      });
      return context.json(value, 201);
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/evidence/runs',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const key = idempotencyKey(context);
      const body = await json(
        context,
        RecordVerificationRunRequestSchema,
        dependencies.maxJsonBytes,
      );
      const claims = context.get('artifactWriteClaims');
      if (body.run.projectId !== projectId)
        throw new HttpError(422, 'project_mismatch', 'Run projectId must match the route');
      if (claims) {
        ensureEvidenceProvenance(claims, body.run.repository);
        if (
          body.run.status !== 'passed' ||
          (body.run.changeState !== 'passed' && body.run.changeState !== 'changed')
        ) {
          throw new HttpError(
            422,
            'evidence_not_passed',
            'OIDC Run ingestion accepts only functionally passed evidence that is unchanged or reviewable',
          );
        }
        if (
          body.run.privacy.status !== 'clear' ||
          body.run.attempts.some(
            (attempt) =>
              attempt.privacy.status !== 'clear' ||
              attempt.states.some((state) => state.privacy.status !== 'clear'),
          )
        ) {
          throw new HttpError(
            422,
            'evidence_not_clear',
            'OIDC Run ingestion requires exact clear privacy evidence for every persisted attempt',
          );
        }
        if (scanStructuredValue(body.run, { blockAt: 'high', now }).status !== 'clear') {
          throw new HttpError(
            422,
            'evidence_privacy_not_clear',
            'OIDC Run ingestion requires server-validated clear structured evidence',
          );
        }
        const evidenceUpload = await requireFinalizedEvidenceObject(context, claims, body);
        for (const attempt of body.run.attempts) {
          for (const state of attempt.states) {
            const screenshot = evidenceUpload.objects.find(
              (object) =>
                object.sha256 === state.screenshot.sha256 &&
                object.mediaType === state.screenshot.mediaType &&
                object.byteLength === state.screenshot.byteLength &&
                object.status === 'finalized' &&
                object.finalKey,
            );
            if (!screenshot) {
              throw new HttpError(
                422,
                'evidence_asset_missing',
                `The finalized evidence upload does not contain screenshot ${state.screenshot.sha256}`,
              );
            }
          }
        }
      }
      const revision = await dependencies.repository.getSceneRevision(
        workspaceId,
        projectId,
        body.run.sceneId,
        body.run.sourceRevision,
      );
      if (!revision)
        throw new HttpError(
          422,
          'unknown_scene_revision',
          'Run sourceRevision is not a persisted Scene revision',
        );
      const binding = await dependencies.repository.getRepositoryBinding(
        workspaceId,
        projectId,
        body.run.repository.repository,
      );
      if (!binding)
        throw new HttpError(
          422,
          'unknown_repository',
          'Run repository is not bound to the Project',
        );
      const sceneStepIds = revision.scene.steps.map((step) => step.id);
      if (!sameStringSet(body.run.expectedStepIds, sceneStepIds))
        throw new HttpError(
          422,
          'run_plan_mismatch',
          'Run expectedStepIds must cover the exact persisted Scene revision',
        );
      const selected = body.run.attempts.find(
        (attempt) => attempt.id === body.run.selectedAttemptId,
      )!;
      if (
        (body.run.status === 'passed' &&
          body.run.changeState !== 'passed' &&
          body.run.changeState !== 'changed') ||
        ((body.run.status === 'failed' || body.run.status === 'cancelled') &&
          body.run.changeState !== 'broken') ||
        (body.run.status === 'blocked' && body.run.changeState !== 'blocked')
      ) {
        throw new HttpError(
          422,
          'run_change_state_mismatch',
          'Run change state contradicts its selected execution status',
        );
      }
      if (
        body.run.status === 'passed' &&
        body.run.changeState === 'passed' &&
        body.run.attempts.some(
          (attempt) => attempt.id !== selected.id && attempt.status !== 'passed',
        )
      ) {
        throw new HttpError(
          422,
          'run_retry_state_mismatch',
          'A Run that recovered from a non-passing attempt must remain changed and reviewable',
        );
      }
      if (
        body.run.status === 'passed' &&
        (['blocked', 'quarantined'].includes(body.run.privacy.status) ||
          ['blocked', 'quarantined'].includes(selected.privacy.status) ||
          selected.states.some((state) =>
            ['blocked', 'quarantined'].includes(state.privacy.status),
          ))
      ) {
        throw new HttpError(
          422,
          'run_privacy_mismatch',
          'A passed Run cannot contain blocked privacy evidence',
        );
      }
      if (
        body.run.status === 'passed' &&
        [...selected.actions, ...selected.checks].some((result) => result.status !== 'passed')
      ) {
        throw new HttpError(
          422,
          'run_execution_mismatch',
          'A passed Run cannot contain non-passing Actions or Checks',
        );
      }
      if (
        body.run.status === 'passed' &&
        selected.actions.length === 0 &&
        selected.checks.length === 0
      ) {
        throw new HttpError(
          422,
          'run_execution_evidence_missing',
          'A passed Run requires at least one recorded Playwright Action or Check',
        );
      }
      if (scanStructuredValue(body.run, { blockAt: 'high', now }).status === 'blocked') {
        throw new HttpError(
          422,
          'evidence_privacy_blocked',
          'Run evidence contains sensitive material that cannot enter immutable storage',
        );
      }
      const actorId = actor(context);
      const artifactRevision = artifactHash(body.run);
      const requestHash = canonicalJsonHash({ body, actorId });
      const value = await dependencies.repository.recordVerificationRun({
        id: body.run.id,
        workspaceId,
        projectId,
        sceneId: body.run.sceneId,
        sourceRevision: body.run.sourceRevision,
        artifactHash: artifactRevision,
        run: body.run,
        idempotencyKey: key,
        requestHash,
        recordedBy: actorId,
        recordedAt: now().toISOString(),
      });
      await audit(context, {
        workspaceId,
        actorId,
        action: 'evidence.run-recorded',
        targetType: 'verification-run',
        targetId: value.id,
        metadata: {
          artifactHash: artifactRevision,
          sceneId: value.sceneId,
          sourceRevision: value.sourceRevision,
        },
      });
      return context.json({ run: value }, 201);
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/evidence/runs',
    async (context) => {
      const runs = await dependencies.repository.listVerificationRuns(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        numberQuery(context, 'limit', 100, 500),
      );
      return context.json({ runs });
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/evidence/runs/:runId',
    async (context) => {
      const value = await dependencies.repository.getVerificationRun(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        requiredParam(context, 'runId'),
      );
      if (!value) throw new RepositoryNotFoundError('Verification Run not found');
      return context.json({ run: value });
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/evidence/builds',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const key = idempotencyKey(context);
      const body = await json(
        context,
        RecordVerificationBuildRequestSchema,
        dependencies.maxJsonBytes,
      );
      const claims = context.get('artifactWriteClaims');
      if (body.build.projectId !== projectId)
        throw new HttpError(422, 'project_mismatch', 'Build projectId must match the route');
      if (claims) {
        ensureEvidenceProvenance(claims, body.build.repository);
        if (body.build.completeness !== 'complete') {
          throw new HttpError(
            422,
            'evidence_build_partial',
            'OIDC Build ingestion requires a finalized complete Build, not a shard fragment',
          );
        }
        if (
          (body.build.status !== 'passed' && body.build.status !== 'changed') ||
          body.build.summary.broken > 0 ||
          body.build.summary.blocked > 0 ||
          body.build.summary.pending > 0
        ) {
          throw new HttpError(
            422,
            'evidence_not_passed',
            'OIDC Build ingestion accepts only functionally passed evidence that is unchanged or reviewable',
          );
        }
        if (scanStructuredValue(body.build, { blockAt: 'high', now }).status !== 'clear') {
          throw new HttpError(
            422,
            'evidence_privacy_not_clear',
            'OIDC Build ingestion requires server-validated clear structured evidence',
          );
        }
        await requireFinalizedEvidenceObject(context, claims, body);
      }
      if (body.build.status === 'pending' || body.build.status === 'running' || !body.build.endedAt)
        throw new HttpError(
          422,
          'build_not_terminal',
          'Only completed Build evidence is immutable',
        );
      if (body.build.completeness !== 'complete' || body.build.shard) {
        throw new HttpError(
          422,
          'build_partial',
          'Shard fragments must be merged into one complete Build before immutable ingestion',
        );
      }
      const references = new Set<string>();
      const actualSummary = {
        total: body.build.expectedRunPlan.length,
        passed: 0,
        changed: 0,
        broken: 0,
        blocked: 0,
        pending: 0,
      };
      for (const reference of body.build.runs) {
        const keyForRun = `${reference.sceneId}\0${reference.runTargetId}`;
        if (references.has(keyForRun))
          throw new HttpError(
            422,
            'duplicate_run_reference',
            'Build Run references must be unique',
          );
        references.add(keyForRun);
        if (reference.run?.kind !== 'run')
          throw new HttpError(
            422,
            'invalid_run_reference',
            'Build evidence must reference Run artifacts',
          );
        const run = await dependencies.repository.getVerificationRun(
          workspaceId,
          projectId,
          reference.run.id,
        );
        if (
          !run ||
          run.artifactHash !== reference.run.sha256 ||
          run.sceneId !== reference.sceneId ||
          run.run.runTargetId !== reference.runTargetId ||
          reference.status !== run.run.status ||
          reference.changeState !== run.run.changeState ||
          stableStringify(body.build.repository) !== stableStringify(run.run.repository)
        ) {
          throw new HttpError(
            422,
            'run_reference_mismatch',
            `Build Run reference is not bound to immutable evidence: ${reference.run.id}`,
          );
        }
        const truth = runStatus(run);
        actualSummary[truth === 'unverified' ? 'pending' : truth] += 1;
      }
      for (const planned of body.build.expectedRunPlan) {
        if (!references.has(`${planned.sceneId}\0${planned.runTargetId}`)) {
          actualSummary.pending += 1;
        }
        if (planned.required && !references.has(`${planned.sceneId}\0${planned.runTargetId}`))
          throw new HttpError(
            422,
            'required_run_missing',
            `Build is missing required Run evidence for ${planned.sceneId}`,
          );
      }
      if (stableStringify(body.build.summary) !== stableStringify(actualSummary)) {
        throw new HttpError(
          422,
          'build_summary_mismatch',
          'Build summary does not match its exact persisted Run evidence',
        );
      }
      const cleanStatus =
        actualSummary.broken === 0 && actualSummary.blocked === 0 && actualSummary.pending === 0;
      const statusConsistent = cleanStatus
        ? actualSummary.changed > 0
          ? body.build.status === 'changed'
          : body.build.status === 'passed'
        : actualSummary.broken > 0
          ? body.build.status === 'failed'
          : actualSummary.blocked > 0
            ? body.build.status === 'failed' || body.build.status === 'blocked'
            : body.build.status === 'failed' || body.build.status === 'cancelled';
      if (!statusConsistent) {
        throw new HttpError(
          422,
          'build_status_mismatch',
          'Build status contradicts its exact persisted Run evidence',
        );
      }
      const actorId = actor(context);
      const artifactRevision = artifactHash(body.build);
      const requestHash = canonicalJsonHash({ body, actorId });
      const value = await dependencies.repository.recordVerificationBuild({
        id: body.build.id,
        workspaceId,
        projectId,
        artifactHash: artifactRevision,
        build: body.build,
        idempotencyKey: key,
        requestHash,
        recordedBy: actorId,
        recordedAt: now().toISOString(),
      });
      const checkRun = await syncGitHubCheckForBuild(workspaceId, projectId, value);
      await audit(context, {
        workspaceId,
        actorId,
        action: 'evidence.build-recorded',
        targetType: 'verification-build',
        targetId: value.id,
        metadata: {
          artifactHash: artifactRevision,
          status: value.build.status,
          ...(checkRun
            ? {
                checkRunId: checkRun.id,
                checkRunStatus: checkRun.status,
                ...(checkRun.conclusion ? { checkRunConclusion: checkRun.conclusion } : {}),
              }
            : {}),
        },
      });
      return context.json({ build: value }, 201);
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/evidence/builds',
    async (context) => {
      const builds = await dependencies.repository.listVerificationBuilds(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        numberQuery(context, 'limit', 100, 500),
      );
      return context.json({ builds });
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/evidence/builds/:buildId',
    async (context) => {
      const value = await dependencies.repository.getVerificationBuild(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        requiredParam(context, 'buildId'),
      );
      if (!value) throw new RepositoryNotFoundError('Verification Build not found');
      return context.json({ build: value });
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/evidence/baselines',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const key = idempotencyKey(context);
      const body = await json(
        context,
        RecordVerificationBaselineRequestSchema,
        dependencies.maxJsonBytes,
      );
      const baseline = body.baseline;
      if (baseline.projectId !== projectId)
        throw new HttpError(422, 'project_mismatch', 'Baseline projectId must match the route');
      const run = await dependencies.repository.getVerificationRun(
        workspaceId,
        projectId,
        baseline.sourceRunId,
      );
      const selected = run?.run.attempts.find(
        (attempt) => attempt.id === run.run.selectedAttemptId,
      );
      if (
        !run ||
        !selected ||
        run.run.status !== 'passed' ||
        selected.status !== 'passed' ||
        baseline.sourceAttemptId !== selected.id ||
        baseline.sceneId !== run.sceneId ||
        baseline.runTargetId !== run.run.runTargetId ||
        baseline.sourceRevision !== run.sourceRevision ||
        run.artifactHash !== artifactHash(run.run) ||
        !sameStringSet(baseline.expectedStepIds, run.run.expectedStepIds)
      ) {
        throw new HttpError(
          422,
          'baseline_source_mismatch',
          'Baseline is not an exact derivative of a persisted successful Run',
        );
      }
      if (
        stableStringify(baseline.checks) !== stableStringify(selected.checks) ||
        baseline.checksHash !== canonicalJsonHash(baseline.checks)
      ) {
        throw new HttpError(
          422,
          'baseline_checks_mismatch',
          'Baseline checks do not match the source Run',
        );
      }
      const sourceStates = new Map(
        selected.states.map((state) => [state.id, baselineStateFromRun(state)]),
      );
      if (baseline.states.length !== sourceStates.size) {
        throw new HttpError(
          422,
          'baseline_state_mismatch',
          'Baseline State set must exactly match the selected source Run attempt',
        );
      }
      for (const state of baseline.states) {
        const expected = sourceStates.get(state.stateId);
        const { narrativeHash, ...comparable } = state;
        if (
          !expected ||
          stableStringify(comparable) !== stableStringify(expected) ||
          (narrativeHash !== undefined && narrativeHash !== run.run.narrativeRevision)
        ) {
          throw new HttpError(
            422,
            'baseline_state_mismatch',
            `Baseline State is not present in the source Run: ${state.stateId}`,
          );
        }
      }
      if (scanStructuredValue(baseline, { blockAt: 'high', now }).status === 'blocked') {
        throw new HttpError(
          422,
          'evidence_privacy_blocked',
          'Baseline evidence contains sensitive material that cannot enter immutable storage',
        );
      }
      const actorId = actor(context);
      if (
        baseline.approvals.some(
          (approval) =>
            approval.actorId !== actorId || approval.revision !== baseline.sourceRevision,
        )
      ) {
        throw new HttpError(
          422,
          'baseline_approval_mismatch',
          'Embedded Baseline approvals must be attributed to the authenticated actor and source revision',
        );
      }
      const artifactRevision = artifactHash(baseline);
      const requestHash = canonicalJsonHash({ body, actorId });
      const value = await dependencies.repository.recordVerificationBaseline({
        id: baseline.id,
        workspaceId,
        projectId,
        sceneId: baseline.sceneId,
        sourceRevision: baseline.sourceRevision,
        sourceRunId: baseline.sourceRunId,
        sourceRunHash: run.artifactHash,
        artifactHash: artifactRevision,
        baseline,
        idempotencyKey: key,
        requestHash,
        recordedBy: actorId,
        recordedAt: now().toISOString(),
      });
      await audit(context, {
        workspaceId,
        actorId,
        action: 'evidence.baseline-recorded',
        targetType: 'verification-baseline',
        targetId: value.id,
        metadata: {
          artifactHash: artifactRevision,
          runId: value.sourceRunId,
          sceneId: value.sceneId,
        },
      });
      return context.json({ baseline: value }, 201);
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/evidence/baselines',
    async (context) => {
      const baselines = await dependencies.repository.listVerificationBaselines(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        numberQuery(context, 'limit', 100, 500),
      );
      return context.json({ baselines });
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/evidence/baselines/:baselineId',
    async (context) => {
      const value = await dependencies.repository.getVerificationBaseline(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        requiredParam(context, 'baselineId'),
      );
      if (!value) throw new RepositoryNotFoundError('Verification Baseline not found');
      return context.json({ baseline: value });
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/evidence/approvals',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const key = idempotencyKey(context);
      const body = await json(
        context,
        RecordReviewApprovalRequestSchema,
        dependencies.maxJsonBytes,
      );
      if (
        body.reason &&
        scanStructuredValue({ reason: body.reason }, { blockAt: 'high', now }).status === 'blocked'
      ) {
        throw new HttpError(
          422,
          'evidence_privacy_blocked',
          'Approval reason contains sensitive material that cannot enter immutable storage',
        );
      }
      const actorId = actor(context);
      const approvalId = body.id ?? makeId('approval');
      let subjectKind: ReviewApprovalRecord['subjectKind'];
      let subjectId: string;
      let subjectRevision: string;
      if (body.kind === 'release') {
        if (body.release.projectId !== projectId)
          throw new HttpError(422, 'project_mismatch', 'Release projectId must match the route');
        const channel = await dependencies.repository.getChannel(
          workspaceId,
          projectId,
          body.release.channelId,
        );
        const build = await dependencies.repository.getVerificationBuild(
          workspaceId,
          projectId,
          body.release.sourceBuildId,
        );
        if (!channel || !build || build.artifactHash !== artifactHash(build.build))
          throw new HttpError(
            422,
            'unknown_approval_subject',
            'Release approval requires a persisted Channel and Build',
          );
        await assertReleasePublicationAvailable(workspaceId, projectId, body.release, {
          repository: build.build.repository.repository,
          commit: build.build.repository.commit,
        });
        subjectKind = 'release-candidate';
        subjectId = body.release.id;
        subjectRevision = canonicalJsonHash(body.release);
      } else {
        const baseline = await dependencies.repository.getVerificationBaseline(
          workspaceId,
          projectId,
          body.baselineId,
        );
        if (!baseline || baseline.artifactHash !== artifactHash(baseline.baseline))
          throw new HttpError(422, 'unknown_approval_subject', 'Approval Baseline was not found');
        subjectKind = 'baseline';
        subjectId = baseline.id;
        subjectRevision = baseline.artifactHash;
      }
      const approval = {
        id: approvalId,
        kind: body.kind,
        decision: body.decision,
        actorId,
        createdAt: now().toISOString(),
        revision: subjectRevision,
        ...(body.reason ? { reason: body.reason } : {}),
      } as const;
      const artifactRevision = canonicalJsonHash({ subjectKind, subjectId, approval });
      const requestHash = canonicalJsonHash({ body, actorId });
      const value = await dependencies.repository.recordReviewApproval({
        id: approvalId,
        workspaceId,
        projectId,
        subjectKind,
        subjectId,
        subjectRevision,
        artifactHash: artifactRevision,
        approval,
        idempotencyKey: key,
        requestHash,
        recordedBy: actorId,
        recordedAt: now().toISOString(),
      });
      await audit(context, {
        workspaceId,
        actorId,
        action: `evidence.${body.kind}-${body.decision}`,
        targetType: 'review-approval',
        targetId: value.id,
        metadata: { artifactHash: artifactRevision, subjectKind, subjectId, subjectRevision },
      });
      return context.json({ approval: value }, 201);
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/evidence/approvals',
    async (context) => {
      const approvals = await dependencies.repository.listReviewApprovals(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        numberQuery(context, 'limit', 100, 500),
      );
      return context.json({ approvals });
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/evidence/approvals/:approvalId',
    async (context) => {
      const value = await dependencies.repository.getReviewApproval(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        requiredParam(context, 'approvalId'),
      );
      if (!value) throw new RepositoryNotFoundError('Review approval not found');
      return context.json({ approval: value });
    },
  );

  app.put(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/studio/assets/:hash',
    async (context) => {
      const parsedHash = Sha256Schema.safeParse(requiredParam(context, 'hash'));
      if (!parsedHash.success) {
        throw new HttpError(400, 'invalid_asset_hash', 'Asset hash must be a SHA-256 digest');
      }
      const mediaType = context.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (!mediaType || !isAllowedObjectMediaType(mediaType)) {
        throw new HttpError(
          415,
          'invalid_asset_media_type',
          'Hosted Studio asset Content-Type is not supported',
        );
      }
      const byteLength = Number(context.req.query('byteLength'));
      const maximumStudioAssetBytes = Math.min(
        dependencies.maxObjectBytes,
        MAX_STUDIO_ASSET_RESPONSE_BYTES,
      );
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength < 1 ||
        byteLength > maximumStudioAssetBytes
      ) {
        throw new HttpError(
          413,
          'invalid_asset_length',
          `Hosted Studio asset length must be between 1 and ${maximumStudioAssetBytes} bytes`,
        );
      }
      try {
        new ObjectMediaStreamValidator(mediaType, byteLength);
      } catch (error) {
        if (error instanceof ObjectMediaPolicyError) {
          throw new HttpError(413, 'object_media_limit', error.message);
        }
        throw error;
      }
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const suppliedKey = idempotencyKey(context);
      const objectSpec = { sha256: parsedHash.data, mediaType, byteLength };
      const timestamp = now();
      let upload = await dependencies.repository.beginUpload({
        id: makeId('upload'),
        workspaceId,
        projectId,
        repository: 'scenebook-studio',
        commit: parsedHash.data,
        ref: 'refs/scenebook/studio',
        idempotencyKey: `studio:${projectId}:${suppliedKey}`,
        requestHash: canonicalJsonHash({ schemaVersion: 1, object: objectSpec }),
        objects: [objectSpec],
        now: timestamp.toISOString(),
        expiresAt: new Date(timestamp.getTime() + 15 * 60_000).toISOString(),
        limits: dependencies.uploadLimits,
      });
      if (upload.status !== 'finalized') {
        if (upload.status === 'expired') {
          throw new HttpError(410, 'upload_expired', 'Hosted Studio asset upload expired');
        }
        const reservation = uploadAdmission.acquire(workspaceId, byteLength);
        let staged: StoredObject;
        try {
          staged = await dependencies.objectStore.putStagedStream(
            upload.id,
            parsedHash.data,
            readLimitedStream(context.req.raw, byteLength),
            byteLength,
            mediaType,
          );
        } catch (error) {
          if (error instanceof ObjectMediaPolicyError) {
            throw new HttpError(415, 'unsafe_object_media', error.message);
          }
          if (error instanceof ObjectIntegrityError) {
            throw new HttpError(
              422,
              error.kind === 'digest' ? 'object_digest_mismatch' : 'object_length_mismatch',
              error.message,
            );
          }
          throw error;
        } finally {
          reservation.release();
        }
        upload = await dependencies.repository.markObjectStaged(
          upload.id,
          parsedHash.data,
          mediaType,
          staged.key,
          now().toISOString(),
        );
        const promoted = await dependencies.objectStore.promote(staged, workspaceId);
        const manifest = {
          schemaVersion: 1 as const,
          objects: [objectSpec],
          metadata: { kind: 'studio-asset', projectId },
        };
        upload = await dependencies.repository.finalizeUpload(
          upload.id,
          canonicalJsonHash(manifest),
          [promoted],
          now().toISOString(),
        );
        await dependencies.objectStore.deleteStaged(staged).catch((error) => {
          dependencies.logger.warn('Finalized Studio staging object cleanup failed', {
            uploadId: upload.id,
            sha256: parsedHash.data,
            mediaType,
            error,
          });
        });
      }
      const object = await dependencies.repository.getFinalizedObject(
        workspaceId,
        projectId,
        parsedHash.data,
        mediaType,
      );
      if (!object || object.byteLength !== byteLength) {
        throw new HttpError(
          503,
          'studio_asset_unavailable',
          'Hosted Studio asset was not available after finalization',
        );
      }
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'studio.asset-finalized',
        targetType: 'studio-asset',
        targetId: parsedHash.data,
        metadata: { projectId, mediaType, byteLength, uploadId: upload.id },
      });
      return context.json({ asset: object });
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/studio/assets/:hash',
    async (context) => {
      const parsedHash = Sha256Schema.safeParse(requiredParam(context, 'hash'));
      if (!parsedHash.success) {
        throw new HttpError(400, 'invalid_asset_hash', 'Asset hash must be a SHA-256 digest');
      }
      const mediaTypes = new URL(context.req.url).searchParams.getAll('mediaType');
      if (mediaTypes.length !== 1 || !isAllowedObjectMediaType(mediaTypes[0] ?? '')) {
        throw new HttpError(
          400,
          'invalid_asset_media_type',
          'Hosted Studio assets require exactly one supported mediaType',
        );
      }
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      if (
        !(await dependencies.repository.studioPayloadIsReferenced(
          workspaceId,
          projectId,
          parsedHash.data,
          mediaTypes[0]!,
        ))
      ) {
        throw new RepositoryNotFoundError('Hosted Studio asset not found');
      }
      const object = await dependencies.repository.getFinalizedObject(
        workspaceId,
        projectId,
        parsedHash.data,
        mediaTypes[0]!,
      );
      if (!object) throw new RepositoryNotFoundError('Hosted Studio asset not found');
      if (object.byteLength > MAX_STUDIO_ASSET_RESPONSE_BYTES) {
        throw new HttpError(
          413,
          'studio_asset_too_large',
          'Hosted Studio asset exceeds the interactive editor size limit',
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = await dependencies.objectStore.read(object);
      } catch {
        throw new HttpError(
          503,
          'studio_asset_unavailable',
          'The hosted Studio asset failed storage verification',
        );
      }
      context.header('cache-control', 'private, max-age=31536000, immutable');
      context.header('content-security-policy', "default-src 'none'; sandbox");
      context.header('cross-origin-resource-policy', 'same-origin');
      context.header('content-disposition', `attachment; filename="${parsedHash.data}"`);
      context.header('content-type', mediaTypes[0]!);
      context.header('content-length', String(bytes.byteLength));
      return new Response(bytes as BodyInit, { status: 200, headers: context.res.headers });
    },
  );

  app.get('/v1/admin/workspaces/:workspaceId/projects/:projectId/assets/:hash', async (context) => {
    const hash = Sha256Schema.safeParse(requiredParam(context, 'hash'));
    if (!hash.success)
      throw new HttpError(400, 'invalid_asset_hash', 'Asset hash must be a SHA-256 digest');
    const mediaTypes = new URL(context.req.url).searchParams.getAll('mediaType');
    if (mediaTypes.length !== 1 || !['image/png', 'image/jpeg'].includes(mediaTypes[0] ?? '')) {
      throw new HttpError(
        400,
        'invalid_asset_media_type',
        'Evidence assets require exactly one PNG or JPEG mediaType',
      );
    }
    const object = await dependencies.repository.getFinalizedObject(
      requiredParam(context, 'workspaceId'),
      requiredParam(context, 'projectId'),
      hash.data,
      mediaTypes[0]!,
    );
    if (!object) throw new RepositoryNotFoundError('Evidence asset not found');
    if (object.byteLength > MAX_EVIDENCE_IMAGE_RESPONSE_BYTES) {
      throw new HttpError(
        413,
        'evidence_asset_too_large',
        'Evidence image exceeds the interactive review size limit',
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await dependencies.objectStore.read(object);
    } catch {
      throw new HttpError(
        503,
        'evidence_asset_unavailable',
        'The immutable evidence asset failed storage verification',
      );
    }
    context.header('cache-control', 'private, max-age=31536000, immutable');
    context.header('content-security-policy', "default-src 'none'; sandbox");
    context.header('cross-origin-resource-policy', 'same-origin');
    context.header('content-disposition', `inline; filename="${hash.data}"`);
    context.header('content-type', mediaTypes[0]!);
    context.header('content-length', String(bytes.byteLength));
    return new Response(bytes as BodyInit, {
      status: 200,
      headers: context.res.headers,
    });
  });

  const channelWithHostedUrl = async (channel: ChannelRecord) => {
    if (channel.kind !== 'public-catalog' && channel.kind !== 'private-portal') return channel;
    const [workspace, project] = await Promise.all([
      dependencies.repository.getWorkspace(channel.workspaceId),
      dependencies.repository.getProject(channel.workspaceId, channel.projectId),
    ]);
    if (!workspace || !project) {
      throw new RepositoryNotFoundError('Channel tenant binding not found');
    }
    return {
      ...channel,
      hostedUrl: `${dependencies.publicationBaseUrl.replace(/\/$/u, '')}/s/${workspace.slug}/${project.slug}/${channel.slug}/`,
    };
  };

  app.post('/v1/admin/workspaces/:workspaceId/projects/:projectId/channels', async (context) => {
    const workspaceId = context.req.param('workspaceId');
    const projectId = context.req.param('projectId');
    const body = await json(context, CreateChannelRequestSchema, dependencies.maxJsonBytes);
    if (new Set(body.webhookIds).size !== body.webhookIds.length) {
      throw new HttpError(422, 'duplicate_webhook', 'Channel webhook IDs must be unique');
    }
    for (const webhookId of body.webhookIds) requireConfiguredWebhook(webhookId);
    const channelId = body.id ?? makeId('channel');
    const analyticsToken = dependencies.hasher.hash(
      `${workspaceId}\0${projectId}\0${channelId}`,
      'channel-analytics-credential',
    );
    const value = await dependencies.repository.createChannel({
      id: channelId,
      workspaceId,
      projectId,
      slug: body.slug,
      name: body.name,
      kind: body.kind,
      policy: body.policy,
      webhookIds: body.webhookIds,
      analyticsTokenHash: dependencies.hasher.hash(analyticsToken, 'analytics-token'),
      now: now().toISOString(),
    });
    await audit(context, {
      workspaceId,
      actorId: actor(context),
      action: 'channel.created',
      targetType: 'channel',
      targetId: value.id,
      metadata: { slug: value.slug, kind: value.kind, webhookIds: value.webhookIds },
    });
    return context.json({ channel: await channelWithHostedUrl(value), analyticsToken }, 201);
  });

  app.get('/v1/admin/workspaces/:workspaceId/projects/:projectId/channels', async (context) => {
    const channels = await dependencies.repository.listChannels(
      requiredParam(context, 'workspaceId'),
      requiredParam(context, 'projectId'),
      numberQuery(context, 'limit', 100, 500),
    );
    return context.json({ channels: await Promise.all(channels.map(channelWithHostedUrl)) });
  });

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId',
    async (context) => {
      const value = await dependencies.repository.getChannel(
        context.req.param('workspaceId'),
        context.req.param('projectId'),
        context.req.param('channelId'),
      );
      if (!value) throw new RepositoryNotFoundError('Channel not found');
      return context.json({ channel: await channelWithHostedUrl(value) });
    },
  );

  const customDomainForRoute = async (context: AppContext): Promise<CustomDomainRecord> => {
    const value = await dependencies.repository.getCustomDomain(
      requiredParam(context, 'workspaceId'),
      requiredParam(context, 'projectId'),
      requiredParam(context, 'channelId'),
      requiredParam(context, 'domainId'),
    );
    if (!value) throw new RepositoryNotFoundError('Custom domain not found');
    return value;
  };

  const assertCustomDomainVersion = (domain: CustomDomainRecord, expectedVersion: number): void => {
    if (domain.version !== expectedVersion) {
      throw new RepositoryConflictError('Custom domain changed');
    }
  };

  const requireCustomDomainProvisioner = (): CustomDomainProvisioner => {
    if (!customDomains.enabled || !customDomains.routingTarget) {
      throw new CustomDomainProvisionerError(
        'Custom-domain ingress provisioning is not configured',
        'provisioner_disabled',
      );
    }
    return customDomains.provisioner;
  };

  const updateCustomDomain = async (
    current: CustomDomainRecord,
    patch: Omit<Partial<CustomDomainRecord>, 'id' | 'workspaceId' | 'projectId' | 'channelId'>,
  ): Promise<CustomDomainRecord> => {
    const record: CustomDomainRecord = {
      ...current,
      ...patch,
      version: current.version + 1,
      updatedAt: now().toISOString(),
    };
    return dependencies.repository.updateCustomDomain({
      record,
      expectedVersion: current.version,
    });
  };

  const auditCustomDomainReconciliation = async (
    context: AppContext,
    domain: CustomDomainRecord,
    action: string,
  ): Promise<void> => {
    await audit(context, {
      workspaceId: domain.workspaceId,
      actorId: actor(context),
      action,
      targetType: 'custom-domain',
      targetId: domain.id,
      metadata: {
        projectId: domain.projectId,
        channelId: domain.channelId,
        hostname: domain.hostname,
        status: domain.status,
        desiredState: domain.provisioning?.desiredState,
        certificate: domain.provisioning?.certificate,
        routing: domain.provisioning?.routing,
        failureCode: domain.provisioning?.failureCode,
      },
    });
  };

  const reconcileCustomDomain = async (
    context: AppContext,
    current: CustomDomainRecord,
  ): Promise<CustomDomainRecord> => {
    const provisioner = requireCustomDomainProvisioner();
    if (!current.provisioning) {
      throw new HttpError(
        409,
        'custom_domain_operation_missing',
        'Custom domain has no ingress operation to reconcile',
      );
    }
    if (current.provisioning.desiredState === 'active' && current.dnsProof.status !== 'verified') {
      throw new HttpError(
        409,
        'custom_domain_dns_unverified',
        'Custom domain DNS ownership must be verified before activation',
      );
    }
    let observation: CustomDomainProvisioningObservation;
    try {
      observation = await provisioner.reconcile({
        operationKey: current.provisioning.operationKey,
        desiredState: current.provisioning.desiredState,
        domain: current,
      });
      assertMatchingProvisioningObservation(current, observation);
    } catch (error) {
      const provisionerError =
        error instanceof CustomDomainProvisionerError
          ? error
          : new CustomDomainProvisionerError(
              'Custom-domain provisioner is temporarily unavailable',
              'provisioner_unavailable',
            );
      const value = await updateCustomDomain(current, {
        status: 'failed',
        provisioning: {
          ...current.provisioning,
          observedAt: now().toISOString(),
          failureCode: provisionerError.code,
        },
      });
      await auditCustomDomainReconciliation(context, value, 'custom-domain.reconcile-failed');
      throw provisionerError;
    }
    const status = customDomainStatusFromObservation(observation);
    const value = await updateCustomDomain(current, {
      status,
      provisioning: {
        operationKey: observation.operationKey,
        operationId: observation.operationId,
        desiredState: observation.desiredState,
        certificate: observation.certificate,
        routing: observation.routing,
        requestedAt: current.provisioning.requestedAt,
        observedAt: now().toISOString(),
        ...(observation.failureCode ? { failureCode: observation.failureCode } : {}),
      },
      ...(status === 'removed' ? { removedAt: now().toISOString() } : {}),
    });
    const action =
      status === 'active'
        ? 'custom-domain.activated'
        : status === 'disabled'
          ? 'custom-domain.disabled'
          : status === 'removed'
            ? 'custom-domain.removed'
            : 'custom-domain.reconciled';
    await auditCustomDomainReconciliation(context, value, action);
    return value;
  };

  const beginCustomDomainTransition = async (
    context: AppContext,
    current: CustomDomainRecord,
    desiredState: CustomDomainDesiredState,
  ): Promise<CustomDomainRecord> => {
    if (current.status === 'removed' || current.status === 'removing') {
      throw new HttpError(
        409,
        'custom_domain_removed',
        'Removed custom domains cannot start another lifecycle transition',
      );
    }
    if (desiredState === 'active') {
      if (current.status === 'active') return current;
      if (current.dnsProof.status !== 'verified') {
        throw new HttpError(
          409,
          'custom_domain_dns_unverified',
          'Custom domain DNS ownership must be verified before activation',
        );
      }
      const channel = await dependencies.repository.getChannel(
        current.workspaceId,
        current.projectId,
        current.channelId,
      );
      if (!channel?.currentReleaseId) {
        throw new HttpError(
          409,
          'custom_domain_release_missing',
          'Custom domain activation requires a current immutable Channel Release',
        );
      }
    } else if (desiredState === 'disabled' && current.status === 'disabled') {
      return current;
    }
    if (
      current.provisioning?.desiredState === desiredState &&
      ['provisioning', 'disabling', 'removing', 'failed'].includes(current.status)
    ) {
      return current;
    }
    const transitionStatus =
      desiredState === 'active'
        ? 'provisioning'
        : desiredState === 'disabled'
          ? 'disabling'
          : 'removing';
    const value = await updateCustomDomain(current, {
      status: transitionStatus,
      provisioning: {
        operationKey: makeId('domain-operation'),
        desiredState,
        certificate: current.provisioning?.certificate ?? 'not-requested',
        routing: current.provisioning?.routing ?? 'not-requested',
        requestedAt: now().toISOString(),
      },
    });
    await auditCustomDomainReconciliation(
      context,
      value,
      `custom-domain.${desiredState}-requested`,
    );
    return value;
  };

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/custom-domains',
    async (context) => {
      requireCustomDomainProvisioner();
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const channelId = requiredParam(context, 'channelId');
      const channel = await dependencies.repository.getChannel(workspaceId, projectId, channelId);
      if (!channel) throw new RepositoryNotFoundError('Channel not found');
      if (channel.kind !== 'public-catalog' && channel.kind !== 'private-portal') {
        throw new HttpError(
          422,
          'custom_domain_channel_unsupported',
          'Custom domains require a hosted public-catalog or private-portal Channel',
        );
      }
      const body = await json(context, CreateCustomDomainRequestSchema, dependencies.maxJsonBytes);
      const hostname = normalizeCustomDomainHostname(body.hostname);
      const routingTarget = normalizeCustomDomainHostname(customDomains.routingTarget!);
      const controlPlaneHostname = new URL(dependencies.publicBaseUrl).hostname.toLowerCase();
      const publicationHostname = new URL(dependencies.publicationBaseUrl).hostname.toLowerCase();
      if (
        hostname === routingTarget ||
        hostname === controlPlaneHostname ||
        hostname === publicationHostname
      ) {
        throw new HttpError(
          422,
          'custom_domain_origin_conflict',
          'Custom domain must differ from the control-plane and ingress target hostnames',
        );
      }
      const domainId = body.id ?? makeId('domain');
      const existing = await dependencies.repository.getCustomDomain(
        workspaceId,
        projectId,
        channelId,
        domainId,
      );
      if (existing) {
        if (existing.hostname !== hostname || existing.routingTarget !== routingTarget) {
          throw new RepositoryConflictError('Custom domain idempotency conflict');
        }
        return context.json({ domain: existing });
      }
      const timestamp = now().toISOString();
      const value = await dependencies.repository.createCustomDomain({
        id: domainId,
        workspaceId,
        projectId,
        channelId,
        hostname,
        routingTarget,
        status: 'pending-dns',
        dnsProof: {
          status: 'pending',
          challengeName: customDomainChallengeName(hostname),
          challengeValue: makeCustomDomainChallengeValue(),
        },
        version: 1,
        createdBy: actor(context),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'custom-domain.created',
        targetType: 'custom-domain',
        targetId: value.id,
        metadata: { projectId, channelId, hostname, routingTarget },
      });
      return context.json({ domain: value }, 201);
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/custom-domains',
    async (context) => {
      const domains = await dependencies.repository.listCustomDomains(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        requiredParam(context, 'channelId'),
        numberQuery(context, 'limit', 100, 500),
      );
      return context.json({ domains });
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/custom-domains/:domainId',
    async (context) => context.json({ domain: await customDomainForRoute(context) }),
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/custom-domains/:domainId/challenge',
    async (context) => {
      const body = await json(
        context,
        CustomDomainMutationRequestSchema,
        dependencies.maxJsonBytes,
      );
      const current = await customDomainForRoute(context);
      assertCustomDomainVersion(current, body.expectedVersion);
      if (current.status === 'removed' || current.status === 'removing') {
        throw new HttpError(
          409,
          'custom_domain_removed',
          'Removed custom domains cannot rotate DNS proof',
        );
      }
      if (current.provisioning && current.status !== 'disabled') {
        throw new HttpError(
          409,
          'custom_domain_disable_required',
          'Disable custom-domain ingress before rotating its DNS ownership proof',
        );
      }
      const value = await updateCustomDomain(current, {
        status: current.status === 'disabled' ? 'disabled' : 'pending-dns',
        dnsProof: {
          status: 'pending',
          challengeName: customDomainChallengeName(current.hostname),
          challengeValue: makeCustomDomainChallengeValue(),
        },
      });
      await auditCustomDomainReconciliation(context, value, 'custom-domain.challenge-rotated');
      return context.json({ domain: value });
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/custom-domains/:domainId/verify-dns',
    async (context) => {
      const body = await json(
        context,
        CustomDomainMutationRequestSchema,
        dependencies.maxJsonBytes,
      );
      const current = await customDomainForRoute(context);
      assertCustomDomainVersion(current, body.expectedVersion);
      if (current.status === 'removed' || current.status === 'removing') {
        throw new HttpError(
          409,
          'custom_domain_removed',
          'Removed custom domains cannot verify DNS proof',
        );
      }
      const verified = await hasExactCustomDomainDnsProof(
        customDomains.dnsResolver,
        current.dnsProof.challengeName,
        current.dnsProof.challengeValue,
      );
      const timestamp = now().toISOString();
      const preservesOperationalStatus = [
        'active',
        'provisioning',
        'disabling',
        'disabled',
        'failed',
      ].includes(current.status);
      const value = await updateCustomDomain(current, {
        status: preservesOperationalStatus
          ? current.status
          : verified
            ? 'ready-to-provision'
            : 'pending-dns',
        dnsProof: {
          status: verified ? 'verified' : 'failed',
          challengeName: current.dnsProof.challengeName,
          challengeValue: current.dnsProof.challengeValue,
          checkedAt: timestamp,
          ...(verified ? { verifiedAt: timestamp } : {}),
        },
      });
      await auditCustomDomainReconciliation(
        context,
        value,
        verified ? 'custom-domain.dns-verified' : 'custom-domain.dns-verification-failed',
      );
      return context.json({ domain: value, verified });
    },
  );

  for (const desiredState of ['active', 'disabled', 'removed'] as const) {
    const routeAction =
      desiredState === 'active' ? 'activate' : desiredState === 'disabled' ? 'disable' : 'remove';
    app.post(
      `/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/custom-domains/:domainId/${routeAction}`,
      async (context) => {
        const body = await json(
          context,
          CustomDomainMutationRequestSchema,
          dependencies.maxJsonBytes,
        );
        const current = await customDomainForRoute(context);
        assertCustomDomainVersion(current, body.expectedVersion);
        if (desiredState === 'removed' && !current.provisioning) {
          const value = await updateCustomDomain(current, {
            status: 'removed',
            removedAt: now().toISOString(),
          });
          await auditCustomDomainReconciliation(context, value, 'custom-domain.removed');
          return context.json({ domain: value });
        }
        requireCustomDomainProvisioner();
        const transition = await beginCustomDomainTransition(context, current, desiredState);
        if (
          (desiredState === 'active' && transition.status === 'active') ||
          (desiredState === 'disabled' && transition.status === 'disabled')
        ) {
          return context.json({ domain: transition });
        }
        return context.json({ domain: await reconcileCustomDomain(context, transition) });
      },
    );
  }

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/custom-domains/:domainId/refresh',
    async (context) => {
      const body = await json(
        context,
        CustomDomainMutationRequestSchema,
        dependencies.maxJsonBytes,
      );
      const current = await customDomainForRoute(context);
      assertCustomDomainVersion(current, body.expectedVersion);
      return context.json({ domain: await reconcileCustomDomain(context, current) });
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/portal/grants',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const channelId = requiredParam(context, 'channelId');
      const body = await json(context, CreatePortalGrantRequestSchema, dependencies.maxJsonBytes);
      const value = await dependencies.repository.createPortalGrant({
        id: body.id ?? makeId('grant'),
        workspaceId,
        projectId,
        channelId,
        subject: body.subject,
        permission: body.permission,
        createdBy: actor(context),
        createdAt: now().toISOString(),
        expiresAt: boundedExpiry(
          body.expiresAt,
          dependencies.identity.shareLinkMaxTtlSeconds,
          'Portal grant',
        ),
      });
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'portal.grant-created',
        targetType: 'portal-grant',
        targetId: value.id,
        metadata: {
          projectId,
          channelId,
          subjectKind: value.subject.kind,
          permission: value.permission,
        },
      });
      return context.json({ grant: value }, 201);
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/portal/grants',
    async (context) => {
      const grants = await dependencies.repository.listPortalGrants(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        requiredParam(context, 'channelId'),
        numberQuery(context, 'limit', 100, 500),
      );
      return context.json({ grants });
    },
  );

  app.delete(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/portal/grants/:grantId',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const grantId = requiredParam(context, 'grantId');
      const grant = await dependencies.repository.getPortalGrant(grantId);
      if (
        !grant ||
        grant.workspaceId !== workspaceId ||
        grant.projectId !== requiredParam(context, 'projectId') ||
        grant.channelId !== requiredParam(context, 'channelId')
      ) {
        throw new RepositoryNotFoundError('Portal grant not found');
      }
      if (
        !(await dependencies.repository.revokePortalGrant(
          grantId,
          workspaceId,
          now().toISOString(),
        ))
      )
        throw new RepositoryNotFoundError('Active portal grant not found');
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'portal.grant-revoked',
        targetType: 'portal-grant',
        targetId: grantId,
        metadata: { projectId: grant.projectId, channelId: grant.channelId },
      });
      return context.body(null, 204);
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/portal/share-links',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const channelId = requiredParam(context, 'channelId');
      const body = await json(
        context,
        CreatePrivateShareLinkRequestSchema,
        dependencies.maxJsonBytes,
      );
      const grant = await dependencies.repository.getPortalGrant(body.grantId);
      if (
        !grant ||
        grant.workspaceId !== workspaceId ||
        grant.projectId !== projectId ||
        grant.channelId !== channelId ||
        grant.subject.kind !== 'link' ||
        grant.permission !== 'view' ||
        grant.revokedAt ||
        new Date(grant.expiresAt).getTime() <= now().getTime()
      ) {
        throw new RepositoryNotFoundError('Active view-only link grant not found');
      }
      const expiresAt = boundedExpiry(
        body.expiresAt,
        dependencies.identity.shareLinkMaxTtlSeconds,
        'Private share link',
      );
      if (new Date(expiresAt).getTime() > new Date(grant.expiresAt).getTime())
        throw new HttpError(
          422,
          'share_exceeds_grant',
          'Share link cannot outlive its Portal grant',
        );
      const id = makeId('share');
      const credential = await dependencies.identityTokens.issuePrivateShare(
        { id, grantId: grant.id, expiresAt },
        Math.floor(now().getTime() / 1_000),
      );
      const value = await dependencies.repository.createPrivateShareLink({
        id,
        grantId: grant.id,
        tokenHash: dependencies.identityTokens.hashShareToken(credential),
        createdBy: actor(context),
        createdAt: now().toISOString(),
        expiresAt,
      });
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'portal.share-created',
        targetType: 'private-share-link',
        targetId: value.id,
        metadata: { projectId, channelId, grantId: grant.id, expiresAt },
      });
      return context.json(
        {
          share: {
            id: value.id,
            grantId: value.grantId,
            createdAt: value.createdAt,
            expiresAt: value.expiresAt,
          },
          credential,
          url: `${dependencies.publicationBaseUrl.replace(/\/$/u, '')}/share#token=${encodeURIComponent(credential)}`,
        },
        201,
      );
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/portal/grants/:grantId/share-links',
    async (context) => {
      const grant = await dependencies.repository.getPortalGrant(requiredParam(context, 'grantId'));
      if (
        !grant ||
        grant.workspaceId !== requiredParam(context, 'workspaceId') ||
        grant.projectId !== requiredParam(context, 'projectId') ||
        grant.channelId !== requiredParam(context, 'channelId')
      ) {
        throw new RepositoryNotFoundError('Portal grant not found');
      }
      const links = await dependencies.repository.listPrivateShareLinks(
        grant.id,
        numberQuery(context, 'limit', 100, 500),
      );
      return context.json({
        links: links.map(({ tokenHash: _tokenHash, ...value }) => value),
      });
    },
  );

  app.delete(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/portal/share-links/:linkId',
    async (context) => {
      const linkId = requiredParam(context, 'linkId');
      const link = await dependencies.repository.getPrivateShareLink(linkId);
      const grant = link ? await dependencies.repository.getPortalGrant(link.grantId) : undefined;
      if (
        !link ||
        !grant ||
        grant.workspaceId !== requiredParam(context, 'workspaceId') ||
        grant.projectId !== requiredParam(context, 'projectId') ||
        grant.channelId !== requiredParam(context, 'channelId')
      ) {
        throw new RepositoryNotFoundError('Private share link not found');
      }
      if (!(await dependencies.repository.revokePrivateShareLink(link.id, now().toISOString())))
        throw new RepositoryNotFoundError('Active private share link not found');
      await audit(context, {
        workspaceId: grant.workspaceId,
        actorId: actor(context),
        action: 'portal.share-revoked',
        targetType: 'private-share-link',
        targetId: link.id,
        metadata: { projectId: grant.projectId, channelId: grant.channelId },
      });
      return context.body(null, 204);
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/releases',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const channelId = requiredParam(context, 'channelId');
      const key = idempotencyKey(context);
      const body = await json(context, PromoteReleaseRequestSchema, dependencies.maxJsonBytes);
      if (body.release.projectId !== projectId)
        throw new HttpError(422, 'project_mismatch', 'Release projectId must match the route');
      if (body.release.channelId !== channelId)
        throw new HttpError(422, 'channel_mismatch', 'Release channelId must match the route');
      const channel = await dependencies.repository.getChannel(workspaceId, projectId, channelId);
      if (!channel) throw new RepositoryNotFoundError('Channel not found');
      const build = await dependencies.repository.getVerificationBuild(
        workspaceId,
        projectId,
        body.release.sourceBuildId,
      );
      if (!build)
        throw new HttpError(422, 'unknown_build', 'Release sourceBuildId was not recorded');
      if (build.artifactHash !== artifactHash(build.build)) {
        throw new HttpError(
          409,
          'evidence_integrity_failed',
          'Persisted Build evidence is corrupt',
        );
      }
      if (build.build.repository.dirty)
        throw new HttpError(
          409,
          'dirty_build',
          'A Build from a dirty repository cannot be published',
        );

      const releaseSceneIds = body.release.scenes.map((scene) => scene.sceneId);
      const evidenceSceneIds = body.evidence.scenes.map((scene) => scene.sceneId);
      if (!sameStringSet(releaseSceneIds, evidenceSceneIds))
        throw new HttpError(
          422,
          'evidence_mismatch',
          'Evidence must cover exactly the Scenes in the Release candidate',
        );

      const previousRelease = channel.currentReleaseId
        ? await dependencies.repository.getRelease(workspaceId, projectId, channel.currentReleaseId)
        : undefined;
      if (channel.currentReleaseId && !previousRelease)
        throw new HttpError(
          409,
          'channel_release_missing',
          'Channel current Release was not found',
        );

      const baselineByScene = new Map<string, VerificationBaselineRecord>();
      const readiness: SceneReadiness[] = [];
      const promotionScenes: ReleasePromotionSceneEvidence[] = [];
      for (const sceneEvidence of body.evidence.scenes) {
        const run = await dependencies.repository.getVerificationRun(
          workspaceId,
          projectId,
          sceneEvidence.runId,
        );
        if (!run || run.sceneId !== sceneEvidence.sceneId)
          throw new HttpError(
            422,
            'unknown_run',
            `Release references unknown Run evidence for Scene ${sceneEvidence.sceneId}`,
          );
        if (run.artifactHash !== artifactHash(run.run)) {
          throw new HttpError(
            409,
            'evidence_integrity_failed',
            'Persisted Run evidence is corrupt',
          );
        }
        if (!buildReferencesRun(build, run))
          throw new HttpError(
            422,
            'build_run_mismatch',
            `Run ${run.id} is not exactly bound to Build ${build.id}`,
          );
        const revision = await dependencies.repository.getSceneRevision(
          workspaceId,
          projectId,
          sceneEvidence.sceneId,
          run.sourceRevision,
        );
        if (!revision)
          throw new HttpError(
            422,
            'unknown_scene_revision',
            `Run ${run.id} references an unknown Scene revision`,
          );
        let baseline: VerificationBaselineRecord | undefined;
        if (sceneEvidence.baselineId) {
          baseline = await dependencies.repository.getVerificationBaseline(
            workspaceId,
            projectId,
            sceneEvidence.baselineId,
          );
          if (
            !baseline ||
            baseline.sceneId !== sceneEvidence.sceneId ||
            baseline.sourceRunId !== run.id ||
            baseline.sourceRunHash !== run.artifactHash ||
            baseline.artifactHash !== artifactHash(baseline.baseline) ||
            baseline.sourceRevision !== run.sourceRevision
          ) {
            throw new HttpError(
              422,
              'baseline_mismatch',
              `Baseline is not bound to Run ${run.id} and its exact Scene revision`,
            );
          }
          baselineByScene.set(sceneEvidence.sceneId, baseline);
        }
        const visualApproval = sceneEvidence.visualApprovalId
          ? await dependencies.repository.getReviewApproval(
              workspaceId,
              projectId,
              sceneEvidence.visualApprovalId,
            )
          : undefined;
        const editorialApproval = sceneEvidence.editorialApprovalId
          ? await dependencies.repository.getReviewApproval(
              workspaceId,
              projectId,
              sceneEvidence.editorialApprovalId,
            )
          : undefined;
        const previousScene = previousRelease?.release.scenes.find(
          (candidate) => candidate.sceneId === sceneEvidence.sceneId,
        );
        const status = runStatus(run);
        promotionScenes.push({
          sceneId: sceneEvidence.sceneId,
          runId: run.id,
          runArtifactHash: run.artifactHash,
          ...(baseline
            ? { baselineId: baseline.id, baselineArtifactHash: baseline.artifactHash }
            : {}),
          ...(visualApproval
            ? {
                visualApprovalId: visualApproval.id,
                visualApprovalArtifactHash: visualApproval.artifactHash,
              }
            : {}),
          ...(editorialApproval
            ? {
                editorialApprovalId: editorialApproval.id,
                editorialApprovalArtifactHash: editorialApproval.artifactHash,
              }
            : {}),
        });
        readiness.push({
          sceneId: sceneEvidence.sceneId,
          criticality: revision.scene.criticality,
          status,
          visualApproved:
            baseline !== undefined &&
            approvalIsBound(
              visualApproval,
              'visual',
              'baseline',
              baseline.id,
              baseline.artifactHash,
            ),
          editorialApproved:
            baseline !== undefined &&
            approvalIsBound(
              editorialApproval,
              'editorial',
              'baseline',
              baseline.id,
              baseline.artifactHash,
            ),
          localizationComplete: revision.scene.locales.every((locale) => locale.complete),
          ...(status === 'passed' || status === 'changed'
            ? { candidateRevision: run.sourceRevision }
            : {}),
          ...(previousScene ? { previousReleaseRevision: previousScene.sourceRevision } : {}),
        });
      }

      const policy = evaluateChannelPolicy(channel.policy, readiness);
      if (!policy.allowed)
        throw new HttpError(409, 'channel_policy_blocked', 'Channel policy blocked publication', {
          decision: policy,
        });
      const decisions = new Map(policy.scenes.map((decision) => [decision.sceneId, decision]));
      const releaseScenes: Release['scenes'][number][] = [];
      for (const scene of body.release.scenes) {
        const decision = decisions.get(scene.sceneId)!;
        if (decision.action === 'exclude')
          throw new HttpError(
            422,
            'excluded_scene_present',
            `Release contains excluded Scene ${scene.sceneId}`,
          );
        if (decision.revision !== scene.sourceRevision) {
          throw new HttpError(
            422,
            'release_policy_mismatch',
            `Release Scene ${scene.sceneId} does not match the policy decision`,
          );
        }
        if (decision.action === 'carry-forward') {
          const previous = previousRelease?.release.scenes.find(
            (candidate) => candidate.sceneId === scene.sceneId,
          );
          if (!previous) {
            throw new HttpError(
              422,
              'carry_forward_missing',
              `Release Scene ${scene.sceneId} has no immutable previous output`,
            );
          }
          const {
            baselineId: _baselineId,
            carriedForward: _carriedForward,
            ...previousCandidate
          } = previous;
          if (stableStringify(previousCandidate) !== stableStringify(scene))
            throw new HttpError(
              422,
              'carry_forward_tampered',
              `Carry-forward Scene ${scene.sceneId} must preserve the previous Release bytes`,
            );
          releaseScenes.push({ ...previous, carriedForward: true });
          continue;
        }
        const baseline = baselineByScene.get(scene.sceneId);
        if (!baseline)
          throw new HttpError(
            422,
            'baseline_required',
            `Candidate Scene ${scene.sceneId} requires immutable Baseline evidence`,
          );
        const revision = await dependencies.repository.getSceneRevision(
          workspaceId,
          projectId,
          scene.sceneId,
          scene.sourceRevision,
        );
        if (!revision)
          throw new HttpError(
            422,
            'unknown_scene_revision',
            `Release references unknown revision for Scene ${scene.sceneId}`,
          );
        if (['unknown', 'blocked', 'quarantined'].includes(revision.privacy.status)) {
          throw new HttpError(
            409,
            'scene_privacy_not_cleared',
            `Release Scene ${scene.sceneId} has not passed the privacy gate`,
          );
        }
        releaseScenes.push({ ...scene, baselineId: baseline.id, carriedForward: false });
      }

      const candidateRevision = canonicalJsonHash(body.release);
      const releaseApproval = await dependencies.repository.getReviewApproval(
        workspaceId,
        projectId,
        body.evidence.releaseApprovalId,
      );
      if (
        !releaseApproval ||
        !approvalIsBound(
          releaseApproval,
          'release',
          'release-candidate',
          body.release.id,
          candidateRevision,
        )
      ) {
        throw new HttpError(
          422,
          'release_approval_mismatch',
          'Release requires an authenticated approval bound to this exact candidate',
        );
      }
      const release = ReleaseSchema.parse({
        ...body.release,
        sequence: 1,
        status: 'staged',
        scenes: releaseScenes,
        approvals: [releaseApproval.approval],
      });
      validateReleaseAgainstPolicy(release, readiness, channelId);
      const upload = await assertReleasePublicationAvailable(
        workspaceId,
        projectId,
        {
          ...release,
          publication: body.release.publication,
        },
        {
          repository: build.build.repository.repository,
          commit: build.build.repository.commit,
        },
      );
      if (
        upload.repository.toLowerCase() !== build.build.repository.repository.toLowerCase() ||
        upload.commit !== build.build.repository.commit
      ) {
        throw new HttpError(
          422,
          'stale_release_artifacts',
          'Release artifacts were not built from the exact verified repository revision',
        );
      }
      const requestHash = canonicalJsonHash({ body, actorId: actor(context) });
      const value = await dependencies.repository.promoteRelease({
        workspaceId,
        projectId,
        channelId,
        release,
        expectedCurrentReleaseId: body.expectedCurrentReleaseId,
        idempotencyKey: key,
        requestHash,
        promotionEvidence: {
          buildId: build.id,
          buildArtifactHash: build.artifactHash,
          releaseCandidateHash: candidateRevision,
          releaseApprovalId: releaseApproval.id,
          releaseApprovalArtifactHash: releaseApproval.artifactHash,
          artifactUploadId: upload.id,
          manifestHash: release.manifestHash,
          scenes: promotionScenes,
        },
        now: now().toISOString(),
      });
      await audit(context, {
        workspaceId,
        actorId: actor(context),
        action: 'release.promoted',
        targetType: 'release',
        targetId: value.release.id,
        metadata: {
          channelId,
          sequence: value.release.sequence,
          manifestHash: value.release.manifestHash,
        },
      });
      return context.json({ ...value, policy }, 201);
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/releases',
    async (context) => {
      const releases = await dependencies.repository.listReleases(
        requiredParam(context, 'workspaceId'),
        requiredParam(context, 'projectId'),
        requiredParam(context, 'channelId'),
        numberQuery(context, 'limit', 100, 500),
      );
      return context.json({ releases });
    },
  );

  app.post(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/rollback',
    async (context) => {
      const workspaceId = context.req.param('workspaceId');
      const projectId = context.req.param('projectId');
      const channelId = context.req.param('channelId');
      const key = idempotencyKey(context);
      const body = await json(context, RollbackReleaseRequestSchema, dependencies.maxJsonBytes);
      if (body.targetReleaseId === body.expectedCurrentReleaseId) {
        throw new HttpError(
          422,
          'rollback_target_current',
          'Rollback target must precede the current Release',
        );
      }
      const target = await dependencies.repository.getRelease(
        workspaceId,
        projectId,
        body.targetReleaseId,
      );
      if (!target || target.release.channelId !== channelId)
        throw new RepositoryNotFoundError('Rollback target not found');
      if (!target.promotionEvidence?.artifactUploadId) {
        throw new HttpError(
          409,
          'rollback_evidence_unavailable',
          'Rollback target has no immutable artifact-upload binding',
        );
      }
      if (!target.release.publication) {
        throw new HttpError(
          409,
          'rollback_publication_unbound',
          'Rollback target predates the immutable compiler publication binding',
        );
      }
      await assertReleasePublicationAvailable(
        workspaceId,
        projectId,
        {
          ...target.release,
          publication: target.release.publication,
        },
        {
          uploadId: target.promotionEvidence.artifactUploadId,
        },
      );
      const actorId = actor(context);
      const requestHash = canonicalJsonHash({ body, actorId });
      const value = await dependencies.repository.rollbackRelease({
        workspaceId,
        projectId,
        channelId,
        targetReleaseId: body.targetReleaseId,
        expectedCurrentReleaseId: body.expectedCurrentReleaseId,
        newReleaseId: makeId('release'),
        idempotencyKey: key,
        requestHash,
        now: now().toISOString(),
      });
      await audit(context, {
        workspaceId,
        actorId,
        action: 'release.rolled-back',
        targetType: 'release',
        targetId: value.release.id,
        metadata: {
          channelId,
          targetReleaseId: body.targetReleaseId,
          reasonHash: dependencies.hasher.hash(body.reason, `rollback-reason:${workspaceId}`),
        },
      });
      return context.json(value, 201);
    },
  );

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/releases/:releaseId',
    async (context) => {
      const value = await dependencies.repository.getRelease(
        context.req.param('workspaceId'),
        context.req.param('projectId'),
        context.req.param('releaseId'),
      );
      if (!value) throw new RepositoryNotFoundError('Release not found');
      return context.json(value);
    },
  );

  app.get('/v1/admin/workspaces/:workspaceId/audit', async (context) => {
    const values = await dependencies.repository.listAudit(
      context.req.param('workspaceId'),
      numberQuery(context, 'after', 0, Number.MAX_SAFE_INTEGER),
      numberQuery(context, 'limit', 100, 1_000),
    );
    return context.json({ events: values });
  });

  app.post('/v1/admin/workspaces/:workspaceId/retention/run', async (context) => {
    if (!dependencies.evidenceRetention) {
      throw new HttpError(
        503,
        'evidence_retention_disabled',
        'Evidence retention has no configured final-delete capability',
      );
    }
    const dryRunValue = context.req.query('dryRun');
    if (dryRunValue !== undefined && dryRunValue !== 'true' && dryRunValue !== 'false') {
      throw new HttpError(400, 'invalid_query', 'dryRun must be true or false');
    }
    try {
      const result = await dependencies.evidenceRetention.runOnce(
        requiredParam(context, 'workspaceId'),
        dryRunValue !== 'false',
      );
      return context.json(result);
    } catch (error) {
      if (error instanceof EvidenceRetentionBusyError) {
        throw new HttpError(
          409,
          'evidence_retention_busy',
          'Another bounded evidence-retention pass is already running',
        );
      }
      throw error;
    }
  });

  app.get('/v1/admin/workspaces/:workspaceId/export', async (context) => {
    const workspaceId = requiredParam(context, 'workspaceId');
    const limits = dependencies.workspaceExport ?? {
      maxRecords: 100_000,
      maxAssets: 10_000,
      maxAssetBytes: 4 * 1024 * 1024 * 1024,
      maxMetadataBytes: 64 * 1024 * 1024,
      maxTotalBytes: 0xffff_ffff,
    };
    let value;
    try {
      value = await prepareWorkspaceExport({
        repository: dependencies.repository,
        objectStore: dependencies.objectStore,
        workspaceId,
        createdAt: now().toISOString(),
        ...limits,
      });
    } catch (error) {
      if (error instanceof WorkspaceExportLimitError) {
        throw new HttpError(
          error.kind === 'concurrent-change' ? 409 : 413,
          `workspace_export_${error.kind.replace('-', '_')}`,
          error.message,
        );
      }
      if (error instanceof WorkspaceExportIntegrityError) {
        throw new HttpError(
          409,
          'workspace_export_incomplete',
          'A referenced immutable object is unavailable or failed integrity verification',
        );
      }
      if (error instanceof Error && error.message === 'Workspace not found') {
        throw new HttpError(404, 'workspace_not_found', 'Workspace not found');
      }
      throw error;
    }
    await audit(context, {
      workspaceId,
      actorId: actor(context),
      action: 'workspace.export-created',
      targetType: 'workspace',
      targetId: workspaceId,
      metadata: { manifestHash: value.manifest.manifestHash },
    });
    return new Response(value.body, {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${value.filename}"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  const privatePortalPayload = async (
    workspaceId: string,
    projectId: string,
    channelId: string,
  ) => {
    const channel = await dependencies.repository.getChannel(workspaceId, projectId, channelId);
    if (!channel || channel.kind !== 'private-portal')
      throw new RepositoryNotFoundError('Private portal Channel not found');
    const release = channel.currentReleaseId
      ? await dependencies.repository.getRelease(workspaceId, projectId, channel.currentReleaseId)
      : undefined;
    if (channel.currentReleaseId && (!release || release.release.channelId !== channelId)) {
      throw new HttpError(
        503,
        'release_state_inconsistent',
        'Private portal current Release is unavailable',
      );
    }
    return {
      workspaceId,
      projectId,
      channel: {
        id: channel.id,
        slug: channel.slug,
        name: channel.name,
        kind: channel.kind,
        currentReleaseId: channel.currentReleaseId ?? null,
      },
      release: release?.release ?? null,
    };
  };

  const privatePortalAccess = async (context: AppContext) => {
    const principal = await authenticateHumanBearer(parseBearer(context));
    if (!principal)
      throw new HttpError(
        401,
        'invalid_identity_token',
        'Identity credential is invalid or expired',
      );
    const workspaceId = requiredParam(context, 'workspaceId');
    const projectId = requiredParam(context, 'projectId');
    const channelId = requiredParam(context, 'channelId');
    if (
      principal.workspaceId !== workspaceId ||
      (principal.projectId && principal.projectId !== projectId) ||
      (principal.channelId && principal.channelId !== channelId) ||
      !principal.scopes.includes('channel:read')
    ) {
      throw new HttpError(403, 'insufficient_scope', 'Credential is not scoped to this Portal');
    }
    const channel = await dependencies.repository.getChannel(workspaceId, projectId, channelId);
    if (!channel || channel.kind !== 'private-portal')
      throw new RepositoryNotFoundError('Private portal Channel not found');
    const timestamp = now().toISOString();
    const membership = await dependencies.repository.getWorkspaceMembership(
      workspaceId,
      principal.userId,
    );
    const activeMembership = membership && !membership.revokedAt ? membership : undefined;
    const grant = await dependencies.repository.findPortalGrantForUser(
      workspaceId,
      projectId,
      channelId,
      principal.userId,
      timestamp,
    );
    if (!activeMembership && !grant)
      throw new HttpError(403, 'portal_grant_required', 'No active Portal grant allows access');
    if (activeMembership && !roleAllows(activeMembership.role, 'channel:read') && !grant)
      throw new HttpError(403, 'portal_grant_required', 'No active Portal grant allows access');
    const canReview =
      principal.scopes.includes('review:write') &&
      ((activeMembership && roleAllows(activeMembership.role, 'review:write')) ||
        grant?.permission === 'review');
    setHumanPrincipal(context, principal);
    return {
      principal,
      workspaceId,
      projectId,
      channelId,
      permission: canReview ? ('review' as const) : ('view' as const),
      grant: grant ?? null,
    };
  };

  const livePublicationLoginAuthorization = async (
    handoff: PublicationLoginHandoffRecord,
    current: Date,
  ) => {
    const [session, grant, user, channel] = await Promise.all([
      dependencies.repository.getUserSession(handoff.sourceSessionId),
      dependencies.repository.getPortalGrant(handoff.grantId),
      dependencies.repository.getUser(handoff.userId),
      dependencies.repository.getChannel(handoff.workspaceId, handoff.projectId, handoff.channelId),
    ]);
    const source = session
      ? await dependencies.repository.getIdentityApiToken(session.sourceTokenId)
      : undefined;
    if (
      !session ||
      session.userId !== handoff.userId ||
      session.workspaceId !== handoff.workspaceId ||
      (session.projectId && session.projectId !== handoff.projectId) ||
      (session.channelId && session.channelId !== handoff.channelId) ||
      session.revokedAt ||
      new Date(session.expiresAt).getTime() <= current.getTime() ||
      !session.scopes.includes('channel:read') ||
      !source ||
      source.userId !== session.userId ||
      source.workspaceId !== session.workspaceId ||
      source.projectId !== session.projectId ||
      source.channelId !== session.channelId ||
      stableStringify(source.scopes) !== stableStringify(session.scopes) ||
      source.revokedAt ||
      new Date(source.expiresAt).getTime() <= current.getTime() ||
      !grant ||
      grant.subject.kind !== 'user' ||
      grant.subject.userId !== handoff.userId ||
      grant.workspaceId !== handoff.workspaceId ||
      grant.projectId !== handoff.projectId ||
      grant.channelId !== handoff.channelId ||
      grant.revokedAt ||
      new Date(grant.expiresAt).getTime() <= current.getTime() ||
      !user ||
      user.disabledAt ||
      !channel ||
      channel.kind !== 'private-portal'
    ) {
      throw new HttpError(
        401,
        'publication_login_invalid',
        'Publication login is invalid, expired, or revoked',
      );
    }
    return {
      workspaceId: handoff.workspaceId,
      projectId: handoff.projectId,
      channelId: handoff.channelId,
      userId: handoff.userId,
      sourceSessionId: handoff.sourceSessionId,
      grantId: handoff.grantId,
      audienceOrigin: handoff.audienceOrigin,
      returnPath: handoff.returnPath,
      expiresAt: new Date(
        Math.min(
          new Date(session.expiresAt).getTime(),
          new Date(source.expiresAt).getTime(),
          new Date(grant.expiresAt).getTime(),
        ),
      ).toISOString(),
    };
  };

  const portalReview = async (
    workspaceId: string,
    projectId: string,
    channelId: string,
    reviewId: string,
  ) => {
    const value = await dependencies.repository.getReview(workspaceId, projectId, reviewId);
    if (!value || value.review.subject.kind !== 'release')
      throw new RepositoryNotFoundError('Portal Release review not found');
    const release = await dependencies.repository.getRelease(
      workspaceId,
      projectId,
      value.review.subject.id,
    );
    if (
      !release ||
      release.release.channelId !== channelId ||
      artifactHash(release.release) !== value.review.subject.revision
    ) {
      throw new RepositoryNotFoundError('Portal Release review not found');
    }
    return value;
  };

  app.post(
    '/v1/portal/workspaces/:workspaceId/projects/:projectId/channels/:channelId/login-handoffs',
    async (context) => {
      const config = dependencies.publicationLogin;
      if (!config) {
        throw new HttpError(
          503,
          'publication_login_unavailable',
          'Publication login is not configured',
        );
      }
      await json(context, CreatePublicationLoginHandoffRequestSchema, dependencies.maxJsonBytes);
      const access = await privatePortalAccess(context);
      const principal = access.principal;
      if (!principal || principal.credential !== 'session') {
        throw new HttpError(
          403,
          'browser_session_required',
          'A signed browser Session is required to open a private publication',
        );
      }
      const { workspaceId, projectId, channelId } = access;
      const current = now();
      const [workspace, project, channel, session, grant] = await Promise.all([
        dependencies.repository.getWorkspace(workspaceId),
        dependencies.repository.getProject(workspaceId, projectId),
        dependencies.repository.getChannel(workspaceId, projectId, channelId),
        dependencies.repository.getUserSession(principal.credentialId),
        Promise.resolve(access.grant),
      ]);
      if (
        !workspace ||
        !project ||
        !channel ||
        channel.kind !== 'private-portal' ||
        !session ||
        session.userId !== principal.userId ||
        !grant ||
        grant.subject.kind !== 'user'
      ) {
        throw new HttpError(
          403,
          'portal_grant_required',
          'An active User Portal grant is required to open this private publication',
        );
      }
      const credential = randomBytes(32).toString('base64url');
      const audienceOrigin = new URL(dependencies.publicationBaseUrl).origin;
      const returnPath = `/s/${workspace.slug}/${project.slug}/${channel.slug}/`;
      const expiresAt = new Date(
        Math.min(
          current.getTime() + config.handoffTtlSeconds * 1_000,
          new Date(session.expiresAt).getTime(),
          new Date(grant.expiresAt).getTime(),
        ),
      ).toISOString();
      if (new Date(expiresAt).getTime() <= current.getTime()) {
        throw new HttpError(401, 'publication_login_expired', 'Publication login has expired');
      }
      const handoff = await dependencies.repository.createPublicationLoginHandoff({
        id: makeId('portal-login'),
        tokenHash: sha256(credential),
        workspaceId,
        projectId,
        channelId,
        userId: principal.userId,
        sourceSessionId: session.id,
        grantId: grant.id,
        audienceOrigin,
        returnPath,
        createdAt: current.toISOString(),
        expiresAt,
      });
      await audit(context, {
        workspaceId,
        actorId: principal.userId,
        action: 'portal.login-handoff-created',
        targetType: 'channel',
        targetId: channelId,
        metadata: { projectId, grantId: grant.id, handoffId: handoff.id },
      });
      context.header('cache-control', 'private, no-store');
      context.header('referrer-policy', 'no-referrer');
      return context.json(
        {
          url: `${audienceOrigin}/login#credential=${encodeURIComponent(credential)}`,
          expiresAt,
        },
        201,
      );
    },
  );

  app.post('/v1/internal/publication-login/consume', async (context) => {
    const config = dependencies.publicationLogin;
    const supplied = parseBearer(context);
    if (!config || !constantTimeEqual(supplied, config.exchangeSecret)) {
      throw new HttpError(401, 'internal_authentication_failed', 'Internal authentication failed');
    }
    const body = await json(
      context,
      ConsumePublicationLoginHandoffRequestSchema,
      dependencies.maxJsonBytes,
    );
    const current = now();
    const lookup = {
      tokenHash: sha256(body.credential),
      audienceOrigin: body.audienceOrigin,
      now: current.toISOString(),
    };
    const candidate = await dependencies.repository.getActivePublicationLoginHandoff(lookup);
    if (!candidate) {
      throw new HttpError(
        401,
        'publication_login_invalid',
        'Publication login is invalid, expired, or already used',
      );
    }
    const authorization = await livePublicationLoginAuthorization(candidate, current);
    const handoff = await dependencies.repository.consumePublicationLoginHandoffAndAudit(
      lookup,
      auditRecord(context, {
        workspaceId: candidate.workspaceId,
        actorId: candidate.userId,
        action: 'portal.login-handoff-consumed',
        targetType: 'channel',
        targetId: candidate.channelId,
        metadata: {
          projectId: candidate.projectId,
          grantId: candidate.grantId,
          handoffId: candidate.id,
        },
      }),
    );
    if (!handoff) {
      throw new HttpError(
        401,
        'publication_login_invalid',
        'Publication login is invalid, expired, or already used',
      );
    }
    context.header('cache-control', 'private, no-store');
    context.header('referrer-policy', 'no-referrer');
    return context.json({ authorization });
  });

  app.post('/v1/portal/share/resolve', async (context) => {
    const body = await json(context, ResolvePrivateShareRequestSchema, dependencies.maxJsonBytes);
    let claims;
    try {
      claims = await dependencies.identityTokens.verifyPrivateShare(
        body.token,
        Math.floor(now().getTime() / 1_000),
      );
    } catch {
      throw new HttpError(401, 'invalid_private_share', 'Private share is invalid or expired');
    }
    const link = await dependencies.repository.getPrivateShareLink(claims.linkId);
    const grant = await dependencies.repository.getPortalGrant(claims.grantId);
    const current = now().getTime();
    const suppliedHash = dependencies.identityTokens.hashShareToken(body.token);
    const storedHash = link?.tokenHash ?? '0'.repeat(64);
    const hashMatches = constantTimeEqual(suppliedHash, storedHash);
    if (
      !link ||
      link.grantId !== claims.grantId ||
      link.revokedAt ||
      new Date(link.expiresAt).getTime() <= current ||
      Math.floor(new Date(link.expiresAt).getTime() / 1_000) !== claims.expiresAt ||
      !hashMatches ||
      !grant ||
      grant.id !== link.grantId ||
      grant.subject.kind !== 'link' ||
      grant.permission !== 'view' ||
      grant.revokedAt ||
      new Date(grant.expiresAt).getTime() <= current
    ) {
      throw new HttpError(401, 'invalid_private_share', 'Private share is invalid or expired');
    }
    const portal = await privatePortalPayload(grant.workspaceId, grant.projectId, grant.channelId);
    context.header('cache-control', 'no-store');
    await audit(context, {
      workspaceId: grant.workspaceId,
      actorId: `private-share:${link.id}`,
      action: 'portal.share-resolved',
      targetType: 'channel',
      targetId: grant.channelId,
      metadata: { projectId: grant.projectId, grantId: grant.id },
    });
    return context.json({ portal, permission: 'view', expiresAt: link.expiresAt });
  });

  app.get('/portal/private', (context) => {
    const nonce = randomUUID().replace(/-/gu, '');
    context.header('cache-control', 'no-store');
    context.header(
      'content-security-policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    );
    return context.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f4f2ed"><title>Opening private publication</title><style nonce="${nonce}">:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f2ed;color:#25231f;--muted:#68645d}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:clamp(20px,5vw,64px);background:#f4f2ed;color:#25231f}main{width:min(100%,38rem);padding-block:clamp(24px,6vw,56px)}h1{max-width:20ch;margin:0;font-size:clamp(2rem,8vw,3.25rem);font-weight:720;line-height:1.05;letter-spacing:-.035em}p{max-width:52ch;margin:18px 0 0;color:var(--muted);font-size:1.0625rem;line-height:1.6}noscript p{color:#942b20}@media(max-width:360px){body{place-items:start}main{padding-top:32px}}@media(prefers-color-scheme:dark){:root{background:#191815;color:#f4f2ed;--muted:#c2bdb3}body{background:#191815;color:#f4f2ed}noscript p{color:#ff9c90}}</style></head>
<body><main aria-busy="true"><h1>Opening private publication</h1><p id="status" role="status" aria-live="polite">Continuing securely to the publication gateway…</p><noscript><p>JavaScript is required to preserve and open this private invitation. Enable it, then reopen the link.</p></noscript></main>
<script nonce="${nonce}">(()=>{const destination=${JSON.stringify(`${dependencies.publicationBaseUrl.replace(/\/$/u, '')}/share`)};location.replace(destination+location.hash)})();</script></body></html>`);
  });

  app.get(
    '/v1/portal/workspaces/:workspaceId/projects/:projectId/channels/:channelId',
    async (context) => {
      const access = await privatePortalAccess(context);
      context.header('cache-control', 'no-store');
      return context.json({
        portal: await privatePortalPayload(access.workspaceId, access.projectId, access.channelId),
        permission: access.permission,
        grant: access.grant,
      });
    },
  );

  app.get(
    '/v1/portal/workspaces/:workspaceId/projects/:projectId/channels/:channelId/reviews/:reviewId',
    async (context) => {
      const access = await privatePortalAccess(context);
      const review = await portalReview(
        access.workspaceId,
        access.projectId,
        access.channelId,
        requiredParam(context, 'reviewId'),
      );
      context.header('cache-control', 'no-store');
      return context.json({ ...review, permission: access.permission });
    },
  );

  app.post(
    '/v1/portal/workspaces/:workspaceId/projects/:projectId/channels/:channelId/reviews/:reviewId/comments',
    async (context) => {
      const access = await privatePortalAccess(context);
      if (access.permission !== 'review')
        throw new HttpError(403, 'review_permission_required', 'Portal grant is view-only');
      const reviewId = requiredParam(context, 'reviewId');
      await portalReview(access.workspaceId, access.projectId, access.channelId, reviewId);
      const body = await json(context, AddReviewCommentRequestSchema, dependencies.maxJsonBytes);
      if (scanStructuredValue(body, { blockAt: 'high', now }).status === 'blocked')
        throw new HttpError(422, 'privacy_blocked', 'Review comment contains sensitive material');
      const value = await dependencies.repository.addReviewComment(
        access.workspaceId,
        access.projectId,
        reviewId,
        {
          ...body,
          id: body.id ?? makeId('comment'),
          actorId: access.principal.userId,
          createdAt: now().toISOString(),
        },
      );
      await audit(context, {
        workspaceId: access.workspaceId,
        actorId: access.principal.userId,
        action: 'review.comment-added',
        targetType: 'review',
        targetId: reviewId,
        metadata: { channelId: access.channelId },
      });
      return context.json(value, 201);
    },
  );

  app.post(
    '/v1/portal/workspaces/:workspaceId/projects/:projectId/channels/:channelId/reviews/:reviewId/decisions',
    async (context) => {
      const access = await privatePortalAccess(context);
      if (access.permission !== 'review')
        throw new HttpError(403, 'review_permission_required', 'Portal grant is view-only');
      const reviewId = requiredParam(context, 'reviewId');
      await portalReview(access.workspaceId, access.projectId, access.channelId, reviewId);
      const body = await json(context, AddReviewDecisionRequestSchema, dependencies.maxJsonBytes);
      if (scanStructuredValue(body, { blockAt: 'high', now }).status === 'blocked')
        throw new HttpError(422, 'privacy_blocked', 'Review decision contains sensitive material');
      const value = await dependencies.repository.addReviewDecision(
        access.workspaceId,
        access.projectId,
        reviewId,
        {
          ...body,
          id: body.id ?? makeId('decision'),
          actorId: access.principal.userId,
          createdAt: now().toISOString(),
        },
      );
      const checkRun = await syncGitHubCheckForReview(access.workspaceId, access.projectId, value);
      await audit(context, {
        workspaceId: access.workspaceId,
        actorId: access.principal.userId,
        action: `review.${body.decision}`,
        targetType: 'review',
        targetId: reviewId,
        metadata: {
          channelId: access.channelId,
          ...(checkRun
            ? {
                checkRunId: checkRun.id,
                checkRunStatus: checkRun.status,
                ...(checkRun.conclusion ? { checkRunConclusion: checkRun.conclusion } : {}),
              }
            : {}),
        },
      });
      return context.json(value, 201);
    },
  );

  app.post('/v1/oidc/exchange', async (context) => {
    const body = await json(context, OidcExchangeRequestSchema, dependencies.maxJsonBytes);
    let claims;
    try {
      claims = await dependencies.oidcVerifier.verify(body.oidcToken);
    } catch {
      throw new HttpError(401, 'invalid_oidc_token', 'GitHub OIDC token is invalid');
    }
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(claims.repository) ||
      !/^[a-f0-9]{40,64}$/u.test(claims.commit)
    ) {
      throw new HttpError(
        401,
        'invalid_oidc_claims',
        'GitHub OIDC repository or commit claim is invalid',
      );
    }
    const binding = await dependencies.repository.getRepositoryBinding(
      body.workspaceId,
      body.projectId,
      claims.repository,
    );
    if (!binding || !matchesWorkflowRef(binding.workflowRefPattern, claims.workflowRef)) {
      throw new HttpError(
        403,
        'repository_not_authorized',
        'Repository or workflow is not authorized for this Project',
      );
    }
    const current = Math.floor(now().getTime() / 1_000);
    const expiresAt = current + dependencies.uploadTokenTtlSeconds;
    const consumed = await dependencies.repository.consumeOidcToken({
      tokenId: claims.tokenId,
      repository: claims.repository,
      commit: claims.commit,
      expiresAt: new Date((current + 600) * 1_000).toISOString(),
    });
    if (!consumed)
      throw new HttpError(409, 'oidc_replay', 'This GitHub OIDC token was already exchanged');
    const uploadClaims: UploadTokenClaims = {
      workspaceId: body.workspaceId,
      projectId: body.projectId,
      repository: claims.repository,
      commit: claims.commit,
      ref: claims.ref,
      workflowRef: claims.workflowRef,
      permissions: ['artifact:write'],
      expiresAt,
      tokenId: makeId('upload-token'),
    };
    const token = await dependencies.uploadTokens.issue(uploadClaims, current);
    await audit(context, {
      workspaceId: body.workspaceId,
      actorId: IdSchema.safeParse(claims.actor).success ? claims.actor : 'github-actions',
      action: 'oidc.exchanged',
      targetType: 'repository',
      targetId: binding.id,
      metadata: {
        repository: claims.repository,
        commit: claims.commit,
        ref: claims.ref,
        runId: claims.runId,
        expiresAt,
      },
    });
    return context.json({
      tokenType: 'Bearer',
      token,
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
      scope: 'artifact:write',
    });
  });

  app.post('/v1/uploads', async (context) => {
    const claims = await verifyUploadToken(context);
    const key = idempotencyKey(context);
    const body = await json(context, BeginUploadRequestSchema, dependencies.maxJsonBytes);
    if (body.objects.length > dependencies.uploadLimits.maxObjectsPerUpload) {
      throw new HttpError(
        413,
        'too_many_objects',
        `Upload object count exceeds the ${dependencies.uploadLimits.maxObjectsPerUpload} object limit`,
      );
    }
    let aggregateBytes = 0;
    if (body.objects.some((object) => object.byteLength > dependencies.maxObjectBytes)) {
      throw new HttpError(
        413,
        'object_too_large',
        `An object exceeds the ${dependencies.maxObjectBytes} byte limit`,
      );
    }
    for (const object of body.objects) {
      aggregateBytes += object.byteLength;
      if (
        !Number.isSafeInteger(aggregateBytes) ||
        aggregateBytes > dependencies.uploadLimits.maxBytesPerUpload
      ) {
        throw new HttpError(
          413,
          'upload_too_large',
          `Upload exceeds the ${dependencies.uploadLimits.maxBytesPerUpload} aggregate byte limit`,
        );
      }
      try {
        new ObjectMediaStreamValidator(object.mediaType, object.byteLength);
      } catch (error) {
        if (error instanceof ObjectMediaPolicyError) {
          throw new HttpError(413, 'object_media_limit', error.message);
        }
        throw error;
      }
    }
    const requestHash = canonicalJsonHash(body);
    const value = await dependencies.repository.beginUpload({
      id: makeId('upload'),
      workspaceId: claims.workspaceId,
      projectId: claims.projectId,
      repository: claims.repository,
      commit: claims.commit,
      ref: claims.ref,
      idempotencyKey: key,
      requestHash,
      objects: body.objects,
      now: now().toISOString(),
      expiresAt: new Date(claims.expiresAt * 1_000).toISOString(),
      limits: dependencies.uploadLimits,
    });
    await audit(context, {
      workspaceId: claims.workspaceId,
      actorId: 'github-actions',
      action: 'upload.created',
      targetType: 'artifact-upload',
      targetId: value.id,
      metadata: {
        projectId: claims.projectId,
        repository: claims.repository,
        commit: claims.commit,
        objectCount: value.objects.length,
        aggregateBytes,
      },
    });
    return context.json({ upload: value }, 201);
  });

  app.put('/v1/uploads/:uploadId/objects/:sha256', async (context) => {
    const claims = await verifyUploadToken(context);
    const uploadId = context.req.param('uploadId');
    const hash = context.req.param('sha256');
    const upload = await dependencies.repository.getUpload(uploadId);
    if (!upload) throw new RepositoryNotFoundError('Upload not found');
    ensureUploadBinding(claims, upload);
    if (new Date(upload.expiresAt).getTime() <= now().getTime())
      throw new HttpError(410, 'upload_expired', 'Upload expired');
    if (upload.status === 'finalized' || upload.status === 'expired')
      throw new HttpError(409, 'upload_closed', 'Upload no longer accepts objects');
    const contentType = context.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    const matchingHash = upload.objects.some((object) => object.sha256 === hash);
    if (!matchingHash) throw new RepositoryNotFoundError('Upload object not found');
    const expected = upload.objects.find(
      (object) => object.sha256 === hash && object.mediaType.toLowerCase() === contentType,
    );
    if (!expected)
      throw new HttpError(
        415,
        'media_type_mismatch',
        'Content-Type does not match the declared object media type',
      );
    const reservation = uploadAdmission.acquire(claims.workspaceId, expected.byteLength);
    metrics.gauge(
      'scenebook_upload_active_objects',
      'Artifact object upload streams currently active',
      reservation.snapshot.globalObjects,
    );
    metrics.gauge(
      'scenebook_upload_active_bytes',
      'Declared artifact bytes reserved by active upload streams',
      reservation.snapshot.globalBytes,
    );
    let staged: StoredObject;
    try {
      staged = await dependencies.objectStore.putStagedStream(
        uploadId,
        expected.sha256,
        readLimitedStream(
          context.req.raw,
          Math.min(dependencies.maxObjectBytes, expected.byteLength),
        ),
        expected.byteLength,
        expected.mediaType,
      );
    } catch (error) {
      if (error instanceof ObjectMediaPolicyError) {
        throw new HttpError(415, 'unsafe_object_media', error.message);
      }
      if (error instanceof ObjectIntegrityError) {
        throw new HttpError(
          422,
          error.kind === 'digest' ? 'object_digest_mismatch' : 'object_length_mismatch',
          error.message,
        );
      }
      throw error;
    } finally {
      const snapshot = reservation.release();
      metrics.gauge(
        'scenebook_upload_active_objects',
        'Artifact object upload streams currently active',
        snapshot.globalObjects,
      );
      metrics.gauge(
        'scenebook_upload_active_bytes',
        'Declared artifact bytes reserved by active upload streams',
        snapshot.globalBytes,
      );
    }
    const stagedAt = now();
    let value: ArtifactUploadRecord;
    try {
      value = await dependencies.repository.markObjectStaged(
        uploadId,
        hash,
        expected.mediaType,
        staged.key,
        stagedAt.toISOString(),
      );
    } catch (error) {
      // If the stream crossed the upload expiry boundary, the GC might have
      // claimed an empty/pending record before the immutable object appeared.
      // Remove that deterministic staged object here so it cannot become an
      // orphan after the GC claim completes.
      const latest = await dependencies.repository.getUpload(uploadId).catch(() => undefined);
      if (
        !latest ||
        latest.status === 'expired' ||
        new Date(latest.expiresAt).getTime() <= stagedAt.getTime()
      ) {
        await dependencies.objectStore.deleteStaged(staged).catch((cleanupError) => {
          dependencies.logger.warn('Failed to remove an uncommitted staged artifact', {
            uploadId,
            sha256: hash,
            mediaType: expected.mediaType,
            error: cleanupError,
          });
        });
      }
      throw error;
    }
    metrics.increment(
      'scenebook_upload_staged_bytes_total',
      'Artifact object bytes successfully staged',
      {},
      staged.byteLength,
    );
    await audit(context, {
      workspaceId: claims.workspaceId,
      actorId: 'github-actions',
      action: 'upload.object-staged',
      targetType: 'artifact-upload',
      targetId: uploadId,
      metadata: {
        sha256: hash,
        mediaType: staged.mediaType,
        byteLength: staged.byteLength,
      },
    });
    return context.json({ upload: value });
  });

  app.post('/v1/uploads/:uploadId/finalize', async (context) => {
    const claims = await verifyUploadToken(context);
    const uploadId = context.req.param('uploadId');
    const upload = await dependencies.repository.getUpload(uploadId);
    if (!upload) throw new RepositoryNotFoundError('Upload not found');
    ensureUploadBinding(claims, upload);
    const body = await json(context, FinalizeUploadRequestSchema, dependencies.maxJsonBytes);
    if (!exactManifestObjects(upload.objects, body.manifest.objects)) {
      throw new HttpError(
        422,
        'manifest_object_mismatch',
        'Manifest must describe exactly the declared upload objects',
      );
    }
    const privacy = scanStructuredValue(body.manifest.metadata, { blockAt: 'high', now });
    if (privacy.status === 'blocked')
      throw new HttpError(
        422,
        'privacy_blocked',
        'Artifact manifest metadata contains sensitive material',
      );
    const manifestHash = canonicalJsonHash(body.manifest);
    if (upload.status === 'finalized') {
      if (upload.manifestHash !== manifestHash)
        throw new RepositoryConflictError('Upload was finalized with another manifest');
      return context.json({ upload });
    }
    if (upload.status !== 'staged')
      throw new RepositoryConflictError('Every expected object must be staged before finalization');
    const promoted: StoredObject[] = [];
    try {
      for (const object of upload.objects) {
        promoted.push(
          await dependencies.objectStore.promote(uploadObject(object), upload.workspaceId),
        );
      }
    } catch (error) {
      dependencies.logger.warn('Artifact promotion failed; upload remains retryable', {
        uploadId,
        promotedCount: promoted.length,
        objectCount: upload.objects.length,
        error,
      });
      throw new HttpError(
        503,
        'artifact_promotion_failed',
        'Artifact promotion failed; finalization can be retried',
      );
    }
    const value = await dependencies.repository.finalizeUpload(
      uploadId,
      manifestHash,
      promoted,
      now().toISOString(),
    );
    await Promise.all(
      upload.objects.map((object) =>
        dependencies.objectStore.deleteStaged(uploadObject(object)).catch((error) => {
          dependencies.logger.warn('Finalized staging object cleanup failed', {
            uploadId,
            sha256: object.sha256,
            mediaType: object.mediaType,
            error,
          });
        }),
      ),
    );
    await audit(context, {
      workspaceId: claims.workspaceId,
      actorId: 'github-actions',
      action: 'upload.finalized',
      targetType: 'artifact-upload',
      targetId: uploadId,
      metadata: { manifestHash, objectCount: promoted.length },
    });
    return context.json({ upload: value, manifestHash });
  });

  app.get(
    '/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/analytics/funnel',
    async (context) => {
      const workspaceId = requiredParam(context, 'workspaceId');
      const projectId = requiredParam(context, 'projectId');
      const channelId = requiredParam(context, 'channelId');
      const parameters = new URL(context.req.url).searchParams;
      const allowedParameters = new Set(['releaseId', 'from', 'to']);
      for (const key of parameters.keys()) {
        if (!allowedParameters.has(key) || parameters.getAll(key).length !== 1) {
          throw new HttpError(
            422,
            'validation_failed',
            'Analytics funnel query contains an unknown or repeated parameter',
          );
        }
      }
      const parsedQuery = AnalyticsFunnelQuerySchema.safeParse(Object.fromEntries(parameters));
      if (!parsedQuery.success) {
        throw new HttpError(422, 'validation_failed', 'Analytics funnel query is invalid', {
          issues: parsedQuery.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }
      const channel = await dependencies.repository.getChannel(workspaceId, projectId, channelId);
      if (!channel) throw new RepositoryNotFoundError('Channel not found');
      const releaseId = parsedQuery.data.releaseId ?? channel.currentReleaseId;
      if (!releaseId) {
        throw new HttpError(
          409,
          'channel_unpublished',
          'Channel has no current Release to summarize',
        );
      }
      const release = await dependencies.repository.getRelease(workspaceId, projectId, releaseId);
      if (!release || release.release.channelId !== channelId) {
        throw new RepositoryNotFoundError('Release not found for Channel');
      }
      const current = now();
      const to = parsedQuery.data.to ? new Date(parsedQuery.data.to) : current;
      const defaultFrom = to.getTime() - 30 * 24 * 60 * 60 * 1_000;
      const from = parsedQuery.data.from ? new Date(parsedQuery.data.from) : new Date(defaultFrom);
      if (
        from.getTime() >= to.getTime() ||
        to.getTime() > current.getTime() + 5 * 60 * 1_000 ||
        to.getTime() - from.getTime() > 90 * 24 * 60 * 60 * 1_000
      ) {
        throw new HttpError(
          422,
          'analytics_range_invalid',
          'Analytics range must be positive, at most 90 days, and not in the future',
        );
      }
      const rows = await dependencies.repository.aggregateAnalytics({
        workspaceId,
        projectId,
        channelId,
        releaseId,
        from: from.toISOString(),
        to: to.toISOString(),
      });
      const totals = emptyAnalyticsCounts();
      const scenes = new Map<
        string,
        { readonly counts: AnalyticsCounts; readonly steps: Map<string, AnalyticsCounts> }
      >();
      const sceneBucket = (sceneId: string) => {
        let scene = scenes.get(sceneId);
        if (!scene) {
          scene = { counts: emptyAnalyticsCounts(), steps: new Map() };
          scenes.set(sceneId, scene);
        }
        return scene;
      };
      for (const row of rows) {
        if (row.scope === 'total') {
          addAnalyticsCount(totals, row);
          continue;
        }
        if (!row.sceneId) {
          throw new Error('Analytics aggregate Scene scope is missing sceneId');
        }
        const scene = sceneBucket(row.sceneId);
        if (row.scope === 'scene') {
          addAnalyticsCount(scene.counts, row);
          continue;
        }
        if (!row.stepId) throw new Error('Analytics aggregate Step scope is missing stepId');
        let step = scene.steps.get(row.stepId);
        if (!step) {
          step = emptyAnalyticsCounts();
          scene.steps.set(row.stepId, step);
        }
        addAnalyticsCount(step, row);
      }
      const sceneSummaries = [...scenes.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sceneId, scene]) => ({
          sceneId,
          ...analyticsSceneSummary(scene.counts),
          steps: [...scene.steps.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([stepId, counts]) => ({
              stepId,
              ...analyticsStepSummary(counts, scene.counts.events.view),
            })),
        }));
      const ctas = sceneSummaries.flatMap((scene) => {
        return scene.steps
          .filter((step) => step.events.cta > 0)
          .map((step) => ({
            sceneId: scene.sceneId,
            stepId: step.stepId,
            events: step.events.cta,
            uniqueSubjects: step.uniqueSubjects.cta,
            conversionPerReach: step.rates.ctaPerReach,
          }));
      });
      context.header('cache-control', 'private, no-store');
      return context.json({
        funnel: {
          schemaVersion: 1,
          workspaceId,
          projectId,
          channelId,
          releaseId,
          from: from.toISOString(),
          to: to.toISOString(),
          generatedAt: current.toISOString(),
          rateBasis: 'accepted-events',
          counting: {
            uniqueSubjects:
              'distinct session, then anonymous subject, otherwise one privacy-safe subject per event',
          },
          totals: analyticsSceneSummary(totals),
          scenes: sceneSummaries,
          ctas,
        },
      });
    },
  );

  const publicChannel = async (context: AppContext) => {
    const workspaceId = requiredParam(context, 'workspaceId');
    const projectId = requiredParam(context, 'projectId');
    const channelId = requiredParam(context, 'channelId');
    const channel = await dependencies.repository.getChannel(workspaceId, projectId, channelId);
    if (!channel) throw new RepositoryNotFoundError('Channel not found');
    const supplied = dependencies.hasher.hash(parseBearer(context), 'analytics-token');
    if (!constantTimeEqual(supplied, channel.analyticsTokenHash))
      throw new HttpError(401, 'invalid_channel_token', 'Channel token is invalid');
    return { workspaceId, projectId, channelId, channel };
  };

  const assertCurrentReleaseSubject = async (
    scope: {
      readonly workspaceId: string;
      readonly projectId: string;
      readonly channelId: string;
      readonly channel: ChannelRecord;
    },
    releaseId: string,
    sceneId: string,
    stepId?: string,
  ): Promise<{ readonly step?: Step }> => {
    if (!scope.channel.currentReleaseId)
      throw new HttpError(409, 'channel_unpublished', 'Channel has no current Release');
    if (releaseId !== scope.channel.currentReleaseId)
      throw new HttpError(409, 'stale_release', 'Event must target the Channel current Release');
    const record = await dependencies.repository.getRelease(
      scope.workspaceId,
      scope.projectId,
      releaseId,
    );
    if (!record || record.release.channelId !== scope.channelId) {
      throw new HttpError(
        503,
        'release_state_inconsistent',
        'Channel current Release is unavailable',
      );
    }
    const releaseScene = record.release.scenes.find((scene) => scene.sceneId === sceneId);
    if (!releaseScene)
      throw new HttpError(422, 'unknown_release_scene', 'Scene is not part of the current Release');
    if (stepId) {
      const revision = await dependencies.repository.getSceneRevision(
        scope.workspaceId,
        scope.projectId,
        sceneId,
        releaseScene.sourceRevision,
      );
      if (!revision)
        throw new HttpError(
          503,
          'release_state_inconsistent',
          'Current Release Scene revision is unavailable',
        );
      const step = revision.scene.steps.find((candidate) => candidate.id === stepId);
      if (!step) {
        throw new HttpError(
          422,
          'unknown_release_step',
          'Step is not part of the current Release Scene',
        );
      }
      return { step };
    }
    return {};
  };

  app.post(
    '/v1/public/workspaces/:workspaceId/projects/:projectId/channels/:channelId/analytics',
    async (context) => {
      const scope = await publicChannel(context);
      const body = await json(context, AnalyticsEventRequestSchema, dependencies.maxJsonBytes);
      await assertCurrentReleaseSubject(scope, body.releaseId, body.sceneId, body.stepId);
      const occurred = new Date(body.occurredAt).getTime();
      const current = now().getTime();
      if (
        occurred > current + 7 * 24 * 60 * 60 * 1_000 ||
        occurred < current - 90 * 24 * 60 * 60 * 1_000
      ) {
        throw new HttpError(
          422,
          'event_time_out_of_range',
          'Analytics occurredAt is outside the accepted retention window',
        );
      }
      const privacy = scanStructuredValue(body.properties, { blockAt: 'medium', now });
      if (privacy.findings.length > 0)
        throw new HttpError(
          422,
          'analytics_privacy_rejected',
          'Analytics properties may not contain personal or secret data',
        );
      const inserted = await dependencies.repository.ingestAnalytics({
        schemaVersion: body.schemaVersion,
        id: body.id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        channelId: scope.channelId,
        releaseId: body.releaseId,
        sceneId: body.sceneId,
        type: body.type,
        occurredAt: body.occurredAt,
        properties: body.properties,
        ...(body.stepId ? { stepId: body.stepId } : {}),
        ...(body.anonymousId
          ? {
              anonymousIdHash: dependencies.hasher.hash(
                body.anonymousId,
                `analytics-anonymous:${scope.workspaceId}`,
              ),
            }
          : {}),
        ...(body.sessionId
          ? {
              sessionIdHash: dependencies.hasher.hash(
                body.sessionId,
                `analytics-session:${scope.workspaceId}`,
              ),
            }
          : {}),
      });
      return context.json({ accepted: inserted }, inserted ? 202 : 200);
    },
  );

  app.post(
    '/v1/public/workspaces/:workspaceId/projects/:projectId/channels/:channelId/cta',
    async (context) => {
      const scope = await publicChannel(context);
      const body = await json(context, CtaSubmissionRequestSchema, dependencies.maxJsonBytes);
      if (!scope.channel.webhookIds.includes(body.webhookId)) {
        throw new HttpError(422, 'webhook_not_allowed', 'Webhook is not allowed for this Channel');
      }
      requireConfiguredWebhook(body.webhookId);
      const subject = await assertCurrentReleaseSubject(
        scope,
        body.releaseId,
        body.sceneId,
        body.stepId,
      );
      const cta = assertCtaFieldContract(subject.step!, body.ctaId, body.webhookId, body.fields);
      const privacy = scanStructuredValue(body.fields, { blockAt: 'high', now });
      if (privacy.status === 'blocked')
        throw new HttpError(
          422,
          'cta_privacy_rejected',
          'CTA fields contain secret, authentication, or payment data',
        );
      const id = body.id ?? makeId('cta');
      const createdAt = now().toISOString();
      const payload = {
        schemaVersion: 1,
        id,
        releaseId: body.releaseId,
        sceneId: body.sceneId,
        stepId: body.stepId,
        ctaId: cta.id,
        fields: body.fields,
        createdAt,
      };
      const inserted = await dependencies.repository.createCtaSubmission(
        {
          id,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          channelId: scope.channelId,
          releaseId: body.releaseId,
          sceneId: body.sceneId,
          ctaId: cta.id,
          webhookId: body.webhookId,
          payloadHash: dependencies.hasher.hash(
            stableStringify(payload),
            `cta-payload:${scope.workspaceId}`,
          ),
          encryptedPayload: dependencies.secretBox.encrypt(payload),
          createdAt,
          stepId: body.stepId,
        },
        {
          id: makeId('delivery'),
          submissionId: id,
          webhookId: body.webhookId,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: createdAt,
        },
      );
      return context.json({ accepted: inserted, submissionId: id }, inserted ? 202 : 200);
    },
  );

  return app;
}
