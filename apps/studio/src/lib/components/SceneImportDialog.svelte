<script lang="ts">
  import { goto } from '$app/navigation';
  import { importPortableBytes, PortableFileError, type PortableImportResult } from '../portable';
  import {
    studioSceneLibrary,
    type ImportConflictStrategy,
    type ImportScenesResult,
  } from '../scene-library';
  import Icon from './Icon.svelte';

  let {
    visible,
    onclose,
    onimported,
  }: {
    visible: boolean;
    onclose: () => void;
    onimported?: (result: ImportScenesResult) => void;
  } = $props();

  let dialog = $state<HTMLDialogElement>();
  let fileInput = $state<HTMLInputElement>();
  let importState = $state<'idle' | 'reading' | 'ready' | 'importing' | 'error'>('idle');
  let result = $state<PortableImportResult | null>(null);
  let filename = $state('');
  let error = $state('');
  let issues = $state<string[]>([]);
  let strategy = $state<ImportConflictStrategy>('rename');
  let dragActive = $state(false);

  $effect(() => {
    if (visible && dialog && !dialog.open) queueMicrotask(() => dialog?.showModal());
    else if (!visible && dialog?.open) dialog.close();
  });

  function reset() {
    importState = 'idle';
    result = null;
    filename = '';
    error = '';
    issues = [];
    strategy = 'rename';
    dragActive = false;
    if (fileInput) fileInput.value = '';
  }

  function handleClose() {
    if (importState === 'reading' || importState === 'importing') return;
    reset();
    onclose();
  }

  async function inspectFile(file: File | undefined) {
    if (!file) return;
    filename = file.name;
    importState = 'reading';
    error = '';
    issues = [];
    result = null;
    try {
      result = await importPortableBytes(new Uint8Array(await file.arrayBuffer()), file.name);
      importState = 'ready';
    } catch (candidate) {
      importState = 'error';
      error =
        candidate instanceof Error ? candidate.message : 'Studio could not inspect this file.';
      issues = candidate instanceof PortableFileError ? [...candidate.issues] : [];
    }
  }

  async function applyImport() {
    if (!result) return;
    importState = 'importing';
    error = '';
    issues = [];
    try {
      const imported = await studioSceneLibrary.importScenes(
        result.scenes,
        strategy,
        result.project,
      );
      onimported?.(imported);
      dialog?.close();
      if (imported.imported.length === 1) {
        await goto(`/scenes/${encodeURIComponent(imported.imported[0]!.id)}`);
      } else {
        await goto('/catalog');
      }
    } catch (candidate) {
      importState = 'error';
      error = candidate instanceof Error ? candidate.message : 'The import could not be saved.';
    }
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="import-scene-title"
  onclose={handleClose}
  oncancel={(event) => {
    if (importState === 'reading' || importState === 'importing') event.preventDefault();
  }}
>
  <div class="dialog-head">
    <div>
      <h2 id="import-scene-title">Import Scenes or a project</h2>
    </div>
    <button
      class="icon-button"
      type="button"
      aria-label="Close"
      disabled={importState === 'reading' || importState === 'importing'}
      onclick={() => dialog?.close()}
    >
      <Icon name="close" />
    </button>
  </div>

  {#if importState === 'idle' || importState === 'reading'}
    <p>
      Studio validates canonical YAML, archive paths, expansion limits, asset byte lengths, and
      SHA-256 integrity before anything enters the local catalog.
    </p>
    <label
      class="drop-zone"
      class:active={dragActive}
      ondragenter={(event) => {
        event.preventDefault();
        dragActive = true;
      }}
      ondragover={(event) => event.preventDefault()}
      ondragleave={() => (dragActive = false)}
      ondrop={(event) => {
        event.preventDefault();
        dragActive = false;
        void inspectFile(event.dataTransfer?.files[0]);
      }}
    >
      <input
        bind:this={fileInput}
        class="sr-only"
        type="file"
        accept=".yaml,.yml,.zip,application/yaml,application/zip"
        onchange={(event) => void inspectFile(event.currentTarget.files?.[0])}
      />
      <span class="file-mark"><Icon name="download" size={22} /></span>
      <strong
        >{importState === 'reading'
          ? `Inspecting ${filename}…`
          : 'Choose or drop a portable file'}</strong
      >
      <small>Scene YAML, project YAML, Scene ZIP, or project ZIP</small>
    </label>
  {:else if importState === 'ready' && result}
    <section class="file-summary" aria-live="polite">
      <span class="file-mark"><Icon name="check" size={22} /></span>
      <div>
        <strong>{filename}</strong>
        <small
          >Valid {result.kind} · {result.scenes.length} Scene{result.scenes.length === 1
            ? ''
            : 's'}{result.project ? ` · ${result.project.name}` : ''}</small
        >
      </div>
      <button class="button" type="button" onclick={reset}>Choose another</button>
    </section>

    {#if result.warnings.length}
      <div class="warning-box">
        {#each result.warnings as warning}<span><Icon name="warning" size={14} />{warning}</span
          >{/each}
      </div>
    {/if}

    {#if result.scenes.length}
      <fieldset>
        <legend>If a Scene ID already exists</legend>
        <label
          ><input type="radio" bind:group={strategy} value="rename" /> Keep both and rename imported</label
        >
        <label
          ><input type="radio" bind:group={strategy} value="replace" /> Replace the local Scene</label
        >
        <label
          ><input type="radio" bind:group={strategy} value="skip" /> Skip conflicting Scenes</label
        >
      </fieldset>
    {/if}
  {:else}
    <section class="error-box" role="alert">
      <span class="file-mark"><Icon name="warning" size={22} /></span>
      <div>
        <strong>{error}</strong>
        {#if issues.length}
          <ul>
            {#each issues as issue}<li>{issue}</li>{/each}
          </ul>
        {/if}
      </div>
    </section>
    <button class="button" type="button" onclick={reset}>Choose another file</button>
  {/if}

  <div class="dialog-actions">
    <button
      class="button"
      type="button"
      disabled={importState === 'reading' || importState === 'importing'}
      onclick={() => dialog?.close()}>Cancel</button
    >
    {#if importState === 'ready'}
      <button class="button primary" type="button" onclick={applyImport}>
        <Icon name="download" size={15} />Import {result?.scenes.length || result?.project
          ? 'source'
          : ''}
      </button>
    {:else if importState === 'importing'}
      <button class="button primary" type="button" disabled>Importing…</button>
    {/if}
  </div>
</dialog>

<style>
  dialog {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 6px 8px rgba(25, 24, 22, 0.18);
    color: var(--ink);
    max-height: min(760px, calc(100dvh - 28px));
    max-width: min(620px, calc(100vw - 28px));
    overflow: auto;
    padding: 20px;
    width: 100%;
  }
  dialog::backdrop {
    background: rgba(25, 24, 22, 0.46);
  }
  .dialog-head {
    align-items: start;
    display: flex;
    justify-content: space-between;
  }
  h2 {
    font-size: 1.3rem;
    letter-spacing: -0.035em;
    margin: 4px 0 0;
  }
  dialog > p {
    color: var(--muted);
    font-size: 0.76rem;
    line-height: 1.55;
    margin: 12px 0 18px;
  }
  .drop-zone {
    align-items: center;
    background: var(--paper);
    border: 1px dashed var(--line-strong);
    border-radius: 12px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 220px;
    padding: 24px;
    text-align: center;
  }
  .drop-zone:hover,
  .drop-zone.active,
  .drop-zone:focus-within {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  .file-mark {
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
    color: var(--accent);
    display: flex;
    height: 48px;
    justify-content: center;
    margin-bottom: 11px;
    width: 48px;
  }
  .drop-zone strong,
  .file-summary strong,
  .error-box strong {
    font-size: 0.8rem;
  }
  .drop-zone small,
  .file-summary small {
    color: var(--muted);
    font-size: 0.72rem;
    margin-top: 4px;
  }
  .file-summary,
  .error-box {
    align-items: center;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 10px;
    display: grid;
    gap: 12px;
    grid-template-columns: auto 1fr auto;
    margin-top: 18px;
    padding: 12px;
  }
  .file-summary .file-mark,
  .error-box .file-mark {
    margin: 0;
  }
  .file-summary strong,
  .file-summary small {
    display: block;
  }
  .warning-box {
    background: var(--changed-soft);
    border: 1px solid #dfc589;
    border-radius: 8px;
    color: var(--changed);
    display: grid;
    font-size: 0.72rem;
    gap: 5px;
    margin-top: 10px;
    padding: 10px;
  }
  .warning-box span {
    align-items: center;
    display: flex;
    gap: 6px;
  }
  fieldset {
    border: 1px solid var(--line);
    border-radius: 9px;
    display: grid;
    gap: 8px;
    margin: 12px 0 0;
    padding: 12px;
  }
  legend {
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0 5px;
  }
  fieldset label {
    align-items: center;
    display: flex;
    font-size: 0.7rem;
    gap: 8px;
    min-height: 30px;
  }
  fieldset input {
    accent-color: var(--accent);
  }
  .error-box {
    align-items: start;
    background: var(--broken-soft);
    border-color: color-mix(in srgb, var(--broken) 30%, transparent);
    grid-template-columns: auto 1fr;
  }
  .error-box .file-mark {
    color: var(--broken);
  }
  .error-box ul {
    color: var(--muted);
    font-size: 0.72rem;
    margin: 7px 0 0;
    max-height: 140px;
    overflow: auto;
    padding-left: 18px;
  }
  .dialog-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 18px;
  }
  @media (max-width: 520px) {
    .file-summary {
      grid-template-columns: auto 1fr;
    }
    .file-summary .button {
      grid-column: 1 / -1;
    }
  }
  @media (pointer: coarse) {
    .button,
    .icon-button,
    fieldset label {
      min-height: 44px;
    }
    .icon-button {
      min-width: 44px;
    }
  }
</style>
