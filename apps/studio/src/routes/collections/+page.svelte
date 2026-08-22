<script lang="ts">
  import { beforeNavigate } from '$app/navigation';
  import { onMount } from 'svelte';
  import { ProjectSchema, type Collection, type Project } from '@scenebook/schema';

  import AppShell from '$lib/components/AppShell.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { effectiveLocalProject, uniqueProjectId } from '$lib/project-surfaces';
  import { studioSceneLibrary, type SceneSummary } from '$lib/scene-library';

  let scenes = $state<SceneSummary[]>([]);
  let draft = $state<Project | null>(null);
  let saved = $state<Project | null>(null);
  let persisted = $state(false);
  let selectedId = $state('');
  let candidateSceneId = $state('');
  let loadState = $state<'loading' | 'ready' | 'error'>('loading');
  let saveState = $state<'idle' | 'saving' | 'saved'>('idle');
  let error = $state('');
  let dirty = $state(false);
  let pendingDelete = $state(false);
  let deletedCollection = $state<{
    collection: Collection;
    index: number;
    channelLinks: Array<{ channelId: string; index: number }>;
  } | null>(null);

  let selected = $derived(draft?.collections.find((collection) => collection.id === selectedId));
  let availableScenes = $derived(
    scenes.filter((scene) => !selected?.entries.some((entry) => entry.sceneId === scene.id)),
  );
  let missingEntries = $derived(
    selected?.entries.filter((entry) => !scenes.some((scene) => scene.id === entry.sceneId)) ?? [],
  );
  let selectedChannelCount = $derived(
    draft?.channels.filter((channel) =>
      selected ? channel.collectionIds.includes(selected.id) : false,
    ).length ?? 0,
  );

  async function loadCollections() {
    loadState = 'loading';
    error = '';
    try {
      const [nextScenes, project] = await Promise.all([
        studioSceneLibrary.list(),
        studioSceneLibrary.loadProject(),
      ]);
      scenes = nextScenes;
      persisted = Boolean(project);
      const next = effectiveLocalProject(project, nextScenes);
      draft = structuredClone(next);
      saved = structuredClone(next);
      selectedId = next.collections[0]?.id ?? '';
      candidateSceneId = nextScenes[0]?.id ?? '';
      dirty = false;
      pendingDelete = false;
      deletedCollection = null;
      saveState = 'idle';
      loadState = 'ready';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Collections could not be read.';
      loadState = 'error';
    }
  }

  function markDirty() {
    dirty = true;
    saveState = 'idle';
    error = '';
  }

  function createCollection() {
    if (!draft || scenes.length === 0) return;
    const ids = new Set(draft.collections.map((collection) => collection.id));
    const id = uniqueProjectId('collection', ids);
    const scene = scenes[0]!;
    const collection: Collection = {
      id,
      title: `Collection ${draft.collections.length + 1}`,
      slug: id.replaceAll(/[._:]+/gu, '-'),
      description: 'Curated in local Studio.',
      audience: [],
      entries: [{ id: `${scene.id}-entry`, sceneId: scene.id }],
    };
    draft.collections.push(collection);
    selectedId = collection.id;
    candidateSceneId = availableScenes[0]?.id ?? '';
    pendingDelete = false;
    deletedCollection = null;
    markDirty();
  }

  function deleteCollection() {
    if (!draft || !selected) return;
    const removedId = selected.id;
    const index = draft.collections.findIndex((collection) => collection.id === removedId);
    const channelLinks = draft.channels.flatMap((channel) => {
      const channelIndex = channel.collectionIds.indexOf(removedId);
      return channelIndex >= 0 ? [{ channelId: channel.id, index: channelIndex }] : [];
    });
    deletedCollection = {
      collection: $state.snapshot(selected),
      index,
      channelLinks,
    };
    draft.collections = draft.collections.filter((collection) => collection.id !== removedId);
    for (const channel of draft.channels) {
      channel.collectionIds = channel.collectionIds.filter((id) => id !== removedId);
    }
    selectedId = draft.collections[0]?.id ?? '';
    pendingDelete = false;
    markDirty();
  }

  function undoCollectionDeletion() {
    if (!draft || !deletedCollection) return;
    const deletion = deletedCollection;
    if (!draft.collections.some((collection) => collection.id === deletion.collection.id)) {
      draft.collections.splice(
        Math.min(deletion.index, draft.collections.length),
        0,
        deletion.collection,
      );
    }
    for (const link of deletion.channelLinks) {
      const channel = draft.channels.find((candidate) => candidate.id === link.channelId);
      if (channel && !channel.collectionIds.includes(deletion.collection.id)) {
        channel.collectionIds.splice(
          Math.min(link.index, channel.collectionIds.length),
          0,
          deletion.collection.id,
        );
      }
    }
    selectedId = deletion.collection.id;
    deletedCollection = null;
    pendingDelete = false;
    markDirty();
  }

  function addScene() {
    if (
      !selected ||
      !candidateSceneId ||
      !availableScenes.some((scene) => scene.id === candidateSceneId)
    )
      return;
    const existing = new Set(selected.entries.map((entry) => entry.id));
    selected.entries.push({
      id: uniqueProjectId(`${candidateSceneId}-entry`, existing),
      sceneId: candidateSceneId,
    });
    candidateSceneId = availableScenes.find((scene) => scene.id !== candidateSceneId)?.id ?? '';
    markDirty();
  }

  function removeEntry(entryId: string) {
    if (!selected || selected.entries.length <= 1) return;
    selected.entries = selected.entries.filter((entry) => entry.id !== entryId);
    markDirty();
  }

  function moveEntry(index: number, direction: -1 | 1) {
    if (!selected) return;
    const destination = index + direction;
    if (destination < 0 || destination >= selected.entries.length) return;
    const [entry] = selected.entries.splice(index, 1);
    if (entry) selected.entries.splice(destination, 0, entry);
    markDirty();
  }

  function updateAudience(value: string) {
    if (!selected) return;
    selected.audience = [
      ...new Set(
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
    markDirty();
  }

  function discardChanges() {
    if (!saved) return;
    draft = structuredClone(saved);
    selectedId = draft.collections.some((collection) => collection.id === selectedId)
      ? selectedId
      : (draft.collections[0]?.id ?? '');
    dirty = false;
    pendingDelete = false;
    deletedCollection = null;
    error = '';
    saveState = 'idle';
  }

  async function saveCollections() {
    if (!draft || (!dirty && persisted)) return;
    saveState = 'saving';
    error = '';
    const parsed = ProjectSchema.safeParse(draft);
    if (!parsed.success) {
      error = parsed.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join('.') || 'project'}: ${issue.message}`)
        .join(' · ');
      saveState = 'idle';
      return;
    }
    try {
      await studioSceneLibrary.saveProject(parsed.data);
      draft = structuredClone(parsed.data);
      saved = structuredClone(parsed.data);
      persisted = true;
      dirty = false;
      pendingDelete = false;
      deletedCollection = null;
      saveState = 'saved';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Collections could not be saved.';
      saveState = 'idle';
    }
  }

  function sceneFor(id: string) {
    return scenes.find((scene) => scene.id === id);
  }

  beforeNavigate((navigation) => {
    if (
      dirty &&
      !navigation.willUnload &&
      !window.confirm('Leave Collections and discard your unsaved changes?')
    ) {
      navigation.cancel();
    }
  });

  onMount(() => void loadCollections());
</script>

<svelte:head><title>Collections · Scenebook</title></svelte:head>
<svelte:window
  onbeforeunload={(event) => {
    if (dirty) event.preventDefault();
  }}
/>

<AppShell active="collections">
  <div class="project-page collections-page">
    <header class="surface-header">
      <div>
        <h1>Collections</h1>
      </div>
      <div class="surface-actions">
        {#if dirty}<button class="button" type="button" onclick={discardChanges}>Discard</button
          >{/if}
        <button
          class="button"
          class:primary={dirty}
          type="button"
          disabled={(!dirty && persisted) || saveState === 'saving'}
          onclick={saveCollections}
          ><Icon name="save" size={15} />{saveState === 'saving'
            ? 'Saving…'
            : saveState === 'saved'
              ? 'Saved locally'
              : 'Save changes'}</button
        >
        <button
          class="button"
          class:primary={!dirty && scenes.length > 0 && loadState === 'ready'}
          type="button"
          disabled={scenes.length === 0 || loadState !== 'ready'}
          onclick={createCollection}><Icon name="plus" size={15} />New collection</button
        >
      </div>
    </header>

    {#if error && loadState !== 'error'}<p class="surface-error" role="alert">{error}</p>{/if}

    {#if loadState === 'loading'}
      <div class="surface-state" aria-busy="true">
        <Icon name="clock" />
        <div>
          <strong>Reading collections…</strong>
        </div>
      </div>
    {:else if loadState === 'error'}
      <div class="surface-state">
        <Icon name="warning" />
        <div><strong>Collections are unavailable</strong><small>{error}</small></div>
        <button class="button" type="button" onclick={loadCollections}>Try again</button>
      </div>
    {:else if scenes.length === 0}
      <div class="surface-state">
        <Icon name="collection" />
        <div>
          <strong>A collection needs at least one scene</strong><small
            >Create or import a scene first, then return here to build an ordered path.</small
          >
        </div>
        <a class="button primary" href="/catalog?action=create">New scene</a>
      </div>
    {:else}
      <div class="curation-layout">
        {#if deletedCollection}
          <div class="undo-deletion curation-notice" role="status">
            <span
              ><strong>“{deletedCollection.collection.title}” removed</strong><small
                >{deletedCollection.channelLinks.length} channel link{deletedCollection.channelLinks
                  .length === 1
                  ? ''
                  : 's'} will also be removed when you save.</small
              ></span
            >
            <button class="button" type="button" onclick={undoCollectionDeletion}>Undo</button>
          </div>
        {/if}
        <aside class="collection-list surface-card" aria-label="Project collections">
          <div class="list-heading">
            <span>Collections</span><strong>{draft?.collections.length ?? 0}</strong>
          </div>
          {#if draft?.collections.length}
            <nav>
              {#each draft.collections as collection, index (collection.id)}
                <button
                  class:active={selectedId === collection.id}
                  type="button"
                  onclick={() => {
                    selectedId = collection.id;
                    pendingDelete = false;
                  }}
                >
                  <span class="collection-number">{String(index + 1).padStart(2, '0')}</span>
                  <span
                    ><strong>{collection.title}</strong><small
                      >{collection.entries.length} scene{collection.entries.length === 1 ? '' : 's'} ·
                      /{collection.slug}</small
                    ></span
                  >
                  <Icon name="chevron-right" size={14} />
                </button>
              {/each}
            </nav>
          {:else}
            <div class="list-empty">
              <Icon name="collection" />
              <p>No collections remain. Create one to curate your saved scenes.</p>
            </div>
          {/if}
        </aside>

        {#if selected}
          <section class="collection-editor surface-card">
            <header>
              <div>
                <h2>{selected.title}</h2>
              </div>
              <button
                class="button danger"
                type="button"
                aria-expanded={pendingDelete}
                onclick={() => (pendingDelete = !pendingDelete)}
                ><Icon name="trash" size={14} />Delete collection…</button
              >
            </header>
            {#if pendingDelete}
              <div class="delete-confirmation" role="alert">
                <span
                  ><strong>Delete “{selected.title}”?</strong><small
                    >This removes it from {selectedChannelCount} channel{selectedChannelCount === 1
                      ? ''
                      : 's'}. Nothing is permanent until you save.</small
                  ></span
                >
                <button class="button" type="button" onclick={() => (pendingDelete = false)}
                  >Cancel</button
                >
                <button class="button danger" type="button" onclick={deleteCollection}
                  >Delete collection</button
                >
              </div>
            {/if}
            <div class="metadata-grid">
              <label class="field"
                ><span class="field-label">Title</span><input
                  class="input"
                  bind:value={selected.title}
                  oninput={markDirty}
                  maxlength="500"
                /></label
              >
              <label class="field full"
                ><span class="field-label">Description</span><textarea
                  class="textarea"
                  bind:value={selected.description}
                  oninput={markDirty}
                  maxlength="5000"></textarea></label
              >
              <details class="advanced-fields full">
                <summary>Advanced fields</summary>
                <div>
                  <label class="field"
                    ><span class="field-label">Public slug</span><input
                      class="input mono"
                      bind:value={selected.slug}
                      oninput={markDirty}
                      maxlength="100"
                    /></label
                  >
                  <label class="field"
                    ><span class="field-label">Audiences <small>Comma separated</small></span><input
                      class="input"
                      value={selected.audience.join(', ')}
                      oninput={(event) => updateAudience(event.currentTarget.value)}
                      placeholder="developers, support, sales"
                    /></label
                  >
                </div>
              </details>
            </div>

            <section class="entries" aria-labelledby="entries-title">
              <div class="entry-heading">
                <div>
                  <h3 id="entries-title">Scene entries</h3>
                </div>
                <div class="add-entry">
                  <select class="select" bind:value={candidateSceneId} aria-label="Scene to add"
                    ><option value="">Choose a scene…</option
                    >{#each availableScenes as scene}<option value={scene.id}>{scene.title}</option
                      >{/each}</select
                  ><button
                    class="button"
                    type="button"
                    disabled={!candidateSceneId}
                    onclick={addScene}><Icon name="plus" size={14} />Add</button
                  >
                </div>
              </div>
              {#if missingEntries.length}<p class="missing-warning">
                  <Icon name="warning" size={14} />{missingEntries.length}
                  {missingEntries.length === 1 ? 'entry references' : 'entries reference'} a scene not
                  stored in this browser. Keep it for a partial checkout, or remove it before publishing
                  locally.
                </p>{/if}
              <ol>
                {#each selected.entries as entry, index (entry.id)}
                  {@const scene = sceneFor(entry.sceneId)}
                  <li class:missing={!scene}>
                    <span class="drag-index">{String(index + 1).padStart(2, '0')}</span>
                    <span class="entry-copy"
                      ><strong>{entry.title ?? scene?.title ?? entry.sceneId}</strong><small
                        >{entry.description ??
                          scene?.description ??
                          'Referenced scene is not available locally.'}</small
                      ></span
                    >
                    <span class="entry-status status-chip {scene?.runStatus ?? 'stale'}"
                      >{scene ? scene.runStatus : 'missing'}</span
                    >
                    <span class="entry-actions"
                      ><button
                        class="icon-button"
                        type="button"
                        aria-label={`Move ${entry.sceneId} up`}
                        disabled={index === 0}
                        onclick={() => moveEntry(index, -1)}><Icon name="up" size={14} /></button
                      ><button
                        class="icon-button"
                        type="button"
                        aria-label={`Move ${entry.sceneId} down`}
                        disabled={index === selected.entries.length - 1}
                        onclick={() => moveEntry(index, 1)}><Icon name="down" size={14} /></button
                      >{#if scene}<a
                          class="icon-button"
                          aria-label={`Open ${scene.title}`}
                          href={`/scenes/${encodeURIComponent(scene.id)}`}
                          ><Icon name="external" size={14} /></a
                        >{/if}<button
                        class="icon-button danger"
                        type="button"
                        aria-label={`Remove ${entry.sceneId}`}
                        disabled={selected.entries.length <= 1}
                        title={selected.entries.length <= 1
                          ? 'A collection must retain at least one entry.'
                          : undefined}
                        onclick={() => removeEntry(entry.id)}
                        ><Icon name="trash" size={14} /></button
                      ></span
                    >
                  </li>
                {/each}
              </ol>
            </section>
          </section>
        {:else}
          <section class="surface-state">
            <Icon name="collection" />
            <div>
              <strong>No collection selected</strong><small
                >Create a collection to begin curating an ordered path.</small
              >
            </div>
            <button class="button primary" type="button" onclick={createCollection}
              >New collection</button
            >
          </section>
        {/if}
      </div>
    {/if}
  </div>
</AppShell>

<style>
  .curation-layout {
    align-items: start;
    display: grid;
    gap: 16px;
    grid-template-columns: minmax(230px, 0.7fr) minmax(0, 2fr);
  }
  .collection-list {
    overflow: hidden;
    position: sticky;
    top: 78px;
  }
  .list-heading {
    align-items: center;
    background: var(--paper-2);
    border-bottom: 1px solid var(--line);
    display: flex;
    font-size: 0.75rem;
    justify-content: space-between;
    padding: 12px 14px;
  }
  .list-heading span {
    color: var(--muted);
    font-weight: 700;
  }
  .collection-list nav {
    display: grid;
  }
  .collection-list nav button {
    align-items: center;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--line);
    display: grid;
    gap: 10px;
    grid-template-columns: auto 1fr auto;
    padding: 13px;
    min-height: 48px;
    text-align: left;
  }
  .collection-list nav button:last-child {
    border-bottom: 0;
  }
  .collection-list nav button:hover,
  .collection-list nav button.active {
    background: var(--accent-soft);
  }
  .collection-list nav button.active {
    color: var(--accent);
  }
  .collection-number {
    color: var(--faint);
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
  }
  .collection-list nav strong,
  .collection-list nav small {
    display: block;
  }
  .collection-list nav strong {
    font-size: 0.82rem;
  }
  .collection-list nav small {
    color: var(--muted);
    font-size: 0.75rem;
    margin-top: 3px;
  }
  .list-empty {
    color: var(--muted);
    font-size: 0.8rem;
    padding: 24px;
    text-align: center;
  }
  .collection-editor {
    overflow: hidden;
  }
  .collection-editor > header {
    align-items: center;
    border-bottom: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    padding: 18px 20px;
  }
  .collection-editor h2 {
    font-size: 1.12rem;
    margin: 0;
  }
  .delete-confirmation,
  .undo-deletion {
    align-items: center;
    border-bottom: 1px solid var(--line);
    display: flex;
    gap: 8px;
    padding: 12px 20px;
  }
  .delete-confirmation {
    background: var(--broken-soft);
  }
  .undo-deletion {
    background: var(--changed-soft);
  }
  .curation-notice {
    border: 1px solid color-mix(in srgb, var(--changed) 25%, var(--line));
    border-radius: var(--radius-sm);
    grid-column: 1 / -1;
  }
  .delete-confirmation > span,
  .undo-deletion > span {
    flex: 1;
    min-width: 0;
  }
  .delete-confirmation strong,
  .delete-confirmation small,
  .undo-deletion strong,
  .undo-deletion small {
    display: block;
  }
  .delete-confirmation strong,
  .undo-deletion strong {
    font-size: 0.82rem;
  }
  .delete-confirmation small,
  .undo-deletion small {
    color: var(--muted);
    font-size: 0.78rem;
    line-height: 1.45;
    margin-top: 2px;
  }
  .metadata-grid {
    display: grid;
    gap: 14px;
    grid-template-columns: 1.4fr 1fr;
    padding: 20px;
  }
  .metadata-grid .full {
    grid-column: 1 / -1;
  }
  .advanced-fields {
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .advanced-fields summary {
    color: var(--muted);
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 650;
    min-height: 40px;
  }
  .advanced-fields > div {
    display: grid;
    gap: 14px;
    grid-template-columns: 1fr 1fr;
    margin-top: 12px;
  }
  .field-label small {
    font-weight: 500;
  }
  .entries {
    border-top: 1px solid var(--line);
    display: grid;
    gap: 13px;
    padding: 20px;
  }
  .entry-heading {
    align-items: end;
    display: flex;
    gap: 15px;
    justify-content: space-between;
  }
  .entry-heading h3 {
    font-size: 0.9rem;
    margin: 4px 0 0;
  }
  .add-entry {
    display: flex;
    gap: 7px;
    min-width: min(390px, 100%);
  }
  .entries ol {
    display: grid;
    gap: 8px;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .entries li {
    align-items: center;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 9px;
    display: grid;
    gap: 12px;
    grid-template-columns: auto 1fr auto auto;
    padding: 10px;
  }
  .entries li.missing {
    border-color: color-mix(in srgb, var(--broken) 30%, var(--line));
  }
  .drag-index {
    color: var(--faint);
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
  }
  .entry-copy {
    min-width: 0;
  }
  .entry-copy strong,
  .entry-copy small {
    display: block;
  }
  .entry-copy strong {
    font-size: 0.82rem;
  }
  .entry-copy small {
    color: var(--muted);
    font-size: 0.75rem;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .entry-actions {
    display: flex;
  }
  .entry-actions .danger {
    color: var(--broken);
  }
  .missing-warning {
    align-items: center;
    background: var(--broken-soft);
    border-radius: 7px;
    color: var(--broken);
    display: flex;
    font-size: 0.78rem;
    gap: 7px;
    margin: 0;
    padding: 9px;
  }
  @media (max-width: 930px) {
    .curation-layout {
      grid-template-columns: 1fr;
    }
    .collection-list {
      position: static;
    }
  }
  @media (max-width: 650px) {
    .metadata-grid {
      grid-template-columns: 1fr;
    }
    .metadata-grid .full {
      grid-column: auto;
    }
    .advanced-fields > div {
      grid-template-columns: 1fr;
    }
    .entry-heading {
      align-items: stretch;
      flex-direction: column;
    }
    .add-entry {
      min-width: 0;
    }
    .entries li {
      grid-template-columns: auto 1fr;
    }
    .entry-status,
    .entry-actions {
      grid-column: 2;
    }
    .delete-confirmation,
    .undo-deletion {
      align-items: stretch;
      flex-wrap: wrap;
      padding-inline: 14px;
    }
    .delete-confirmation > span,
    .undo-deletion > span {
      flex-basis: 100%;
    }
    .delete-confirmation .button,
    .undo-deletion .button,
    .advanced-fields summary {
      min-height: 44px;
    }
    .entry-actions .icon-button {
      min-height: 44px;
      min-width: 44px;
    }
  }
</style>
