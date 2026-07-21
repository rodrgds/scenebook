<script lang="ts">
  import { onMount } from 'svelte';
  import type { Project } from '@scenebook/schema';

  import AppShell from '$lib/components/AppShell.svelte';
  import CatalogView from '$lib/components/CatalogView.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { defaultProject, downloadPortable, exportProjectZip } from '$lib/portable';
  import {
    releaseLocalMediaUrls,
    studioSceneLibrary,
    type LoadedScene,
    type SceneSummary,
  } from '$lib/scene-library';

  let project = $state<Project | null>(null);
  let summaries = $state<SceneSummary[]>([]);
  let workspaceState = $state<'loading' | 'ready' | 'error'>('loading');
  let workspaceError = $state('');
  let exporting = $state(false);

  async function loadWorkspace() {
    workspaceState = 'loading';
    workspaceError = '';
    try {
      project = await studioSceneLibrary.loadProject();
    } catch (error) {
      workspaceState = 'error';
      workspaceError =
        error instanceof Error ? error.message : 'The local workspace could not be read.';
    }
  }

  function handleCatalogLoaded(items: SceneSummary[]) {
    summaries = items;
    if (workspaceState !== 'error') workspaceState = 'ready';
  }

  async function exportWorkspace() {
    if (summaries.length === 0) return;
    exporting = true;
    workspaceError = '';
    const loaded: LoadedScene[] = [];
    try {
      for (const summary of await studioSceneLibrary.list()) {
        const result = await studioSceneLibrary.load(summary.id);
        if (result.scene) loaded.push(result);
      }
      const scenes = loaded.flatMap((result) => (result.scene ? [result.scene] : []));
      downloadPortable(await exportProjectZip(scenes, project ?? defaultProject(scenes)));
    } catch (error) {
      workspaceError =
        error instanceof Error ? error.message : 'The project export could not be built.';
    } finally {
      releaseLocalMediaUrls(loaded);
      exporting = false;
    }
  }

  onMount(() => void loadWorkspace());
</script>

<svelte:head>
  <title>Scenes · Scenebook</title>
</svelte:head>

<AppShell active="catalog">
  <div class="catalog-page">
    <header class="catalog-header">
      <div>
        <h1>Scenes</h1>
        <p>Create, review, and organize your product walkthroughs.</p>
      </div>
      <div class="header-actions">
        <button
          class="button"
          type="button"
          disabled={workspaceState !== 'ready' || summaries.length === 0 || exporting}
          title={summaries.length === 0
            ? 'Save or import a Scene before exporting a project.'
            : undefined}
          onclick={exportWorkspace}
          ><Icon name="file" size={16} />{exporting ? 'Building…' : 'Export project'}</button
        >
      </div>
    </header>

    {#if workspaceState === 'error'}
      <div class="catalog-error" role="alert">
        <Icon name="warning" size={17} />
        <span><strong>Project settings could not be loaded.</strong> {workspaceError}</span>
        <button class="button" type="button" onclick={loadWorkspace}>Try again</button>
      </div>
    {/if}

    <CatalogView title="All scenes" onloaded={handleCatalogLoaded} />
  </div>
</AppShell>

<style>
  .catalog-page {
    display: grid;
    gap: 24px;
    grid-template-columns: minmax(0, 1fr);
    margin: 0 auto;
    max-width: 1500px;
    padding: 32px clamp(20px, 3.4vw, 52px) 72px;
  }
  .catalog-header {
    align-items: end;
    display: flex;
    gap: 24px;
    justify-content: space-between;
  }
  h1 {
    font-size: 1.8rem;
    letter-spacing: -0.035em;
    line-height: 1.1;
    margin: 0 0 7px;
  }
  .catalog-header p {
    color: var(--muted);
    font-size: 0.82rem;
    line-height: 1.45;
    margin: 0;
  }
  .header-actions {
    display: flex;
    gap: 8px;
  }
  .catalog-error {
    align-items: center;
    background: var(--broken-soft);
    border-radius: var(--radius-sm);
    color: var(--broken);
    display: flex;
    font-size: 0.72rem;
    gap: 9px;
    padding: 10px 12px;
  }
  .catalog-error span {
    flex: 1;
  }
  @media (max-width: 900px) {
    .catalog-header {
      align-items: start;
      flex-direction: column;
    }
  }
  @media (max-width: 560px) {
    .catalog-page {
      padding: 28px 14px 58px;
    }
    .header-actions {
      width: 100%;
    }
    .header-actions > * {
      flex: 1;
    }
    .catalog-error {
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .catalog-error .button {
      margin-left: 26px;
    }
  }
</style>
