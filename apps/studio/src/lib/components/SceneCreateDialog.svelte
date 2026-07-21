<script lang="ts">
  import { goto } from '$app/navigation';

  import { studioSceneLibrary } from '../scene-library';
  import { trapDialogFocus } from '../dialog-focus';
  import Icon from './Icon.svelte';

  let {
    visible,
    onclose,
    oncreated,
  }: { visible: boolean; onclose: () => void; oncreated?: (id: string) => void } = $props();

  let dialog = $state<HTMLDialogElement>();
  let titleInput = $state<HTMLInputElement>();
  let title = $state('');
  let description = $state('');
  let error = $state('');
  let saving = $state(false);

  $effect(() => {
    if (visible && dialog && !dialog.open) {
      queueMicrotask(() => {
        dialog?.showModal();
        titleInput?.focus();
      });
    } else if (!visible && dialog?.open) {
      dialog.close();
    }
  });

  function handleClose() {
    if (saving) return;
    title = '';
    description = '';
    error = '';
    onclose();
  }

  async function createScene() {
    if (saving) return;
    const nextTitle = title.trim();
    const nextDescription = description.trim();
    if (!nextTitle) {
      error = 'Give the scene a title.';
      titleInput?.focus();
      return;
    }
    saving = true;
    error = '';
    queueMicrotask(() => dialog?.focus({ preventScroll: true }));
    try {
      const scene = await studioSceneLibrary.create(nextTitle);
      if (nextDescription) {
        scene.description = nextDescription;
        await studioSceneLibrary.save(scene);
      }
      saving = false;
      oncreated?.(scene.id);
      dialog?.close();
      await goto(`/scenes/${encodeURIComponent(scene.id)}`);
    } catch (candidate) {
      error = candidate instanceof Error ? candidate.message : 'The scene could not be created.';
    } finally {
      saving = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  tabindex="-1"
  aria-labelledby="create-scene-title"
  aria-busy={saving}
  onkeydown={(event) => trapDialogFocus(event, dialog)}
  onclose={handleClose}
  oncancel={(event) => {
    if (saving) event.preventDefault();
  }}
>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void createScene();
    }}
  >
    <div class="dialog-head">
      <div>
        <h2 id="create-scene-title">Create a scene</h2>
      </div>
      <button
        class="icon-button"
        type="button"
        aria-label="Close"
        disabled={saving}
        onclick={() => dialog?.close()}
      >
        <Icon name="close" />
      </button>
    </div>
    <p>Name the product outcome you want to document.</p>
    <label class="field">
      <span class="field-label">Scene name</span>
      <input
        bind:this={titleInput}
        bind:value={title}
        class="input"
        maxlength="500"
        autocomplete="off"
        disabled={saving}
        placeholder="Invite a teammate"
      />
    </label>
    <label class="field">
      <span class="field-label">Description <small>Optional</small></span>
      <textarea
        bind:value={description}
        class="textarea"
        maxlength="10000"
        disabled={saving}
        placeholder="What will someone learn or accomplish?"></textarea>
    </label>
    {#if error}<div class="dialog-error" role="alert">{error}</div>{/if}
    <div class="dialog-actions">
      <button class="button" type="button" disabled={saving} onclick={() => dialog?.close()}>
        Cancel
      </button>
      <button class="button primary" type="submit" disabled={saving}>
        <Icon name="plus" size={15} />{saving ? 'Creating…' : 'Create scene'}
      </button>
    </div>
  </form>
</dialog>

<style>
  dialog {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 6px 8px rgba(25, 24, 22, 0.18);
    color: var(--ink);
    max-width: min(520px, calc(100vw - 28px));
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
  form > p {
    color: var(--muted);
    font-size: 0.84rem;
    line-height: 1.55;
    margin: 12px 0 18px;
  }
  .field + .field {
    margin-top: 12px;
  }
  .field-label small {
    color: var(--faint);
    font-size: 0.9em;
    font-weight: 500;
  }
  .dialog-error {
    background: var(--broken-soft);
    border: 1px solid color-mix(in srgb, var(--broken) 32%, transparent);
    border-radius: 8px;
    color: var(--broken);
    font-size: 0.82rem;
    margin-top: 12px;
    padding: 9px 10px;
  }
  .dialog-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 18px;
  }
  @media (pointer: coarse) {
    .button,
    .icon-button,
    .input {
      min-height: 44px;
    }
    .icon-button {
      min-width: 44px;
    }
  }
</style>
