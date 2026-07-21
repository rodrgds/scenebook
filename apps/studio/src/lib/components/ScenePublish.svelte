<script lang="ts">
  import type { EditorScene, OutputKind } from '../model';
  import { downloadPortable, exportSceneYaml, exportSceneZip } from '../portable';
  import Icon from './Icon.svelte';

  let { scene }: { scene: EditorScene } = $props();
  let exporting = $state<'yaml' | 'zip' | null>(null);
  let error = $state('');
  let copiedKey = $state('');

  const recipeOutputs: Array<{
    id: OutputKind;
    label: string;
    detail: string;
    icon: 'play' | 'guide' | 'video' | 'globe';
  }> = [
    {
      id: 'interactive',
      label: 'Interactive',
      detail: 'Player and catalog visibility',
      icon: 'play',
    },
    { id: 'guide', label: 'Guide', detail: 'Documentation visibility', icon: 'guide' },
    { id: 'motion', label: 'Motion', detail: 'Video and GIF visibility', icon: 'video' },
    { id: 'social', label: 'Launch media', detail: 'README and social visibility', icon: 'globe' },
  ];

  const compilerOutputs = [
    {
      format: 'catalog',
      label: 'Catalog',
      detail: 'Searchable static collection',
      icon: 'catalog',
    },
    {
      format: 'standalone-html',
      label: 'Standalone HTML',
      detail: 'Shareable accessible player',
      icon: 'play',
    },
    {
      format: 'web-component',
      label: 'Web Component',
      detail: 'Host-integrated custom element',
      icon: 'code',
    },
    { format: 'iframe', label: 'Iframe', detail: 'Origin-checked embed wrapper', icon: 'code' },
    { format: 'markdown', label: 'Markdown', detail: 'Portable prose guide', icon: 'guide' },
    { format: 'mdx', label: 'MDX', detail: 'Framework-ready guide', icon: 'code' },
    {
      format: 'html-guide',
      label: 'HTML guide',
      detail: 'Static step-by-step page',
      icon: 'guide',
    },
    { format: 'pdf', label: 'PDF', detail: 'Deterministic document', icon: 'file' },
    { format: 'mp4', label: 'MP4', detail: 'Silent authored motion', icon: 'video' },
    { format: 'webm', label: 'WebM', detail: 'Open web motion', icon: 'video' },
    { format: 'gif', label: 'GIF', detail: 'Compact motion loop', icon: 'video' },
    { format: 'readme-card', label: 'README card', detail: 'Repository-ready card', icon: 'file' },
    { format: 'og-image', label: 'Open Graph', detail: '1200 × 630 share image', icon: 'globe' },
    {
      format: 'social-carousel',
      label: 'Social images',
      detail: 'Square and landscape art',
      icon: 'globe',
    },
    {
      format: 'remix-source',
      label: 'Remix source',
      detail: 'Flattened public Scene ZIP',
      icon: 'collection',
    },
  ] as const;

  let commands = $derived([
    {
      key: 'place',
      label: 'Place the portable source',
      value: `mkdir -p scenes/${scene.id}.scene && unzip ${scene.id}.scene.zip -d scenes/${scene.id}.scene`,
    },
    {
      key: 'scan',
      label: 'Scan exact publication derivatives',
      value: 'bunx --bun @scenebook/cli@0.1.0 privacy scan --provider tesseract',
    },
    {
      key: 'preview',
      label: 'Preview one reviewed Channel',
      value: 'bunx --bun @scenebook/cli@0.1.0 dev --channel public --port 6100',
    },
    {
      key: 'build',
      label: 'Compile the configured output matrix',
      value: 'bunx --bun @scenebook/cli@0.1.0 build --channel public',
    },
    {
      key: 'publish',
      label: 'Finalize an atomic local static directory',
      value:
        'bunx --bun @scenebook/cli@0.1.0 publish --channel public --destination public/scenebook',
    },
  ]);

  let checkCount = $derived(
    scene.portableSource?.steps.reduce((count, step) => count + step.checks.length, 0) ?? 0,
  );
  let assetCount = $derived(new Set(scene.steps.map((step) => step.image).filter(Boolean)).size);
  let translationCount = $derived(Object.keys(scene.translations ?? {}).length);
  let opaqueMaskCount = $derived(
    scene.steps.flatMap((step) => step.masks).filter((mask) => mask.mode === 'opaque').length,
  );
  let decorativeBlurCount = $derived(
    scene.steps
      .flatMap((step) => step.masks)
      .filter(
        (mask) =>
          mask.mode === 'blur' && mask.source === 'manual' && mask.classification === 'custom',
      ).length,
  );

  function visibleCount(output: OutputKind): number {
    return scene.steps.filter((step) => step.outputVisibility[output]).length;
  }

  function compilerGroup(format: (typeof compilerOutputs)[number]['format']): string {
    if (['catalog', 'standalone-html', 'web-component', 'iframe'].includes(format)) return 'Web';
    if (['markdown', 'mdx', 'html-guide', 'pdf'].includes(format)) return 'Guides';
    if (['mp4', 'webm', 'gif'].includes(format)) return 'Motion';
    if (format === 'remix-source') return 'Source';
    return 'Launch media';
  }

  async function exportScene(format: 'yaml' | 'zip') {
    exporting = format;
    error = '';
    try {
      downloadPortable(
        format === 'zip' ? await exportSceneZip(scene) : await exportSceneYaml(scene),
      );
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The portable release could not be built.';
    } finally {
      exporting = null;
    }
  }

  async function copyText(value: string, key: string) {
    error = '';
    try {
      await navigator.clipboard.writeText(value);
      copiedKey = key;
      setTimeout(() => {
        if (copiedKey === key) copiedKey = '';
      }, 1_500);
    } catch {
      error = 'Clipboard access was denied. Select the command or scene ID to copy it manually.';
    }
  }
