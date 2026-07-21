<script lang="ts">
  import { page } from '$app/state';
  import { onDestroy, onMount } from 'svelte';

  import { catalogScenes } from '../demo';
  import type { Capability, CatalogScene, RunStatus } from '../model';
  import { releaseLocalMediaUrls, studioSceneLibrary, type SceneSummary } from '../scene-library';
  import Icon from './Icon.svelte';

  let {
    limit,
    title = 'Scene catalog',
    showFilters = true,
    onloaded,
  }: {
    limit?: number;
    title?: string;
    showFilters?: boolean;
    onloaded?: (summaries: SceneSummary[]) => void;
  } = $props();

  let query = $state('');
  let status = $state<'all' | RunStatus>('all');
  let capability = $state<'all' | Capability>('all');
  let publication = $state<'all' | 'draft' | 'published' | 'archived'>('all');
  let layout = $state<'grid' | 'list'>('grid');
  let filtersOpen = $state(false);
  let summaries = $state<SceneSummary[]>([]);
  let loadState = $state<'loading' | 'ready' | 'error'>('loading');
  let loadError = $state('');
  let nextCursor = $state<string | null>(null);
  let loadGeneration = 0;
  let destroyed = false;
  let searchInput = $state<HTMLInputElement>();

  interface CatalogItem {
    id: string;
    title: string;
    description: string;
    capability: Capability;
    status: RunStatus;
    firstImage?: string;
    finalImage?: string;
    audience: string;
    feature: string;
    tags: string[];
    stepCount: number;
    published: boolean;
    publicationStatus: 'draft' | 'published' | 'archived';
    sample: boolean;
    local?: SceneSummary;
    demo?: CatalogScene;
  }

  let items = $derived.by((): CatalogItem[] => {
    const local = summaries.map((scene): CatalogItem => ({
      id: scene.id,
      title: scene.title,
      description: scene.description || 'Local draft without a description.',
      capability: scene.capability,
      status: scene.runStatus,
      firstImage: scene.firstImage,
      finalImage: scene.finalImage,
      audience: scene.audiences.join(', ') || 'General audience',
      feature: scene.tags[0] ?? 'Uncategorized',
      tags: scene.tags,
      stepCount: scene.stepCount,
      published: scene.publicationStatus === 'published',
      publicationStatus: scene.publicationStatus,
      sample: scene.sample,
      local: scene,
    }));
    if (!local.some((scene) => scene.id === 'invite-teammate')) {
      const demo = catalogScenes.find((scene) => scene.id === 'invite-teammate');
      if (demo)
        local.push({
          ...demo,
          publicationStatus: demo.published ? 'published' : 'draft',
          sample: true,
          demo,
        });
    }
    return local;
  });

  let filtered = $derived(
    items
      .filter((scene) => {
        const term = query.trim().toLowerCase();
        const matchesQuery =
          !term ||
          [scene.title, scene.description, scene.audience, scene.feature, ...scene.tags]
            .join(' ')
            .toLowerCase()
            .includes(term);
        return (
          matchesQuery &&
          (status === 'all' || scene.status === status) &&
          (capability === 'all' || scene.capability === capability) &&
          (publication === 'all' || scene.publicationStatus === publication)
        );
      })
      .slice(0, limit ?? items.length),
  );
  let hasActiveFilters = $derived(
    Boolean(query.trim()) || status !== 'all' || capability !== 'all' || publication !== 'all',
  );

  const statusLabel: Record<RunStatus, string> = {
    passed: 'Passed',
    changed: 'Changed',
    broken: 'Broken',
    blocked: 'Privacy blocked',
    stale: 'Not run',
  };

  function setPublicationFilter(event: Event) {
    publication = (event.currentTarget as HTMLSelectElement).value as typeof publication;
  }

  function clearFilters() {
    query = '';
    status = 'all';
    capability = 'all';
    publication = 'all';
    queueMicrotask(() => searchInput?.focus());
  }

  async function loadScenes(append = false) {
    const generation = ++loadGeneration;
    loadState = 'loading';
    loadError = '';
    try {
      const page = await studioSceneLibrary.listPage({
        cursor: append ? nextCursor : null,
        limit: limit ?? 24,
        includePreviews: true,
      });
      if (destroyed || generation !== loadGeneration) {
        releaseLocalMediaUrls(page.items);
        return;
      }
      if (!append) releaseLocalMediaUrls(summaries);
      summaries = append ? [...summaries, ...page.items] : page.items;
      nextCursor = limit ? null : page.nextCursor;
      onloaded?.(summaries);
      loadState = 'ready';
    } catch (error) {
      if (destroyed || generation !== loadGeneration) return;
      loadState = 'error';
      loadError = error instanceof Error ? error.message : 'The local catalog could not be read.';
    }
  }

  onMount(() => {
    if (showFilters) {
      query = page.url.searchParams.get('q') ?? '';
      if (page.url.searchParams.has('focusSearch')) queueMicrotask(() => searchInput?.focus());
    }
    void loadScenes();
  });

  onDestroy(() => {
    destroyed = true;
    loadGeneration += 1;
    releaseLocalMediaUrls(summaries);
  });
