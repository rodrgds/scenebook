<script lang="ts">
  import { onMount } from 'svelte';
  import { ProjectSchema, type Project } from '@scenebook/schema';

  import AppShell from '$lib/components/AppShell.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import {
    effectiveLocalProject,
    readStudioPrivacyDefaults,
    summarizeChannelCoverage,
  } from '$lib/project-surfaces';
  import { defaultProject, downloadPortable, exportProjectZip } from '$lib/portable';
  import {
    releaseLocalMediaUrls,
    studioSceneLibrary,
    type LoadedScene,
    type SceneSummary,
  } from '$lib/scene-library';

  let scenes = $state<SceneSummary[]>([]);
  let project = $state<Project | null>(null);
  let projectPersisted = $state(false);
  let loadState = $state<'loading' | 'ready' | 'error'>('loading');
  let action = $state<'export' | 'channel' | null>(null);
  let error = $state('');

  let coverage = $derived(project ? summarizeChannelCoverage(project, scenes) : []);
  let privacy = $derived(project ? readStudioPrivacyDefaults(project) : null);
  let incompleteScenes = $derived(
    scenes.filter(
      (scene) =>
        scene.screenAssetCount < scene.screenStepCount || scene.hiddenStepCount > 0 || scene.sample,
    ).length,
  );
  let releaseBlocked = $derived(
    !projectPersisted ||
      incompleteScenes > 0 ||
      coverage.length === 0 ||
      coverage.some((item) => item.releaseBlockers.length > 0),
  );

  async function loadPublish() {
    loadState = 'loading';
    error = '';
    try {
      const [nextScenes, persisted] = await Promise.all([
        studioSceneLibrary.list(),
        studioSceneLibrary.loadProject(),
      ]);
      scenes = nextScenes;
      projectPersisted = Boolean(persisted);
      project = effectiveLocalProject(persisted, nextScenes);
      loadState = 'ready';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Publication readiness could not be read.';
      loadState = 'error';
    }
  }

  async function addStaticChannel() {
    if (!project || project.channels.length > 0 || scenes.length === 0) return;
    action = 'channel';
    error = '';
    try {
      // Zod returns an ordinary validated object; cloning a Svelte $state proxy directly throws.
      const next = ProjectSchema.parse(project);
      next.channels.push({
        id: 'local-static',
        name: 'Local static release',
        slug: 'local-static',
        description: 'Privacy-gated static output configured in local Studio.',
        kind: 'static',
        collectionIds: next.collections.map((collection) => collection.id),
        policy: {
          requireCriticalPassing: true,
          requireVisualApproval: true,
          requireEditorialApproval: true,
          requireCompleteLocalization: false,
          publication: 'manual',
          nonCriticalFailure: 'block',
        },
        public: {},
      });
      const parsed = ProjectSchema.safeParse(next);
      if (!parsed.success) {
        error = parsed.error.issues
          .map((issue) => issue.message)
          .slice(0, 3)
          .join(' · ');
        return;
      }
      await studioSceneLibrary.saveProject(parsed.data);
      project = structuredClone(parsed.data);
      projectPersisted = true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The channel could not be saved.';
    } finally {
      action = null;
    }
  }

  async function exportWorkspace() {
    if (!project || scenes.length === 0) return;
    action = 'export';
    error = '';
    const loaded: LoadedScene[] = [];
    try {
      for (const summary of scenes) {
        const result = await studioSceneLibrary.load(summary.id);
        if (result.scene) loaded.push(result);
      }
      const sources = loaded.flatMap((result) => (result.scene ? [result.scene] : []));
      downloadPortable(await exportProjectZip(sources, project ?? defaultProject(sources)));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The portable project could not be built.';
    } finally {
      releaseLocalMediaUrls(loaded);
      action = null;
    }
  }

  onMount(() => void loadPublish());
</script>

<svelte:head><title>Release · Scenebook</title></svelte:head>

