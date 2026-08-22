<script lang="ts">
  import {
    activateHostedWorkspace,
    disconnectHostedWorkspace,
    hostedSessionCredential,
    openHostedSession,
    readHostedWorkspace,
    type HostedConnectionCandidate,
  } from '../hosted-workspace';
  import Icon from './Icon.svelte';

  let binding = $state(readHostedWorkspace());
  let token = $state('');
  let candidate = $state<HostedConnectionCandidate | null>(null);
  let selectedProject = $state('');
  let action = $state<'connect' | 'disconnect' | null>(null);
  let error = $state('');
  let status = $state('');

  async function connect() {
    if (action) return;
    const source = token;
    token = '';
    action = 'connect';
    candidate = null;
    error = '';
    status = 'Opening a short-lived browser session…';
    try {
      const next = await openHostedSession(source);
      candidate = next;
      selectedProject =
        binding && next.projects.some((project) => project.id === binding?.projectId)
          ? binding.projectId
          : (next.projects[0]?.id ?? '');
      if (next.projects.length === 1) {
        activateHostedWorkspace(next, selectedProject);
        window.location.reload();
        return;
      }
      status = `Signed in as ${next.userName}. Choose a project.`;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The hosted workspace could not be opened.';
      status = '';
    } finally {
      action = null;
    }
  }

  function chooseProject() {
    if (!candidate || !selectedProject) return;
    activateHostedWorkspace(candidate, selectedProject);
    window.location.reload();
  }

  async function disconnect() {
    if (action) return;
    action = 'disconnect';
    error = '';
    status = 'Returning to this browser’s local workspace…';
    await disconnectHostedWorkspace();
    window.location.reload();
  }
</script>

<section class="surface-card hosted-storage" aria-labelledby="workspace-storage-title">
  <header>
    <div>
      <h2 id="workspace-storage-title">Workspace storage</h2>
      <p>
        {binding
          ? 'Scenes, versions, and project settings are shared through your self-hosted control plane.'
          : 'Local work stays in this browser. Connect only when you want a shared self-hosted workspace.'}
      </p>
    </div>
    <span class:hosted={Boolean(binding)} class="status-chip">
      {binding ? 'self-hosted' : 'this browser'}
    </span>
  </header>

  {#if binding}
    <dl class="workspace-binding">
      <div>
        <dt>Workspace</dt>
        <dd>{binding.workspaceName}</dd>
      </div>
      <div>
        <dt>Project</dt>
        <dd>{binding.projectName}</dd>
      </div>
      <div>
        <dt>Browser session</dt>
        <dd>{hostedSessionCredential() ? 'Available in this tab' : 'Reconnect required'}</dd>
      </div>
    </dl>
    <div class="workspace-actions">
      <details>
        <summary class="button">Reconnect or switch project</summary>
        <form
          class="connection-form"
          onsubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <label class="field">
            <span class="field-label">Personal API token</span>
            <input
              class="input mono"
              type="password"
              autocomplete="off"
              bind:value={token}
              required
              placeholder="sbk_…"
            />
            <small>The token is exchanged once and cleared immediately.</small>
          </label>
          <button class="button" type="submit" disabled={Boolean(action)}>
            {action === 'connect' ? 'Connecting…' : 'Open session'}
          </button>
        </form>
      </details>
      <button class="button danger" type="button" disabled={Boolean(action)} onclick={disconnect}>
        {action === 'disconnect' ? 'Disconnecting…' : 'Use local workspace'}
      </button>
    </div>
  {:else}
    <form
      class="connection-form"
      onsubmit={(event) => {
        event.preventDefault();
        void connect();
      }}
    >
      <label class="field">
        <span class="field-label">Personal API token</span>
        <input
          class="input mono"
          type="password"
          autocomplete="off"
          bind:value={token}
          required
          placeholder="sbk_…"
        />
        <small>
          Use an Owner or Editor token with workspace read, project read, and project write. The
          operator token never belongs in Studio.
        </small>
      </label>
      <button class="button" type="submit" disabled={Boolean(action)}>
        <Icon name="lock" size={15} />{action === 'connect'
          ? 'Connecting…'
          : 'Connect self-hosted workspace'}
      </button>
    </form>
  {/if}

  {#if candidate && candidate.projects.length > 1}
    <div class="project-choice">
      <label class="field">
        <span class="field-label">Project</span>
        <select class="select" bind:value={selectedProject}>
          {#each candidate.projects as project}
            <option value={project.id}>{project.name}</option>
          {/each}
        </select>
      </label>
      <button class="button primary" type="button" onclick={chooseProject}>Open project</button>
    </div>
  {/if}

  {#if status}<p class="connection-status" role="status">{status}</p>{/if}
  {#if error}<p class="connection-error" role="alert">{error}</p>{/if}
</section>

<style>
  .hosted-storage {
    overflow: hidden;
  }
  .hosted-storage > header {
    align-items: flex-start;
    border-bottom: 1px solid var(--line);
    display: flex;
    gap: 20px;
    justify-content: space-between;
    padding: 18px 19px;
  }
  h2,
  p {
    margin: 0;
  }
  header p {
    color: var(--muted);
    font-size: 0.82rem;
    line-height: 1.55;
    margin-top: 5px;
    max-width: 68ch;
  }
  .status-chip.hosted {
    color: var(--success);
  }
  .connection-form,
  .project-choice {
    align-items: end;
    display: grid;
    gap: 12px;
    grid-template-columns: minmax(240px, 1fr) auto;
    padding: 18px 19px;
  }
  .connection-form small {
    color: var(--muted);
    display: block;
    font-size: 0.75rem;
    line-height: 1.45;
    margin-top: 6px;
  }
  .workspace-binding {
    display: grid;
    gap: 0;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin: 0;
    padding: 6px 19px;
  }
  .workspace-binding div {
    min-width: 0;
    padding: 12px 0;
  }
  .workspace-binding dt {
    color: var(--muted);
    font-size: 0.75rem;
  }
  .workspace-binding dd {
    font-size: 0.86rem;
    font-weight: 650;
    margin: 4px 0 0;
    overflow-wrap: anywhere;
  }
  .workspace-actions {
    align-items: center;
    border-top: 1px solid var(--line);
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: space-between;
    padding: 14px 19px;
  }
  .workspace-actions details {
    min-width: min(100%, 420px);
  }
  .workspace-actions summary {
    display: inline-flex;
    list-style: none;
  }
  .workspace-actions summary::-webkit-details-marker {
    display: none;
  }
  .workspace-actions details[open] .connection-form {
    grid-template-columns: 1fr auto;
    padding: 14px 0 0;
  }
  .project-choice {
    border-top: 1px solid var(--line);
  }
  .connection-status,
  .connection-error {
    border-top: 1px solid var(--line);
    font-size: 0.8rem;
    line-height: 1.5;
    padding: 12px 19px;
  }
  .connection-status {
    color: var(--muted);
  }
  .connection-error {
    color: var(--danger);
  }
  @media (max-width: 720px) {
    .hosted-storage > header,
    .workspace-actions {
      align-items: stretch;
      flex-direction: column;
    }
    .connection-form,
    .project-choice,
    .workspace-actions details[open] .connection-form {
      align-items: stretch;
      grid-template-columns: 1fr;
    }
    .workspace-binding {
      grid-template-columns: 1fr;
    }
    .workspace-binding div + div {
      border-top: 1px solid var(--line);
    }
  }
</style>
