<script lang="ts">
  import { onMount } from 'svelte';
  import { ProjectSchema, type Project } from '@scenebook/schema';

  import AppShell from '$lib/components/AppShell.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import {
    effectiveLocalProject,
    readStudioPrivacyDefaults,
    writeStudioPrivacyDefaults,
    type StudioPrivacyDefaults,
  } from '$lib/project-surfaces';
  import { downloadPortable, exportProjectYaml, exportProjectZip } from '$lib/portable';
  import {
    releaseLocalMediaUrls,
    studioSceneLibrary,
    type LoadedScene,
    type SceneSummary,
  } from '$lib/scene-library';

  let scenes = $state<SceneSummary[]>([]);
  let draft = $state<Project | null>(null);
  let saved = $state<Project | null>(null);
  let privacy = $state<StudioPrivacyDefaults>({
    blockAt: 'high',
    scanBeforeExport: true,
    ocrBeforePublication: true,
  });
  let localesText = $state('en');
  let dirty = $state(false);
  let loadState = $state<'loading' | 'ready' | 'error'>('loading');
  let action = $state<'save' | 'yaml' | 'zip' | null>(null);
  let status = $state('');
  let error = $state('');

  async function loadSettings() {
    loadState = 'loading';
    error = '';
    status = '';
    try {
      const [nextScenes, project] = await Promise.all([
        studioSceneLibrary.list(),
        studioSceneLibrary.loadProject(),
      ]);
      const next = effectiveLocalProject(project, nextScenes);
      scenes = nextScenes;
      draft = structuredClone(next);
      saved = structuredClone(next);
      privacy = readStudioPrivacyDefaults(next);
      localesText = next.locales.join(', ');
      dirty = false;
      loadState = 'ready';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Project settings could not be read.';
      loadState = 'error';
    }
  }

  function markDirty() {
    dirty = true;
    status = '';
    error = '';
  }

  function candidateProject(): Project | null {
    if (!draft) return null;
    const candidate = writeStudioPrivacyDefaults(draft, privacy);
    candidate.locales = [
      ...new Set(
        localesText
          .split(',')
          .map((locale) => locale.trim())
          .filter(Boolean),
      ),
    ];
    return candidate;
  }

  function validateDraft(): Project | null {
    error = '';
    const candidate = candidateProject();
    const parsed = ProjectSchema.safeParse(candidate);
    if (!parsed.success) {
      error = parsed.error.issues
        .slice(0, 6)
        .map((issue) => `${issue.path.join('.') || 'project'}: ${issue.message}`)
        .join(' · ');
      return null;
    }
    return parsed.data;
  }

  async function saveSettings() {
    const valid = validateDraft();
    if (!valid) return;
    action = 'save';
    try {
      await studioSceneLibrary.saveProject(valid);
      draft = structuredClone(valid);
      saved = structuredClone(valid);
      dirty = false;
      status = 'Project settings saved to this browser.';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Project settings could not be saved.';
    } finally {
      action = null;
    }
  }

  function discardSettings() {
    if (!saved) return;
    draft = structuredClone(saved);
    privacy = readStudioPrivacyDefaults(saved);
    localesText = saved.locales.join(', ');
    dirty = false;
    status = '';
    error = '';
  }

  function exportYaml() {
    const valid = validateDraft();
    if (!valid) return;
    action = 'yaml';
    downloadPortable(exportProjectYaml(valid));
    action = null;
    status = 'Portable project.yaml downloaded.';
  }

  async function exportArchive() {
    const valid = validateDraft();
    if (!valid || scenes.length === 0) return;
    action = 'zip';
    const loaded: LoadedScene[] = [];
    try {
      for (const summary of scenes) {
        const result = await studioSceneLibrary.load(summary.id);
        if (result.scene) loaded.push(result);
      }
      const sources = loaded.flatMap((item) => (item.scene ? [item.scene] : []));
      downloadPortable(await exportProjectZip(sources, valid));
      status = 'Portable Project archive downloaded.';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Project archive could not be built.';
    } finally {
      releaseLocalMediaUrls(loaded);
      action = null;
    }
  }

  onMount(() => void loadSettings());
</script>

<svelte:head><title>Settings · Scenebook</title></svelte:head>
<svelte:window
  onbeforeunload={(event) => {
    if (dirty) event.preventDefault();
  }}
/>

