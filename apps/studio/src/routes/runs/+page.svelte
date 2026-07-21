<script lang="ts">
  import { onMount } from 'svelte';
  import type { Project } from '@scenebook/schema';

  import AppShell from '$lib/components/AppShell.svelte';
  import EvidenceImportDialog from '$lib/components/EvidenceImportDialog.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { effectiveLocalProject } from '$lib/project-surfaces';
  import {
    studioSceneLibrary,
    type ImportRunEvidenceResult,
    type SceneSummary,
  } from '$lib/scene-library';

  type RunFilter = 'all' | 'passed' | 'changed' | 'attention' | 'missing';

  let scenes = $state<SceneSummary[]>([]);
  let project = $state<Project | null>(null);
  let loadState = $state<'loading' | 'ready' | 'error'>('loading');
  let error = $state('');
  let success = $state('');
  let filter = $state<RunFilter>('all');
  let copied = $state('');
  let importVisible = $state(false);

  let targets = $derived(project?.runTargets ?? []);
  let runs = $derived(scenes.flatMap((scene) => scene.evidenceRuns.map((run) => ({ scene, run }))));
  let visibleRuns = $derived(
    runs.filter(({ run }) => {
      if (filter === 'passed') return run.changeState === 'passed';
      if (filter === 'changed') return run.changeState === 'changed';
      if (filter === 'attention') return ['broken', 'blocked'].includes(run.changeState);
      return filter !== 'missing';
    }),
  );
  let missingScenes = $derived(
    filter === 'missing'
      ? scenes.filter((scene) => scene.evidenceRuns.length === 0 || scene.sample)
      : [],
  );

  async function loadRuns() {
    loadState = 'loading';
    error = '';
    try {
      const [nextScenes, persisted] = await Promise.all([
        studioSceneLibrary.list(),
        studioSceneLibrary.loadProject(),
      ]);
      scenes = nextScenes;
      project = effectiveLocalProject(persisted, nextScenes);
      loadState = 'ready';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Local Run evidence could not be read.';
      loadState = 'error';
    }
  }

  function imported(result: ImportRunEvidenceResult) {
    success = `${result.runCount} exact Run${result.runCount === 1 ? '' : 's'} attached across ${result.scenes.length} Scene${result.scenes.length === 1 ? '' : 's'}.`;
    void loadRuns();
  }

  async function copyCommand(targetId: string) {
    error = '';
    try {
      await navigator.clipboard.writeText(
        `bunx --bun @scenebook/cli@0.1.0 ci --target ${targetId}`,
      );
      copied = targetId;
      setTimeout(() => {
        if (copied === targetId) copied = '';
      }, 1_500);
    } catch {
      error = 'Clipboard access was denied. Select the command manually.';
    }
  }

  function environmentName(id: string) {
    return project?.environments.find((environment) => environment.id === id)?.name ?? id;
  }

  function targetDetail(target: Project['runTargets'][number]) {
    const variant = project?.productVariants.find(
      (candidate) => candidate.id === target.productVariantId,
    );
    const profile = project?.captureProfiles.find(
      (candidate) => candidate.id === target.captureProfileId,
    );
    return [
      variant?.name ?? target.productVariantId,
      profile?.name ?? target.captureProfileId,
    ].join(' · ');
  }

  function ageLabel(endedAt: string) {
    const days = Math.max(0, Math.floor((Date.now() - Date.parse(endedAt)) / 86_400_000));
    return days === 0 ? 'today' : `${days}d old`;
  }

  function durationLabel(milliseconds: number) {
    return milliseconds < 1_000
      ? `${milliseconds}ms`
      : `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
  }

  onMount(() => {
    importVisible = new URL(window.location.href).searchParams.get('action') === 'import';
    void loadRuns();
  });
</script>

<svelte:head><title>Runs · Scenebook</title></svelte:head>

<AppShell active="runs">
  <div class="project-page runs-page">
    <header class="surface-header">
      <div>
        <h1>Runs</h1>
        <p>Inspect imported test results, screenshots, and review changes.</p>
      </div>
      <div class="surface-actions">
        <button class="button primary" type="button" onclick={() => (importVisible = true)}
          ><Icon name="download" size={15} />Import run evidence</button
        >
      </div>
    </header>

    {#if success}<p class="surface-success" role="status">{success}</p>{/if}
    {#if error}<p class="surface-error" role="alert">{error}</p>{/if}

    <details class="targets">
      <summary>
        <div>
          <strong>Run from the CLI</strong>
          <span>Commands for the targets configured in this project</span>
        </div>
        <span>{targets.length} {targets.length === 1 ? 'target' : 'targets'}</span>
      </summary>
      <div class="target-content">
        {#if loadState === 'loading'}
          <div class="surface-state" aria-busy="true">
            <Icon name="clock" />
            <div><strong>Reading project configuration…</strong></div>
          </div>
        {:else if targets.length === 0}
          <div class="surface-state">
            <Icon name="runs" />
            <div>
              <strong>No run targets configured</strong><small
                >Import a project archive or configure targets in project.yaml.</small
              >
            </div>
            <a class="button" href="/settings">Project settings</a>
          </div>
        {:else}
          <div class="target-grid">
            {#each targets as target (target.id)}
              <article class="surface-card">
                <div>
                  <span class="status-chip {target.enabled ? 'ready' : 'stale'}"
                    >{target.enabled ? 'enabled' : 'disabled'}</span
                  >
                  <h3>{target.name}</h3>
                  <p>{environmentName(target.environmentId)} · {targetDetail(target)}</p>
                </div>
                <code>bunx --bun @scenebook/cli@0.1.0 ci --target {target.id}</code>
                <button
                  class="button"
                  type="button"
                  disabled={!target.enabled}
                  onclick={() => copyCommand(target.id)}
                  >{copied === target.id ? 'Copied' : 'Copy command'}</button
                >
              </article>
            {/each}
          </div>
        {/if}
      </div>
    </details>

    <section class="evidence" aria-labelledby="evidence-title">
      <div class="section-title">
        <div>
          <h2 id="evidence-title">Run history</h2>
          <p>{runs.length} imported {runs.length === 1 ? 'run' : 'runs'}</p>
        </div>
        <label class="run-filter">
          <span class="sr-only">Filter run evidence</span>
          <select bind:value={filter} aria-label="Filter run evidence">
            <option value="all">All runs</option>
            <option value="passed">Passed</option>
            <option value="changed">Changed</option>
            <option value="attention">Broken or blocked</option>
            <option value="missing">Scenes without evidence</option>
          </select>
        </label>
      </div>

      {#if loadState === 'error'}
        <div class="surface-state">
          <Icon name="warning" />
          <div><strong>Run evidence is unavailable</strong><small>{error}</small></div>
          <button class="button" type="button" onclick={loadRuns}>Try again</button>
        </div>
      {:else if loadState === 'loading'}
        <div class="surface-state" aria-busy="true">
          <Icon name="clock" />
          <div>
            <strong>Reading attached evidence…</strong><small>No replay is being performed.</small>
          </div>
        </div>
      {:else if filter === 'missing' && missingScenes.length > 0}
        <div class="missing-grid">
          {#each missingScenes as scene (scene.id)}
            <article class="surface-card missing-card">
              <div>
                <strong>{scene.title}</strong><small
                  >{scene.sample ? 'Synthetic fixture' : `${scene.capability} source`} · r{scene.revision}</small
                >
              </div>
              <span class="status-chip stale">not attached</span>
              <a class="button" href={`/scenes/${encodeURIComponent(scene.id)}?tab=health`}
                >Inspect source</a
              >
            </article>
          {/each}
        </div>
      {:else if visibleRuns.length === 0}
        <div class="surface-state">
          <Icon name="runs" />
          <div>
            <strong>No matching evidence</strong><small
              >{runs.length
                ? 'Choose another filter.'
                : 'Import a generated Run directory or evidence ZIP to attach real execution results.'}</small
            >
          </div>
          <button class="button" type="button" onclick={() => (importVisible = true)}
            >Import evidence</button
          >
        </div>
      {:else}
        <div class="run-list">
          {#each visibleRuns as row (`${row.scene.id}:${row.run.runRevision}`)}
            <article class="surface-card run-card">
              <div class="run-heading">
                <div>
                  <span class={`status-chip ${row.run.changeState}`}
                    ><span class="status-dot"></span>{row.run.changeState}</span
                  >
                  <h3>{row.scene.title}</h3>
                  <p>
                    {new Date(row.run.endedAt).toLocaleString()} · {row.run.runTargetId}
                  </p>
                </div>
                <a
                  class="button"
                  href={`/scenes/${encodeURIComponent(row.scene.id)}?tab=health&run=${encodeURIComponent(row.run.runRevision)}`}
                  >Inspect evidence</a
                >
              </div>
              <div class="run-facts">
                <span
                  ><small>Duration</small><strong>{durationLabel(row.run.durationMs)}</strong></span
                >
                <span
                  ><small>Results</small><strong
                    >{row.run.checkCount - row.run.failedCheckCount}/{row.run.checkCount} checks · {row
                      .run.errorCount} errors</strong
                  ></span
                >
                <span
                  ><small>Review</small><strong
                    >{row.run.review
                      ? `${row.run.review.changes.length} changes · ${row.run.review.status}`
                      : 'Not included'}</strong
                  ></span
                >
              </div>
              <details class="run-details">
                <summary>Run details</summary>
                <dl>
                  <div>
                    <dt>Run</dt>
                    <dd class="mono">{row.run.runId}</dd>
                  </div>
                  <div>
                    <dt>Revision</dt>
                    <dd class="mono">{row.run.runRevision.slice(0, 12)}</dd>
                  </div>
                  <div>
                    <dt>Target</dt>
                    <dd>{row.run.runTargetId}</dd>
                  </div>
                  <div>
                    <dt>Visual states</dt>
                    <dd>{row.run.stateCount} captured · {row.run.verifiedAssetCount} local</dd>
                  </div>
                  <div>
                    <dt>Privacy</dt>
                    <dd>{row.run.privacyStatus}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd class="mono">
                      {row.run.repository}@{row.run.commit}{row.run.dirty ? ' (dirty)' : ''}
                    </dd>
                  </div>
                </dl>
                <p>
                  Completed {ageLabel(row.run.endedAt)}.
                  {#if row.run.missingAssetCount}
                    <span class="asset-warning"
                      ><Icon name="warning" size={12} />{row.run.missingAssetCount} screenshot asset{row
                        .run.missingAssetCount === 1
                        ? ''
                        : 's'} not stored locally</span
                    >
                  {/if}
                </p>
              </details>
            </article>
          {/each}
        </div>
      {/if}
    </section>
  </div>
</AppShell>

<EvidenceImportDialog
  visible={importVisible}
  onclose={() => (importVisible = false)}
  onimported={imported}
/>

<style>
  .evidence,
  .run-list {
    display: grid;
    gap: 14px;
  }
  .runs-page :global(.surface-header h1) {
    font-size: 1.8rem;
    letter-spacing: -0.035em;
  }
  .surface-success {
    background: var(--pass-soft);
    border: 1px solid color-mix(in srgb, var(--pass) 30%, transparent);
    border-radius: 8px;
    color: var(--pass);
    font-size: 0.7rem;
    margin: 0;
    padding: 9px 11px;
  }
  .targets {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }
  .targets > summary {
    align-items: center;
    cursor: pointer;
    display: flex;
    gap: 14px;
    justify-content: space-between;
    padding: 14px 16px;
  }
  .targets > summary strong,
  .targets > summary span {
    display: block;
  }
  .targets > summary strong {
    font-size: 0.8rem;
  }
  .targets > summary div span,
  .targets > summary > span {
    color: var(--muted);
    font-size: 0.72rem;
    margin-top: 2px;
  }
  .target-content {
    border-top: 1px solid var(--line);
    padding: 14px;
  }
  .target-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
  }
  .target-grid article {
    display: grid;
    gap: 14px;
    padding: 17px;
  }
  .target-grid h3 {
    font-size: 0.9rem;
    margin: 8px 0 4px;
  }
  .target-grid p {
    color: var(--muted);
    font-size: 0.7rem;
    margin: 0;
  }
  .target-grid code {
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 7px;
    font-size: 0.72rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
    padding: 9px;
  }
  .section-title > div > p {
    color: var(--muted);
    font-size: 0.7rem;
    margin: 4px 0 0;
  }
  .run-filter select {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    font-size: 0.72rem;
    min-height: 38px;
    padding: 7px 10px;
  }
  .missing-grid {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  }
  .missing-card {
    align-items: center;
    display: grid;
    gap: 12px;
    grid-template-columns: 1fr auto auto;
    padding: 13px;
  }
  .missing-card strong,
  .missing-card small {
    display: block;
  }
  .missing-card strong {
    font-size: 0.72rem;
  }
  .missing-card small {
    color: var(--muted);
    font-size: 0.72rem;
    margin-top: 3px;
  }
  .run-card {
    overflow: hidden;
  }
  .run-heading {
    align-items: start;
    display: flex;
    gap: 16px;
    justify-content: space-between;
    padding: 15px 16px 12px;
  }
  .run-heading h3 {
    font-size: 0.88rem;
    margin: 8px 0 2px;
  }
  .run-heading p {
    color: var(--faint);
    font-size: 0.72rem;
    margin: 0;
  }
  .run-facts {
    border-block: 1px solid var(--line);
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .run-facts span {
    border-left: 1px solid var(--line);
    min-width: 0;
    padding: 10px 12px;
  }
  .run-facts span:first-child {
    border-left: 0;
  }
  .run-facts small,
  .run-facts strong {
    display: block;
  }
  .run-facts small {
    color: var(--faint);
    font-size: 0.72rem;
    margin-bottom: 3px;
  }
  .run-facts strong {
    font-size: 0.7rem;
    overflow-wrap: anywhere;
  }
  .run-details {
    padding: 10px 16px;
  }
  .run-details summary {
    color: var(--muted);
    cursor: pointer;
    font-size: 0.7rem;
    font-weight: 650;
    width: max-content;
  }
  .run-details dl {
    display: grid;
    gap: 10px 18px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin: 12px 0 0;
  }
  .run-details dt {
    color: var(--faint);
    font-size: 0.72rem;
  }
  .run-details dd {
    font-size: 0.72rem;
    margin: 3px 0 0;
    overflow-wrap: anywhere;
  }
  .run-details p {
    color: var(--muted);
    font-size: 0.72rem;
    margin: 10px 0 0;
  }
  .asset-warning {
    align-items: center;
    color: var(--changed);
    display: inline-flex;
    gap: 4px;
  }
  @media (max-width: 620px) {
    .run-facts {
      grid-template-columns: 1fr 1fr;
    }
    .run-facts span:nth-child(odd) {
      border-left: 0;
    }
    .run-facts span:nth-child(n + 3) {
      border-top: 1px solid var(--line);
    }
    .run-facts span:nth-child(4) {
      border-left: 1px solid var(--line);
    }
    .run-details dl {
      grid-template-columns: 1fr 1fr;
    }
    .run-heading {
      align-items: stretch;
      flex-direction: column;
    }
    .run-heading .button {
      align-self: start;
    }
    .missing-card {
      grid-template-columns: 1fr auto;
    }
    .missing-card .button {
      grid-column: 1 / -1;
    }
  }
</style>
