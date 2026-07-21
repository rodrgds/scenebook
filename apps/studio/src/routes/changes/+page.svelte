<script lang="ts">
  import { onMount } from 'svelte';

  import AppShell from '$lib/components/AppShell.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { summarizeVersionChange, type VersionChange } from '$lib/project-surfaces';
  import { studioSceneLibrary } from '$lib/scene-library';

  type Filter = 'all' | 'changed' | 'review' | 'evidence' | 'draft';

  let changes = $state<VersionChange[]>([]);
  let loadState = $state<'loading' | 'ready' | 'error'>('loading');
  let error = $state('');
  let filter = $state<Filter>('all');

  let visible = $derived(
    changes.filter((item) => {
      if (filter === 'changed') return item.changedFields.length > 0;
      if (filter === 'review')
        return item.scene.evidenceRuns.some((run) => (run.review?.changes.length ?? 0) > 0);
      if (filter === 'evidence') return Boolean(item.scene.verification);
      if (filter === 'draft') return !item.scene.verification;
      return true;
    }),
  );
  let contentChanges = $derived(changes.filter((item) => item.changedFields.length > 0).length);
  let reviewChanges = $derived(
    changes.reduce(
      (count, item) =>
        count +
        item.scene.evidenceRuns.reduce(
          (runCount, run) => runCount + (run.review?.changes.length ?? 0),
          0,
        ),
      0,
    ),
  );

  async function loadChanges() {
    loadState = 'loading';
    error = '';
    try {
      const scenes = await studioSceneLibrary.list();
      const next: VersionChange[] = [];
      for (let offset = 0; offset < scenes.length; offset += 6) {
        const batch = scenes.slice(offset, offset + 6);
        next.push(
          ...(await Promise.all(
            batch.map(async (scene) => {
              const versions = await studioSceneLibrary.listVersionSummaries(scene.id, {
                limit: 2,
              });
              return summarizeVersionChange(scene, versions.items);
            }),
          )),
        );
      }
      changes = next;
      loadState = 'ready';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Local change history could not be read.';
      loadState = 'error';
    }
  }

  onMount(() => void loadChanges());
</script>

<svelte:head>
  <title>Changes · Scenebook</title>
</svelte:head>

