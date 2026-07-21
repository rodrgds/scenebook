export const CHANGE_DIMENSIONS = [
  'functional',
  'visual',
  'semantic',
  'geometry',
  'narrative',
  'privacy',
] as const;

export type ChangeDimension = (typeof CHANGE_DIMENSIONS)[number];
export type ChangeSeverity = 'info' | 'warning' | 'changed' | 'broken' | 'blocked';

export interface GitHubReviewChange {
  readonly dimension: ChangeDimension;
  readonly severity: ChangeSeverity;
  readonly summary: string;
  readonly details?: string;
  readonly sceneId: string;
  readonly stepId?: string;
  readonly path?: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface GitHubCheckPayload {
  readonly name: string;
  readonly head_sha: string;
  readonly status: 'completed';
  readonly conclusion: 'success' | 'neutral' | 'failure';
  readonly details_url?: string;
  readonly output: {
    readonly title: string;
    readonly summary: string;
    readonly text: string;
    readonly annotations: readonly {
      readonly path: string;
      readonly start_line: number;
      readonly end_line: number;
      readonly annotation_level: 'notice' | 'warning' | 'failure';
      readonly title: string;
      readonly message: string;
      readonly raw_details?: string;
    }[];
  };
}

function conclusion(changes: readonly GitHubReviewChange[]): GitHubCheckPayload['conclusion'] {
  if (changes.some((change) => change.severity === 'broken' || change.severity === 'blocked'))
    return 'failure';
  if (changes.some((change) => change.severity === 'changed' || change.severity === 'warning'))
    return 'neutral';
  return 'success';
}

function level(severity: ChangeSeverity): 'notice' | 'warning' | 'failure' {
  if (severity === 'blocked' || severity === 'broken') return 'failure';
  if (severity === 'warning' || severity === 'changed') return 'warning';
  return 'notice';
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function buildGitHubSummary(changes: readonly GitHubReviewChange[]): string {
  const counts = Object.fromEntries(
    CHANGE_DIMENSIONS.map((dimension) => [
      dimension,
      changes.filter((change) => change.dimension === dimension).length,
    ]),
  );
  const rows = changes.length
    ? changes
        .map(
          (change) =>
            `| ${escapeCell(change.severity)} | ${escapeCell(change.dimension)} | ${escapeCell(change.sceneId)} | ${escapeCell(change.stepId ?? '—')} | ${escapeCell(change.summary)} |`,
        )
        .join('\n')
    : '| passed | — | — | — | No changes detected |';
  return `## Scenebook review\n\n**${conclusion(changes)}** · ${changes.length} change(s) · ${CHANGE_DIMENSIONS.map((dimension) => `${dimension}: ${counts[dimension]}`).join(' · ')}\n\n| Severity | Dimension | Scene | Step | Summary |\n| --- | --- | --- | --- | --- |\n${rows}\n`;
}

export function buildGitHubCheckPayloads(options: {
  readonly name?: string;
  readonly headSha: string;
  readonly detailsUrl?: string;
  readonly changes: readonly GitHubReviewChange[];
}): readonly GitHubCheckPayload[] {
  if (!/^[a-f0-9]{7,64}$/iu.test(options.headSha))
    throw new Error('headSha must be a Git commit SHA.');
  const summary = buildGitHubSummary(options.changes);
  const annotations = options.changes.map((change) => ({
    path: change.path ?? '.scenebook/review.json',
    start_line: change.startLine ?? 1,
    end_line: change.endLine ?? change.startLine ?? 1,
    annotation_level: level(change.severity),
    title:
      `${change.dimension}: ${change.sceneId}${change.stepId ? ` / ${change.stepId}` : ''}`.slice(
        0,
        255,
      ),
    message: change.summary.slice(0, 65_535),
    ...(change.details ? { raw_details: change.details.slice(0, 65_535) } : {}),
  }));
  const chunks = annotations.length
    ? Array.from({ length: Math.ceil(annotations.length / 50) }, (_, index) =>
        annotations.slice(index * 50, index * 50 + 50),
      )
    : [[]];
  return chunks.map((chunk, index) => ({
    name: options.name ?? 'Scenebook',
    head_sha: options.headSha,
    status: 'completed',
    conclusion: conclusion(options.changes),
    ...(options.detailsUrl ? { details_url: options.detailsUrl } : {}),
    output: {
      title:
        chunks.length > 1 ? `Scenebook review (${index + 1}/${chunks.length})` : 'Scenebook review',
      summary: summary.slice(0, 65_535),
      text: `${options.changes.length} deterministic review change(s). Payload generation performs no network operations.`,
      annotations: chunk,
    },
  }));
}
