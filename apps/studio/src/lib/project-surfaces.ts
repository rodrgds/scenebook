import type { Channel, Project } from '@scenebook/schema';

import { defaultProject } from './portable';
import type { SceneSummary, SceneVersionSummary } from './scene-library';

export const STUDIO_PRIVACY_METADATA_KEY = 'scenebookStudioPrivacy';

export interface StudioPrivacyDefaults {
  blockAt: 'medium' | 'high' | 'blocking';
  scanBeforeExport: boolean;
  ocrBeforePublication: boolean;
}

export const DEFAULT_STUDIO_PRIVACY: StudioPrivacyDefaults = {
  blockAt: 'high',
  scanBeforeExport: true,
  ocrBeforePublication: true,
};

export interface LocalWorkspaceSnapshot {
  project: Project;
  projectPersisted: boolean;
  scenes: SceneSummary[];
}

export interface VersionChange {
  scene: SceneSummary;
  current?: SceneVersionSummary;
  previous?: SceneVersionSummary;
  changedFields: string[];
}

export interface ChannelCoverage {
  channel: Channel;
  sceneIds: string[];
  missingSceneIds: string[];
  passedSceneCount: number;
  releaseBlockers: string[];
  handoffChecks: string[];
}

export interface WorkspaceMetrics {
  sceneCount: number;
  stepCount: number;
  evidenceCount: number;
  passedCount: number;
  monitoredCount: number;
  verifiedSourceCount: number;
  collectionSceneCount: number;
  channelSceneCount: number;
  screenStepCount: number;
  screenAssetCount: number;
  translationCount: number;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readStudioPrivacyDefaults(project: Project): StudioPrivacyDefaults {
  const value = objectValue(project.metadata[STUDIO_PRIVACY_METADATA_KEY]);
  return {
    blockAt:
      value?.blockAt === 'medium' || value?.blockAt === 'blocking' || value?.blockAt === 'high'
        ? value.blockAt
        : DEFAULT_STUDIO_PRIVACY.blockAt,
    scanBeforeExport:
      typeof value?.scanBeforeExport === 'boolean'
        ? value.scanBeforeExport
        : DEFAULT_STUDIO_PRIVACY.scanBeforeExport,
    ocrBeforePublication:
      typeof value?.ocrBeforePublication === 'boolean'
        ? value.ocrBeforePublication
        : DEFAULT_STUDIO_PRIVACY.ocrBeforePublication,
  };
}

export function writeStudioPrivacyDefaults(
  project: Project,
  privacy: StudioPrivacyDefaults,
): Project {
  return {
    ...project,
    metadata: {
      ...project.metadata,
      [STUDIO_PRIVACY_METADATA_KEY]: { ...privacy },
    },
  };
}

export function effectiveLocalProject(
  persisted: Project | null,
  scenes: readonly SceneSummary[],
): Project {
  return persisted ? structuredClone(persisted) : defaultProject(scenes);
}

export function collectionSceneIds(project: Project): Set<string> {
  return new Set(
    project.collections.flatMap((collection) => collection.entries.map((entry) => entry.sceneId)),
  );
}

export function channelSceneIds(project: Project, channel: Channel): string[] {
  const collectionIds = new Set(channel.collectionIds);
  const selected = project.collections.filter((collection) => collectionIds.has(collection.id));
  return [
    ...new Set(selected.flatMap((collection) => collection.entries.map((entry) => entry.sceneId))),
  ];
}

export function summarizeVersionChange(
  scene: SceneSummary,
  versions: readonly SceneVersionSummary[],
): VersionChange {
  const current = versions[0];
  const previous = versions[1];
  const changedFields: string[] = [];
  if (current && previous) {
    if (current.title !== previous.title) changedFields.push('title');
    if (current.stepCount !== previous.stepCount) changedFields.push('Step count');
    if (current.translationCount !== previous.translationCount) changedFields.push('translations');
    if (current.hasPortableSource !== previous.hasPortableSource)
      changedFields.push('portable source');
    if (
      current.verification !== previous.verification ||
      JSON.stringify(current.runRevisions) !== JSON.stringify(previous.runRevisions)
    )
      changedFields.push('Run evidence');
    if (JSON.stringify(current.theme) !== JSON.stringify(previous.theme))
      changedFields.push('theme');
    if (
      current.steps.length !== previous.steps.length ||
      current.steps.some((step, index) => {
        const before = previous.steps[index];
        return (
          !before ||
          step.id !== before.id ||
          step.title !== before.title ||
          step.type !== before.type
        );
      })
    )
      changedFields.push('Step structure');
  }
  return { scene, current, previous, changedFields };
}

export function summarizeChannelCoverage(
  project: Project,
  scenes: readonly SceneSummary[],
): ChannelCoverage[] {
  const scenesById = new Map(scenes.map((scene) => [scene.id, scene]));
  return project.channels.map((channel) => {
    const sceneIds = channelSceneIds(project, channel);
    const selectedScenes = sceneIds.flatMap((id) => {
      const scene = scenesById.get(id);
      return scene ? [scene] : [];
    });
    const missingSceneIds = sceneIds.filter((id) => !scenesById.has(id));
    const releaseBlockers: string[] = [];
    const handoffChecks: string[] = [];
    if (channel.collectionIds.length === 0) releaseBlockers.push('No Collections selected');
    if (sceneIds.length === 0) releaseBlockers.push('No Scenes selected');
    if (missingSceneIds.length > 0)
      releaseBlockers.push(
        `${missingSceneIds.length} referenced Scene${missingSceneIds.length === 1 ? '' : 's'} missing locally`,
      );
    const samples = selectedScenes.filter((scene) => scene.sample).length;
    if (samples > 0)
      releaseBlockers.push(
        `${samples} synthetic sample${samples === 1 ? '' : 's'} cannot establish release evidence`,
      );
    if (channel.policy.requireCriticalPassing) {
      const notPassing = selectedScenes.filter((scene) => scene.runStatus !== 'passed').length;
      if (notPassing > 0)
        releaseBlockers.push(
          `${notPassing} Scene${notPassing === 1 ? '' : 's'} lack a passed attached Run`,
        );
    }
    if (channel.policy.requireVisualApproval)
      handoffChecks.push('Visual approval is evaluated by the CLI or Console');
    if (channel.policy.requireEditorialApproval)
      handoffChecks.push('Editorial approval is evaluated by the CLI or Console');
    if (channel.policy.requireCompleteLocalization)
      handoffChecks.push('Complete localization is evaluated from portable source at build time');
    handoffChecks.push('Privacy scanning and compilation run outside browser Studio');
    return {
      channel,
      sceneIds,
      missingSceneIds,
      passedSceneCount: selectedScenes.filter((scene) => scene.runStatus === 'passed').length,
      releaseBlockers,
      handoffChecks,
    };
  });
}

export function summarizeWorkspaceMetrics(
  project: Project,
  scenes: readonly SceneSummary[],
): WorkspaceMetrics {
  const collectionIds = collectionSceneIds(project);
  const publishedIds = new Set(
    project.channels.flatMap((channel) => channelSceneIds(project, channel)),
  );
  return {
    sceneCount: scenes.length,
    stepCount: scenes.reduce((count, scene) => count + scene.stepCount, 0),
    evidenceCount: scenes.filter((scene) => Boolean(scene.verification) && !scene.sample).length,
    passedCount: scenes.filter((scene) => scene.runStatus === 'passed' && !scene.sample).length,
    monitoredCount: scenes.filter((scene) => scene.automationLevel !== 'none' && !scene.sample)
      .length,
    verifiedSourceCount: scenes.filter((scene) => scene.capability === 'verified' && !scene.sample)
      .length,
    collectionSceneCount: scenes.filter((scene) => collectionIds.has(scene.id)).length,
    channelSceneCount: scenes.filter((scene) => publishedIds.has(scene.id)).length,
    screenStepCount: scenes.reduce((count, scene) => count + scene.screenStepCount, 0),
    screenAssetCount: scenes.reduce((count, scene) => count + scene.screenAssetCount, 0),
    translationCount: scenes.reduce((count, scene) => count + scene.translationCount, 0),
  };
}

export function freshnessLabel(
  scene: SceneSummary,
  now = Date.now(),
): { label: 'fresh' | 'aging' | 'stale' | 'no evidence'; ageDays: number | null } {
  if (!scene.verification?.at || scene.sample) return { label: 'no evidence', ageDays: null };
  const timestamp = Date.parse(scene.verification.at);
  if (!Number.isFinite(timestamp)) return { label: 'no evidence', ageDays: null };
  const ageDays = Math.max(0, Math.floor((now - timestamp) / 86_400_000));
  return { label: ageDays < 14 ? 'fresh' : ageDays <= 30 ? 'aging' : 'stale', ageDays };
}

export function uniqueProjectId(preferred: string, existing: ReadonlySet<string>): string {
  const base =
    preferred
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9._:-]+/gu, '-')
      .replaceAll(/^-+|-+$/gu, '') || 'collection';
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