</script>

<section class="catalog-section" aria-labelledby="catalog-heading">
  <div class="section-heading">
    <h2 id="catalog-heading">{title}</h2>
    <div class="heading-actions">
      <div class="layout-switch" role="group" aria-label="Catalog layout">
        <button
          class:active={layout === 'grid'}
          type="button"
          aria-label="Grid view"
          aria-pressed={layout === 'grid'}
          onclick={() => (layout = 'grid')}><Icon name="catalog" size={16} /></button
        >
        <button
          class:active={layout === 'list'}
          type="button"
          aria-label="List view"
          aria-pressed={layout === 'list'}
          onclick={() => (layout = 'list')}><Icon name="guide" size={16} /></button
        >
      </div>
      {#if limit}
        <a class="button" href="/catalog">View all scenes <Icon name="arrow-right" size={15} /></a>
      {/if}
    </div>
  </div>

  {#if showFilters}
    <div class="filterbar" role="search" aria-label="Search and filter scenes">
      <label class="catalog-search">
        <span class="sr-only">Search the scene catalog</span>
        <Icon name="search" size={16} />
        <input
          bind:this={searchInput}
          bind:value={query}
          placeholder="Search by scene, capability, or audience…"
        />
      </label>
      <button
        class="filter-toggle"
        class:active={hasActiveFilters}
        type="button"
        aria-expanded={filtersOpen}
        aria-controls="scene-filter-controls"
        onclick={() => (filtersOpen = !filtersOpen)}
        ><Icon name="settings" size={15} />Filters</button
      >
      <div
        id="scene-filter-controls"
        class="filter-controls"
        class:open={filtersOpen}
        role="group"
        aria-label="Scene filters"
      >
        <label>
          <span class="sr-only">Filter by run status</span>
          <select bind:value={status}>
            <option value="all">Any run status</option>
            <option value="passed">Passed</option>
            <option value="changed">Changed</option>
            <option value="broken">Broken</option>
            <option value="blocked">Privacy blocked</option>
            <option value="stale">Not run</option>
          </select>
        </label>
        <label>
          <span class="sr-only">Filter by capability level</span>
          <select bind:value={capability}>
            <option value="all">Any capability</option>
            <option value="captured">Captured</option>
            <option value="monitored">Monitored</option>
            <option value="verified">Verified</option>
          </select>
        </label>
        <label>
          <span class="sr-only">Filter by publication state</span>
          <select value={publication} onchange={setPublicationFilter}>
            <option value="all">Any publication state</option>
            <option value="draft">Unpublished</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
        </label>
      </div>
      <div class="filter-summary">
        <span class="result-count" aria-live="polite"
          >{filtered.length} {filtered.length === 1 ? 'scene' : 'scenes'}</span
        >
        {#if hasActiveFilters}
          <button type="button" onclick={clearFilters}>Clear filters</button>
        {/if}
      </div>
    </div>
  {/if}

  {#if loadState === 'loading'}
    <div class="catalog-loading" aria-live="polite" aria-busy="true">
      <span></span><span></span><span></span>
      <p>Reading local scenes…</p>
    </div>
  {:else if loadState === 'error'}
    <div class="empty-state" role="alert">
      <span class="empty-icon error"><Icon name="warning" size={21} /></span>
      <h3>Local catalog unavailable</h3>
      <p>{loadError}</p>
      <button class="button" type="button" onclick={() => loadScenes()}>Retry</button>
    </div>
  {:else if filtered.length}
    <div class="scene-grid" class:list={layout === 'list'}>
      {#each filtered as scene}
        <article class="scene-card">
          <a class="scene-image" href={`/scenes/${scene.id}`} aria-label={`Open ${scene.title}`}>
            {#if scene.finalImage ?? scene.firstImage}
              <img
                src={scene.finalImage ?? scene.firstImage}
                alt={`${scene.title} preview`}
                loading="lazy"
                decoding="async"
              />
            {:else}
              <span class="missing-preview"><Icon name="file" size={20} />No screenshot yet</span>
            {/if}
          </a>
          <div class="scene-body">
            <div class="scene-title-row">
              <div>
                <a href={`/scenes/${scene.id}`}>{scene.title}</a>
                <p>{scene.description}</p>
              </div>
            </div>
            <div class="badges">
              <span class={`run-state status-${scene.status}`}
                ><span class="status-dot"></span>{statusLabel[scene.status]}</span
              >
              {#if scene.publicationStatus === 'archived'}
                <span class="publication-state archived">Archived</span>
              {:else if !scene.published}
                <span class="publication-state unpublished">Unpublished</span>
              {:else}
                <span class="publication-state published">Published</span>
              {/if}
              {#if scene.sample}<span class="sample-badge">Synthetic sample</span>{/if}
            </div>
            <div class="scene-meta">
              <span class="capability-meta"
                ><Icon
                  name={scene.capability === 'verified'
                    ? 'check'
                    : scene.capability === 'monitored'
                      ? 'clock'
                      : 'camera'}
                  size={12}
                />{scene.capability}</span
              >
              <span>{scene.stepCount} {scene.stepCount === 1 ? 'step' : 'steps'}</span>
              <span>{scene.audience}</span>
              {#if scene.local}
                <time datetime={new Date(scene.local.savedAt).toISOString()}
                  >Updated {new Date(scene.local.savedAt).toLocaleDateString()}</time
                >
              {/if}
            </div>
          </div>
        </article>
      {/each}
    </div>
    {#if nextCursor}
      <button class="button load-more" type="button" onclick={() => loadScenes(true)}
        >Load more scenes</button
      >
    {/if}
  {:else}
    <div class="empty-state" aria-live="polite">
      <span class="empty-icon"><Icon name={hasActiveFilters ? 'search' : 'file'} size={21} /></span>
      <h3>{hasActiveFilters ? 'No scenes match your filters' : 'No scenes yet'}</h3>
      <p>
        {hasActiveFilters
          ? 'Try a broader search or clear the active filters.'
          : 'Create a scene or import portable source to get started.'}
      </p>
      {#if hasActiveFilters}
        <button class="button" type="button" onclick={clearFilters}>Clear filters</button>
      {:else}
        <a class="button primary" href="/catalog?action=create">Create scene</a>
      {/if}
    </div>
  {/if}
</section>

<style>
  .catalog-section {
    display: grid;
    gap: 20px;
  }
  .load-more {
    justify-self: center;
  }
  .section-heading {
    align-items: center;
    display: flex;
    gap: 24px;
    justify-content: space-between;
  }
  h2 {
    font-size: 1.15rem;
    letter-spacing: -0.02em;
    margin: 0;
  }
  .heading-actions {
    align-items: center;
    display: flex;
    gap: 8px;
  }
  .layout-switch {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 8px;
    display: flex;
    padding: 3px;
  }
  .layout-switch button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 5px;
    color: var(--muted);
    display: flex;
    height: 40px;
    justify-content: center;
    padding: 0;
    width: 40px;
  }
  .layout-switch button.active {
    background: var(--paper-2);
    color: var(--ink);
  }
  .filterbar {
    align-items: center;
    display: grid;
    gap: 8px;
    grid-template-columns: minmax(220px, 1fr) auto auto;
  }
  .catalog-search {
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    color: var(--muted);
    display: flex;
    gap: 8px;
    min-height: 40px;
    min-width: 0;
    padding: 0 10px;
  }
  .catalog-search input {
    background: transparent;
    border: 0;
    font-size: 0.82rem;
    min-width: 0;
    outline: 0;
    width: 100%;
  }
  .catalog-search:focus-within {
    border-color: var(--accent);
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .filter-controls {
    display: flex;
    gap: 6px;
  }
  .filter-toggle {
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    display: none;
    font-size: 0.76rem;
    font-weight: 650;
    gap: 6px;
    min-height: 40px;
    padding: 0 11px;
  }
  .filter-toggle.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  select {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 7px;
    font-size: 0.78rem;
    height: 40px;
    padding: 0 8px;
    width: 148px;
  }
  .filter-summary {
    align-items: center;
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .result-count {
    color: var(--muted);
    font-size: 0.75rem;
    text-align: right;
    white-space: nowrap;
  }
  .filter-summary button {
    background: transparent;
    border: 0;
    color: var(--accent);
    font-size: 0.78rem;
    font-weight: 650;
    min-height: 40px;
    padding: 6px;
    white-space: nowrap;
  }
  .scene-grid {
    display: grid;
    gap: 14px;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
  }
  .scene-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    min-width: 0;
    overflow: hidden;
  }
  .scene-card:hover {
    border-color: var(--line-strong);
  }
  .scene-image {
    background: var(--preview-surface);
    display: block;
    height: 190px;
    overflow: hidden;
    text-decoration: none;
  }
  .scene-image img {
    height: 100%;
    object-fit: cover;
    object-position: top;
    width: 100%;
  }
  .missing-preview {
    align-items: center;
    color: var(--preview-muted);
    display: flex;
    flex-direction: column;
    font-size: 0.75rem;
    gap: 5px;
    height: 100%;
    justify-content: center;
  }
  .scene-body {
    display: grid;
    gap: 10px;
    padding: 14px;
  }
  .scene-title-row {
    align-items: start;
    display: grid;
    gap: 10px;
    grid-template-columns: 1fr auto;
  }
  .scene-title-row a {
    font-size: 0.97rem;
    font-weight: 690;
    letter-spacing: -0.018em;
    text-decoration: none;
  }
  .scene-title-row a:hover {
    color: var(--accent);
  }
  .scene-title-row p {
    color: var(--muted);
    display: -webkit-box;
    font-size: 0.82rem;
    line-clamp: 2;
    line-height: 1.45;
    margin: 4px 0 0;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }
  .badges {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .run-state,
  .publication-state,
  .sample-badge {
    align-items: center;
    border-radius: 999px;
    display: inline-flex;
    font-size: 0.75rem;
    font-weight: 680;
    gap: 5px;
    min-height: 24px;
    padding: 3px 8px;
  }
  .status-passed {
    background: var(--pass-soft);
    color: var(--pass);
  }
  .status-changed {
    background: var(--changed-soft);
    color: var(--changed);
  }
  .status-broken,
  .status-blocked {
    background: var(--broken-soft);
    color: var(--broken);
  }
  .status-stale {
    background: var(--paper-2);
    color: var(--muted);
  }
  .publication-state.unpublished {
    background: var(--info-soft);
    color: var(--info);
  }
  .publication-state.published {
    background: var(--pass-soft);
    color: var(--pass);
  }
  .publication-state.archived {
    background: var(--paper-2);
    color: var(--muted);
  }
  .sample-badge {
    background: var(--changed-soft);
    color: var(--changed);
  }
  .scene-meta {
    align-items: center;
    border-top: 1px solid var(--line);
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    font-size: 0.75rem;
    gap: 6px 12px;
    padding-top: 10px;
  }
  .scene-meta > * {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .scene-meta > * + *::before {
    color: var(--line-strong);
    content: '·';
    margin-right: 12px;
  }
  .capability-meta {
    align-items: center;
    display: inline-flex;
    gap: 4px;
    text-transform: capitalize;
  }
  .scene-grid.list {
    grid-template-columns: 1fr;
  }
  .scene-grid.list .scene-card {
    display: grid;
    grid-template-columns: minmax(250px, 0.55fr) 1fr;
  }
  .scene-grid.list .scene-image {
    height: auto;
    min-height: 180px;
  }
  .empty-state {
    align-items: center;
    border: 1px dashed var(--line-strong);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    padding: 58px 20px;
    text-align: center;
  }
  .catalog-loading {
    align-items: center;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(3, 1fr);
    min-height: 280px;
    padding: 24px;
  }
  .catalog-loading span {
    animation: catalog-pulse 1.4s ease-in-out infinite alternate;
    background: var(--paper-2);
    border-radius: 10px;
    height: 180px;
  }
  .catalog-loading span:nth-child(2) {
    animation-delay: 120ms;
  }
  .catalog-loading span:nth-child(3) {
    animation-delay: 240ms;
  }
  .catalog-loading p {
    color: var(--muted);
    font-size: 0.75rem;
    grid-column: 1 / -1;
    margin: 0;
    text-align: center;
  }
  .empty-icon.error {
    background: var(--broken-soft);
    color: var(--broken);
  }
  @keyframes catalog-pulse {
    from {
      opacity: 0.55;
    }
    to {
      opacity: 1;
    }
  }
  .empty-icon {
    align-items: center;
    background: var(--paper-2);
    border-radius: 50%;
    color: var(--muted);
    display: flex;
    height: 46px;
    justify-content: center;
    width: 46px;
  }
  .empty-state h3 {
    font-size: 1rem;
    margin: 14px 0 3px;
  }
  .empty-state p {
    color: var(--muted);
    font-size: 0.82rem;
    margin: 0 0 15px;
  }
  @media (max-width: 1220px) {
    .filterbar {
      grid-template-columns: 1fr auto;
    }
    .filter-controls {
      grid-column: 1 / -1;
      grid-row: 2;
    }
    .filter-controls label {
      flex: 1;
    }
    .filter-controls select {
      width: 100%;
    }
  }
  @media (max-width: 760px) {
    .section-heading {
      align-items: start;
      flex-direction: column;
    }
    .filterbar {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .catalog-search {
      min-height: 44px;
    }
    .filter-summary {
      grid-column: auto;
      grid-row: auto;
    }
    .filter-toggle {
      display: inline-flex;
      min-height: 44px;
    }
    .filter-controls {
      display: none;
      grid-column: 1 / -1;
      grid-row: auto;
    }
    .filter-controls.open {
      display: flex;
    }
    .filter-controls select {
      height: 44px;
    }
    .filter-summary {
      grid-column: 1 / -1;
      justify-content: space-between;
    }
    .scene-grid.list .scene-card {
      display: block;
    }
    .scene-image {
      height: 154px;
    }
    .catalog-loading {
      grid-template-columns: 1fr;
    }
    .catalog-loading span:not(:first-child) {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .catalog-loading span {
      animation: none;
    }
  }
  @media (max-width: 480px) {
    .filter-controls.open {
      display: grid;
      grid-template-columns: 1fr;
    }
    .layout-switch {
      display: none;
    }
    .scene-image {
      height: 132px;
    }
  }
</style>
