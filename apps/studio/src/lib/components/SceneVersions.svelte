<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  import { cloneScene } from '../model';
  import type { EditorScene } from '../model';
  import { downloadPortable, exportSceneYaml, exportSceneZip } from '../portable';
  import {
    releaseLocalMediaUrls,
    studioSceneLibrary,
    type SceneVersionSummary,
    type StoredSceneRecord,
  } from '../scene-library';
  import Icon from './Icon.svelte';

  let { scene, onrestore }: { scene: EditorScene; onrestore?: (scene: EditorScene) => void } =
    $props();

  let versions = $state<SceneVersionSummary[]>([]);
  let selectedRevision = $state<number | null>(null);
  let selectedRecord = $state<StoredSceneRecord | null>(null);
  let nextCursor = $state<string | null>(null);
  let loadState = $state<'loading' | 'ready' | 'error'>('loading');
  let action = $state<'yaml' | 'zip' | 'restore' | null>(null);
  let error = $state('');
  let destroyed = false;
  let versionsGeneration = 0;
  let selectedGeneration = 0;

  let selected = $derived(
    versions.find((version) => version.revision === selectedRevision) ?? versions[0],
  );
  let currentRevision = $derived(versions[0]?.revision ?? 0);

  onMount(loadVersions);

  $effect(() => {
    const revision = selectedRevision;
    if (revision !== null) void loadSelectedRevision(revision);
  });

  onDestroy(() => {
    destroyed = true;
    versionsGeneration += 1;
    selectedGeneration += 1;
    releaseLocalMediaUrls(selectedRecord);
  });

  async function loadVersions(append = false) {
    const generation = ++versionsGeneration;
    loadState = 'loading';
    error = '';
    try {
      const page = await studioSceneLibrary.listVersionSummaries(scene.id, {
        cursor: append ? nextCursor : null,
        limit: 25,
      });
      if (destroyed || generation !== versionsGeneration) return;
      versions = append ? [...versions, ...page.items] : page.items;
      nextCursor = page.nextCursor;
      if (!append) selectedRevision = versions[0]?.revision ?? null;
      loadState = 'ready';
    } catch (cause) {
      if (destroyed || generation !== versionsGeneration) return;
      loadState = 'error';
      error = cause instanceof Error ? cause.message : 'Local revision history could not be read.';
    }
  }

  async function loadSelectedRevision(revision: number) {
    const generation = ++selectedGeneration;
    const requestedRevision = revision;
    try {
      const record = await studioSceneLibrary.loadVersion(scene.id, requestedRevision);
      if (
        destroyed ||
        generation !== selectedGeneration ||
        selectedRevision !== requestedRevision
      ) {
        releaseLocalMediaUrls(record);
        return;
      }
      releaseLocalMediaUrls(selectedRecord);
      selectedRecord = record;
      if (!record) error = `Local revision ${requestedRevision} is no longer available.`;
    } catch (cause) {
      if (
        !destroyed &&
        generation === selectedGeneration &&
        selectedRevision === requestedRevision
      ) {
        releaseLocalMediaUrls(selectedRecord);
        selectedRecord = null;
        error = cause instanceof Error ? cause.message : 'This revision could not be read.';
      }
    }
  }

  async function exportSelected(format: 'yaml' | 'zip') {
    if (!selected) return;
    const revision = selected.revision;
    selectedGeneration += 1;
    action = format;
    error = '';
    let actionRecord: StoredSceneRecord | null = null;
    let ownsActionRecord = false;
    try {
      actionRecord = selectedRecord?.revision === revision ? selectedRecord : null;
      if (!actionRecord) {
        actionRecord = await studioSceneLibrary.loadVersion(scene.id, revision);
        ownsActionRecord = true;
      }
      if (!actionRecord) throw new Error(`Local revision ${revision} is no longer available.`);
      const output =
        format === 'zip'
          ? await exportSceneZip(actionRecord.scene)
          : await exportSceneYaml(actionRecord.scene);
      output.filename = output.filename.replace(
        /(?=\.scene\.yaml$|\.scenebook\.zip$)/u,
        `.r${revision}`,
      );
      downloadPortable(output);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'This revision could not be exported.';
    } finally {
      if (ownsActionRecord) releaseLocalMediaUrls(actionRecord);
      action = null;
    }
  }

  async function restoreSelected() {
    if (!selected || selected.revision === currentRevision) return;
    const revision = selected.revision;
    action = 'restore';
    error = '';
    try {
      const restored = await studioSceneLibrary.restoreVersion(scene.id, revision);
      onrestore?.(cloneScene(restored.scene));
      await loadVersions();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'This revision could not be restored.';
    } finally {
      action = null;
    }
  }
</script>