<AppShell active="publish">
  <div class="project-page publish-page">
    <header class="surface-header">
      <div>
        <h1>Release</h1>
      </div>
    </header>

    {#if error && loadState !== 'error'}<p class="surface-error" role="alert">{error}</p>{/if}

    {#if loadState === 'loading'}
      <div class="surface-state" aria-busy="true">
        <Icon name="clock" />
        <div>
          <strong>Computing publication readiness…</strong><small
            >Reading project policy and compact scene metadata.</small
          >
        </div>
      </div>
    {:else if loadState === 'error'}
      <div class="surface-state">
        <Icon name="warning" />
        <div><strong>Readiness is unavailable</strong><small>{error}</small></div>
        <button class="button" type="button" onclick={loadPublish}>Try again</button>
      </div>
    {:else}
      <section class="scene-readiness" aria-labelledby="scene-readiness-title">
        <div class="section-title">
          <div>
            <h2 id="scene-readiness-title">Authoring blockers</h2>
          </div>
        </div>
        {#if scenes.length === 0}
          <div class="surface-state">
            <Icon name="file" />
            <div>
              <strong>No scenes to publish</strong><small
                >Create or import portable source before configuring output.</small
              >
            </div>
            <a class="button primary" href="/catalog?action=create">New scene</a>
          </div>
        {:else if incompleteScenes === 0}
          <div class="surface-state">
            <Icon name="check" />
            <div>
              <strong>No authoring blockers</strong><small
                >All scenes have visuals and at least one visible output step.</small
              >
            </div>
            <a class="button" href="/catalog">View scenes</a>
          </div>
        {:else}
          <div class="scene-grid">
            {#each scenes as scene (scene.id)}
              {@const issues =
                (scene.sample ? 1 : 0) +
                (scene.screenAssetCount < scene.screenStepCount ? 1 : 0) +
                (scene.hiddenStepCount > 0 ? 1 : 0)}
              {#if issues > 0}<article class="surface-card">
                  <div>
                    <span class="status-chip {issues ? 'warning' : 'ready'}"
                      >{issues
                        ? `${issues} authoring note${issues === 1 ? '' : 's'}`
                        : 'source ready'}</span
                    >
                    <h3>{scene.title}</h3>
                    <p>
                      {scene.stepCount} steps · {scene.screenAssetCount}/{scene.screenStepCount} screen
                      visuals · {scene.translationCount} translations
                    </p>
                  </div>
                  <div class="readiness-notes">
                    {#if scene.sample}<span
                        ><Icon name="warning" size={12} />Synthetic sample is not release evidence</span
                      >{/if}{#if scene.screenAssetCount < scene.screenStepCount}<span
                        ><Icon name="warning" size={12} />Some screen steps lack visuals</span
                      >{/if}{#if scene.hiddenStepCount}<span
                        ><Icon name="warning" size={12} />{scene.hiddenStepCount} step{scene.hiddenStepCount ===
                        1
                          ? ''
                          : 's'} hidden from every output</span
                      >{/if}
                  </div>
                  <a class="button" href={`/scenes/${encodeURIComponent(scene.id)}?tab=publish`}
                    >Configure outputs <Icon name="arrow-right" size={13} /></a
                  >
                </article>{/if}
            {/each}
          </div>
        {/if}
      </section>

      <section class="channels" aria-labelledby="channels-title">
        <div class="section-title">
          <div>
            <h2 id="channels-title">Channels</h2>
          </div>
        </div>
        {#if coverage.length === 0}
          <div class="surface-state">
            <Icon name="publish" />
            <div>
              <strong>No channel configured</strong><small
                >Add a conservative static channel selecting every local collection, or import a
                reviewed project definition.</small
              >
            </div>
            <button
              class="button"
              type="button"
              disabled={scenes.length === 0 || action === 'channel'}
              onclick={addStaticChannel}
              >{action === 'channel' ? 'Saving…' : 'Add static channel'}</button
            ><a class="button" href="/settings?action=import">Import project</a>
          </div>
        {:else}
          <div class="channel-grid">
            {#each coverage as item (item.channel.id)}
              <article class="surface-card">
                <header>
                  <span class="channel-icon"
                    ><Icon
                      name={item.channel.kind === 'private-portal' ? 'lock' : 'globe'}
                      size={17}
                    /></span
                  >
                  <div>
                    <span class="status-chip {item.releaseBlockers.length ? 'warning' : 'ready'}"
                      >{item.releaseBlockers.length ? 'preflight blocked' : 'configured'}</span
                    >
                    <h3>{item.channel.name}</h3>
                    <p>{item.channel.kind} · /{item.channel.slug}</p>
                  </div>
                </header>
                <dl>
                  <div>
                    <dt>Collections</dt>
                    <dd>{item.channel.collectionIds.length}</dd>
                  </div>
                  <div>
                    <dt>Scenes</dt>
                    <dd>{item.sceneIds.length}</dd>
                  </div>
                  <div>
                    <dt>Passed runs</dt>
                    <dd>{item.passedSceneCount}/{item.sceneIds.length}</dd>
                  </div>
                  <div>
                    <dt>Publication</dt>
                    <dd>{item.channel.policy.publication}</dd>
                  </div>
                </dl>
                {#if item.releaseBlockers.length}<div class="gate-list blocking">
                    <strong>Local blockers</strong>
                    <ul>
                      {#each item.releaseBlockers as blocker}<li>
                          <Icon name="warning" size={12} />{blocker}
                        </li>{/each}
                    </ul>
                  </div>{/if}
                <details class="handoff-details">
                  <summary>CLI handoff</summary>
                  <div class="gate-list">
                    <ul>
                      {#each item.handoffChecks as check}<li>
                          <Icon name="chevron-right" size={12} />{check}
                        </li>{/each}
                    </ul>
                  </div>
                  <code>scenebook build --channel {item.channel.id}</code>
                </details>
              </article>
            {/each}
          </div>
        {/if}
      </section>

      <section class="export-handoff" aria-labelledby="export-title">
        <div class="section-title">
          <div>
            <h2 id="export-title">Export handoff</h2>
          </div>
        </div>
        <div
          class="release-summary"
          class:blocked={releaseBlocked}
          aria-label="Release source handoff"
        >
          <span class="release-summary-icon"
            ><Icon name={releaseBlocked ? 'warning' : 'check'} size={18} /></span
          >
          <div>
            <strong
              >{releaseBlocked
                ? 'Draft source handoff: release blockers remain'
                : 'Source is ready for the release pipeline'}</strong
            >
            <small
              >{scenes.length} scenes · {project?.collections.length ?? 0} collections · {project
                ?.channels.length ?? 0} channels · privacy blocks at {privacy?.blockAt ??
                'default'}</small
            >
          </div>
          {#if !projectPersisted}<span class="status-chip warning">default project</span>{/if}
          <a class="button" href="/settings">Project settings</a>
          <button
            class="button"
            class:primary={!releaseBlocked}
            type="button"
            disabled={scenes.length === 0 || Boolean(action)}
            onclick={exportWorkspace}
            ><Icon name="download" size={15} />{action === 'export'
              ? 'Building archive…'
              : releaseBlocked
                ? 'Export draft project source'
                : 'Export project source'}</button
          >
        </div>
      </section>
    {/if}
  </div>
</AppShell>

<style>
  .release-summary {
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    padding: 12px 14px;
  }
  .release-summary.blocked {
    border-color: color-mix(in srgb, var(--changed) 28%, var(--line));
  }
  .release-summary-icon {
    align-items: center;
    background: var(--pass-soft);
    border-radius: 50%;
    color: var(--pass);
    display: flex;
    flex: 0 0 auto;
    height: 34px;
    justify-content: center;
    width: 34px;
  }
  .release-summary.blocked .release-summary-icon {
    background: var(--changed-soft);
    color: var(--changed);
  }
  .release-summary > div {
    flex: 1;
    min-width: 0;
  }
  .release-summary strong,
  .release-summary small {
    display: block;
  }
  .release-summary strong {
    font-size: 0.82rem;
  }
  .release-summary small {
    color: var(--muted);
    font-size: 0.78rem;
    margin-top: 2px;
  }
  .channels,
  .scene-readiness,
  .export-handoff {
    display: grid;
    gap: 14px;
  }
  .channel-grid {
    display: grid;
    gap: 14px;
    grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
  }
  .channel-grid article {
    display: grid;
    gap: 15px;
    padding: 18px;
  }
  .channel-grid header {
    align-items: start;
    display: flex;
    gap: 11px;
  }
  .channel-icon {
    align-items: center;
    background: var(--info-soft);
    border-radius: 8px;
    color: var(--info);
    display: flex;
    height: 36px;
    justify-content: center;
    width: 36px;
  }
  .channel-grid h3,
  .scene-grid h3 {
    font-size: 0.9rem;
    margin: 7px 0 3px;
  }
  .channel-grid p,
  .scene-grid p {
    color: var(--muted);
    font-size: 0.78rem;
    margin: 0;
  }
  .channel-grid dl {
    background: var(--paper-2);
    border-radius: 8px;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    margin: 0;
    padding: 10px;
  }
  .channel-grid dl div {
    border-right: 1px solid var(--line);
    padding: 0 8px;
  }
  .channel-grid dl div:last-child {
    border-right: 0;
  }
  dt {
    color: var(--faint);
    font-size: 0.75rem;
  }
  dd {
    font-size: 0.78rem;
    font-weight: 700;
    margin: 3px 0 0;
  }
  .gate-list {
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .gate-list strong {
    font-size: 0.8rem;
  }
  .gate-list ul {
    display: grid;
    gap: 5px;
    list-style: none;
    margin: 7px 0 0;
    padding: 0;
  }
  .gate-list li {
    align-items: start;
    color: var(--muted);
    display: flex;
    font-size: 0.78rem;
    gap: 5px;
    line-height: 1.4;
  }
  .gate-list.blocking li {
    color: var(--broken);
  }
  .channel-grid code {
    background: var(--ink);
    border-radius: 7px;
    color: white;
    font-size: 0.75rem;
    overflow-wrap: anywhere;
    padding: 9px;
  }
  .handoff-details {
    border-top: 1px solid var(--line);
    padding-top: 10px;
  }
  .handoff-details summary {
    color: var(--muted);
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 650;
    min-height: 40px;
  }
  .handoff-details .gate-list {
    border: 0;
  }
  .handoff-details code {
    display: block;
    margin-top: 10px;
  }
  .scene-grid {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  }
  .scene-grid article {
    align-content: start;
    display: grid;
    gap: 14px;
    padding: 16px;
  }
  .readiness-notes {
    display: grid;
    gap: 5px;
  }
  .readiness-notes span {
    align-items: center;
    color: var(--muted);
    display: flex;
    font-size: 0.78rem;
    gap: 5px;
  }
  @media (max-width: 550px) {
    .release-summary {
      align-items: flex-start;
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
    }
    .release-summary > div,
    .release-summary > .status-chip {
      grid-column: 2;
      justify-self: start;
    }
    .release-summary > .button {
      grid-column: 1 / -1;
      width: 100%;
    }
    .channel-grid {
      grid-template-columns: 1fr;
    }
    .channel-grid dl {
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .channel-grid dl div {
      border: 0;
    }
    .handoff-details summary {
      min-height: 44px;
    }
  }
</style>