</script>

<section class="publish-view" aria-label="Export scene">
  <header>
    <div>
      <h2>Export this scene</h2>
      <p>
        Download portable source here. Use the CLI for privacy-gated production formats and
        deployment; Studio never uploads or deploys on your behalf.
      </p>
    </div>
  </header>

  {#if error}<p class="error-banner" role="alert">{error}</p>{/if}

  <div class="publish-layout">
    <div class="publish-main">
      <section class="release-card" aria-labelledby="release-contents">
        <div class="section-heading">
          <span>
            <strong id="release-contents">Portable release contents</strong>
            <small>Computed from the current saved scene</small>
          </span>
          <span class="draft-badge">Local only</span>
        </div>
        <div class="release-summary">
          <div>
            <span class="summary-icon"><Icon name="file" size={16} /></span>
            <span
              ><strong>{scene.steps.length} Steps</strong><small>{assetCount} visual assets</small
              ></span
            >
          </div>
          <div>
            <span class="summary-icon"><Icon name="globe" size={16} /></span>
            <span
              ><strong>{translationCount} translations</strong><small>Locale drafts retained</small
              ></span
            >
          </div>
          <div>
            <span class="summary-icon"><Icon name="lock" size={16} /></span>
            <span>
              <strong>{opaqueMaskCount} opaque masks</strong>
              <small>Irreversible privacy redaction</small>
            </span>
          </div>
          <div>
            <span class="summary-icon"><Icon name="mask" size={16} /></span>
            <span>
              <strong>{decorativeBlurCount} manual blurs</strong>
              <small>Decorative custom regions only</small>
            </span>
          </div>
        </div>
        <dl class="release-metadata">
          <div>
            <dt>Scene ID</dt>
            <dd>
              <code>{scene.id}</code>
              <button type="button" onclick={() => copyText(scene.id, 'scene-id')}>
                {copiedKey === 'scene-id' ? 'Copied' : 'Copy'}
              </button>
            </dd>
          </div>
          <div>
            <dt>Capability</dt>
            <dd>{scene.portableSource?.capability ?? 'captured'}</dd>
          </div>
          <div>
            <dt>Automation</dt>
            <dd>{scene.portableSource?.automation.level ?? 'none'}</dd>
          </div>
          <div>
            <dt>Checks</dt>
            <dd>{checkCount} definitions, no invented results</dd>
          </div>
        </dl>
      </section>

      <section class="distribution-card" aria-labelledby="distribution-policy">
        <details class="card-disclosure">
          <summary class="section-heading">
            <span>
              <strong id="distribution-policy">Safe public-distribution contract</strong>
              <small>SEO, analytics, forms, and remix defaults</small>
            </span>
            <Icon name="lock" size={16} />
          </summary>
          <div class="policy-grid">
            <article>
              <span class="policy-status safe">Default</span>
              <strong>SEO is noindex, nofollow</strong>
              <p>
                Indexing requires a reviewed public-catalog or static Channel and exact public URL.
              </p>
            </article>
            <article>
              <span class="policy-status off">Off</span>
              <strong>Analytics is opt-in</strong>
              <p>
                No request, cookie, browser identity, form field, or storage exists without <code
                  >public.analytics</code
                >.
              </p>
            </article>
            <article>
              <span class="policy-status off">Fail closed</span>
              <strong>Form delivery is opt-in</strong>
              <p>
                Standalone forms render unavailable until a reviewed <code>public.cta</code> endpoint
                and token source exist.
              </p>
            </article>
            <article>
              <span class="policy-status safe">Privacy-bound</span>
              <strong>Remix source stays useful</strong>
              <p>
                Routes, selectors, automation, checks, and raw captures are removed; flattened
                assets are integrity-bound.
              </p>
            </article>
          </div>
          <div class="config-sample">
            <div>
              <strong>Typed Project defaults</strong>
              <small>Use separate reviewed credentials for each optional public service.</small>
            </div>
            <pre><code
                >public:
  seo:
    index: false
    follow: false
  attribution: true
  remix: true
  # analytics: endpoint + tokenEnv + releaseId
  # cta: endpoint + tokenEnv + releaseId</code
              ></pre>
          </div>
        </details>
      </section>

      <section class="outputs-card" aria-labelledby="compiler-matrix">
        <details class="card-disclosure">
          <summary class="section-heading">
            <span>
              <strong id="compiler-matrix">Production compiler matrix</strong>
              <small>{compilerOutputs.length} formats available through the CLI</small>
            </span>
            <span class="format-count">{compilerOutputs.length} formats</span>
          </summary>
          <div class="compiler-table-wrap">
            <table class="compiler-table">
              <thead>
                <tr>
                  <th scope="col">Format</th>
                  <th scope="col">Use</th>
                  <th scope="col">Group</th>
                </tr>
              </thead>
              <tbody>
                {#each compilerOutputs as output (output.format)}
                  <tr>
                    <th scope="row">
                      <span class="output-icon"><Icon name={output.icon} size={15} /></span>
                      <span><strong>{output.label}</strong><code>{output.format}</code></span>
                    </th>
                    <td>{output.detail}</td>
                    <td>{compilerGroup(output.format)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <div class="recipe-strip" role="group" aria-label="Current step visibility recipes">
            {#each recipeOutputs as output (output.id)}
              <span>
                <Icon name={output.icon} size={14} />
                <strong>{output.label}</strong>
                <small
                  >{visibleCount(output.id)} / {scene.steps.length} steps · {output.detail}</small
                >
              </span>
            {/each}
          </div>
        </details>
      </section>

      <section class="handoff-card" aria-labelledby="cli-handoff">
        <details class="card-disclosure">
          <summary class="section-heading">
            <span>
              <strong id="cli-handoff">Verified CLI handoff</strong>
              <small>Commands to build and publish reviewed outputs</small>
            </span>
            <Icon name="code" size={16} />
          </summary>
          <ol class="command-list">
            {#each commands as command, index (command.key)}
              <li>
                <span class="command-number">{index + 1}</span>
                <span class="command-copy">
                  <strong>{command.label}</strong>
                  <code>{command.value}</code>
                </span>
                <button type="button" onclick={() => copyText(command.value, command.key)}>
                  <Icon name="copy" size={13} />
                  {copiedKey === command.key ? 'Copied' : 'Copy'}
                </button>
              </li>
            {/each}
          </ol>
          <p class="boundary-note">
            <Icon name="warning" size={14} />
            <span
              ><strong>Two separate destinations:</strong> deploy the entire generated directory to an
              independent static origin or CDN. Optional GitHub OIDC uploads a deterministic archive and
              evidence to the control plane for review; it does not deploy the static site, and the control
              plane never serves its active HTML or JavaScript.</span
            >
          </p>
        </details>
      </section>
    </div>

    <aside>
      <section class="artifact-card">
        <div class="section-heading">
          <span><strong>Scene YAML</strong><small>Human-reviewable canonical source</small></span>
          <Icon name="file" size={16} />
        </div>
        <p>
          Best for code review and readable diffs. Inline passive image data keeps a single file
          self-contained.
        </p>
        <ul>
          <li><Icon name="check" size={13} />Schema version 1</li>
          <li><Icon name="check" size={13} />Narrative, presentation, locales, checks</li>
          <li><Icon name="check" size={13} />No network or deployment side effect</li>
        </ul>
        <button
          class="button"
          type="button"
          disabled={Boolean(exporting)}
          onclick={() => exportScene('yaml')}
        >
          <Icon name="download" size={14} />
          {exporting === 'yaml' ? 'Preparing YAML…' : 'Download scene YAML'}
        </button>
      </section>

      <section class="artifact-card primary-artifact">
        <div class="section-heading">
          <span><strong>Scene ZIP</strong><small>Complete source handoff</small></span>
          <Icon name="collection" size={16} />
        </div>
        <p>
          Bundles <code>scene.yaml</code> with content-addressed passive raster assets and retained sidecars.
          Import verifies paths, sizes, media, and hashes.
        </p>
        <ul>
          <li><Icon name="check" size={13} />Portable across Studio instances</li>
          <li><Icon name="check" size={13} />No remote asset dependency</li>
          <li><Icon name="check" size={13} />Strict archive safety limits</li>
        </ul>
        <button
          class="button primary"
          type="button"
          disabled={Boolean(exporting)}
          onclick={() => exportScene('zip')}
        >
          <Icon name="download" size={14} />
          {exporting === 'zip' ? 'Preparing ZIP…' : 'Download scene ZIP'}
        </button>
      </section>

      <section class="deploy-card">
        <details class="card-disclosure">
          <summary class="section-heading">
            <span
              ><strong>Share and deploy</strong><small>Created by the privacy-gated CLI build</small
              ></span
            >
            <Icon name="globe" size={16} />
          </summary>
          <dl>
            <div>
              <dt>Canonical and social metadata</dt>
              <dd>From reviewed <code>public.baseUrl</code> and SEO copy</dd>
            </div>
            <div>
              <dt>Manifest share links</dt>
              <dd>Only for artifacts compiled in the same release</dd>
            </div>
            <div>
              <dt>Attribution</dt>
              <dd>On by default; explicit policy can disable it</dd>
            </div>
            <div>
              <dt>Rollback</dt>
              <dd>Retain the previous complete static directory</dd>
            </div>
          </dl>
        </details>
      </section>
    </aside>
  </div>
</section>

<style>
  .publish-view {
    display: grid;
    gap: 18px;
    margin: 0 auto;
    max-width: 1420px;
    min-height: calc(100vh - 178px);
    padding: 26px clamp(14px, 2.5vw, 34px) 52px;
  }
  .publish-view > header {
    align-items: end;
    display: flex;
    gap: 20px;
    justify-content: space-between;
  }
  h2 {
    font-size: 1.6rem;
    letter-spacing: -0.03em;
    margin: 5px 0;
  }
  .publish-view > header p {
    color: var(--muted);
    font-size: 0.84rem;
    line-height: 1.55;
    margin: 0;
    max-width: 82ch;
  }
  .section-heading strong,
  .section-heading small,
  .release-summary strong,
  .release-summary small,
  .compiler-table strong,
  .compiler-table code,
  .recipe-strip strong,
  .recipe-strip small,
  .command-copy strong,
  .command-copy code {
    display: block;
  }
  .section-heading small {
    color: var(--muted);
    font-size: 0.75rem;
    margin-top: 2px;
  }
  .error-banner {
    background: var(--broken-soft);
    border: 1px solid color-mix(in srgb, var(--broken) 25%, transparent);
    border-radius: 8px;
    color: var(--broken);
    font-size: 0.82rem;
    margin: 0;
    padding: 10px 12px;
  }
  .publish-layout {
    display: grid;
    gap: 14px;
    grid-template-columns: minmax(0, 1fr) 360px;
  }
  .publish-main,
  .publish-layout aside {
    align-content: start;
    display: grid;
    gap: 14px;
  }
  .publish-layout section {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .section-heading {
    align-items: center;
    border-bottom: 1px solid var(--line);
    display: flex;
    gap: 12px;
    justify-content: space-between;
    padding: 11px 13px;
  }
  .card-disclosure > summary {
    cursor: pointer;
    list-style: none;
    min-height: 46px;
  }
  .card-disclosure > summary::-webkit-details-marker {
    display: none;
  }
  .card-disclosure > summary::after {
    color: var(--muted);
    content: '+';
    font-size: 0.9rem;
    margin-left: 2px;
  }
  .card-disclosure[open] > summary::after {
    content: '−';
  }
  .section-heading strong {
    font-size: 0.8rem;
  }
  .draft-badge,
  .format-count,
  .policy-status {
    border-radius: 999px;
    font-size: 0.75rem;
    padding: 4px 8px;
  }
  .draft-badge,
  .format-count {
    background: var(--paper-2);
    color: var(--muted);
  }
  .release-summary {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
  }
  .release-summary > div {
    align-items: center;
    border-bottom: 1px solid var(--line);
    border-right: 1px solid var(--line);
    display: flex;
    gap: 8px;
    padding: 13px;
  }
  .summary-icon,
  .output-icon {
    align-items: center;
    background: var(--accent-soft);
    border-radius: 50%;
    color: var(--accent);
    display: flex;
    flex: 0 0 30px;
    height: 30px;
    justify-content: center;
  }
  .release-summary strong,
  .compiler-table strong {
    font-size: 0.78rem;
  }
  .release-summary small,
  .recipe-strip small {
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1.4;
    margin-top: 2px;
  }
  .release-metadata {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    margin: 0;
  }
  .release-metadata > div {
    align-items: center;
    border-right: 1px solid var(--line);
    border-top: 1px solid var(--line);
    display: grid;
    gap: 5px;
    grid-template-columns: 84px 1fr;
    padding: 10px 13px;
  }
  .release-metadata dt {
    color: var(--muted);
    font-size: 0.75rem;
  }
  .release-metadata dd {
    align-items: center;
    display: flex;
    font-size: 0.75rem;
    gap: 7px;
    justify-content: space-between;
    margin: 0;
    min-width: 0;
  }
  .release-metadata code {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .release-metadata button,
  .command-list button {
    background: transparent;
    border: 0;
    color: var(--accent);
    cursor: pointer;
    font-size: 0.75rem;
    min-height: 40px;
  }
  .policy-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
  }
  .policy-grid article {
    border-bottom: 1px solid var(--line);
    border-right: 1px solid var(--line);
    padding: 14px;
  }
  .policy-grid article > strong {
    display: block;
    font-size: 0.75rem;
    margin-top: 9px;
  }
  .policy-grid p {
    color: var(--muted);
    font-size: 0.8rem;
    line-height: 1.5;
    margin: 5px 0 0;
  }
  .policy-status.safe {
    background: color-mix(in srgb, var(--pass) 12%, transparent);
    color: var(--pass);
  }
  .policy-status.off {
    background: var(--paper-2);
    color: var(--muted);
  }
  .config-sample {
    align-items: start;
    display: grid;
    gap: 16px;
    grid-template-columns: 180px 1fr;
    padding: 14px;
  }
  .config-sample strong,
  .config-sample small {
    display: block;
  }
  .config-sample strong {
    font-size: 0.75rem;
  }
  .config-sample small {
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1.45;
    margin-top: 4px;
  }
  .config-sample pre {
    background: var(--paper-2);
    border-radius: 8px;
    font-size: 0.75rem;
    line-height: 1.55;
    margin: 0;
    overflow: auto;
    padding: 11px;
  }
  .compiler-table-wrap {
    overflow-x: auto;
  }
  .compiler-table {
    border-collapse: collapse;
    min-width: 560px;
    width: 100%;
  }
  .compiler-table th,
  .compiler-table td {
    border-bottom: 1px solid var(--line);
    font-size: 0.78rem;
    padding: 10px 12px;
    text-align: left;
  }
  .compiler-table thead th {
    background: var(--paper-2);
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 650;
  }
  .compiler-table tbody th {
    align-items: center;
    display: grid;
    gap: 9px;
    grid-template-columns: auto 1fr;
    min-width: 210px;
  }
  .compiler-table tbody tr:last-child > * {
    border-bottom: 0;
  }
  .compiler-table td {
    color: var(--muted);
  }
  .compiler-table code {
    color: var(--accent);
    font-size: 0.75rem;
    margin-top: 2px;
  }
  .recipe-strip {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
  }
  .recipe-strip > span {
    border-right: 1px solid var(--line);
    display: grid;
    gap: 3px;
    padding: 11px 13px;
  }
  .recipe-strip :global(svg) {
    color: var(--accent);
  }
  .recipe-strip strong {
    font-size: 0.75rem;
  }
  .command-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .command-list li {
    align-items: center;
    border-bottom: 1px solid var(--line);
    display: grid;
    gap: 10px;
    grid-template-columns: 24px minmax(0, 1fr) auto;
    padding: 11px 13px;
  }
  .command-number {
    align-items: center;
    background: var(--paper-2);
    border-radius: 50%;
    display: flex;
    font-size: 0.75rem;
    height: 28px;
    justify-content: center;
  }
  .command-copy {
    min-width: 0;
  }
  .command-copy strong {
    font-size: 0.75rem;
  }
  .command-copy code {
    color: var(--muted);
    font-size: 0.75rem;
    margin-top: 4px;
    overflow: auto;
    padding: 2px 0;
    white-space: nowrap;
  }
  .command-list button {
    align-items: center;
    display: flex;
    gap: 4px;
  }
  .boundary-note {
    align-items: flex-start;
    color: var(--muted);
    display: flex;
    font-size: 0.8rem;
    gap: 8px;
    line-height: 1.5;
    margin: 0;
    padding: 12px 14px;
  }
  .boundary-note :global(svg) {
    color: var(--accent);
    flex: 0 0 auto;
    margin-top: 2px;
  }
  .boundary-note strong {
    color: var(--ink);
  }
  .artifact-card > p {
    color: var(--muted);
    font-size: 0.8rem;
    line-height: 1.55;
    margin: 0;
    padding: 13px;
  }
  .artifact-card ul {
    display: grid;
    gap: 7px;
    list-style: none;
    margin: 0;
    padding: 0 13px 13px;
  }
  .artifact-card li {
    align-items: center;
    color: var(--muted);
    display: flex;
    font-size: 0.78rem;
    gap: 6px;
  }
  .artifact-card li :global(svg) {
    color: var(--pass);
  }
  .artifact-card > .button {
    justify-content: center;
    margin: 0 13px 13px;
    width: calc(100% - 26px);
  }
  .primary-artifact {
    border-color: color-mix(in srgb, var(--accent) 35%, var(--line)) !important;
  }
  .deploy-card dl {
    margin: 0;
  }
  .deploy-card dl > div {
    border-bottom: 1px solid var(--line);
    padding: 11px 13px;
  }
  .deploy-card dt {
    font-size: 0.75rem;
    font-weight: 650;
  }
  .deploy-card dd {
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1.45;
    margin: 3px 0 0;
  }
  @media (pointer: coarse) {
    .publish-view .button,
    .publish-view button,
    .card-disclosure > summary {
      min-height: 44px;
    }
  }
  @media (max-width: 940px) {
    .publish-layout {
      grid-template-columns: 1fr;
    }
    .publish-layout aside {
      grid-template-columns: repeat(2, 1fr);
      order: -1;
    }
    .primary-artifact {
      order: -1;
    }
    .deploy-card {
      grid-column: 1/-1;
    }
  }
  @media (max-width: 680px) {
    .publish-view > header {
      align-items: start;
    }
    .release-summary,
    .release-metadata,
    .policy-grid,
    .recipe-strip,
    .publish-layout aside,
    .config-sample {
      grid-template-columns: 1fr;
    }
    .deploy-card {
      grid-column: auto;
    }
    .artifact-card > p,
    .artifact-card > ul {
      display: none;
    }
    .artifact-card > .button {
      margin-top: 13px;
    }
    .command-list li {
      align-items: start;
      grid-template-columns: 24px minmax(0, 1fr);
    }
    .command-list button {
      grid-column: 2;
      justify-self: start;
    }
    .policy-grid article,
    .recipe-strip > span,
    .release-summary > div {
      border-right: 0;
    }
  }
</style>
