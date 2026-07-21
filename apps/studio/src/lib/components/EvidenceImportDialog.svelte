<script lang="ts">
  import {
    EvidenceImportError,
    inspectEvidenceFiles,
    type EvidenceImportInspection,
  } from '../evidence';
  import { studioSceneLibrary, type ImportRunEvidenceResult } from '../scene-library';
  import Icon from './Icon.svelte';

  let {
    visible,
    onclose,
    onimported,
  }: {
    visible: boolean;
    onclose: () => void;
    onimported?: (result: ImportRunEvidenceResult) => void;
  } = $props();

  let dialog = $state<HTMLDialogElement>();
  let fileInput = $state<HTMLInputElement>();
  let folderInput = $state<HTMLInputElement>();
  let importState = $state<'idle' | 'reading' | 'ready' | 'importing' | 'error'>('idle');
  let inspection = $state<EvidenceImportInspection | null>(null);
  let filenames = $state<string[]>([]);
  let error = $state('');
  let issues = $state<string[]>([]);
  let dragActive = $state(false);

  let sceneCount = $derived(new Set(inspection?.candidates.map((item) => item.sceneId)).size);
  let reviewCount = $derived(
    inspection?.candidates.filter((item) => Boolean(item.evidence.review)).length ?? 0,
  );
  let verifiedAssetCount = $derived(
    inspection?.candidates.reduce(
      (count, item) => count + item.evidence.verifiedAssetHashes.length,
      0,
    ) ?? 0,
  );
  let missingAssetCount = $derived(
    inspection?.candidates.reduce(
      (count, item) => count + item.evidence.missingAssetHashes.length,
      0,
    ) ?? 0,
  );

  $effect(() => {
    if (visible && dialog && !dialog.open) queueMicrotask(() => dialog?.showModal());
    else if (!visible && dialog?.open) dialog.close();
  });

  function reset() {
    importState = 'idle';
    inspection = null;
    filenames = [];
    error = '';
    issues = [];
    dragActive = false;
    if (fileInput) fileInput.value = '';
    if (folderInput) folderInput.value = '';
  }

  function handleClose() {
    if (importState === 'reading' || importState === 'importing') return;
    reset();
    onclose();
  }

  async function inspect(files: readonly File[]) {
    if (files.length === 0) return;
    filenames = files.map((file) => file.name);
    importState = 'reading';
    inspection = null;
    error = '';
    issues = [];
    try {
      inspection = await inspectEvidenceFiles(files);
      importState = 'ready';
    } catch (candidate) {
      importState = 'error';
      error =
        candidate instanceof Error
          ? candidate.message
          : 'Studio could not inspect this evidence selection.';
      issues = candidate instanceof EvidenceImportError ? [...candidate.issues] : [];
    }
  }

  async function applyImport() {
    if (!inspection) return;
    importState = 'importing';
    error = '';
    issues = [];
    try {
      const imported = await studioSceneLibrary.importRunEvidence(inspection.candidates);
      onimported?.(imported);
      dialog?.close();
    } catch (candidate) {
      importState = 'error';
      error = candidate instanceof Error ? candidate.message : 'Run evidence could not be saved.';
      issues = candidate instanceof EvidenceImportError ? [...candidate.issues] : [];
    }
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="import-evidence-title"
  onclose={handleClose}
  oncancel={(event) => {
    if (importState === 'reading' || importState === 'importing') event.preventDefault();
  }}
>
  <div class="dialog-head">
    <div>
      <h2 id="import-evidence-title">Import Run evidence</h2>
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
      Import a ZIP of <span class="mono">.scenebook/runs</span>, or select Run, Review, optional
      Baseline JSON and referenced screenshots together. Studio validates schemas, exact artifact
      and source revisions, paths, media bytes, and SHA-256 identities before saving.
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
        void inspect([...(event.dataTransfer?.files ?? [])]);
      }}
    >
      <input
        bind:this={fileInput}
        class="sr-only"
        type="file"
        multiple
        accept=".json,.zip,application/json,application/zip,image/png,image/jpeg,image/webp"
        onchange={(event) => void inspect([...(event.currentTarget.files ?? [])])}
      />
      <span class="file-mark"><Icon name="runs" size={22} /></span>
      <strong
        >{importState === 'reading'
          ? `Verifying ${filenames.length} file${filenames.length === 1 ? '' : 's'}…`
          : 'Choose or drop an evidence ZIP or file set'}</strong
      >
      <small>Run JSON is required · Review, Baseline, and screenshots are linked exactly</small>
    </label>
    <div class="folder-row">
      <span>Keeping the generated directory layout?</span>
      <label class="button">
        <input
          bind:this={folderInput}
          class="sr-only"
          type="file"
          multiple
          webkitdirectory={true}
          onchange={(event) => void inspect([...(event.currentTarget.files ?? [])])}
        />
        Choose evidence folder
      </label>
    </div>
  {:else if importState === 'ready' && inspection}
    <section class="file-summary" aria-live="polite">
      <span class="file-mark"><Icon name="check" size={22} /></span>
      <div>
        <strong
          >{inspection.candidates.length} exact Run artifact{inspection.candidates.length === 1
            ? ''
            : 's'}</strong
        >
        <small
          >{sceneCount} Scene{sceneCount === 1 ? '' : 's'} · {reviewCount} Review{reviewCount === 1
            ? ''
            : 's'} · {inspection.buildCount} Build manifest{inspection.buildCount === 1
            ? ''
            : 's'}</small
        >
      </div>
      <button class="button" type="button" onclick={reset}>Choose another</button>
    </section>

    <div class="integrity-grid" aria-label="Evidence integrity summary">
      <span><strong>{verifiedAssetCount}</strong><small>verified screenshots</small></span>
      <span class:warning={missingAssetCount > 0}
        ><strong>{missingAssetCount}</strong><small>remote / missing locally</small></span
      >
      <span
        ><strong>{inspection.candidates.filter((item) => item.evidence.baseline).length}</strong
        ><small>exact Baselines</small></span
      >
    </div>

    <ol class="run-list">
      {#each inspection.candidates as candidate (candidate.evidence.runRevision)}
        <li>
          <span
            class={`status-dot ${candidate.evidence.run.changeState ?? candidate.evidence.run.status}`}
          ></span>
          <span
            ><strong>{candidate.evidence.run.sceneId}</strong><small
              >{candidate.evidence.run.id} · {candidate.evidence.run.runTargetId} · {candidate
                .evidence.run.durationMs}ms</small
            ></span
          >
          <code>{candidate.evidence.runRevision.slice(0, 10)}</code>
        </li>
      {/each}
    </ol>

    {#if inspection.warnings.length}
      <div class="warning-box">
        {#each inspection.warnings as warning}<span><Icon name="warning" size={14} />{warning}</span
          >{/each}
      </div>
    {/if}
  {:else}
    <section class="error-box" role="alert">
      <span class="file-mark"><Icon name="warning" size={22} /></span>
      <div>
        <strong>{error}</strong>
        {#if issues.length}<ul>
            {#each issues as issue}<li>{issue}</li>{/each}
          </ul>{/if}
      </div>
    </section>
    <button class="button" type="button" onclick={reset}>Choose another file set</button>
  {/if}

  <div class="dialog-actions">
    <button
      class="button"
      type="button"
      disabled={importState === 'reading' || importState === 'importing'}
      onclick={() => dialog?.close()}>Cancel</button
    >
    {#if importState === 'ready'}
      <button class="button primary" type="button" onclick={applyImport}
        ><Icon name="download" size={15} />Attach verified evidence</button
      >
    {:else if importState === 'importing'}
      <button class="button primary" type="button" disabled>Saving atomically…</button>
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
    max-height: min(820px, calc(100dvh - 28px));
    max-width: min(680px, calc(100vw - 28px));
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
    font-size: 0.75rem;
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
    min-height: 218px;
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
    display: block;
    font-size: 0.72rem;
    margin-top: 4px;
  }
  .folder-row {
    align-items: center;
    color: var(--muted);
    display: flex;
    font-size: 0.72rem;
    justify-content: space-between;
    padding: 9px 2px 0;
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
  .integrity-grid {
    display: grid;
    gap: 8px;
    grid-template-columns: repeat(3, 1fr);
    margin-top: 10px;
  }
  .integrity-grid span {
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 10px;
  }
  .integrity-grid strong,
  .integrity-grid small {
    display: block;
  }
  .integrity-grid strong {
    font-size: 0.9rem;
  }
  .integrity-grid small {
    color: var(--muted);
    font-size: 0.72rem;
    margin-top: 2px;
  }
  .integrity-grid .warning {
    background: var(--changed-soft);
    border-color: #dfc589;
  }
  .run-list {
    border: 1px solid var(--line);
    border-radius: 9px;
    list-style: none;
    margin: 10px 0 0;
    max-height: 210px;
    overflow: auto;
    padding: 0;
  }
  .run-list li {
    align-items: center;
    border-top: 1px solid var(--line);
    display: grid;
    gap: 9px;
    grid-template-columns: auto 1fr auto;
    padding: 9px 11px;
  }
  .run-list li:first-child {
    border-top: 0;
  }
  .run-list strong,
  .run-list small {
    display: block;
  }
  .run-list strong {
    font-size: 0.72rem;
  }
  .run-list small,
  .run-list code {
    color: var(--muted);
    font-size: 0.72rem;
  }
  .status-dot {
    background: var(--pass);
    border-radius: 50%;
    height: 8px;
    width: 8px;
  }
  .status-dot.changed,
  .status-dot.failed {
    background: var(--changed);
  }
  .status-dot.broken,
  .status-dot.blocked {
    background: var(--broken);
  }
  .warning-box {
    background: var(--changed-soft);
    border: 1px solid #dfc589;
    border-radius: 8px;
    color: var(--changed);
    display: grid;
    font-size: 0.72rem;
    gap: 6px;
    margin-top: 10px;
    padding: 10px;
  }
  .warning-box span {
    align-items: start;
    display: flex;
    gap: 6px;
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
    max-height: 150px;
    overflow: auto;
    padding-left: 18px;
  }
  .dialog-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 18px;
  }
  @media (max-width: 560px) {
    .file-summary {
      grid-template-columns: auto 1fr;
    }
    .file-summary .button {
      grid-column: 1 / -1;
    }
    .integrity-grid {
      grid-template-columns: 1fr;
    }
    .folder-row {
      align-items: stretch;
      flex-direction: column;
      gap: 7px;
    }
  }
  @media (pointer: coarse) {
    .button,
    .icon-button {
      min-height: 44px;
    }
    .icon-button {
      min-width: 44px;
    }
  }
</style>
