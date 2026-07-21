<script lang="ts">
  import { onMount } from 'svelte';

  import AppShell from '$lib/components/AppShell.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { studioSceneLibrary, type SceneSummary } from '$lib/scene-library';

  let scenes = $state<SceneSummary[]>([]);
  let overviewState = $state<'loading' | 'ready' | 'error'>('loading');
  let error = $state('');

  let verifiedSourceCount = $derived(
    scenes.filter((scene) => scene.capability === 'verified').length,
  );
  let passedRunCount = $derived(scenes.filter((scene) => scene.runStatus === 'passed').length);
  let stepCount = $derived(scenes.reduce((total, scene) => total + scene.stepCount, 0));

  async function loadOverview() {
    overviewState = 'loading';
    error = '';
    try {
      scenes = await studioSceneLibrary.list();
      overviewState = 'ready';
    } catch (candidate) {
      overviewState = 'error';
      error =
        candidate instanceof Error ? candidate.message : 'The local workspace could not be read.';
    }
  }

  onMount(() => void loadOverview());
</script>

<svelte:head>
  <title>Home · Scenebook</title>
</svelte:head>

<AppShell active="home">
  <div class="home-page">
    <header class="welcome">
      <div>
        <h1>Your product journeys</h1>
        <p>Document complete outcomes, verify them in the product, and publish what is ready.</p>
      </div>
    </header>

    <section
      class="workspace-summary"
      class:error-state={overviewState === 'error'}
      aria-live="polite"
    >
      {#if overviewState === 'loading'}
        <Icon name="clock" size={18} />
        <div><strong>Loading your workspace</strong><span>Reading local project data…</span></div>
      {:else if overviewState === 'error'}
        <Icon name="health" size={18} />
        <div><strong>Could not open this workspace</strong><span>{error}</span></div>
        <button class="button" type="button" onclick={loadOverview}>Try again</button>
      {:else}
        <span class="local-indicator" aria-hidden="true"><span class="status-dot"></span></span>
        <div>
          <strong
            >{scenes.length
              ? `${scenes.length} local Scene${scenes.length === 1 ? '' : 's'}`
              : 'Empty local workspace'}</strong
          >
          <span
            >{scenes.length
              ? `Last saved ${new Date(scenes[0]!.savedAt).toLocaleString()}`
              : 'Create a Scene or import portable source to begin.'}</span
          >
        </div>
        {#if scenes.length}
          <dl class="summary-counts">
            <div>
              <dt>Verified</dt>
              <dd>{verifiedSourceCount}</dd>
            </div>
            <div>
              <dt>Passed</dt>
              <dd>{passedRunCount}</dd>
            </div>
            <div>
              <dt>Steps</dt>
              <dd>{stepCount}</dd>
            </div>
          </dl>
        {/if}
      {/if}
    </section>

    {#if overviewState === 'ready' && scenes.length === 0}
      <section class="getting-started" aria-labelledby="start-title">
        <div>
          <h2 id="start-title">Create your first product journey</h2>
          <p>
            A Scene is an ordered, portable story of one outcome—from the first action to proof that
            it worked.
          </p>
        </div>
        <div class="start-actions">
          <a class="button primary" href="/?action=create"
            ><Icon name="plus" size={16} />Create a Scene</a
          >
          <a class="button" href="/?action=import"
            ><Icon name="download" size={16} />Import source</a
          >
        </div>
        <a class="example-link" href="/scenes/invite-teammate"
          >Or explore the included example <Icon name="arrow-right" size={15} /></a
        >
      </section>
    {:else}
      <section class="recent" aria-labelledby="recent-title">
        <div class="section-heading">
          <div>
            <h2 id="recent-title">Recent Scenes</h2>
            <p>Continue editing, reviewing, or publishing your latest work.</p>
          </div>
          {#if scenes.length}<a href="/catalog"
              >View catalog <Icon name="arrow-right" size={15} /></a
            >{/if}
        </div>

        {#if overviewState === 'loading'}
          <div class="work-state" aria-busy="true">
            <Icon name="clock" /><span
              ><strong>Loading recent Scenes</strong><small>Reading durable local records…</small
              ></span
            >
          </div>
        {:else if scenes.length}
          <div class="recent-list">
            {#each scenes.slice(0, 3) as scene}
              <article>
                <a
                  class="recent-preview"
                  href={`/scenes/${scene.id}`}
                  aria-label={`Open ${scene.title}`}
                >
                  {#if scene.firstImage}<img src={scene.firstImage} alt="" />{:else}<span
                      ><Icon name="file" size={22} />No screenshot</span
                    >{/if}
                </a>
                <div class="recent-copy">
                  <div class="scene-status">
                    <span class="status-chip {scene.capability}">{scene.capability}</span>
                    {#if scene.runStatus === 'passed'}<span class="status-chip passed"
                        >Run passed</span
                      >{/if}
                  </div>
                  <h3><a href={`/scenes/${scene.id}`}>{scene.title}</a></h3>
                  <p>{scene.description || 'No description yet.'}</p>
                  <small
                    >{scene.stepCount} Step{scene.stepCount === 1 ? '' : 's'} · saved {new Date(
                      scene.savedAt,
                    ).toLocaleString()}</small
                  >
                </div>
                <a
                  class="open-scene"
                  href={`/scenes/${scene.id}`}
                  aria-label={`Open ${scene.title}`}><Icon name="arrow-right" /></a
                >
              </article>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  </div>
</AppShell>

<style>
  .home-page {
    display: grid;
    gap: 28px;
    margin: 0 auto;
    max-width: 1180px;
    padding: 44px clamp(20px, 3.4vw, 48px) 72px;
  }
  .welcome {
    align-items: end;
    display: flex;
    gap: 24px;
    justify-content: space-between;
  }
  h1 {
    font-size: 2.35rem;
    font-weight: 720;
    letter-spacing: -0.04em;
    line-height: 1.08;
    margin: 0 0 9px;
  }
  .welcome p,
  .section-heading p,
  .getting-started p {
    color: var(--muted);
    font-size: 0.9rem;
    line-height: 1.55;
    margin: 0;
    max-width: 68ch;
  }
  .start-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .workspace-summary {
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    display: flex;
    gap: 12px;
    min-height: 66px;
    padding: 12px 14px;
  }
  .workspace-summary.error-state {
    border-color: color-mix(in srgb, var(--broken) 35%, var(--line));
  }
  .workspace-summary > div:not(.summary-counts) {
    flex: 1;
    min-width: 0;
  }
  .workspace-summary strong,
  .workspace-summary span {
    display: block;
  }
  .workspace-summary strong {
    font-size: 0.82rem;
  }
  .workspace-summary > div > span {
    color: var(--muted);
    font-size: 0.73rem;
    line-height: 1.4;
    margin-top: 2px;
  }
  .local-indicator {
    align-items: center;
    background: var(--pass-soft);
    border-radius: 50%;
    color: var(--pass);
    display: flex;
    height: 34px;
    justify-content: center;
    width: 34px;
  }
  .summary-counts {
    align-items: center;
    display: flex;
    gap: 0;
    margin: 0;
  }
  .summary-counts div {
    border-left: 1px solid var(--line);
    display: grid;
    gap: 1px;
    min-width: 78px;
    padding-left: 14px;
  }
  .summary-counts dt {
    color: var(--muted);
    font-size: 0.72rem;
  }
  .summary-counts dd {
    font-size: 0.9rem;
    font-weight: 720;
    margin: 0;
  }
  .recent {
    display: grid;
    gap: 14px;
  }
  .section-heading {
    align-items: end;
    display: flex;
    gap: 20px;
    justify-content: space-between;
  }
  .section-heading h2,
  .getting-started h2 {
    font-size: 1.3rem;
    letter-spacing: -0.025em;
    margin: 0 0 4px;
  }
  .section-heading > a,
  .example-link {
    align-items: center;
    color: var(--muted);
    display: inline-flex;
    font-size: 0.78rem;
    font-weight: 650;
    gap: 5px;
    text-decoration: none;
  }
  .section-heading > a:hover,
  .example-link:hover {
    color: var(--ink);
  }
  .recent-list {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .recent-list article {
    align-items: center;
    display: grid;
    gap: 16px;
    grid-template-columns: 116px minmax(0, 1fr) auto;
    min-height: 118px;
    padding: 12px;
  }
  .recent-list article + article {
    border-top: 1px solid var(--line);
  }
  .recent-preview {
    align-items: center;
    background: #292724;
    border-radius: var(--radius-sm);
    color: #b9b4ac;
    display: flex;
    height: 88px;
    justify-content: center;
    overflow: hidden;
    text-decoration: none;
  }
  .recent-preview img {
    height: 100%;
    object-fit: cover;
    object-position: top;
    width: 100%;
  }
  .recent-preview > span {
    align-items: center;
    display: flex;
    flex-direction: column;
    font-size: 0.72rem;
    gap: 5px;
  }
  .recent-copy {
    min-width: 0;
  }
  .scene-status {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .recent-copy h3 {
    font-size: 0.96rem;
    margin: 7px 0 3px;
  }
  .recent-copy h3 a {
    text-decoration: none;
  }
  .recent-copy p {
    color: var(--muted);
    font-size: 0.77rem;
    line-height: 1.4;
    margin: 0 0 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recent-copy small {
    color: var(--faint);
    font-size: 0.7rem;
  }
  .open-scene {
    align-items: center;
    border-radius: var(--radius-sm);
    color: var(--muted);
    display: flex;
    height: 40px;
    justify-content: center;
    width: 40px;
  }
  .open-scene:hover {
    background: var(--paper-2);
    color: var(--ink);
  }
  .getting-started {
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    display: grid;
    gap: 20px;
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 28px;
  }
  .getting-started .example-link {
    grid-column: 1 / -1;
  }
  .work-state {
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    color: var(--muted);
    display: flex;
    gap: 11px;
    min-height: 96px;
    padding: 18px;
  }
  .work-state strong,
  .work-state small {
    display: block;
  }
  .work-state strong {
    color: var(--ink);
    font-size: 0.8rem;
  }
  .work-state small {
    font-size: 0.72rem;
    margin-top: 3px;
  }
  @media (max-width: 800px) {
    .welcome,
    .section-heading {
      align-items: flex-start;
      flex-direction: column;
    }
    .summary-counts {
      display: none;
    }
    .getting-started {
      align-items: start;
      grid-template-columns: 1fr;
    }
    .getting-started .example-link {
      grid-column: auto;
    }
  }
  @media (max-width: 560px) {
    .home-page {
      gap: 24px;
      padding: 30px 16px 56px;
    }
    h1 {
      font-size: 2rem;
    }
    .start-actions,
    .start-actions .button {
      width: 100%;
    }
    .recent-list article {
      grid-template-columns: 76px minmax(0, 1fr);
    }
    .recent-preview {
      height: 72px;
    }
    .open-scene {
      display: none;
    }
    .recent-copy p,
    .recent-copy small {
      display: none;
    }
  }
</style>
