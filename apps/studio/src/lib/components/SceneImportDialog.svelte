<script lang="ts">
  import { goto } from '$app/navigation';
  import { importPortableBytes, PortableFileError, type PortableImportResult } from '../portable';
  import {
    studioSceneLibrary,
    type ImportConflictStrategy,
    type ImportScenesResult,
  } from '../scene-library';
  import { trapDialogFocus } from '../dialog-focus';
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

  function reset(focusPicker = false) {
    importState = 'idle';
    result = null;
    filename = '';
    error = '';
    issues = [];
    strategy = 'rename';
    dragActive = false;
    if (fileInput) fileInput.value = '';
    if (focusPicker) queueMicrotask(() => fileInput?.focus({ preventScroll: true }));
  }

  function handleClose() {
    if (importState === 'reading' || importState === 'importing') return;
    reset();
    onclose();
  }

  async function inspectFile(file: File | undefined) {
    if (!file || importState === 'reading' || importState === 'importing') return;
    filename = file.name;
    importState = 'reading';
    error = '';
    issues = [];
    result = null;
    queueMicrotask(() => dialog?.focus({ preventScroll: true }));
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
    if (!result || importState !== 'ready') return;
    importState = 'importing';
    error = '';
    issues = [];
    queueMicrotask(() => dialog?.focus({ preventScroll: true }));
    try {
      const imported = await studioSceneLibrary.importScenes(
        result.scenes,
        strategy,
        result.project,
      );
      importState = 'ready';
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
  tabindex="-1"
  aria-labelledby="import-scene-title"
  aria-busy={importState === 'reading' || importState === 'importing'}
  onkeydown={(event) => trapDialogFocus(event, dialog)}
  onclose={handleClose}
  oncancel={(event) => {
    if (importState === 'reading' || importState === 'importing') event.preventDefault();
  }}
>
  <div class="dialog-head">
    <div>
      <h2 id="import-scene-title">Import scenes or a project</h2>
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
    <p>Choose a Scenebook YAML or ZIP. Studio checks it before saving anything.</p>
    <details class="validation-details">
      <summary>What Studio validates</summary>
      <p>
        File structure, archive paths and limits, asset sizes, source format, and file integrity.
      </p>
    </details>
    <label
      class="drop-zone"
      class:active={dragActive}
      aria-disabled={importState === 'reading'}
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
        disabled={importState === 'reading'}
        accept=".yaml,.yml,.zip,application/yaml,application/zip"
        onchange={(event) => void inspectFile(event.currentTarget.files?.[0])}
      />
      <span class="file-mark"><Icon name="download" size={22} /></span>
      <strong
        >{importState === 'reading'
          ? `Inspecting ${filename}…`
          : 'Choose or drop a portable file'}</strong
      >
      <small>Scene YAML, project YAML, scene ZIP, or project ZIP</small>
    </label>
  {:else if (importState === 'ready' || importState === 'importing') && result}
    <section class="file-summary" aria-live="polite">
      <span class="file-mark"><Icon name="check" size={22} /></span>
      <div>
        <strong>{filename}</strong>
        <small
          >Valid {result.kind} · {result.scenes.length} scene{result.scenes.length === 1
            ? ''
            : 's'}{result.project ? ` · ${result.project.name}` : ''}</small
        >
      </div>
      <button
        class="button"
        type="button"
        disabled={importState === 'importing'}
        onclick={() => reset(true)}>Choose another</button
      >
    </section>

    {#if result.warnings.length}
      <div class="warning-box">
        {#each result.warnings as warning}<span><Icon name="warning" size={14} />{warning}</span
          >{/each}
      </div>
    {/if}

    {#if result.scenes.length}
      <fieldset>
        <legend>If a scene ID already exists</legend>
        <label
          ><input
            type="radio"
            bind:group={strategy}
            value="rename"
            disabled={importState === 'importing'}
          /> Keep both and rename imported</label
        >
        <label
          ><input
            type="radio"
            bind:group={strategy}
            value="replace"
            disabled={importState === 'importing'}
          /> Replace the local scene</label
        >
        <label
          ><input
            type="radio"
            bind:group={strategy}
            value="skip"
            disabled={importState === 'importing'}
          /> Skip conflicting scenes</label
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
    <button class="button" type="button" onclick={() => reset(true)}>Choose another file</button>
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
    background: var(--backdrop);
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
    font-size: 0.84rem;
    line-height: 1.55;
    margin: 12px 0 18px;
  }
  .validation-details {
    color: var(--muted);
    font-size: 0.8rem;
    margin: -8px 0 18px;
  }
  .validation-details summary {
    cursor: pointer;
    font-weight: 650;
    min-height: 40px;
    padding-block: 9px;
  }
  .validation-details p {
    line-height: 1.55;
    margin: 2px 0 0;
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
    font-size: 0.75rem;
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
    border: 1px solid color-mix(in srgb, var(--changed) 32%, var(--line));
    border-radius: 8px;
    color: var(--changed);
    display: grid;
    font-size: 0.75rem;
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
    font-size: 0.75rem;
    font-weight: 700;
    padding: 0 5px;
  }
  fieldset label {
    align-items: center;
    display: flex;
    font-size: 0.82rem;
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
    font-size: 0.75rem;
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
