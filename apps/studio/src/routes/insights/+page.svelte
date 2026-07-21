<script lang="ts">
  import { onMount } from 'svelte';
  import type { Project } from '@scenebook/schema';

  import AppShell from '$lib/components/AppShell.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import {
    effectiveLocalProject,
    freshnessLabel,
    summarizeWorkspaceMetrics,
    type WorkspaceMetrics,
  } from '$lib/project-surfaces';
  import { studioSceneLibrary, type SceneSummary } from '$lib/scene-library';

  let scenes = $state<SceneSummary[]>([]);
  let project = $state<Project | null>(null);
  let metrics = $state<WorkspaceMetrics | null>(null);
  let loadState = $state<'loading' | 'ready' | 'error'>('loading');
  let error = $state('');

  let analyticsChannels = $derived(
    project?.channels.filter(
      (channel) => channel.public.analytics !== null && channel.public.analytics !== undefined,
    ) ?? [],
  );
  let freshCount = $derived(
    scenes.filter((scene) => freshnessLabel(scene).label === 'fresh').length,
  );
  let agingCount = $derived(
    scenes.filter((scene) => freshnessLabel(scene).label === 'aging').length,
  );
  let staleCount = $derived(
    scenes.filter((scene) => freshnessLabel(scene).label === 'stale').length,
  );
  let noEvidenceCount = $derived(
    scenes.filter((scene) => freshnessLabel(scene).label === 'no evidence').length,
  );

  function percent(value: number, total: number) {
    return total > 0 ? Math.round((value / total) * 100) : 0;
  }

  async function loadInsights() {
    loadState = 'loading';
    error = '';
    try {
      const [nextScenes, persisted] = await Promise.all([
        studioSceneLibrary.list(),
        studioSceneLibrary.loadProject(),
      ]);
      const nextProject = effectiveLocalProject(persisted, nextScenes);
      scenes = nextScenes;
      project = nextProject;
      metrics = summarizeWorkspaceMetrics(nextProject, nextScenes);
      loadState = 'ready';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Local insights could not be computed.';
      loadState = 'error';
    }
  }

  onMount(() => void loadInsights());
</script>

<svelte:head><title>Coverage · Scenebook</title></svelte:head>

