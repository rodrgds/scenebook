<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onDestroy } from 'svelte';

  import AppShell from '$lib/components/AppShell.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import SceneEditor from '$lib/components/SceneEditor.svelte';
  import SceneHealth from '$lib/components/SceneHealth.svelte';
  import ScenePreview from '$lib/components/ScenePreview.svelte';
  import ScenePublish from '$lib/components/ScenePublish.svelte';
  import SceneVersions from '$lib/components/SceneVersions.svelte';
  import { trapDialogFocus } from '$lib/dialog-focus';
  import { demoScene } from '$lib/demo';
  import { cloneScene } from '$lib/model';
  import type { EditorScene } from '$lib/model';
  import {
    releaseLocalMediaUrls,
    studioSceneLibrary,
    type RecoveryRecord,
  } from '$lib/scene-library';

  type Tab = 'edit' | 'preview' | 'health' | 'versions' | 'publish';

  let activeTab = $state<Tab>('edit');
  let scene = $state<EditorScene | null>(null);
  let loadState = $state<'loading' | 'ready' | 'missing' | 'error'>('loading');
  let loadError = $state('');
  let recovery = $state<RecoveryRecord | null>(null);
  let loadKey = $state('');
  let actionsDialog = $state<HTMLDialogElement>();
  let deleteDialog = $state<HTMLDialogElement>();
  let actionError = $state('');
  let duplicating = $state(false);
  let deleting = $state(false);
  let flushEditor: (() => Promise<void>) | null = null;
  let loadGeneration = 0;
  let destroyed = false;

  const tabs: Array<{
    id: Tab;
    label: string;
    icon: 'edit' | 'play' | 'health' | 'versions' | 'publish';
    badge?: string;
  }> = [
    { id: 'edit', label: 'Edit', icon: 'edit' },
    { id: 'preview', label: 'Preview', icon: 'play' },
    { id: 'health', label: 'Health', icon: 'health' },
    { id: 'versions', label: 'Versions', icon: 'versions' },
    { id: 'publish', label: 'Export', icon: 'publish' },
  ];

  $effect(() => {
    if (!browser) return;
    const requested = page.url.searchParams.get('tab') as Tab | null;
    activeTab = tabs.some((tab) => tab.id === requested) ? requested! : 'edit';
    const id = page.params.id;
    if (id && id !== loadKey) {
      loadKey = id;
      void loadScene(id);
    }
  });

  onDestroy(() => {
    destroyed = true;
    loadGeneration += 1;
    const ownedScene = scene;
    if (!ownedScene) return;
    queueMicrotask(() => {
      void studioSceneLibrary
        .waitForPendingSaves(ownedScene.id)
        .catch(() => undefined)
        .then(() => releaseLocalMediaUrls(ownedScene));
    });
  });

  async function loadScene(id: string) {
    const generation = ++loadGeneration;
    const previousScene = scene;
    loadState = 'loading';
    loadError = '';
    recovery = null;
    try {
      if (previousScene && previousScene.id !== id) {
        try {
          await flushEditor?.();
          await studioSceneLibrary.waitForPendingSaves(previousScene.id);
          if (destroyed || generation !== loadGeneration) return;
        } catch (error) {
          if (destroyed || generation !== loadGeneration) return;
          scene = previousScene;
          loadState = 'ready';
          actionError =
            error instanceof Error
              ? error.message
              : 'Studio could not save before leaving this Scene.';
          loadKey = previousScene.id;
          await goto(`/scenes/${encodeURIComponent(previousScene.id)}?tab=edit`, {
            replaceState: true,
            keepFocus: true,
            noScroll: true,
          });
          return;
        }
        releaseLocalMediaUrls(previousScene);
      }
      const loaded = await studioSceneLibrary.load(id);
      if (destroyed || generation !== loadGeneration) {
        releaseLocalMediaUrls(loaded);
        return;
      }
      if (!loaded.scene && id === demoScene.id) {
        scene = cloneScene(demoScene);
        loadState = 'ready';
        return;
      }
      if (!loaded.scene) {
        scene = null;
        loadState = 'missing';
        return;
      }
      scene = cloneScene(loaded.scene);
      recovery = loaded.recovery;
      loadState = 'ready';
    } catch (error) {
      if (destroyed || generation !== loadGeneration) return;
      scene = null;
      loadState = 'error';
      loadError = error instanceof Error ? error.message : 'This Scene could not be loaded.';
    }
  }

  function selectTab(tab: Tab) {
    activeTab = tab;
    const url = new URL(page.url);
    url.searchParams.set('tab', tab);
    void goto(`${url.pathname}${url.search}${url.hash}`, {
      keepFocus: true,
      noScroll: true,
      replaceState: false,
    });
  }

  function handleTabKey(event: KeyboardEvent, index: number) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const next = (index + direction + tabs.length) % tabs.length;
    const tab = tabs[next];
    if (tab) selectTab(tab.id);
    document.querySelector<HTMLButtonElement>(`[data-scene-tab="${tab?.id}"]`)?.focus();
  }

  async function restoreRecovery() {
    if (!recovery) return;
    scene = cloneScene(recovery.scene);
    try {
      await studioSceneLibrary.save(scene, recovery.token);
      recovery = null;
    } catch (error) {
      actionError = error instanceof Error ? error.message : 'Recovery could not be saved.';
    }
  }

  function discardRecovery() {
    if (!scene) return;
    studioSceneLibrary.discardRecovery(scene.id);
    recovery = null;
  }

  async function duplicateCurrent() {
    if (!scene || duplicating) return;
    duplicating = true;
    actionError = '';
    try {
      const copy = await studioSceneLibrary.duplicate(scene);
      actionsDialog?.close();
      await goto(`/scenes/${encodeURIComponent(copy.id)}`);
    } catch (error) {
      actionError = error instanceof Error ? error.message : 'The scene could not be duplicated.';
    } finally {
      duplicating = false;
    }
  }

  async function deleteCurrent() {
    if (!scene || deleting) return;
    deleting = true;
    actionError = '';
    try {
      await studioSceneLibrary.delete(scene.id);
      deleteDialog?.close();
      await goto('/catalog');
    } catch (error) {
      actionError = error instanceof Error ? error.message : 'The scene could not be deleted.';
    } finally {
      deleting = false;
    }
  }
