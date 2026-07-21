import type { NormalizedScene, PublicationGroup, PublicationPlan } from './types.js';
import { DEFAULT_PUBLIC_DISTRIBUTION, validatePublicationDistribution } from './public.js';

const UNGROUPED_GROUP_ID = 'scenebook:ungrouped';
const UNGROUPED_GROUP_SLUG = 'ungrouped';
const LOCALE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/u;

function assertText(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} cannot be empty.`);
}

function assertId(value: string, label: string): void {
  assertText(value, label);
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)) {
    throw new Error(`${label} is not a valid Scenebook id: ${value}.`);
  }
}

function assertSlug(value: string, label: string): void {
  assertText(value, label);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) || value.length > 100) {
    throw new Error(`${label} is not a valid Scenebook slug: ${value}.`);
  }
}

function defaultPublicationPlan(title: string): PublicationPlan {
  return {
    format: 'scenebook-publication-plan',
    version: 1,
    selection: { mode: 'all-scenes', collectionIds: [] },
    title,
    locale: 'en',
    distribution: DEFAULT_PUBLIC_DISTRIBUTION,
    groups: [],
    policy: {
      missingSceneEntry: 'error',
      duplicateScenePlacement: 'first-occurrence-wins',
      ungroupedScenes: 'include',
    },
  };
}

function validatePlanShape(plan: PublicationPlan): void {
  if (plan.format !== 'scenebook-publication-plan' || plan.version !== 1) {
    throw new Error('Unsupported publication plan format or version.');
  }
  assertText(plan.title, 'Publication title');
  if (plan.description !== undefined) assertText(plan.description, 'Publication description');
  if (plan.locale !== undefined && !LOCALE.test(plan.locale)) {
    throw new Error(`Publication locale is not a supported BCP 47 locale: ${plan.locale}.`);
  }
  validatePublicationDistribution(plan.distribution);
  if (plan.policy.missingSceneEntry !== 'error') {
    throw new Error('Publication plans must fail closed for missing Scene entries.');
  }
  if (plan.policy.duplicateScenePlacement !== 'first-occurrence-wins') {
    throw new Error('Unsupported duplicate Scene placement policy.');
  }
  if (!['include', 'exclude'].includes(plan.policy.ungroupedScenes)) {
    throw new Error('Unsupported ungrouped Scene policy.');
  }

  const { selection } = plan;
  if (
    !['all-scenes', 'project', 'channel', 'collection', 'channel-collection'].includes(
      selection.mode,
    )
  ) {
    throw new Error(`Unsupported publication selection mode: ${String(selection.mode)}.`);
  }
  if (selection.projectId) assertId(selection.projectId, 'Publication projectId');
  if (selection.channelId) assertId(selection.channelId, 'Publication channelId');
  for (const collectionId of selection.collectionIds) {
    assertId(collectionId, 'Publication collectionId');
  }
  if (selection.mode !== 'all-scenes' && !selection.projectId) {
    throw new Error(`Publication selection ${selection.mode} requires a projectId.`);
  }
  if (
    (selection.mode === 'channel' || selection.mode === 'channel-collection') &&
    !selection.channelId
  ) {
    throw new Error(`Publication selection ${selection.mode} requires a channelId.`);
  }
  if (
    (selection.mode === 'collection' || selection.mode === 'channel-collection') &&
    selection.collectionIds.length !== 1
  ) {
    throw new Error(`Publication selection ${selection.mode} requires exactly one collectionId.`);
  }
  if (new Set(selection.collectionIds).size !== selection.collectionIds.length) {
    throw new Error('Publication selection collectionIds must be unique.');
  }
  const narrowed = ['channel', 'collection', 'channel-collection'].includes(selection.mode);
  if (narrowed && plan.policy.ungroupedScenes !== 'exclude') {
    throw new Error(`Publication selection ${selection.mode} must exclude ungrouped Scenes.`);
  }
  if (narrowed && plan.groups.some((group) => group.kind === 'ungrouped')) {
    throw new Error(`Publication selection ${selection.mode} cannot define an ungrouped group.`);
  }
  if (!narrowed && plan.policy.ungroupedScenes !== 'include') {
    throw new Error(`Publication selection ${selection.mode} must include ungrouped Scenes.`);
  }
  const channelSelection = selection.mode === 'channel' || selection.mode === 'channel-collection';
  if (channelSelection && !plan.policy.channel) {
    throw new Error(`Publication selection ${selection.mode} requires a Channel policy snapshot.`);
  }
  if (!channelSelection && plan.policy.channel) {
    throw new Error(`Publication selection ${selection.mode} cannot include a Channel policy.`);
  }

  const groupIds = new Set<string>();
  const groupSlugs = new Set<string>();
  for (const [groupIndex, group] of plan.groups.entries()) {
    assertId(group.id, `Publication group ${groupIndex} id`);
    assertSlug(group.slug, `Publication group ${group.id} slug`);
    if (group.kind !== 'collection' && group.kind !== 'ungrouped') {
      throw new Error(`Publication group ${group.id} has an unsupported kind.`);
    }
    assertText(group.title, `Publication group ${group.id} title`);
    if (group.description !== undefined) {
      assertText(group.description, `Publication group ${group.id} description`);
    }
    if (groupIds.has(group.id)) throw new Error(`Duplicate publication group id: ${group.id}`);
    if (groupSlugs.has(group.slug)) {
      throw new Error(`Duplicate publication group slug: ${group.slug}`);
    }
    groupIds.add(group.id);
    groupSlugs.add(group.slug);
    for (const [entryIndex, entry] of group.entries.entries()) {
      assertId(entry.sceneId, `Publication group ${group.id} entry ${entryIndex} sceneId`);
      if (entry.title !== undefined) {
        assertText(entry.title, `Publication group ${group.id} entry ${entryIndex} title`);
      }
      if (entry.description !== undefined) {
        assertText(
          entry.description,
          `Publication group ${group.id} entry ${entryIndex} description`,
        );
      }
    }
  }

  const collectionGroupIds = plan.groups
    .filter((group) => group.kind === 'collection')
    .map((group) => group.id);
  if (
    collectionGroupIds.length !== selection.collectionIds.length ||
    collectionGroupIds.some((id, index) => id !== selection.collectionIds[index])
  ) {
    throw new Error(
      'Publication selection collectionIds must match collection groups in the same order.',
    );
  }
}

export interface ResolvedPublication {
  readonly plan: PublicationPlan;
  readonly sceneIds: readonly string[];
}

/**
 * Validates a caller-authored plan, resolves it against loaded Scenes, and applies the documented
 * first-occurrence rule. Every referenced Scene is checked before any duplicate is discarded.
 */
export function resolvePublicationPlan(
  input: PublicationPlan | undefined,
  scenes: readonly NormalizedScene[],
  fallbackTitle: string,
): ResolvedPublication {
  const plan = input ?? defaultPublicationPlan(fallbackTitle);
  validatePlanShape(plan);

  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  for (const group of plan.groups) {
    for (const entry of group.entries) {
      if (!sceneById.has(entry.sceneId)) {
        throw new Error(
          `Publication collection ${group.id} references missing Scene ${entry.sceneId}.`,
        );
      }
    }
  }

  const placed = new Set<string>();
  const groups: PublicationGroup[] = [];
  for (const group of plan.groups) {
    const entries = group.entries.filter((entry) => {
      if (placed.has(entry.sceneId)) return false;
      placed.add(entry.sceneId);
      return true;
    });
    groups.push({ ...group, entries });
  }

  if (plan.policy.ungroupedScenes === 'include') {
    const entries = scenes
      .filter((scene) => !placed.has(scene.id))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((scene) => ({ sceneId: scene.id }));
    if (entries.length > 0) {
      const existingIndex = groups.findIndex((group) => group.kind === 'ungrouped');
      if (existingIndex >= 0) {
        const existing = groups[existingIndex];
        if (!existing) throw new Error('Compiler publication group alignment failure.');
        groups[existingIndex] = { ...existing, entries: [...existing.entries, ...entries] };
      } else {
        const ids = new Set(plan.groups.map((group) => group.id));
        const slugs = new Set(plan.groups.map((group) => group.slug));
        let id = UNGROUPED_GROUP_ID;
        let idSuffix = 2;
        while (ids.has(id)) id = `${UNGROUPED_GROUP_ID}:${idSuffix++}`;
        let slug = UNGROUPED_GROUP_SLUG;
        let slugSuffix = 2;
        while (slugs.has(slug)) slug = `${UNGROUPED_GROUP_SLUG}-${slugSuffix++}`;
        groups.push({
          id,
          slug,
          kind: 'ungrouped',
          title: 'Ungrouped Scenes',
          description: 'Valid project Scenes that are not placed in a collection.',
          entries,
        });
      }
      for (const entry of entries) placed.add(entry.sceneId);
    }
  }

  const sceneIds = groups.flatMap((group) => group.entries.map((entry) => entry.sceneId));
  if (sceneIds.length === 0) {
    if (plan.selection.mode === 'channel' || plan.selection.mode === 'channel-collection') {
      throw new Error(
        `Channel ${plan.selection.channelId ?? 'selection'} has no publishable Scenes.`,
      );
    }
    if (plan.selection.mode === 'collection') {
      throw new Error(
        `Collection ${plan.selection.collectionIds[0] ?? 'selection'} has no publishable Scenes.`,
      );
    }
    throw new Error('Publication plan has no publishable Scenes.');
  }

  return { plan: { ...plan, locale: plan.locale ?? 'en', groups }, sceneIds };
}