<AppShell active="changes">
  <div class="project-page changes-page">
    <header class="surface-header">
      <div>
        <h1>Changes</h1>
        <p>Review source edits and differences found in imported runs.</p>
      </div>
      <div class="surface-actions">
        <a class="button primary" href="/runs?action=import"
          ><Icon name="download" size={15} />Import run evidence</a
        >
      </div>
    </header>

    <section class="review-section" aria-labelledby="review-title">
      <div class="section-title">
        <div>
          <h2 id="review-title">Review queue</h2>
          <p>
            {contentChanges + reviewChanges} change{contentChanges + reviewChanges === 1 ? '' : 's'} across
            {changes.length} scene{changes.length === 1 ? '' : 's'}
          </p>
        </div>
        <div class="filters" aria-label="Filter changes">
          {#each [['all', 'All'], ['changed', 'Source edits'], ['review', `Run changes (${reviewChanges})`], ['evidence', 'Has evidence'], ['draft', 'No evidence']] as option}
            <button
              class:active={filter === option[0]}
              type="button"
              onclick={() => (filter = option[0] as Filter)}>{option[1]}</button
            >
          {/each}
        </div>
      </div>

      {#if loadState === 'loading'}
        <div class="surface-state" aria-live="polite" aria-busy="true">
          <Icon name="clock" />
          <div>
            <strong>Reading revision history…</strong><small
              >Checking the two newest durable snapshots for every local Scene.</small
            >
          </div>
        </div>
      {:else if loadState === 'error'}
        <div class="surface-state">
          <Icon name="warning" />
          <div><strong>Changes are unavailable</strong><small>{error}</small></div>
          <button class="button" type="button" onclick={loadChanges}>Try again</button>
        </div>
      {:else if visible.length === 0}
        <div class="surface-state">
          <Icon name="changes" />
          <div>
            <strong>No matching changes</strong><small
              >{changes.length
                ? 'Choose another filter to see the local review queue.'
                : 'Create or import a Scene to begin retaining local revisions.'}</small
            >
          </div>
          <a class="button" href="/catalog">Open catalog</a>
        </div>
      {:else}
        <div class="change-list">
          {#each visible as item (item.scene.id)}
            <article class="surface-card">
              <div class="change-main">
                <div class="change-heading">
                  <div>
                    <span class="status-chip {item.scene.runStatus}"
                      ><span class="status-dot"></span>{item.scene.verification
                        ? item.scene.runStatus
                        : 'no evidence'}</span
                    >
                    {#if item.scene.sample}<span class="status-chip warning">synthetic sample</span
                      >{/if}
                    <h3>
                      <a href={`/scenes/${encodeURIComponent(item.scene.id)}`}>{item.scene.title}</a
                      >
                    </h3>
                  </div>
                  <span class="revision">r{item.current?.revision ?? item.scene.revision}</span>
                </div>
                <p>{item.scene.description || 'No description yet.'}</p>
                <div class="delta-line">
                  {#if item.previous}
                    <Icon name={item.changedFields.length ? 'changes' : 'check'} size={14} />
                    <span
                      >{item.changedFields.length
                        ? item.changedFields.join(' · ')
                        : 'No structural delta detected in summary fields'} since r{item.previous
                        .revision}</span
                    >
                  {:else}
                    <Icon name="history" size={14} /><span>First retained local revision</span>
                  {/if}
                </div>
                {#if item.scene.evidenceRuns[0]?.review?.changes.length}
                  <details
                    class="review-deltas"
                    open={item.scene.evidenceRuns[0].changeState !== 'passed'}
                  >
                    <summary>
                      {item.scene.evidenceRuns[0].review.changes.length} exact Review change{item
                        .scene.evidenceRuns[0].review.changes.length === 1
                        ? ''
                        : 's'}
                      · {item.scene.evidenceRuns[0].review.id}
                    </summary>
                    <ul>
                      {#each item.scene.evidenceRuns[0].review.changes as change (change.id)}
                        <li class={`severity-${change.severity}`}>
                          <span class="change-dimension">{change.dimension}</span>
                          <span
                            ><strong>{change.summary}</strong><small
                              >{change.kind}{#if change.stepId}
                                · Step {change.stepId}{/if}{#if Object.keys(change.metrics).length}
                                · {Object.entries(change.metrics)
                                  .map(([key, value]) => `${key} ${Number(value).toFixed(3)}`)
                                  .join(' · ')}{/if}</small
                            ></span
                          >
                        </li>
                      {/each}
                    </ul>
                  </details>
                {:else if item.scene.evidenceRuns[0]}
                  <p class="no-review">The latest run has no review changes.</p>
                {/if}
              </div>
              <footer class="change-footer">
                <span>
                  Saved {new Date(item.scene.savedAt).toLocaleString()}
                  {#if item.scene.verification?.at}
                    · Run {new Date(item.scene.verification.at).toLocaleString()}
                  {/if}
                </span>
                <div class="row-actions">
                  <details>
                    <summary>Evidence details</summary>
                    <dl>
                      <div>
                        <dt>Run evidence</dt>
                        <dd>
                          {item.scene.verification?.at
                            ? new Date(item.scene.verification.at).toLocaleString()
                            : 'Not attached'}
                        </dd>
                      </div>
                      <div>
                        <dt>Commit</dt>
                        <dd class="mono">{item.scene.verification?.commit ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>Environment</dt>
                        <dd>{item.scene.verification?.environment ?? '—'}</dd>
                      </div>
                    </dl>
                  </details>
                  <a class="button" href={`/scenes/${encodeURIComponent(item.scene.id)}?tab=health`}
                    >Review scene</a
                  >
                </div>
              </footer>
            </article>
          {/each}
        </div>
      {/if}
    </section>
  </div>
</AppShell>

<style>
  .changes-page :global(.surface-header h1) {
    font-size: 1.8rem;
    letter-spacing: -0.035em;
  }
  .review-section,
  .change-list {
    display: grid;
    gap: 14px;
  }
  .filters {
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 9px;
    display: flex;
    gap: 3px;
    padding: 3px;
  }
  .filters button {
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: var(--muted);
    font-size: 0.7rem;
    font-weight: 680;
    padding: 7px 10px;
  }
  .filters button.active {
    background: var(--surface);
    box-shadow: var(--shadow-sm);
    color: var(--ink);
  }
  .change-list article {
    display: block;
    padding: 18px;
  }
  .section-title > div > p {
    color: var(--muted);
    font-size: 0.7rem;
    margin: 4px 0 0;
  }
  .change-main {
    min-width: 0;
  }
  .change-heading {
    align-items: start;
    display: flex;
    gap: 12px;
    justify-content: space-between;
  }
  .change-heading > div {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  h3 {
    flex-basis: 100%;
    font-size: 0.98rem;
    margin: 5px 0 0;
  }
  h3 a {
    text-decoration: none;
  }
  h3 a:hover {
    color: var(--accent);
  }
  .revision {
    color: var(--faint);
    font-family: ui-monospace, monospace;
    font-size: 0.72rem;
  }
  .change-main > p {
    color: var(--muted);
    font-size: 0.7rem;
    line-height: 1.45;
    margin: 7px 0 12px;
  }
  .delta-line {
    align-items: center;
    color: var(--info);
    display: flex;
    font-size: 0.7rem;
    gap: 6px;
  }
  .review-deltas {
    border: 1px solid var(--line);
    border-radius: 8px;
    margin-top: 12px;
    overflow: hidden;
  }
  .review-deltas summary {
    background: var(--paper-2);
    color: var(--muted);
    cursor: pointer;
    font-size: 0.7rem;
    font-weight: 680;
    padding: 8px 10px;
  }
  .review-deltas ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .review-deltas li {
    align-items: start;
    border-top: 1px solid var(--line);
    display: grid;
    gap: 8px;
    grid-template-columns: 68px 1fr;
    padding: 8px 10px;
  }
  .change-dimension {
    color: var(--info);
    font-size: 0.72rem;
    font-weight: 720;
    text-transform: capitalize;
  }
  .review-deltas strong,
  .review-deltas small {
    display: block;
  }
  .review-deltas strong {
    font-size: 0.7rem;
  }
  .review-deltas small,
  .no-review {
    color: var(--muted);
    font-size: 0.72rem;
    line-height: 1.4;
    margin: 2px 0 0;
  }
  .review-deltas .severity-error .change-dimension,
  .review-deltas .severity-blocking .change-dimension {
    color: var(--broken);
  }
  .review-deltas .severity-warning .change-dimension {
    color: var(--changed);
  }
  .change-footer {
    align-items: center;
    border-top: 1px solid var(--line);
    display: grid;
    gap: 12px;
    grid-template-columns: minmax(0, 1fr) auto;
    margin-top: 14px;
    padding-top: 12px;
  }
  .change-footer > span {
    color: var(--muted);
    font-size: 0.72rem;
  }
  dl {
    background: var(--paper-2);
    border-radius: 7px;
    display: grid;
    gap: 7px;
    margin: 0;
    min-width: 260px;
    padding: 10px;
  }
  dl div {
    display: grid;
    gap: 2px;
    grid-template-columns: 82px 1fr;
  }
  dt {
    color: var(--faint);
    font-size: 0.72rem;
  }
  dd {
    font-size: 0.72rem;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .row-actions {
    align-items: start;
    display: flex;
    gap: 7px;
  }
  .row-actions details {
    max-width: 320px;
  }
  .row-actions summary {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.72rem;
    font-weight: 650;
    min-height: 38px;
    padding: 9px 11px;
    text-align: center;
  }
  .row-actions details[open] summary {
    margin-bottom: 6px;
  }
  @media (max-width: 680px) {
    .filters {
      align-self: start;
      flex-wrap: wrap;
    }
    .change-footer {
      align-items: stretch;
      grid-template-columns: 1fr;
    }
    .row-actions {
      grid-template-columns: 1fr 1fr;
      width: 100%;
    }
    .row-actions > * {
      flex: 1;
    }
    .row-actions details {
      max-width: none;
    }
  }
</style>
