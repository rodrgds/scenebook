import type {
  PublicationDistribution,
  PublicationGroup,
  PublicationPlan,
  PublicationPolicy,
  PublicAnalyticsRuntime,
  PublicCtaRuntime,
} from '@scenebook/compiler';
import type { Channel, Collection, Project } from '@scenebook/schema';
import { CliError } from './types.js';

export interface ProjectPublicationSelection {
  readonly channel?: string;
  readonly collection?: string;
  readonly attribution?: boolean;
}

function resolveIdOrSlug<T extends { readonly id: string; readonly slug: string }>(
  values: readonly T[],
  token: string,
  label: 'Channel' | 'Collection',
): T {
  const exact = values.find((value) => value.id === token);
  if (exact) return exact;
  const slugMatches = values.filter((value) => value.slug === token);
  if (slugMatches.length === 1 && slugMatches[0]) return slugMatches[0];
  if (slugMatches.length > 1) {
    throw new CliError(`Ambiguous ${label.toLowerCase()} slug: ${token}. Use its exact id.`);
  }
  const available = values.map((value) => `${value.id} (${value.slug})`).join(', ');
  throw new CliError(
    `Unknown ${label.toLowerCase()} ${token}.${available ? ` Available: ${available}.` : ''}`,
  );
}

function collectionGroup(collection: Collection): PublicationGroup {
  return {
    id: collection.id,
    slug: collection.slug,
    kind: 'collection',
    title: collection.title,
    ...(collection.description ? { description: collection.description } : {}),
    entries: collection.entries.map((entry) => ({
      sceneId: entry.sceneId,
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.description ? { description: entry.description } : {}),
    })),
  };
}

function policy(
  ungroupedScenes: PublicationPolicy['ungroupedScenes'],
  channel?: Channel,
): PublicationPolicy {
  return {
    missingSceneEntry: 'error',
    duplicateScenePlacement: 'first-occurrence-wins',
    ungroupedScenes,
    ...(channel ? { channel: { ...channel.policy } } : {}),
  };
}

function selectedChannel(
  project: Project,
  selection: ProjectPublicationSelection,
): Channel | undefined {
  return selection.channel
    ? resolveIdOrSlug(project.channels, selection.channel, 'Channel')
    : undefined;
}

function publicDistribution(
  project: Project,
  channel: Channel | undefined,
  attributionOverride?: boolean,
): PublicationDistribution {
  const override = channel?.public ?? {};
  const customDomain =
    override.customDomain ?? channel?.customDomain ?? project.public.customDomain;
  const analytics =
    override.analytics === null ? undefined : (override.analytics ?? project.public.analytics);
  const cta = override.cta === null ? undefined : (override.cta ?? project.public.cta);
  return {
    ...((override.baseUrl ?? project.public.baseUrl)
      ? { baseUrl: override.baseUrl ?? project.public.baseUrl }
      : {}),
    ...(customDomain ? { customDomain } : {}),
    seo: { ...project.public.seo, ...override.seo },
    attribution:
      (override.attribution ?? project.public.attribution) && attributionOverride !== false,
    remix: override.remix ?? project.public.remix,
    ...(analytics
      ? {
          analytics: {
            endpoint: analytics.endpoint,
            releaseId: analytics.releaseId,
            respectDoNotTrack: analytics.respectDoNotTrack,
          },
        }
      : {}),
    ...(cta
      ? {
          cta: {
            endpoint: cta.endpoint,
            releaseId: cta.releaseId,
          },
        }
      : {}),
  };
}