<AppShell active="settings">
  <div class="project-page settings-page">
    <header class="surface-header">
      <div>
        <h1>Project settings</h1>
        <p>Manage project details, publishing defaults, privacy, and portable backups.</p>
      </div>
      <div class="surface-actions">
        {#if dirty}<button class="button" type="button" onclick={discardSettings}>Discard</button
          >{/if}
        <button
          class="button primary"
          type="button"
          disabled={!dirty || Boolean(action)}
          onclick={saveSettings}
          ><Icon name="save" size={15} />{action === 'save' ? 'Saving…' : 'Save settings'}</button
        >
      </div>
    </header>

    {#if error}<p class="surface-error" role="alert">{error}</p>{/if}
    {#if status}<p class="success-banner" role="status">
        <Icon name="check" size={14} />{status}
      </p>{/if}

    {#if loadState === 'loading'}
      <div class="surface-state" aria-busy="true">
        <Icon name="clock" />
        <div>
          <strong>Reading Project settings…</strong><small
            >Loading the active local Project record.</small
          >
        </div>
      </div>
    {:else if loadState === 'error'}
      <div class="surface-state">
        <Icon name="warning" />
        <div><strong>Settings are unavailable</strong><small>{error}</small></div>
        <button class="button" type="button" onclick={loadSettings}>Try again</button>
      </div>
    {:else if draft}
      <div class="settings-layout">
        <div class="settings-main">
          <section class="surface-card settings-section" aria-labelledby="identity-title">
            <header>
              <div>
                <h2 id="identity-title">General</h2>
              </div>
              <details class="project-id">
                <summary>Project ID</summary><code>{draft.id}</code>
              </details>
            </header>
            <div class="form-grid">
              <label class="field"
                ><span class="field-label">Project name</span><input
                  class="input"
                  bind:value={draft.name}
                  oninput={markDirty}
                  maxlength="200"
                /></label
              >
              <label class="field"
                ><span class="field-label">Public slug</span><input
                  class="input mono"
                  bind:value={draft.slug}
                  oninput={markDirty}
                  maxlength="100"
                /></label
              >
              <label class="field full"
                ><span class="field-label">Description</span><textarea
                  class="textarea"
                  bind:value={draft.description}
                  oninput={markDirty}
                  maxlength="10000"></textarea></label
              >
              <label class="field"
                ><span class="field-label">Locales <small>Comma separated BCP 47 tags</small></span
                ><input
                  class="input"
                  bind:value={localesText}
                  oninput={markDirty}
                  placeholder="en, pt-PT"
                /></label
              >
              <label class="field"
                ><span class="field-label">Default locale</span><input
                  class="input"
                  bind:value={draft.defaultLocale}
                  oninput={markDirty}
                  maxlength="35"
                /></label
              >
            </div>
          </section>

          <section class="surface-card settings-section" aria-labelledby="distribution-title">
            <header>
              <div>
                <h2 id="distribution-title">Publishing</h2>
              </div>
              <span class="status-chip local">telemetry off unless configured</span>
            </header>
            <div class="toggle-list">
              <label
                ><span
                  ><strong>Allow search indexing</strong><small
                    >Only eligible public-catalog and static Channels can apply this.</small
                  ></span
                ><input
                  type="checkbox"
                  bind:checked={draft.public.seo.index}
                  onchange={markDirty}
                /></label
              >
              <label
                ><span
                  ><strong>Allow link following</strong><small
                    >Defaults to nofollow until explicitly reviewed.</small
                  ></span
                ><input
                  type="checkbox"
                  bind:checked={draft.public.seo.follow}
                  onchange={markDirty}
                /></label
              >
              <label
                ><span
                  ><strong>Show Scenebook attribution</strong><small
                    >Preserves product provenance in generated outputs.</small
                  ></span
                ><input
                  type="checkbox"
                  bind:checked={draft.public.attribution}
                  onchange={markDirty}
                /></label
              >
              <label
                ><span
                  ><strong>Allow privacy-safe remix source</strong><small
                    >Flattened remix removes routes, selectors, automation, checks, and raw
                    captures.</small
                  ></span
                ><input
                  type="checkbox"
                  bind:checked={draft.public.remix}
                  onchange={markDirty}
                /></label
              >
            </div>
            {#if draft.public.baseUrl || draft.public.customDomain || draft.public.analytics || draft.public.cta}
              <dl class="advanced-summary">
                <div>
                  <dt>Base URL</dt>
                  <dd>{draft.public.baseUrl ?? '—'}</dd>
                </div>
                <div>
                  <dt>Custom domain</dt>
                  <dd>{draft.public.customDomain ?? '—'}</dd>
                </div>
                <div>
                  <dt>Analytics</dt>
                  <dd>{draft.public.analytics ? 'Explicit endpoint configured' : 'Off'}</dd>
                </div>
                <div>
                  <dt>CTA delivery</dt>
                  <dd>{draft.public.cta ? 'Explicit endpoint configured' : 'Off'}</dd>
                </div>
              </dl>
            {/if}
          </section>

          <section class="surface-card settings-section" aria-labelledby="privacy-title">
            <header>
              <div>
                <h2 id="privacy-title">Privacy</h2>
              </div>
              <Icon name="lock" size={17} />
            </header>
            <p class="section-note">
              These defaults guide readiness checks. The release pipeline still performs the
              required scan and OCR checks.
            </p>
            <div class="form-grid privacy-grid">
              <label class="field"
                ><span class="field-label">Block at severity</span><select
                  class="select"
                  bind:value={privacy.blockAt}
                  onchange={markDirty}
                  ><option value="medium">Medium</option><option value="high">High</option><option
                    value="blocking">Blocking only</option
                  ></select
                ></label
              >
              <span></span>
              <label class="toggle-field"
                ><span
                  ><strong>Require structured scan before export</strong><small
                    >Warn when the source handoff has not declared a structured privacy scan.</small
                  ></span
                ><input
                  type="checkbox"
                  bind:checked={privacy.scanBeforeExport}
                  onchange={markDirty}
                /></label
              >
              <label class="toggle-field"
                ><span
                  ><strong>Require OCR before publication</strong><small
                    >Keep screenshot derivative OCR in the external publication gate.</small
                  ></span
                ><input
                  type="checkbox"
                  bind:checked={privacy.ocrBeforePublication}
                  onchange={markDirty}
                /></label
              >
            </div>
          </section>
        </div>

        <aside class="settings-aside">
          <section class="surface-card export-card">
            <h2>Project data</h2>
            <p>Import source, download configuration, or back up all local scenes and assets.</p>
            <a class="button" href="/settings?action=import"
              ><Icon name="download" size={14} />Import project</a
            ><button class="button" type="button" disabled={Boolean(action)} onclick={exportYaml}
              ><Icon name="file" size={14} />{action === 'yaml'
                ? 'Preparing…'
                : 'Download project.yaml'}</button
            ><button
              class="button"
              type="button"
              disabled={scenes.length === 0 || Boolean(action)}
              onclick={exportArchive}
              ><Icon name="download" size={14} />{action === 'zip'
                ? 'Building archive…'
                : `Download Project ZIP (${scenes.length})`}</button
            >
          </section>
          <details class="surface-card inventory-card">
            <summary
              ><span
                ><strong>Advanced configuration</strong><small
                  >Imported connections and release objects</small
                ></span
              ></summary
            >
            <dl>
              <div>
                <dt>Repositories</dt>
                <dd>{draft.repositories.length}</dd>
              </div>
              <div>
                <dt>Environments</dt>
                <dd>{draft.environments.length}</dd>
              </div>
              <div>
                <dt>Product variants</dt>
                <dd>{draft.productVariants.length}</dd>
              </div>
              <div>
                <dt>Capture profiles</dt>
                <dd>{draft.captureProfiles.length}</dd>
              </div>
              <div>
                <dt>Run targets</dt>
                <dd>{draft.runTargets.length}</dd>
              </div>
              <div>
                <dt>Collections</dt>
                <dd>{draft.collections.length}</dd>
              </div>
              <div>
                <dt>Channels</dt>
                <dd>{draft.channels.length}</dd>
              </div>
            </dl>
            <p>
              Edit runner URLs, repository bindings, selectors, and compiler paths in reviewed
              project files, then import them. Studio does not store secrets.
            </p>
          </details>
        </aside>
      </div>
    {/if}
  </div>
</AppShell>

<style>
  .success-banner {
    align-items: center;
    background: var(--pass-soft);
    border: 1px solid color-mix(in srgb, var(--pass) 25%, var(--line));
    border-radius: var(--radius-sm);
    color: var(--pass);
    display: flex;
    font-size: 0.76rem;
    gap: 6px;
    margin: 0;
    padding: 10px 12px;
  }
  .settings-layout {
    align-items: start;
    display: grid;
    gap: 16px;
    grid-template-columns: minmax(0, 1fr);
    max-width: 960px;
  }
  .settings-main,
  .settings-aside {
    display: grid;
    gap: 15px;
  }
  .settings-aside {
    grid-template-columns: 1fr 1fr;
  }
  .settings-section {
    overflow: hidden;
  }
  .settings-section > header {
    align-items: center;
    border-bottom: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    padding: 16px 19px;
  }
  h2 {
    font-size: 1rem;
    margin: 0;
  }
  .project-id {
    color: var(--muted);
    font-size: 0.74rem;
    text-align: right;
  }
  .project-id summary {
    cursor: pointer;
    font-weight: 650;
  }
  .project-id code {
    display: block;
    color: var(--muted);
    font-size: 0.7rem;
    margin-top: 4px;
  }
  .form-grid {
    display: grid;
    gap: 14px;
    grid-template-columns: 1fr 1fr;
    padding: 19px;
  }
  .form-grid .full {
    grid-column: 1 / -1;
  }
  .field-label small {
    font-weight: 500;
  }
  .toggle-list {
    display: grid;
  }
  .toggle-list label,
  .toggle-field {
    align-items: center;
    border-bottom: 1px solid var(--line);
    display: flex;
    gap: 15px;
    justify-content: space-between;
    padding: 14px 19px;
  }
  .toggle-list label:last-child {
    border-bottom: 0;
  }
  .toggle-list strong,
  .toggle-list small,
  .toggle-field strong,
  .toggle-field small {
    display: block;
  }
  .toggle-list strong,
  .toggle-field strong {
    font-size: 0.78rem;
  }
  .toggle-list small,
  .toggle-field small {
    color: var(--muted);
    font-size: 0.72rem;
    line-height: 1.4;
    margin-top: 3px;
  }
  input[type='checkbox'] {
    accent-color: var(--accent);
    height: 17px;
    width: 17px;
  }
  .advanced-summary {
    background: var(--paper-2);
    border-top: 1px solid var(--line);
    display: grid;
    gap: 10px;
    grid-template-columns: 1fr 1fr;
    margin: 0;
    padding: 14px 19px;
  }
  .advanced-summary dt {
    color: var(--faint);
    font-size: 0.7rem;
  }
  .advanced-summary dd {
    font-size: 0.73rem;
    margin: 3px 0 0;
    overflow-wrap: anywhere;
  }
  .section-note {
    background: var(--changed-soft);
    border-bottom: 1px solid var(--line);
    color: var(--ink-2);
    font-size: 0.73rem;
    line-height: 1.5;
    margin: 0;
    padding: 12px 19px;
  }
  .privacy-grid {
    align-items: end;
  }
  .privacy-grid .toggle-field {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 11px;
  }
  .export-card,
  .inventory-card {
    display: grid;
    gap: 11px;
    padding: 17px;
  }
  .export-card p,
  .inventory-card p {
    color: var(--muted);
    font-size: 0.73rem;
    line-height: 1.5;
    margin: 0;
  }
  .inventory-card dl {
    display: grid;
    gap: 7px;
    margin: 0;
  }
  .inventory-card > summary {
    cursor: pointer;
    list-style: none;
  }
  .inventory-card > summary::-webkit-details-marker {
    display: none;
  }
  .inventory-card > summary span,
  .inventory-card > summary strong,
  .inventory-card > summary small {
    display: block;
  }
  .inventory-card > summary small {
    color: var(--muted);
    font-size: 0.72rem;
    font-weight: 400;
    margin-top: 3px;
  }
  .inventory-card:not([open]) > :not(summary) {
    display: none;
  }
  .inventory-card dl div {
    align-items: center;
    border-bottom: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    padding-bottom: 7px;
  }
  .inventory-card dt {
    color: var(--muted);
    font-size: 0.72rem;
  }
  .inventory-card dd {
    font-size: 0.76rem;
    font-weight: 720;
    margin: 0;
  }
  @media (max-width: 1000px) {
    .settings-aside {
      grid-template-columns: 1fr 1fr;
    }
  }
  @media (max-width: 670px) {
    .form-grid,
    .settings-aside {
      grid-template-columns: 1fr;
    }
    .form-grid .full {
      grid-column: auto;
    }
    .privacy-grid > span {
      display: none;
    }
  }
</style>