</script>

<svelte:head>
  <title>{scene?.title ?? 'Scene'} · Scenebook</title>
</svelte:head>

<AppShell active="scene" flush>
  {#if loadState === 'loading'}
    <section class="route-state" aria-live="polite" aria-busy="true">
      <span class="state-mark"><Icon name="clock" size={22} /></span>
      <div>
        <h1>Opening scene…</h1>
        <p>Reading the durable local workspace.</p>
      </div>
    </section>
  {:else if loadState === 'error'}
    <section class="route-state error-state" role="alert">
      <span class="state-mark"><Icon name="warning" size={22} /></span>
      <div>
        <h1>Studio could not open this scene</h1>
        <p>{loadError}</p>
      </div>
      <button class="button" type="button" onclick={() => loadScene(loadKey)}>Retry</button>
      <a class="button" href="/catalog">Back to catalog</a>
    </section>
  {:else if loadState === 'missing'}
    <section class="route-state">
      <span class="state-mark"><Icon name="file" size={22} /></span>
      <div>
        <h1>Scene not found</h1>
        <p>No local scene exists at <span class="mono">{loadKey}</span>.</p>
      </div>
      <a class="button primary" href="/catalog">Open catalog</a>
    </section>
  {:else if scene}
    {#if recovery}
      <section class="recovery-banner" role="status">
        <Icon name="history" size={17} />
        <div>
          {#if recovery.omittedMedia}
            <strong>Text and layout edits were recovered</strong>
            <span>
              Embedded screenshots and archive media are not copied into the crash journal. The last
              durable images are shown; a newer unsaved replacement may need to be added again.
            </span>
          {:else}
            <strong>Unsaved edits were recovered</strong>
            <span>Studio found changes newer than the last durable save.</span>
          {/if}
        </div>
        <button class="button" type="button" onclick={discardRecovery}
          >Discard recovered edits</button
        >
        <button class="button primary" type="button" onclick={restoreRecovery}>Restore edits</button
        >
      </section>
    {/if}
    <header class="scene-header">
      <div class="scene-identity">
        <nav aria-label="Breadcrumb">
          <a href="/catalog">Scenes</a><Icon name="chevron-right" size={12} /><span
            >{scene.title}</span
          >
        </nav>
        <div class="title-row">
          <h1>{scene.title}</h1>
          {#if scene.sample}
            <span class="sample-badge"><Icon name="warning" size={12} />Sample</span>
          {:else if scene.portableSource?.capability === 'verified'}
            <span class="capability"><Icon name="check" size={12} />Verified source</span>
          {:else if scene.portableSource?.capability === 'monitored'}
            <span class="capability"><Icon name="clock" size={12} />Monitored source</span>
          {:else}
            <span class="capability"><Icon name="edit" size={12} />Captured source</span>
          {/if}
        </div>
      </div>
      <div class="scene-actions">
        <button
          class="icon-button"
          type="button"
          aria-label="More scene actions"
          onclick={() => {
            actionError = '';
            actionsDialog?.showModal();
          }}><Icon name="more" size={16} /></button
        >
      </div>
    </header>

    <div class="scene-tabs" role="tablist" aria-label="Scene workbench">
      {#each tabs as tab, index}
        <button
          class:active={activeTab === tab.id}
          id={`scene-tab-${tab.id}`}
          type="button"
          role="tab"
          data-scene-tab={tab.id}
          aria-selected={activeTab === tab.id}
          aria-controls={activeTab === tab.id ? `${tab.id}-panel` : undefined}
          tabindex={activeTab === tab.id ? 0 : -1}
          onclick={() => selectTab(tab.id)}
          onkeydown={(event) => handleTabKey(event, index)}
        >
          <Icon name={tab.icon} size={14} />{tab.label}{#if tab.badge}<span>{tab.badge}</span>{/if}
        </button>
      {/each}
    </div>

    <div id={`${activeTab}-panel`} role="tabpanel" aria-labelledby={`scene-tab-${activeTab}`}>
      {#if activeTab === 'edit'}
        <SceneEditor
          bind:scene
          onpreview={() => selectTab('preview')}
          onflushchange={(flush) => (flushEditor = flush)}
        />
      {:else if activeTab === 'preview'}
        <ScenePreview {scene} />
      {:else if activeTab === 'health'}
        <SceneHealth {scene} />
      {:else if activeTab === 'versions'}
        <SceneVersions {scene} onrestore={(restored) => (scene = restored)} />
      {:else}
        <ScenePublish {scene} />
      {/if}
    </div>

    <dialog
      bind:this={actionsDialog}
      class="action-dialog"
      tabindex="-1"
      aria-labelledby="actions-title"
      onkeydown={(event) => trapDialogFocus(event, actionsDialog)}
      oncancel={(event) => {
        if (duplicating) event.preventDefault();
      }}
    >
      <form method="dialog" class="dialog-head">
        <div>
          <h2 id="actions-title">Scene actions</h2>
        </div>
        <button
          class="icon-button"
          value="cancel"
          aria-label="Close scene actions"
          disabled={duplicating}><Icon name="close" /></button
        >
      </form>
      {#if actionError}<div class="dialog-error" role="alert">{actionError}</div>{/if}
      <button class="wide-action" type="button" disabled={duplicating} onclick={duplicateCurrent}
        ><Icon name="copy" size={17} /><span
          ><strong>{duplicating ? 'Duplicating…' : 'Duplicate scene'}</strong><small
            >Create an independent local draft with a new ID.</small
          ></span
        ><Icon name="chevron-right" size={15} /></button
      >
      <button
        class="wide-action danger-action"
        type="button"
        disabled={duplicating}
        onclick={() => {
          actionError = '';
          actionsDialog?.close();
          deleteDialog?.showModal();
        }}
        ><Icon name="trash" size={17} /><span
          ><strong>Delete local scene</strong><small
            >Remove this scene and its recovery journal from this browser.</small
          ></span
        ><Icon name="chevron-right" size={15} /></button
      >
    </dialog>

    <dialog
      bind:this={deleteDialog}
      class="action-dialog confirm-dialog"
      tabindex="-1"
      aria-labelledby="delete-title"
      onkeydown={(event) => trapDialogFocus(event, deleteDialog)}
      oncancel={(event) => {
        if (deleting) event.preventDefault();
      }}
    >
      <span class="danger-mark"><Icon name="trash" size={21} /></span>
      <h2 id="delete-title">Delete “{scene.title}”?</h2>
      <p>This permanently removes the local saved copy and its crash-recovery journal.</p>
      {#if actionError}<div class="dialog-error" role="alert">{actionError}</div>{/if}
      <div class="dialog-actions">
        <form method="dialog">
          <button class="button" type="submit" value="cancel" disabled={deleting}>Keep scene</button
          >
        </form>
        <button class="button danger" type="button" disabled={deleting} onclick={deleteCurrent}
          >{deleting ? 'Deleting…' : 'Delete scene'}</button
        >
      </div>
    </dialog>
  {/if}
</AppShell>

<style>
  .route-state {
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    margin: clamp(24px, 7vw, 88px) auto;
    max-width: 680px;
    padding: 24px;
  }
  .route-state > div {
    flex: 1;
    min-width: 220px;
  }
  .route-state h1 {
    font-size: 1.3rem;
    margin: 0 0 5px;
  }
  .route-state p {
    color: var(--muted);
    font-size: 0.78rem;
    margin: 0;
  }
  .state-mark,
  .danger-mark {
    align-items: center;
    background: var(--paper-2);
    border-radius: 10px;
    color: var(--muted);
    display: flex;
    height: 44px;
    justify-content: center;
    width: 44px;
  }
  .error-state .state-mark,
  .danger-mark {
    background: var(--broken-soft);
    color: var(--broken);
  }
  .recovery-banner {
    align-items: center;
    background: var(--changed-soft);
    border-bottom: 1px solid #dfc589;
    color: var(--changed);
    display: flex;
    gap: 10px;
    padding: 9px 18px;
  }
  .recovery-banner > div {
    display: grid;
    flex: 1;
  }
  .recovery-banner strong {
    font-size: 0.75rem;
  }
  .recovery-banner span {
    color: var(--muted);
    font-size: 0.75rem;
  }
  .scene-header {
    align-items: center;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
    display: grid;
    gap: 22px;
    grid-template-columns: minmax(280px, 1fr) auto;
    min-height: 72px;
    padding: 9px 18px;
  }
  .scene-identity nav {
    align-items: center;
    color: var(--faint);
    display: flex;
    font-size: 0.75rem;
    gap: 2px;
  }
  .scene-identity nav a {
    text-decoration: none;
  }
  .scene-identity nav a:hover {
    color: var(--accent);
  }
  .title-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 4px;
  }
  .title-row h1 {
    font-size: 1.2rem;
    letter-spacing: -0.03em;
    margin: 0 5px 0 0;
  }
  .capability,
  .sample-badge {
    align-items: center;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--muted);
    display: flex;
    font-size: 0.75rem;
    font-weight: 680;
    gap: 4px;
    min-height: 28px;
    padding: 3px 7px;
  }
  .sample-badge {
    background: var(--changed-soft);
    border-color: transparent;
    color: var(--changed);
  }
  .scene-actions {
    display: flex;
    gap: 6px;
  }
  .scene-actions .icon-button {
    background: var(--surface);
    border-color: var(--line);
  }
  .scene-tabs {
    align-items: end;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
    display: flex;
    gap: 3px;
    min-height: 45px;
    overflow-x: auto;
    padding: 0 17px;
  }
  .scene-tabs button {
    align-items: center;
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--muted);
    display: flex;
    font-size: 0.75rem;
    font-weight: 620;
    gap: 6px;
    height: 45px;
    padding: 0 11px;
    text-decoration: none;
    white-space: nowrap;
  }
  .scene-tabs button.active {
    border-bottom-color: var(--accent);
    color: var(--ink);
  }
  .scene-tabs button.active :global(svg) {
    color: var(--accent);
  }
  .scene-tabs button span {
    align-items: center;
    background: var(--paper-2);
    border-radius: 999px;
    display: flex;
    font-size: 0.75rem;
    height: 22px;
    justify-content: center;
    min-width: 22px;
    padding: 0 5px;
  }
  .action-dialog {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 6px 8px rgba(25, 24, 22, 0.18);
    color: var(--ink);
    max-height: min(720px, calc(100dvh - 32px));
    max-width: min(540px, calc(100vw - 28px));
    padding: 20px;
    width: 100%;
  }
  .action-dialog::backdrop {
    background: rgba(25, 24, 22, 0.46);
  }
  .dialog-head {
    align-items: start;
    display: flex;
    justify-content: space-between;
  }
  .dialog-head h2,
  .confirm-dialog h2 {
    font-size: 1.25rem;
    letter-spacing: -0.03em;
    margin: 4px 0 0;
  }
  .action-dialog > p {
    color: var(--muted);
    font-size: 0.76rem;
    line-height: 1.55;
    margin: 12px 0 16px;
  }
  .dialog-error {
    background: var(--broken-soft);
    border: 1px solid color-mix(in srgb, var(--broken) 32%, transparent);
    border-radius: 8px;
    color: var(--broken);
    font-size: 0.75rem;
    margin: 10px 0;
    padding: 9px 10px;
  }
  .wide-action {
    align-items: center;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 10px;
    color: var(--ink);
    display: grid;
    gap: 10px;
    grid-template-columns: auto 1fr auto;
    min-height: 74px;
    padding: 11px 12px;
    text-align: left;
    width: 100%;
  }
  .wide-action:hover {
    border-color: var(--line-strong);
  }
  .wide-action {
    grid-template-columns: auto 1fr auto;
    margin-top: 8px;
  }
  .wide-action span,
  .wide-action strong,
  .wide-action small {
    display: block;
  }
  .wide-action strong {
    font-size: 0.76rem;
  }
  .wide-action small {
    color: var(--muted);
    font-size: 0.75rem;
    margin-top: 3px;
  }
  .danger-action {
    color: var(--broken);
  }
  .confirm-dialog {
    max-width: min(440px, calc(100vw - 28px));
  }
  .confirm-dialog .danger-mark {
    margin-bottom: 12px;
  }
  .dialog-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 18px;
  }
  @media (max-width: 1120px) {
    .scene-header {
      grid-template-columns: 1fr auto;
    }
  }
  @media (max-width: 650px) {
    .scene-header {
      align-items: start;
      grid-template-columns: 1fr;
      padding: 10px 12px;
    }
    .scene-actions {
      display: flex;
      justify-content: flex-end;
      width: 100%;
    }
    .scene-tabs {
      gap: 0;
      padding: 0 7px;
    }
    .scene-tabs button {
      flex: 1 0 auto;
      padding-inline: 8px;
    }
    .scene-tabs button :global(svg) {
      display: none;
    }
    .recovery-banner {
      align-items: stretch;
      display: grid;
      grid-template-columns: auto 1fr;
      padding: 10px 12px;
    }
    .recovery-banner .button {
      grid-column: auto;
    }
  }
  @media (pointer: coarse) {
    .scene-actions .icon-button,
    .scene-tabs button,
    .action-dialog .button,
    .action-dialog .icon-button,
    .wide-action {
      min-height: 44px;
    }
    .scene-actions .icon-button,
    .action-dialog .icon-button {
      min-width: 44px;
    }
  }
</style>