export function projectPublicationAnalytics(
  project: Project,
  selection: ProjectPublicationSelection = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PublicAnalyticsRuntime | undefined {
  const channel = selectedChannel(project, selection);
  const override = channel?.public.analytics;
  const analytics = override === null ? undefined : (override ?? project.public.analytics);
  if (!analytics) return undefined;
  const token = environment[analytics.tokenEnv];
  if (!token) {
    throw new CliError(
      `Public analytics requires ${analytics.tokenEnv} at build time. No tracking output was generated.`,
    );
  }
  return {
    endpoint: analytics.endpoint,
    token,
    releaseId: analytics.releaseId,
    respectDoNotTrack: analytics.respectDoNotTrack,
  };
}

export function projectPublicationCta(
  project: Project,
  selection: ProjectPublicationSelection = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PublicCtaRuntime | undefined {
  const channel = selectedChannel(project, selection);
  const override = channel?.public.cta;
  const cta = override === null ? undefined : (override ?? project.public.cta);
  if (!cta) return undefined;
  const token = environment[cta.tokenEnv];
  if (!token) {
    throw new CliError(
      `Public CTA submission requires ${cta.tokenEnv} at build time. Form submissions were not enabled.`,
    );
  }
  return {
    endpoint: cta.endpoint,
    token,
    releaseId: cta.releaseId,
  };
}

/** Resolves project.yaml selection without exposing project files to the compiler. */
export function projectPublicationPlan(
  project: Project,
  selection: ProjectPublicationSelection = {},
): PublicationPlan {
  const channel = selectedChannel(project, selection);
  const collection = selection.collection
    ? resolveIdOrSlug(project.collections, selection.collection, 'Collection')
    : undefined;

  if (channel && collection && !channel.collectionIds.includes(collection.id)) {
    throw new CliError(
      `Collection ${collection.id} is not part of Channel ${channel.id}. Select one of: ${channel.collectionIds.join(', ') || '(none)'}.`,
    );
  }

  if (channel && collection) {
    return {
      format: 'scenebook-publication-plan',
      version: 1,
      selection: {
        mode: 'channel-collection',
        projectId: project.id,
        channelId: channel.id,
        collectionIds: [collection.id],
      },
      title: `${channel.name} · ${collection.title}`,
      locale: project.defaultLocale,
      ...((channel.description ?? collection.description)
        ? { description: channel.description ?? collection.description }
        : {}),
      distribution: publicDistribution(project, channel, selection.attribution),
      groups: [collectionGroup(collection)],
      policy: policy('exclude', channel),
    };
  }

  if (channel) {
    const collectionById = new Map(
      project.collections.map((candidate) => [candidate.id, candidate]),
    );
    const collections = channel.collectionIds.map((collectionId) => {
      const candidate = collectionById.get(collectionId);
      if (!candidate) {
        throw new CliError(`Channel ${channel.id} references unknown Collection ${collectionId}.`);
      }
      return candidate;
    });
    return {
      format: 'scenebook-publication-plan',
      version: 1,
      selection: {
        mode: 'channel',
        projectId: project.id,
        channelId: channel.id,
        collectionIds: collections.map((candidate) => candidate.id),
      },
      title: channel.name,
      locale: project.defaultLocale,
      ...(channel.description ? { description: channel.description } : {}),
      distribution: publicDistribution(project, channel, selection.attribution),
      groups: collections.map(collectionGroup),
      policy: policy('exclude', channel),
    };
  }

  if (collection) {
    return {
      format: 'scenebook-publication-plan',
      version: 1,
      selection: {
        mode: 'collection',
        projectId: project.id,
        collectionIds: [collection.id],
      },
      title: collection.title,
      locale: project.defaultLocale,
      ...(collection.description ? { description: collection.description } : {}),
      distribution: publicDistribution(project, undefined, selection.attribution),
      groups: [collectionGroup(collection)],
      policy: policy('exclude'),
    };
  }

  return {
    format: 'scenebook-publication-plan',
    version: 1,
    selection: {
      mode: 'project',
      projectId: project.id,
      collectionIds: project.collections.map((candidate) => candidate.id),
    },
    title: project.name,
    locale: project.defaultLocale,
    ...(project.description ? { description: project.description } : {}),
    distribution: publicDistribution(project, undefined, selection.attribution),
    groups: project.collections.map(collectionGroup),
    policy: policy('include'),
  };
}
