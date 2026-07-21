<script lang="ts">
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

  let selected = $derived(draft?.collections.find((collection) => collection.id === selectedId));
  let availableScenes = $derived(
    scenes.filter((scene) => !selected?.entries.some((entry) => entry.sceneId === scene.id)),
  );
  let missingEntries = $derived(
    selected?.entries.filter((entry) => !scenes.some((scene) => scene.id === entry.sceneId)) ?? [],
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
    markDirty();
  }

  function deleteCollection() {
    if (!draft || !selected) return;
    const removedId = selected.id;
    draft.collections = draft.collections.filter((collection) => collection.id !== removedId);
    for (const channel of draft.channels) {
      channel.collectionIds = channel.collectionIds.filter((id) => id !== removedId);
    }
    selectedId = draft.collections[0]?.id ?? '';
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
      saveState = 'saved';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Collections could not be saved.';
      saveState = 'idle';
    }
  }

  function sceneFor(id: string) {
    return scenes.find((scene) => scene.id === id);
  }

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
        <p>Group scenes into ordered paths for publishing.</p>
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
          class:primary={!dirty}
          type="button"
          disabled={scenes.length === 0 || loadState !== 'ready'}
          onclick={createCollection}><Icon name="plus" size={15} />New collection</button
        >
      </div>
    </header>

    {#if error}<p class="surface-error" role="alert">{error}</p>{/if}

    {#if loadState === 'loading'}
      <div class="surface-state" aria-busy="true">
        <Icon name="clock" />
        <div>
          <strong>Reading Collections…</strong><small
            >Loading Project configuration and local Scene identities.</small
          >
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
          <strong>A Collection needs at least one Scene</strong><small
            >Create or import a Scene first; the canonical Project schema does not allow empty
            Collection placeholders.</small
          >
        </div>
        <a class="button primary" href="/catalog?action=create">New Scene</a>
      </div>
    {:else}
      <div class="curation-layout">
        <aside class="collection-list surface-card" aria-label="Project Collections">
          <div class="list-heading">
            <span>Collections</span><strong>{draft?.collections.length ?? 0}</strong>
          </div>
          {#if draft?.collections.length}
            <nav>
              {#each draft.collections as collection, index (collection.id)}
                <button
                  class:active={selectedId === collection.id}
                  type="button"
                  onclick={() => (selectedId = collection.id)}
                >
                  <span class="collection-number">{String(index + 1).padStart(2, '0')}</span>
                  <span
                    ><strong>{collection.title}</strong><small
                      >{collection.entries.length} Scene{collection.entries.length === 1 ? '' : 's'} ·
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
              <p>No Collections remain. Create one to curate your saved Scenes.</p>
            </div>
          {/if}
        </aside>

        {#if selected}
          <section class="collection-editor surface-card">
            <header>
              <div>
                <h2>{selected.title}</h2>
              </div>
              <details class="collection-menu">
                <summary class="button">More</summary>
                <button class="button danger" type="button" onclick={deleteCollection}
                  ><Icon name="trash" size={14} />Delete collection</button
                >
              </details>
            </header>
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
                    ><option value="">Choose a Scene…</option
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
                  <Icon name="warning" size={14} />{missingEntries.length} entry reference{missingEntries.length ===
                  1
                    ? 's'
                    : ''} a Scene not stored in this browser. Keep it for a partial checkout, or remove
                  it before publishing locally.
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
                          'Referenced Scene is not available locally.'}</small
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
                          ? 'A Collection must retain at least one entry.'
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
              <strong>No Collection selected</strong><small
                >Create a Collection to begin curating an ordered path.</small
              >
            </div>
            <button class="button primary" type="button" onclick={createCollection}
              >New Collection</button
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
    font-size: 0.7rem;
  }
  .collection-list nav strong,
  .collection-list nav small {
    display: block;
  }
  .collection-list nav strong {
    font-size: 0.78rem;
  }
  .collection-list nav small {
    color: var(--muted);
    font-size: 0.7rem;
    margin-top: 3px;
  }
  .list-empty {
    color: var(--muted);
    font-size: 0.75rem;
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
  .collection-menu {
    position: relative;
  }
  .collection-menu summary {
    list-style: none;
  }
  .collection-menu summary::-webkit-details-marker {
    display: none;
  }
  .collection-menu[open] > button {
    background: var(--surface);
    box-shadow: var(--shadow-sm);
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 2;
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
    font-size: 0.76rem;
    font-weight: 650;
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
    font-size: 0.7rem;
  }
  .entry-copy {
    min-width: 0;
  }
  .entry-copy strong,
  .entry-copy small {
    display: block;
  }
  .entry-copy strong {
    font-size: 0.78rem;
  }
  .entry-copy small {
    color: var(--muted);
    font-size: 0.7rem;
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
    font-size: 0.73rem;
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
  }
</style>
