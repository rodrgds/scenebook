<script lang="ts">
  import type { EditorScene } from '../model';
  import { evidenceImage, runEvidenceStatus, selectedRunAttempt } from '../evidence';
  import Icon from './Icon.svelte';

  type AuditLevel = 'pass' | 'warning' | 'error';
  interface AuditItem {
    id: string;
    level: AuditLevel;
    title: string;
    detail: string;
    stepId?: string;
  }

  let { scene }: { scene: EditorScene } = $props();
  let lastAuditedAt = $state(Date.now());
  let selectedRevision = $state('');

  let firstImage = $derived(scene.steps.find((step) => step.image)?.image);
  let finalImage = $derived([...scene.steps].reverse().find((step) => step.image)?.image);
  let importedChecks = $derived(
    scene.portableSource?.steps.flatMap((step) =>
      step.checks.map((check) => ({ ...check, stepId: step.id })),
    ) ?? [],
  );
  let sourceCapability = $derived(scene.portableSource?.capability ?? 'captured');
  let selectedEvidence = $derived(
    scene.runEvidence?.find((evidence) => evidence.runRevision === selectedRevision) ??
      scene.runEvidence?.[0],
  );
  let selectedAttempt = $derived(
    selectedEvidence ? selectedRunAttempt(selectedEvidence.run) : undefined,
  );
  let baselineStates = $derived(
    new Map(
      (selectedEvidence?.baseline?.states ?? []).map((state) => [
        `${state.stepId}:${state.phase}`,
        state,
      ]),
    ),
  );
  let evidenceStates = $derived(selectedAttempt?.states ?? []);
  let reviewChanges = $derived(selectedEvidence?.review?.changes ?? []);
  let visualChanges = $derived(
    reviewChanges.filter((change) => ['visual', 'semantic', 'geometry'].includes(change.dimension)),
  );
  let functionalChanges = $derived(
    reviewChanges.filter((change) => change.dimension === 'functional'),
  );
  let audit = $derived.by(runAudit);
  let errors = $derived(audit.filter((item) => item.level === 'error'));
  let warnings = $derived(audit.filter((item) => item.level === 'warning'));
  let passes = $derived(audit.filter((item) => item.level === 'pass'));

  $effect(() => {
    if (!scene.runEvidence?.some((evidence) => evidence.runRevision === selectedRevision))
      selectedRevision = scene.runEvidence?.[0]?.runRevision ?? '';
  });

  function runAudit(): AuditItem[] {
    const items: AuditItem[] = [];
    const ids = new Set<string>();
    for (const step of scene.steps) {
      if (ids.has(step.id)) {
        items.push({
          id: `duplicate-${step.id}`,
          level: 'error',
          title: 'Duplicate Step ID',
          detail: `“${step.id}” is used more than once.`,
          stepId: step.id,
        });
      }
      ids.add(step.id);
      if (!step.title.trim())
        items.push({
          id: `title-${step.id}`,
          level: 'error',
          title: 'Step title is missing',
          detail: 'Every output needs a stable Step title.',
          stepId: step.id,
        });
      if (!step.instruction?.trim() && step.type !== 'separator')
        items.push({
          id: `instruction-${step.id}`,
          level: 'warning',
          title: 'Instruction is empty',
          detail: 'Guide and transcript outputs will have no instructional copy.',
          stepId: step.id,
        });
      if (step.type === 'screen' && !step.image)
        items.push({
          id: `image-${step.id}`,
          level: 'warning',
          title: 'Screenshot is missing',
          detail: 'This screen Step will render an empty visual state.',
          stepId: step.id,
        });
      if (step.type === 'screen' && step.image && !step.alt?.trim())
        items.push({
          id: `alt-${step.id}`,
          level: 'warning',
          title: 'Alt text is empty',
          detail: 'Add alt text unless this screenshot is intentionally decorative.',
          stepId: step.id,
        });
      if (step.type === 'choice' && step.choices.length === 0)
        items.push({
          id: `choice-${step.id}`,
          level: 'error',
          title: 'Choice has no destinations',
          detail: 'Add at least one target Scene.',
          stepId: step.id,
        });
      if (step.type === 'choice') {
        for (const choice of step.choices) {
          if (!choice.sceneId.trim() || choice.sceneId === scene.id)
            items.push({
              id: `choice-${step.id}-${choice.id}`,
              level: 'error',
              title: 'Choice destination is invalid',
              detail:
                choice.sceneId === scene.id
                  ? 'A choice cannot loop directly back to the same Scene.'
                  : 'Destination Scene ID is required.',
              stepId: step.id,
            });
        }
      }
      if (step.type === 'end' && step.ctas.length === 0)
        items.push({
          id: `cta-${step.id}`,
          level: 'warning',
          title: 'End card has no action',
          detail: 'Add a restart, product, or documentation action.',
          stepId: step.id,
        });
      if (step.type === 'end') {
        for (const cta of step.ctas) {
          const kind =
            cta.kind ??
            (cta.event === 'restart'
              ? 'restart'
              : cta.targetSceneId
                ? 'view-scene'
                : cta.fields?.length
                  ? 'form'
                  : 'external');
          if (['open-product', 'read-docs', 'book-call', 'external'].includes(kind) && !cta.href)
            items.push({
              id: `cta-url-${step.id}-${cta.id}`,
              level: 'error',
              title: 'Action URL is missing',
              detail: `“${cta.label}” needs an HTTP, HTTPS, or mailto destination.`,
              stepId: step.id,
            });
          if (kind === 'view-scene' && !cta.targetSceneId?.trim())
            items.push({
              id: `cta-scene-${step.id}-${cta.id}`,
              level: 'error',
              title: 'Action Scene is missing',
              detail: `“${cta.label}” needs a destination Scene ID.`,
              stepId: step.id,
            });
          if (kind === 'form' && !cta.fields?.length)
            items.push({
              id: `cta-form-${step.id}-${cta.id}`,
              level: 'error',
              title: 'Form has no fields',
              detail: `“${cta.label}” needs at least one form field.`,
              stepId: step.id,
            });
          for (const field of cta.fields ?? []) {
            if (!field.id.trim() || !field.label.trim())
              items.push({
                id: `cta-field-${step.id}-${cta.id}-${field.id}`,
                level: 'error',
                title: 'Form field is incomplete',
                detail: 'Every field needs an ID and label.',
                stepId: step.id,
              });
            if (field.type === 'checkbox' && field.required && !field.consent)
              items.push({
                id: `cta-consent-${step.id}-${cta.id}-${field.id}`,
                level: 'error',
                title: 'Required checkbox lacks consent semantics',
                detail: `“${field.label}” must be marked as explicit consent before export.`,
                stepId: step.id,
              });
          }
        }
      }
      if (!Object.values(step.outputVisibility).some(Boolean))
        items.push({
          id: `visibility-${step.id}`,
          level: 'warning',
          title: 'Step is hidden from every output',
          detail: 'Enable at least one output or remove the Step.',
          stepId: step.id,
        });
      if (step.image && /^https?:\/\//iu.test(step.image))
        items.push({
          id: `remote-${step.id}`,
          level: 'warning',
          title: 'Screenshot is remote',
          detail: 'Portable ZIP export cannot bundle a cross-origin image automatically.',
          stepId: step.id,
        });
    }

    for (const [locale, translation] of Object.entries(scene.translations ?? {})) {
      const translated = scene.steps.filter((step) => {
        const copy = translation.steps[step.id];
        return copy?.title?.trim() && (copy.instruction?.trim() || step.type === 'separator');
      }).length;
      if (translated < scene.steps.length)
        items.push({
          id: `locale-${locale}`,
          level: 'warning',
          title: `${locale} translation is incomplete`,
          detail: `${translated} of ${scene.steps.length} Steps have translated title and instruction copy.`,
        });
    }

    if (items.length === 0)
      items.push({
        id: 'clean',
        level: 'pass',
        title: 'Authoring audit passes',
        detail:
          'No structural, accessibility, portability, or output-visibility issues were found.',
      });
    else {
      items.push({
        id: 'ids',
        level: 'pass',
        title: 'Scene structure parsed',
        detail: `${scene.steps.length} Steps are available for output compilation.`,
      });
      if (!scene.steps.some((step) => step.masks.length > 0))
        items.push({
          id: 'privacy',
          level: 'pass',
          title: 'No manual redactions configured',
          detail:
            'This is informational; Studio cannot infer whether screenshots contain private data.',
        });
    }
    return items;
  }

  function rerunAudit() {
    lastAuditedAt = Date.now();
  }
</script>

<section class="health-view" aria-label="Scene authoring health">
  <header
    class:error={errors.length > 0}
    class:warning={errors.length === 0 && warnings.length > 0}
  >
    <div class="health-state">
      <span class="state-icon"
        ><Icon
          name={errors.length ? 'close' : warnings.length ? 'warning' : 'check'}
          size={21}
        /></span
      >
      <div>
        <h2>
          {errors.length
            ? `${errors.length} blocking ${errors.length === 1 ? 'issue' : 'issues'}`
            : warnings.length
              ? `${warnings.length} improvements recommended`
              : 'Ready for portable export'}
        </h2>
        <p>
          This audit checks the current Scene source. It does not claim to replay the product or
          compare visual baselines.
        </p>
      </div>
    </div>
    <div class="audit-meta">
      <span><strong>{passes.length}</strong> passed</span><span
        ><strong>{warnings.length}</strong> warnings</span
      ><span><strong>{errors.length}</strong> errors</span>
      <button class="button" type="button" onclick={rerunAudit}
        ><Icon name="runs" size={13} />Run again</button
      >
      <small>Last run {new Date(lastAuditedAt).toLocaleTimeString()}</small>
    </div>
  </header>

  {#if scene.runEvidence?.length}
    <section class="evidence-picker" aria-label="Attached Run evidence">
      <div>
        <strong
          >{scene.runEvidence.length} exact Run revision{scene.runEvidence.length === 1 ? '' : 's'} attached</strong
        >
      </div>
      <label>
        Review Run
        <select bind:value={selectedRevision}>
          {#each scene.runEvidence as evidence (evidence.runRevision)}
            <option value={evidence.runRevision}>
              {new Date(evidence.run.endedAt).toLocaleString()} · {evidence.run.runTargetId} · {runEvidenceStatus(
                evidence.run,
              )}
            </option>
          {/each}
        </select>
      </label>
    </section>
  {/if}

  <div class="health-layout">
    <div class="health-main">
      <section class="audit-card">
        <div class="card-heading">
          <div>
            <h3>Authoring diagnostics</h3>
          </div>
          <span>{audit.length} checks</span>
        </div>
        <ul>
          {#each audit as item}
            <li class={`level-${item.level}`}>
              <span class="audit-icon"
                ><Icon
                  name={item.level === 'pass'
                    ? 'check'
                    : item.level === 'error'
                      ? 'close'
                      : 'warning'}
                  size={14}
                /></span
              >
              <span><strong>{item.title}</strong><small>{item.detail}</small></span>
              {#if item.stepId}<code>{item.stepId}</code>{/if}
            </li>
          {/each}
        </ul>
      </section>

      <section class="visual-card">
        <div class="card-heading">
          <div>
            <h3>Baseline and candidate evidence</h3>
          </div>
          <span
            >{selectedEvidence?.review
              ? `${visualChanges.length} visual / semantic / geometry changes`
              : 'No exact Review attached'}</span
          >
        </div>
        {#if selectedEvidence && evidenceStates.length}
          <div class="evidence-state-list">
            {#each evidenceStates as state (state.id)}
              {@const baseline = baselineStates.get(`${state.stepId}:${state.phase}`)}
              {@const stateChanges = visualChanges.filter(
                (change) =>
                  change.stateId === state.id ||
                  (!change.stateId && change.stepId === state.stepId),
              )}
              <article class="evidence-state">
                <header>
                  <span
                    ><strong>{state.stepId}</strong><small
                      >{state.phase} · {state.viewport.width}×{state.viewport.height} · {state.route}</small
                    ></span
                  >
                  <span
                    class={`status-chip ${state.privacy.status === 'clear' ? 'passed' : state.privacy.status === 'warning' ? 'changed' : 'blocked'}`}
                    >privacy {state.privacy.status}</span
                  >
                </header>
                <div class="visual-grid evidence-visual-grid">
                  <figure>
                    <figcaption>Approved Baseline</figcaption>
                    {#if baseline && evidenceImage(scene, baseline.screenshotHash)}
                      <img
                        src={evidenceImage(scene, baseline.screenshotHash)}
                        alt={`Baseline evidence for ${state.stepId} ${state.phase}`}
                      />
                    {:else}<div class="visual-missing">
                        {baseline
                          ? 'Baseline screenshot is not local'
                          : 'No exact Baseline state attached'}
                      </div>{/if}
                  </figure>
                  <figure>
                    <figcaption>
                      Run candidate · <span class="mono">{state.screenshotHash.slice(0, 10)}</span>
                    </figcaption>
                    {#if evidenceImage(scene, state.screenshotHash)}
                      <img
                        src={evidenceImage(scene, state.screenshotHash)}
                        alt={`Run evidence for ${state.stepId} ${state.phase}`}
                      />
                    {:else}<div class="visual-missing">Referenced screenshot is not local</div>{/if}
                  </figure>
                </div>
                {#if stateChanges.length}
                  <ul class="state-change-list">
                    {#each stateChanges as change (change.id)}
                      <li>
                        <span>{change.dimension}</span><strong>{change.summary}</strong>
                        {#if Object.keys(change.metrics).length}<small
                            >{Object.entries(change.metrics)
                              .map(([name, value]) => `${name} ${Number(value).toFixed(3)}`)
                              .join(' · ')}</small
                          >{/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
              </article>
            {/each}
          </div>
        {:else if firstImage || finalImage}
          <div class="visual-grid">
            <figure>
              <figcaption>Authored first image · not Run evidence</figcaption>
              {#if firstImage}<img src={firstImage} alt="First authored Scene visual" />{/if}
            </figure>
            <figure>
              <figcaption>Authored final image · not Run evidence</figcaption>
              {#if finalImage}<img src={finalImage} alt="Final authored Scene visual" />{/if}
            </figure>
          </div>
        {:else}<p class="empty">No authored or execution screenshots are available.</p>{/if}
      </section>
    </div>

    <aside>
      <section class="verification-card">
        <div class="card-heading">
          <div>
            <h3>Source and Run status</h3>
          </div>
          <Icon name={selectedEvidence ? 'check' : 'warning'} size={16} />
        </div>
        <dl>
          <div>
            <dt>Authored capability</dt>
            <dd>{sourceCapability}</dd>
          </div>
          <div>
            <dt>Run evidence</dt>
            <dd>{selectedEvidence ? runEvidenceStatus(selectedEvidence.run) : 'Not attached'}</dd>
          </div>
        </dl>
        {#if scene.sample}
          <p>
            This is synthetic sample data. It has no product Run, commit, environment, approval, or
            publication.
          </p>
        {:else if selectedEvidence}
          <dl>
            <div>
              <dt>Run</dt>
              <dd class="mono">{selectedEvidence.run.id}</dd>
            </div>
            <div>
              <dt>Revision</dt>
              <dd class="mono">{selectedEvidence.runRevision.slice(0, 12)}</dd>
            </div>
            <div>
              <dt>Commit</dt>
              <dd class="mono">{selectedEvidence.run.repository.commit}</dd>
            </div>
            <div>
              <dt>Run Target</dt>
              <dd>{selectedEvidence.run.runTargetId}</dd>
            </div>
            <div>
              <dt>Recorded</dt>
              <dd>{new Date(selectedEvidence.run.endedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Privacy</dt>
              <dd>{selectedEvidence.run.privacy.status}</dd>
            </div>
            <div>
              <dt>Assets</dt>
              <dd>
                {selectedEvidence.verifiedAssetHashes.length} verified · {selectedEvidence
                  .missingAssetHashes.length} missing
              </dd>
            </div>
            <div>
              <dt>Review</dt>
              <dd>
                {selectedEvidence.review
                  ? `${selectedEvidence.review.status} · ${selectedEvidence.review.changes.length} changes`
                  : 'Not included'}
              </dd>
            </div>
          </dl>
          <p>
            Source revision, exact Step coverage, artifact bindings, and every local screenshot were
            verified before this immutable Run was attached.
          </p>
        {:else}<p>
            No executable Run result is attached. A Verified source declaration is not itself
            passing evidence.
          </p>{/if}
      </section>

      <details class="results-card health-disclosure">
        <summary>
          <span
            ><strong>Functional results</strong><small
              >{selectedAttempt
                ? `${selectedAttempt.checks.length} checks · ${selectedAttempt.errors.length} errors`
                : 'No Run selected'}</small
            ></span
          >
        </summary>
        {#if selectedAttempt}
          <ul>
            {#each selectedAttempt.checks as check (check.checkId)}
              <li>
                <Icon name={check.status === 'passed' ? 'check' : 'warning'} size={13} />
                <span
                  ><strong>{check.message ?? check.checkId}</strong><small
                    >{check.status} · {check.stepId}{#if check.source}
                      · {check.source.path}:{check.source.line}{/if}</small
                  ></span
                >
              </li>
            {/each}
            {#each selectedAttempt.errors as runError, index (`${runError.class}:${index}`)}
              <li class="run-error">
                <Icon name="warning" size={13} /><span
                  ><strong>{runError.message}</strong><small
                    >{runError.class}{#if runError.stepId}
                      · {runError.stepId}{/if}</small
                  ></span
                >
              </li>
            {/each}
            {#each functionalChanges as change (change.id)}
              <li class="run-error">
                <Icon name="changes" size={13} /><span
                  ><strong>{change.summary}</strong><small
                    >Review · {change.kind}{#if change.stepId}
                      · {change.stepId}{/if}</small
                  ></span
                >
              </li>
            {/each}
          </ul>
          {#if selectedAttempt.checks.length === 0 && selectedAttempt.errors.length === 0 && functionalChanges.length === 0}
            <p>No Checks or functional failures were emitted by this selected attempt.</p>
          {/if}
        {:else}<p>Import Run evidence to inspect exact Check and error results.</p>{/if}
      </details>

      <details class="checks-card health-disclosure">
        <summary>
          <span
            ><strong>Executable checks</strong><small>{importedChecks.length} definitions</small
            ></span
          >
        </summary>
        {#if importedChecks.length}
          <ul>
            {#each importedChecks as check}<li>
                <Icon name="code" size={13} /><span
                  ><strong>{check.description}</strong><small>{check.kind} · {check.stepId}</small
                  ></span
                >
              </li>{/each}
          </ul>
          <p>These are check definitions, not pass results.</p>
        {:else}<p>No executable checks are attached to this Scene.</p>{/if}
      </details>

      <details class="privacy-card health-disclosure">
        <summary>
          <span
            ><strong>Redactions</strong><small
              >{scene.steps.reduce((count, step) => count + step.masks.length, 0)} masks</small
            ></span
          >
          <Icon name="lock" size={16} />
        </summary>
        <dl>
          <div>
            <dt>Opaque masks</dt>
            <dd>{scene.steps.reduce((count, step) => count + step.masks.length, 0)}</dd>
          </div>
          <div>
            <dt>Screenshots</dt>
            <dd>{scene.steps.filter((step) => step.image).length}</dd>
          </div>
          {#if selectedEvidence}
            <div>
              <dt>Run scan</dt>
              <dd>{selectedEvidence.run.privacy.status}</dd>
            </div>
            <div>
              <dt>Findings</dt>
              <dd>{selectedEvidence.run.privacy.findings.length}</dd>
            </div>
          {/if}
        </dl>
        <p>
          {selectedEvidence
            ? `This exact Run reports scanner ${selectedEvidence.run.privacy.scannerVersion ?? 'not recorded'} at ${selectedEvidence.run.privacy.scannedAt ? new Date(selectedEvidence.run.privacy.scannedAt).toLocaleString() : 'an unknown time'}.`
            : 'Studio preserves configured masks. It does not claim an OCR or PII scan unless evidence is imported.'}
        </p>
      </details>
    </aside>
  </div>
</section>

<style>
  .health-view {
    background: var(--paper-2);
    min-height: calc(100vh - 178px);
    padding: 22px clamp(14px, 2.4vw, 32px) 52px;
  }
  .health-view > header {
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    display: flex;
    gap: 24px;
    justify-content: space-between;
    margin: 0 auto 14px;
    max-width: 1380px;
    padding: 16px 18px;
  }
  .health-view > header.warning {
    border-color: color-mix(in srgb, var(--changed) 35%, var(--line));
  }
  .health-view > header.error {
    border-color: color-mix(in srgb, var(--broken) 35%, var(--line));
  }
  .health-state {
    align-items: center;
    display: flex;
    gap: 12px;
  }
  .state-icon {
    align-items: center;
    background: var(--pass-soft);
    border-radius: 50%;
    color: var(--pass);
    display: flex;
    height: 40px;
    justify-content: center;
    width: 40px;
  }
  header.warning .state-icon {
    background: var(--changed-soft);
    color: var(--changed);
  }
  header.error .state-icon {
    background: var(--broken-soft);
    color: var(--broken);
  }
  h2 {
    font-size: 1.2rem;
    letter-spacing: -0.035em;
    margin: 3px 0;
  }
  .health-state p {
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1.5;
    margin: 0;
  }
  .audit-meta {
    align-items: center;
    display: grid;
    gap: 4px 10px;
    grid-template-columns: repeat(3, auto) auto;
  }
  .audit-meta span {
    color: var(--muted);
    font-size: 0.7rem;
  }
  .audit-meta span strong {
    color: var(--ink);
  }
  .audit-meta small {
    color: var(--muted);
    font-size: 0.72rem;
    grid-column: 1 / -1;
    text-align: right;
  }
  .evidence-picker {
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    display: flex;
    gap: 20px;
    justify-content: space-between;
    margin: 0 auto 14px;
    max-width: 1380px;
    padding: 11px 14px;
  }
  .evidence-picker > div {
    display: grid;
    gap: 3px;
  }
  .evidence-picker strong {
    font-size: 0.75rem;
  }
  .evidence-picker label {
    color: var(--muted);
    display: grid;
    font-size: 0.7rem;
    gap: 4px;
    min-width: min(430px, 55vw);
  }
  .evidence-picker select {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 7px;
    color: var(--ink);
    font-size: 0.75rem;
    min-height: 40px;
    padding: 5px 8px;
  }
  .health-layout {
    display: grid;
    gap: 14px;
    grid-template-columns: minmax(0, 1fr) 330px;
    margin: 0 auto;
    max-width: 1380px;
  }
  .health-main,
  .health-layout aside {
    align-content: start;
    display: grid;
    gap: 14px;
  }
  .health-layout section,
  .health-disclosure {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .card-heading {
    align-items: center;
    border-bottom: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    padding: 12px 14px;
  }
  .card-heading h3 {
    font-size: 0.78rem;
    margin: 3px 0 0;
  }
  .card-heading > span {
    color: var(--muted);
    font-size: 0.7rem;
  }
  .health-disclosure > summary {
    align-items: center;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    list-style: none;
    min-height: 44px;
    padding: 12px 14px;
  }
  .health-disclosure > summary::-webkit-details-marker {
    display: none;
  }
  .health-disclosure > summary::after {
    color: var(--muted);
    content: '+';
    font-size: 0.9rem;
    margin-left: 10px;
  }
  .health-disclosure[open] > summary {
    border-bottom: 1px solid var(--line);
  }
  .health-disclosure[open] > summary::after {
    content: '−';
  }
  .health-disclosure > summary > span {
    flex: 1;
  }
  .health-disclosure > summary strong,
  .health-disclosure > summary small {
    display: block;
  }
  .health-disclosure > summary strong {
    font-size: 0.75rem;
  }
  .health-disclosure > summary small {
    color: var(--muted);
    font-size: 0.72rem;
    margin-top: 2px;
  }
  .audit-card ul,
  .checks-card ul,
  .results-card ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .audit-card li {
    align-items: center;
    border-top: 1px solid var(--line);
    display: grid;
    gap: 9px;
    grid-template-columns: auto 1fr auto;
    padding: 11px 14px;
  }
  .audit-card li:first-child {
    border-top: 0;
  }
  .audit-icon {
    align-items: center;
    background: var(--pass-soft);
    border-radius: 50%;
    color: var(--pass);
    display: flex;
    height: 27px;
    justify-content: center;
    width: 27px;
  }
  .level-warning .audit-icon {
    background: var(--changed-soft);
    color: var(--changed);
  }
  .level-error .audit-icon {
    background: var(--broken-soft);
    color: var(--broken);
  }
  .audit-card strong,
  .audit-card small,
  .checks-card strong,
  .checks-card small,
  .results-card strong,
  .results-card small {
    display: block;
  }
  .audit-card strong,
  .checks-card strong,
  .results-card strong {
    font-size: 0.72rem;
  }
  .audit-card small,
  .checks-card small,
  .results-card small {
    color: var(--muted);
    font-size: 0.72rem;
    line-height: 1.4;
    margin-top: 2px;
  }
  .audit-card code {
    color: var(--muted);
    font-size: 0.72rem;
  }
  .visual-grid {
    display: grid;
    gap: 1px;
    grid-template-columns: 1fr 1fr;
  }
  .visual-grid figure {
    background: var(--paper-2);
    margin: 0;
    min-width: 0;
  }
  .visual-grid figcaption {
    color: var(--muted);
    font-size: 0.72rem;
    padding: 8px 10px;
  }
  .visual-grid img {
    aspect-ratio: 16 / 9;
    display: block;
    object-fit: contain;
    width: 100%;
  }
  .evidence-state-list {
    display: grid;
    gap: 1px;
  }
  .evidence-state {
    background: var(--paper-2);
  }
  .evidence-state > header {
    align-items: center;
    background: var(--surface);
    border-top: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    padding: 9px 11px;
  }
  .evidence-state:first-child > header {
    border-top: 0;
  }
  .evidence-state header strong,
  .evidence-state header small {
    display: block;
  }
  .evidence-state header strong {
    font-size: 0.72rem;
  }
  .evidence-state header small {
    color: var(--muted);
    font-size: 0.72rem;
    margin-top: 2px;
  }
  .evidence-visual-grid {
    border-top: 1px solid var(--line);
  }
  .visual-missing {
    align-items: center;
    aspect-ratio: 16 / 9;
    color: var(--muted);
    display: flex;
    font-size: 0.7rem;
    justify-content: center;
    padding: 18px;
    text-align: center;
  }
  .state-change-list {
    background: var(--surface);
    border-top: 1px solid var(--line);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .state-change-list li {
    align-items: baseline;
    border-top: 1px solid var(--line);
    display: grid;
    gap: 8px;
    grid-template-columns: 64px 1fr auto;
    padding: 8px 10px;
  }
  .state-change-list li:first-child {
    border-top: 0;
  }
  .state-change-list span {
    color: var(--info);
    font-size: 0.72rem;
    font-weight: 720;
    text-transform: uppercase;
  }
  .state-change-list strong,
  .state-change-list small {
    font-size: 0.7rem;
  }
  .state-change-list small {
    color: var(--muted);
  }
  .empty {
    color: var(--muted);
    font-size: 0.72rem;
    margin: 0;
    padding: 24px;
    text-align: center;
  }
  .verification-card > p,
  .checks-card > p,
  .results-card > p,
  .privacy-card > p {
    color: var(--muted);
    font-size: 0.7rem;
    line-height: 1.5;
    margin: 0;
    padding: 12px 14px;
  }
  aside dl {
    display: grid;
    margin: 0;
  }
  aside dl div {
    border-top: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    padding: 9px 13px;
  }
  aside dt,
  aside dd {
    font-size: 0.7rem;
    margin: 0;
  }
  aside dt {
    color: var(--muted);
  }
  .checks-card li,
  .results-card li {
    align-items: center;
    border-top: 1px solid var(--line);
    display: grid;
    gap: 8px;
    grid-template-columns: auto 1fr;
    padding: 9px 13px;
  }
  .results-card li :global(svg) {
    color: var(--pass);
  }
  .results-card li.run-error :global(svg) {
    color: var(--broken);
  }
  @media (pointer: coarse) {
    .health-view .button,
    .health-view select,
    .health-disclosure > summary {
      min-height: 44px;
    }
  }
  @media (max-width: 880px) {
    .health-view > header {
      align-items: flex-start;
      flex-direction: column;
    }
    .audit-meta {
      width: 100%;
    }
    .health-layout {
      grid-template-columns: 1fr;
    }
    .health-layout aside {
      grid-template-columns: repeat(2, 1fr);
    }
    .evidence-picker {
      align-items: stretch;
      flex-direction: column;
    }
    .evidence-picker label {
      min-width: 0;
    }
  }
  @media (max-width: 580px) {
    .audit-meta {
      grid-template-columns: repeat(3, 1fr);
    }
    .audit-meta .button {
      grid-column: 1 / -1;
    }
    .visual-grid,
    .health-layout aside {
      grid-template-columns: 1fr;
    }
  }
</style>