<AppShell active="insights">
  <div class="project-page insights-page">
    <header class="surface-header">
      <div>
        <h1>Coverage</h1>
        <p>Find scenes that need visuals, run evidence, collection placement, or release setup.</p>
      </div>
      <div class="surface-actions">
        <a class="button" href="/publish"><Icon name="publish" size={15} />Review release</a>
      </div>
    </header>

    {#if loadState === 'loading'}
      <div class="surface-state" aria-busy="true">
        <Icon name="clock" />
        <div>
          <strong>Computing local coverage…</strong><small
            >Reading compact scene and project summaries.</small
          >
        </div>
      </div>
    {:else if loadState === 'error'}
      <div class="surface-state">
        <Icon name="warning" />
        <div><strong>Coverage is unavailable</strong><small>{error}</small></div>
        <button class="button" type="button" onclick={loadInsights}>Try again</button>
      </div>
    {:else if metrics && metrics.sceneCount === 0}
      <div class="surface-state coverage-empty">
        <Icon name="insights" />
        <div>
          <strong>Coverage starts with a scene</strong><small
            >Create a scene or import a project to begin tracking visuals, run evidence,
            collections, and release channels.</small
          >
        </div>
        <a class="button primary" href="/catalog?action=create">New scene</a>
        <a class="button" href="/settings?action=import">Import project</a>
      </div>
    {:else if metrics}
      <dl class="coverage-summary" aria-label="Authoring coverage summary">
        <div>
          <dt>Scenes</dt>
          <dd>{metrics.sceneCount}<span>{metrics.stepCount} steps</span></dd>
        </div>
        <div>
          <dt>Run evidence</dt>
          <dd>
            {percent(metrics.evidenceCount, metrics.sceneCount)}%<span
              >{metrics.evidenceCount} covered</span
            >
          </dd>
        </div>
        <div>
          <dt>Collections</dt>
          <dd>
            {percent(metrics.collectionSceneCount, metrics.sceneCount)}%<span
              >{metrics.collectionSceneCount} included</span
            >
          </dd>
        </div>
        <div>
          <dt>Channels</dt>
          <dd>
            {percent(metrics.channelSceneCount, metrics.sceneCount)}%<span
              >{metrics.channelSceneCount} selected</span
            >
          </dd>
        </div>
      </dl>

      <div class="insight-layout">
        <section class="surface-card coverage-card" aria-labelledby="coverage-title">
          <header>
            <div>
              <h2 id="coverage-title">Authoring coverage</h2>
            </div>
            <span class="status-chip local">{metrics.sceneCount} total</span>
          </header>
          <div class="bar-list">
            {#each [{ label: 'Screen visuals attached', value: metrics.screenAssetCount, total: metrics.screenStepCount, detail: `${metrics.screenAssetCount} / ${metrics.screenStepCount} screen steps` }, { label: 'Automation monitored', value: metrics.monitoredCount, total: metrics.sceneCount, detail: `${metrics.monitoredCount} scenes with monitored or verified automation` }, { label: 'Verified portable source', value: metrics.verifiedSourceCount, total: metrics.sceneCount, detail: `${metrics.verifiedSourceCount} scenes declare verified capability` }, { label: 'Passed attached runs', value: metrics.passedCount, total: metrics.sceneCount, detail: `${metrics.passedCount} non-synthetic passed statuses` }] as row}
              <div class="bar-row">
                <div><strong>{row.label}</strong><span>{percent(row.value, row.total)}%</span></div>
                <div class="bar"><i style={`width: ${percent(row.value, row.total)}%`}></i></div>
                <small>{row.detail}</small>
              </div>
            {/each}
          </div>
          <footer>
            <Icon name="globe" size={14} /><span
              ><strong>{metrics.translationCount} translation drafts</strong><small
                >Counts language drafts, not completeness or review approval.</small
              ></span
            >
          </footer>
        </section>

        <section class="surface-card freshness-card" aria-labelledby="freshness-title">
          <header>
            <div>
              <h2 id="freshness-title">Freshness</h2>
            </div>
            <a href="/runs">Open runs <Icon name="arrow-right" size={12} /></a>
          </header>
          <div class="freshness-summary">
            <span class="fresh"><strong>{freshCount}</strong><small>Fresh &lt;14d</small></span
            ><span class="aging"><strong>{agingCount}</strong><small>Aging 14–30d</small></span
            ><span class="stale"><strong>{staleCount}</strong><small>Stale &gt;30d</small></span
            ><span><strong>{noEvidenceCount}</strong><small>No evidence</small></span>
          </div>
          <div class="freshness-list">
            {#each scenes
              .slice()
              .sort( (left, right) => (right.verification?.at ?? '').localeCompare(left.verification?.at ?? '') ) as scene (scene.id)}
              {@const freshness = freshnessLabel(scene)}
              <a href={`/scenes/${encodeURIComponent(scene.id)}?tab=health`}
                ><span
                  ><strong>{scene.title}</strong><small
                    >{freshness.ageDays === null
                      ? 'No real run timestamp attached'
                      : `${freshness.ageDays} day${freshness.ageDays === 1 ? '' : 's'} since attached evidence`}</small
                  ></span
                ><span
                  class="status-chip {freshness.label === 'no evidence'
                    ? 'stale'
                    : freshness.label}">{freshness.label}</span
                ></a
              >
            {/each}
          </div>
        </section>
      </div>

      <details class="analytics-details">
        <summary>
          <span>Audience analytics</span>
          <span class="status-chip {analyticsChannels.length ? 'verified' : 'local'}"
            >{analyticsChannels.length
              ? `${analyticsChannels.length} configured`
              : 'Not connected'}</span
          >
        </summary>
        <p>
          {analyticsChannels.length
            ? 'Analytics is configured for published channels. View release analytics in the authenticated Console.'
            : 'Published output remains telemetry-free until a channel explicitly enables analytics.'}
        </p>
      </details>
    {/if}
  </div>
</AppShell>

<style>
  .coverage-summary {
    border-block: 1px solid var(--line);
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin: 0;
  }
  .coverage-summary > div {
    padding: 13px 16px;
  }
  .coverage-summary > div + div {
    border-left: 1px solid var(--line);
  }
  .coverage-summary dt {
    color: var(--muted);
    font-size: 0.78rem;
  }
  .coverage-summary dd {
    font-size: 1.05rem;
    font-weight: 720;
    margin: 4px 0 0;
  }
  .coverage-summary dd span {
    color: var(--muted);
    font-size: 0.78rem;
    font-weight: 500;
    margin-left: 6px;
  }
  .insight-layout {
    align-items: start;
    display: grid;
    gap: 15px;
    grid-template-columns: 1.1fr 0.9fr;
  }
  .coverage-card,
  .freshness-card {
    overflow: hidden;
  }
  .coverage-card > header,
  .freshness-card > header {
    align-items: center;
    border-bottom: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    padding: 17px 18px;
  }
  h2 {
    font-size: 1rem;
    margin: 0;
  }
  .freshness-card header a {
    align-items: center;
    color: var(--accent);
    display: inline-flex;
    font-size: 0.8rem;
    font-weight: 680;
    gap: 4px;
    min-height: 40px;
    text-decoration: none;
  }
  .bar-list {
    display: grid;
    gap: 18px;
    padding: 20px;
  }
  .bar-row {
    display: grid;
    gap: 7px;
  }
  .bar-row > div:first-child {
    display: flex;
    font-size: 0.8rem;
    justify-content: space-between;
  }
  .bar-row > div:first-child span {
    color: var(--muted);
    font-weight: 700;
  }
  .bar {
    background: var(--paper-2);
    border-radius: 999px;
    height: 7px;
    overflow: hidden;
  }
  .bar i {
    background: var(--accent);
    border-radius: inherit;
    display: block;
    height: 100%;
  }
  .bar-row small {
    color: var(--muted);
    font-size: 0.78rem;
  }
  .coverage-card footer {
    align-items: center;
    background: var(--paper-2);
    border-top: 1px solid var(--line);
    display: flex;
    gap: 9px;
    padding: 12px 18px;
  }
  .coverage-card footer strong,
  .coverage-card footer small {
    display: block;
  }
  .coverage-card footer strong {
    font-size: 0.8rem;
  }
  .coverage-card footer small {
    color: var(--muted);
    font-size: 0.78rem;
    margin-top: 2px;
  }
  .freshness-summary {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
  }
  .freshness-summary span {
    border-bottom: 1px solid var(--line);
    border-right: 1px solid var(--line);
    display: grid;
    gap: 2px;
    padding: 12px;
  }
  .freshness-summary span:last-child {
    border-right: 0;
  }
  .freshness-summary strong {
    font-size: 1rem;
  }
  .freshness-summary small {
    color: var(--muted);
    font-size: 0.75rem;
  }
  .freshness-summary .fresh strong {
    color: var(--pass);
  }
  .freshness-summary .aging strong {
    color: var(--changed);
  }
  .freshness-summary .stale strong {
    color: var(--broken);
  }
  .freshness-list {
    display: grid;
    max-height: 340px;
    overflow: auto;
  }
  .freshness-list a {
    align-items: center;
    border-bottom: 1px solid var(--line);
    display: flex;
    gap: 10px;
    justify-content: space-between;
    padding: 11px 15px;
    text-decoration: none;
  }
  .freshness-list a:hover {
    background: var(--paper-2);
  }
  .freshness-list a:last-child {
    border-bottom: 0;
  }
  .freshness-list strong,
  .freshness-list small {
    display: block;
  }
  .freshness-list strong {
    font-size: 0.8rem;
  }
  .freshness-list small {
    color: var(--muted);
    font-size: 0.75rem;
    margin-top: 3px;
  }
  .analytics-details {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }
  .analytics-details summary {
    align-items: center;
    cursor: pointer;
    display: flex;
    font-size: 0.8rem;
    font-weight: 680;
    gap: 12px;
    justify-content: space-between;
    min-height: 40px;
    padding: 13px 15px;
  }
  .analytics-details p {
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-size: 0.8rem;
    line-height: 1.5;
    margin: 0;
    padding: 12px 15px;
  }
  @media (max-width: 950px) {
    .insight-layout {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 650px) {
    .coverage-summary {
      grid-template-columns: 1fr 1fr;
    }
    .coverage-summary > div:nth-child(3) {
      border-left: 0;
      border-top: 1px solid var(--line);
    }
    .coverage-summary > div:nth-child(4) {
      border-top: 1px solid var(--line);
    }
    .freshness-summary {
      grid-template-columns: 1fr 1fr;
    }
    .freshness-card header a,
    .analytics-details summary {
      min-height: 44px;
    }
  }
</style>