<section class="versions-view" aria-label="Local Scene revisions">
  <header>
    <div>
      <h2>Scene revisions</h2>
      <p>
        Studio keeps the latest 100 successful local saves. Restoring creates a new revision, so
        existing history remains intact.
      </p>
    </div>
    <button
      class="button"
      type="button"
      disabled={loadState === 'loading'}
      onclick={() => loadVersions()}><Icon name="runs" size={14} />Refresh</button
    >
  </header>

  {#if error}<p class="error-banner" role="alert">{error}</p>{/if}

  {#if loadState === 'loading'}
    <div class="state-card" aria-live="polite" aria-busy="true">
      <Icon name="clock" size={20} /><strong>Reading local revisions…</strong>
    </div>
  {:else if loadState === 'error'}
    <div class="state-card">
      <Icon name="warning" size={20} /><strong>Revision history is unavailable.</strong>
      <button class="button" type="button" onclick={() => loadVersions()}>Try again</button>
    </div>
  {:else if versions.length === 0}
    <div class="state-card">
      <Icon name="history" size={20} /><strong>No saved revision exists yet.</strong>
      <p>Make an edit and wait for “Saved locally” to create the first durable snapshot.</p>
    </div>
  {:else}
    <div class="versions-layout">
      <aside class="version-list">
        <div class="list-heading">
          <strong
            >{versions.length} retained {versions.length === 1 ? 'revision' : 'revisions'}</strong
          ><span>Newest first</span>
        </div>
        <ol>
          {#each versions as version}
            <li>
              <button
                class:active={selectedRevision === version.revision}
                type="button"
                disabled={Boolean(action)}
                aria-current={selectedRevision === version.revision ? 'true' : undefined}
                onclick={() => (selectedRevision = version.revision)}
              >
                <span class="revision-node"><Icon name="save" size={13} /></span>
                <span>
                  <strong>Revision {version.revision}</strong>
                  <small>{new Date(version.savedAt).toLocaleString()}</small>
                  <em>{version.stepCount} Steps · {version.title}</em>
                </span>
                {#if version.revision === currentRevision}<span class="current-badge">Current</span
                  >{/if}
              </button>
            </li>
          {/each}
        </ol>
      </aside>

      {#if selected}
        <section class="revision-detail" aria-labelledby="revision-title">
          <header>
            <div>
              <h3 id="revision-title">Revision {selected.revision}</h3>
              <p>Saved {new Date(selected.savedAt).toLocaleString()} in this browser profile.</p>
            </div>
            <span class:current={selected.revision === currentRevision} class="revision-state"
              >{selected.revision === currentRevision ? 'Current' : 'Historical'}</span
            >
          </header>

          <dl>
            <div>
              <dt>Title</dt>
              <dd>{selected.title}</dd>
            </div>
            <div>
              <dt>Steps</dt>
              <dd>{selected.stepCount}</dd>
            </div>
            <div>
              <dt>Translations</dt>
              <dd>{selected.translationCount}</dd>
            </div>
            <div>
              <dt>Portable source</dt>
              <dd>{selected.hasPortableSource ? 'Attached' : 'Studio draft'}</dd>
            </div>
            <div>
              <dt>Verification</dt>
              <dd>{selected.verification ?? 'Not attached'}</dd>
            </div>
            <div>
              <dt>Theme</dt>
              <dd>
                <i style:background={selected.theme.accent}></i>{selected.theme.accent}
              </dd>
            </div>
          </dl>

          <details class="snapshot-outline">
            <summary>Step outline <small>{selected.steps.length} Steps</small></summary>
            <ol>
              {#each selected.steps as step, index}
                <li>
                  <span class="mono">{String(index + 1).padStart(2, '0')}</span><strong
                    >{step.title}</strong
                  ><small>{step.type}</small>
                </li>
              {/each}
            </ol>
          </details>

          <footer>
            <button
              class="button"
              type="button"
              disabled={Boolean(action)}
              onclick={() => exportSelected('yaml')}
              ><Icon name="download" size={14} />{action === 'yaml'
                ? 'Exporting…'
                : 'Export YAML'}</button
            >
            <button
              class="button"
              type="button"
              disabled={Boolean(action)}
              onclick={() => exportSelected('zip')}
              ><Icon name="download" size={14} />{action === 'zip'
                ? 'Exporting…'
                : 'Export ZIP'}</button
            >
            <button
              class="button primary"
              type="button"
              disabled={Boolean(action) || selected.revision === currentRevision}
              onclick={restoreSelected}
              ><Icon name="history" size={14} />{action === 'restore'
                ? 'Restoring…'
                : 'Restore as new revision'}</button
            >
          </footer>
        </section>
      {/if}
    </div>
    {#if nextCursor}
      <button class="button load-more" type="button" onclick={() => loadVersions(true)}
        >Load older revisions</button
      >
    {/if}
  {/if}
</section>

<style>
  .versions-view {
    display: grid;
    gap: 18px;
    margin: 0 auto;
    max-width: 1280px;
    min-height: calc(100vh - 178px);
    padding: 26px clamp(14px, 2.5vw, 34px) 52px;
  }
  .load-more {
    justify-self: center;
  }
  .versions-view > header {
    align-items: end;
    display: flex;
    justify-content: space-between;
  }
  h2 {
    font-size: 1.6rem;
    letter-spacing: -0.04em;
    margin: 5px 0;
  }
  .versions-view > header p,
  .revision-detail header p,
  .state-card p {
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1.5;
    margin: 0;
    max-width: 70ch;
  }
  .error-banner {
    background: var(--broken-soft);
    border: 1px solid color-mix(in srgb, var(--broken) 25%, transparent);
    border-radius: 8px;
    color: var(--broken);
    font-size: 0.72rem;
    margin: 0;
    padding: 10px 12px;
  }
  .state-card {
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    display: grid;
    gap: 8px;
    justify-items: center;
    min-height: 260px;
    padding: 30px;
    text-align: center;
  }
  .state-card strong {
    font-size: 0.85rem;
  }
  .versions-layout {
    display: grid;
    gap: 14px;
    grid-template-columns: 300px minmax(0, 1fr);
  }
  .version-list,
  .revision-detail {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .list-heading {
    align-items: center;
    border-bottom: 1px solid var(--line);
    display: flex;
    font-size: 0.72rem;
    justify-content: space-between;
    padding: 11px 12px;
  }
  .list-heading span {
    color: var(--muted);
  }
  .version-list ol,
  .snapshot-outline ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .version-list li + li {
    border-top: 1px solid var(--line);
  }
  .version-list button {
    align-items: center;
    background: transparent;
    border: 0;
    display: grid;
    gap: 9px;
    grid-template-columns: auto 1fr auto;
    padding: 12px;
    text-align: left;
    width: 100%;
  }
  .version-list button.active {
    background: var(--accent-soft);
  }
  .revision-node {
    align-items: center;
    background: var(--paper-2);
    border-radius: 50%;
    color: var(--accent);
    display: flex;
    height: 28px;
    justify-content: center;
    width: 28px;
  }
  .version-list strong,
  .version-list small,
  .version-list em {
    display: block;
  }
  .version-list strong {
    font-size: 0.75rem;
  }
  .version-list small,
  .version-list em {
    color: var(--muted);
    font-size: 0.72rem;
    font-style: normal;
    margin-top: 2px;
  }
  .current-badge,
  .revision-state {
    background: var(--pass-soft);
    border-radius: 999px;
    color: var(--pass);
    font-size: 0.72rem;
    padding: 4px 7px;
  }
  .revision-state:not(.current) {
    background: var(--paper-2);
    color: var(--muted);
  }
  .revision-detail > header {
    align-items: start;
    border-bottom: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    padding: 18px;
  }
  .revision-detail h3 {
    font-size: 1.25rem;
    margin: 5px 0;
  }
  .revision-detail dl {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    margin: 0;
  }
  .revision-detail dl div {
    border-bottom: 1px solid var(--line);
    border-right: 1px solid var(--line);
    padding: 12px 14px;
  }
  .revision-detail dt {
    color: var(--muted);
    font-size: 0.72rem;
  }
  .revision-detail dd {
    align-items: center;
    display: flex;
    font-size: 0.72rem;
    gap: 6px;
    margin: 4px 0 0;
  }
  .revision-detail dd i {
    border-radius: 50%;
    height: 10px;
    width: 10px;
  }
  .snapshot-outline {
    border: 0;
    padding: 0;
  }
  .snapshot-outline summary {
    cursor: pointer;
    display: flex;
    font-size: 0.75rem;
    font-weight: 680;
    justify-content: space-between;
    list-style: none;
    min-height: 44px;
    padding: 13px 16px;
  }
  .snapshot-outline summary::-webkit-details-marker {
    display: none;
  }
  .snapshot-outline summary::after {
    color: var(--muted);
    content: '+';
    margin-left: 10px;
  }
  .snapshot-outline[open] summary {
    border-bottom: 1px solid var(--line);
  }
  .snapshot-outline[open] summary::after {
    content: '−';
  }
  .snapshot-outline summary small {
    color: var(--muted);
    font-size: 0.72rem;
    font-weight: 500;
    margin-left: auto;
  }
  .snapshot-outline li {
    align-items: center;
    border-top: 1px solid var(--line);
    display: grid;
    gap: 9px;
    grid-template-columns: 25px 1fr auto;
    padding: 8px 2px;
  }
  .snapshot-outline li span,
  .snapshot-outline li small {
    color: var(--muted);
    font-size: 0.72rem;
  }
  .snapshot-outline li strong {
    font-size: 0.72rem;
  }
  .revision-detail footer {
    border-top: 1px solid var(--line);
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    justify-content: flex-end;
    padding: 12px;
  }
  @media (pointer: coarse) {
    .versions-view .button,
    .version-list button,
    .snapshot-outline summary {
      min-height: 44px;
    }
  }
  @media (max-width: 760px) {
    .versions-view > header {
      align-items: start;
      gap: 12px;
    }
    .versions-layout {
      grid-template-columns: 1fr;
    }
    .version-list ol {
      display: flex;
      overflow-x: auto;
    }
    .version-list li {
      flex: 0 0 255px;
    }
    .version-list li + li {
      border-left: 1px solid var(--line);
      border-top: 0;
    }
    .revision-detail dl {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
