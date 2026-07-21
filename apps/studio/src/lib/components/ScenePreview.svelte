<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  import { registerScenebookPlayer, type SceneDefinition } from '@scenebook/viewer';

  import { toPlayerScene } from '../model';
  import type { EditorScene } from '../model';
  import { downloadPortable, exportSceneZip } from '../portable';
  import Icon from './Icon.svelte';
  import PresentationPreview from './PresentationPreview.svelte';

  type PreviewMode = 'walkthrough' | 'guide' | 'motion' | 'social';

  let { scene }: { scene: EditorScene } = $props();
  let mode = $state<PreviewMode>('walkthrough');
  let viewport = $state<'desktop' | 'tablet' | 'mobile'>('desktop');
  let player:
    | (HTMLElement & { scene: SceneDefinition; scenes: Record<string, SceneDefinition> })
    | undefined = $state();
  let registered = $state(false);
  let currentMotion = $state(0);
  let motionPlaying = $state(false);
  let exportState = $state<'idle' | 'exporting' | 'error'>('idle');
  let exportError = $state('');
  let motionTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    registerScenebookPlayer();
    registered = true;
    if (player) {
      player.scenes = scene.id === 'invite-teammate' ? includedExampleBranches : {};
      player.scene = interactiveScene;
    }
  });

  $effect(() => {
    if (registered && player) {
      player.scenes = scene.id === 'invite-teammate' ? includedExampleBranches : {};
      player.scene = interactiveScene;
    }
  });

  const includedExampleBranches: Record<string, SceneDefinition> = {
    'invite-member-access': {
      version: 1,
      id: 'invite-member-access',
      title: 'Invite a member',
      steps: [
        {
          id: 'member-path',
          type: 'end',
          title: 'Member access path selected',
          instruction: 'This choice opens a separate linear, independently verified scene.',
          ctas: [{ id: 'restart', label: 'Return to the main scene', event: 'restart' }],
        },
      ],
    },
    'invite-admin-access': {
      version: 1,
      id: 'invite-admin-access',
      title: 'Invite an administrator',
      steps: [
        {
          id: 'admin-path',
          type: 'end',
          title: 'Administrator path selected',
          instruction: 'This choice opens a separate linear, independently verified scene.',
          ctas: [{ id: 'restart', label: 'Return to the main scene', event: 'restart' }],
        },
      ],
    },
  };

  let playerScene = $derived(toPlayerScene(scene));
  let interactiveScene = $derived.by(() => {
    return {
      ...playerScene,
      steps: playerScene.steps.filter(
        (_, index) => scene.steps[index]?.outputVisibility.interactive,
      ),
    };
  });
  let visibleGuideSteps = $derived(
    playerScene.steps.filter((_, index) => scene.steps[index]?.outputVisibility.guide),
  );
  let motionSteps = $derived(
    playerScene.steps.filter((_, index) => scene.steps[index]?.outputVisibility.motion),
  );
  let socialSteps = $derived(
    playerScene.steps.filter((_, index) => scene.steps[index]?.outputVisibility.social),
  );
  let verifiedLabel = $derived(
    scene.sample
      ? 'Synthetic sample · no run evidence'
      : scene.verified
        ? scene.verified.at
          ? `Verified ${new Date(scene.verified.at).toLocaleString()}`
          : 'Verification attached · date not recorded'
        : 'Local preview · not verified',
  );

  $effect(() => {
    if (currentMotion >= motionSteps.length) currentMotion = Math.max(0, motionSteps.length - 1);
  });

  onDestroy(() => {
    if (motionTimer) clearTimeout(motionTimer);
  });

  function stopMotion() {
    motionPlaying = false;
    if (motionTimer) clearTimeout(motionTimer);
    motionTimer = undefined;
  }

  function scheduleMotion() {
    if (!motionPlaying || motionSteps.length < 2) return;
    const duration = Math.max(250, motionSteps[currentMotion]?.durationMs ?? 2_400);
    motionTimer = setTimeout(() => {
      if (!motionPlaying) return;
      currentMotion = (currentMotion + 1) % motionSteps.length;
      scheduleMotion();
    }, duration);
  }

  function toggleMotion() {
    if (motionPlaying) {
      stopMotion();
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      exportError = 'Automatic playback is disabled while reduced motion is enabled.';
      return;
    }
    if (motionSteps.length < 2) return;
    motionPlaying = true;
    scheduleMotion();
  }

  function handleModeKeydown(event: KeyboardEvent, current: PreviewMode) {
    const modes: PreviewMode[] = ['walkthrough', 'guide', 'motion', 'social'];
    const currentIndex = modes.indexOf(current);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % modes.length;
    else if (event.key === 'ArrowLeft')
      nextIndex = (currentIndex - 1 + modes.length) % modes.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = modes.length - 1;
    else return;
    event.preventDefault();
    mode = modes[nextIndex]!;
    queueMicrotask(() => document.getElementById(`preview-tab-${mode}`)?.focus());
  }

  async function exportPortableScene() {
    exportState = 'exporting';
    exportError = '';
    try {
      downloadPortable(await exportSceneZip(scene));
      exportState = 'idle';
    } catch (error) {
      exportState = 'error';
      exportError = error instanceof Error ? error.message : 'The scene could not be exported.';
    }
  }
</script>

<section class="preview-view" aria-label="Scene preview">
  <div class="preview-toolbar">
    <div class="mode-switch" role="tablist" aria-label="Output preview">
      <button
        id="preview-tab-walkthrough"
        role="tab"
        aria-controls="preview-panel"
        aria-selected={mode === 'walkthrough'}
        tabindex={mode === 'walkthrough' ? 0 : -1}
        class:active={mode === 'walkthrough'}
        type="button"
        onkeydown={(event) => handleModeKeydown(event, 'walkthrough')}
        onclick={() => (mode = 'walkthrough')}><Icon name="play" size={15} />Walkthrough</button
      >
      <button
        id="preview-tab-guide"
        role="tab"
        aria-controls="preview-panel"
        aria-selected={mode === 'guide'}
        tabindex={mode === 'guide' ? 0 : -1}
        class:active={mode === 'guide'}
        type="button"
        onkeydown={(event) => handleModeKeydown(event, 'guide')}
        onclick={() => (mode = 'guide')}><Icon name="guide" size={15} />Guide</button
      >
      <button
        id="preview-tab-motion"
        role="tab"
        aria-controls="preview-panel"
        aria-selected={mode === 'motion'}
        tabindex={mode === 'motion' ? 0 : -1}
        class:active={mode === 'motion'}
        type="button"
        onkeydown={(event) => handleModeKeydown(event, 'motion')}
        onclick={() => (mode = 'motion')}><Icon name="video" size={15} />Motion</button
      >
      <button
        id="preview-tab-social"
        role="tab"
        aria-controls="preview-panel"
        aria-selected={mode === 'social'}
        tabindex={mode === 'social' ? 0 : -1}
        class:active={mode === 'social'}
        type="button"
        onkeydown={(event) => handleModeKeydown(event, 'social')}
        onclick={() => (mode = 'social')}><Icon name="globe" size={15} />Launch media</button
      >
    </div>
    {#if mode === 'walkthrough'}
      <div class="viewport-switch" role="group" aria-label="Preview viewport">
        <button
          class:active={viewport === 'desktop'}
          type="button"
          aria-pressed={viewport === 'desktop'}
          onclick={() => (viewport = 'desktop')}>Desktop</button
        >
        <button
          class:active={viewport === 'tablet'}
          type="button"
          aria-pressed={viewport === 'tablet'}
          onclick={() => (viewport = 'tablet')}>Tablet</button
        >
        <button
          class:active={viewport === 'mobile'}
          type="button"
          aria-pressed={viewport === 'mobile'}
          onclick={() => (viewport = 'mobile')}>Mobile</button
        >
      </div>
    {:else}<span class="preview-context">{verifiedLabel}</span>{/if}
    <div class="preview-actions">
      <button
        class="button primary"
        type="button"
        disabled={exportState === 'exporting'}
        onclick={exportPortableScene}
        ><Icon name="download" size={14} />{exportState === 'exporting'
          ? 'Preparing…'
          : 'Download scene ZIP'}</button
      >
    </div>
  </div>
  {#if exportError}<p class="preview-error" role="alert">{exportError}</p>{/if}

  <div
    id="preview-panel"
    class="preview-stage"
    class:guide={mode === 'guide'}
    role="tabpanel"
    tabindex="0"
    aria-labelledby={`preview-tab-${mode}`}
  >
    {#if mode === 'walkthrough'}
      <div
        class="device-preview"
        class:tablet={viewport === 'tablet'}
        class:mobile={viewport === 'mobile'}
      >
        <div class="address-bar">
          <span></span><span></span><span></span><i>local-preview/{scene.id}</i>
        </div>
        <div class="embed-shell">
          {#if registered}
            <scenebook-player bind:this={player} transcript></scenebook-player>
          {:else}
            <div class="loading-player"><span></span>Loading accessible player…</div>
          {/if}
        </div>
      </div>
    {:else if mode === 'guide'}
      <article class="guide-page">
        <header>
          <span class="guide-brand"><i>S</i> Product guide</span>
          <span class="guide-version">{verifiedLabel}</span>
          <h1>{scene.title}</h1>
          <p>{scene.description}</p>
          <div class="guide-proof" class:unverified={!scene.verified}>
            <Icon name={scene.verified ? 'check' : 'warning'} size={15} /><span
              ><strong
                >{scene.sample
                  ? 'Synthetic sample'
                  : scene.verified
                    ? 'Run evidence attached'
                    : 'Local authoring preview'}</strong
              ><small
                >{scene.sample
                  ? 'No product run, commit, environment, or publication is attached.'
                  : scene.verified
                    ? `${scene.verified.environment} · ${scene.verified.commit}`
                    : 'No executable run evidence is attached to this scene.'}</small
              ></span
            >
          </div>
        </header>
        <ol>
          {#each visibleGuideSteps as step, index}
            <li>
              <span class="guide-step-number mono">{String(index + 1).padStart(2, '0')}</span>
              <div class="guide-copy">
                <h2>{step.title}</h2>
                <p>{step.instruction}</p>
              </div>
              {#if step.image && step.type === 'screen'}<div class="guide-figure">
                  <PresentationPreview {step} aspect="standard" />{#if step.caption}<p
                      class="guide-caption"
                    >
                      {step.caption}
                    </p>{/if}
                </div>{/if}
              {#if step.type === 'choice'}<div class="guide-choice">
                  <Icon name="branch" size={16} /><span
                    >This guide continues through the <strong>{step.choices?.[0]?.label}</strong> path.</span
                  >
                </div>{/if}
            </li>
          {/each}
        </ol>
      </article>
    {:else if mode === 'motion'}
      <div class="motion-preview">
        <div class="motion-frame">
          {#if motionSteps.length === 0}<div class="preview-empty">
              <Icon name="video" size={22} /><strong>No motion-visible steps</strong><span
                >Enable Motion in a step’s output visibility.</span
              >
            </div>{:else if motionSteps[currentMotion]}
            <PresentationPreview step={motionSteps[currentMotion]!} aspect="wide" />
          {/if}
          <div class="motion-caption">
            <span class="mono">{String(currentMotion + 1).padStart(2, '0')}</span><strong
              >{motionSteps[currentMotion]?.title}</strong
            >
            <p>{motionSteps[currentMotion]?.instruction}</p>
          </div>
        </div>
        <div class="motion-controls">
          <button
            class="icon-button"
            type="button"
            aria-label="Previous motion frame"
            disabled={currentMotion === 0}
            onclick={() => (currentMotion -= 1)}><Icon name="arrow-left" size={16} /></button
          >
          <button
            class="motion-play"
            type="button"
            disabled={motionSteps.length < 2}
            aria-pressed={motionPlaying}
            onclick={toggleMotion}
            ><Icon name={motionPlaying ? 'close' : 'play'} size={16} />{motionPlaying
              ? 'Stop'
              : 'Play'} 00:{String(
              Math.round(
                motionSteps.reduce((total, step) => total + (step.durationMs ?? 0), 0) / 1000,
              ),
            ).padStart(2, '0')}</button
          >
          <button
            class="icon-button"
            type="button"
            aria-label="Next motion frame"
            disabled={currentMotion >= motionSteps.length - 1}
            onclick={() => (currentMotion += 1)}><Icon name="arrow-right" size={16} /></button
          >
          <div class="motion-timeline">
            {#each motionSteps as step, index}<button
                class:active={index === currentMotion}
                type="button"
                aria-label={`View ${step.title}`}
                onclick={() => (currentMotion = index)}
                style:flex={step.durationMs ?? 1000}><span></span></button
              >{/each}
          </div>
        </div>
        <aside class="motion-settings">
          <h2>Review the motion recipe</h2>
          <p>
            This browser presentation applies authored crop, frame, cursor, redactions, annotations,
            and timing. It previews the recipe, not the encoder’s pixel-identical video frames.
          </p>
          <dl>
            <div>
              <dt>Preview</dt>
              <dd>Studio browser · 16:9</dd>
            </div>
            <div>
              <dt>Export</dt>
              <dd>Portable scene ZIP</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>
                {Math.round(
                  motionSteps.reduce((total, step) => total + (step.durationMs ?? 0), 0) / 1000,
                )} seconds
              </dd>
            </div>
            <div>
              <dt>Captions</dt>
              <dd>Step copy overlay</dd>
            </div>
          </dl>
        </aside>
      </div>
    {:else}
      <div class="social-grid">
        <article class="og-card">
          <div class="og-route" aria-hidden="true"><i></i><i></i><i></i><b></b></div>
          <h2>{scene.title}</h2>
          <p>{scene.description}</p>
          <footer><strong>Scenebook</strong><span>{scene.id}</span></footer>
        </article>
        <article class="readme-card">
          <div>
            <h2>{scene.title}</h2>
            <p>{scene.steps.length} steps · {verifiedLabel}</p>
          </div>
          <span class="play-mark"><Icon name="play" size={22} /></span>
        </article>
        <article class="social-square">
          {#if socialSteps[0]}
            <PresentationPreview step={socialSteps[0]} aspect="square" decorative />
            <div class="social-copy">
              <span class="mono">01 / {String(socialSteps.length).padStart(2, '0')}</span>
              <h2>{socialSteps[0]?.title}</h2>
              <p>{socialSteps[0]?.instruction}</p>
            </div>
          {:else}<div class="preview-empty">
              <Icon name="globe" size={22} /><strong>No launch-visible steps</strong><span
                >Enable Launch media in a step’s output visibility.</span
              >
            </div>{/if}
        </article>
        <aside>
          <h3>Preview status</h3>
          <p>
            The carousel card applies authored presentation geometry in-browser. Typography and
            rasterization remain an honest layout preview until the bitmap compiler runs.
          </p>
          <button class="button" type="button" onclick={exportPortableScene}
            ><Icon name="download" size={15} />Download scene ZIP</button
          >
        </aside>
      </div>
    {/if}
  </div>
</section>

<style>
  .preview-view {
    background: var(--paper-2);
    min-height: calc(100vh - 178px);
  }
  .preview-toolbar {
    align-items: center;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
    display: grid;
    gap: 14px;
    grid-template-columns: 1fr auto 1fr;
    min-height: 53px;
    padding: 7px 12px;
    position: sticky;
    top: var(--topbar-height, 62px);
    z-index: 4;
  }
  .mode-switch,
  .viewport-switch {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 8px;
    display: flex;
    justify-self: start;
    padding: 3px;
  }
  .mode-switch button,
  .viewport-switch button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 5px;
    color: var(--muted);
    display: flex;
    font-size: 0.75rem;
    gap: 5px;
    height: 40px;
    padding: 0 9px;
  }
  .mode-switch button.active,
  .viewport-switch button.active {
    background: var(--surface);
    box-shadow: var(--shadow-sm);
    color: var(--ink);
  }
  .viewport-switch {
    justify-self: center;
  }
  .preview-actions {
    display: flex;
    gap: 6px;
    justify-self: end;
  }
  .preview-context {
    align-self: center;
    color: var(--muted);
    font-size: 0.75rem;
    justify-self: center;
  }
  .preview-error {
    background: var(--broken-soft);
    border-bottom: 1px solid color-mix(in srgb, var(--broken) 24%, transparent);
    color: var(--broken);
    font-size: 0.75rem;
    margin: 0;
    padding: 8px 13px;
    text-align: center;
  }
  .preview-stage {
    min-height: calc(100vh - 231px);
    overflow: auto;
    padding: clamp(18px, 3.5vw, 46px);
  }
  .device-preview {
    background: var(--preview-surface);
    border: 1px solid var(--preview-line);
    border-radius: 11px;
    box-shadow: var(--shadow-sm);
    margin: 0 auto;
    max-width: 1120px;
    overflow: hidden;
  }
  .device-preview.tablet {
    max-width: 780px;
  }
  .device-preview.mobile {
    max-width: 390px;
  }
  .address-bar {
    align-items: center;
    display: flex;
    gap: 5px;
    height: 34px;
    padding: 0 10px;
    position: relative;
  }
  .address-bar span {
    background: var(--preview-muted);
    border-radius: 50%;
    height: 6px;
    width: 6px;
  }
  .address-bar span:first-child {
    background: #c85d49;
  }
  .address-bar i {
    background: var(--preview-chrome);
    border-radius: 5px;
    color: #9f978f;
    font-size: 8px;
    font-style: normal;
    left: 50%;
    line-height: 19px;
    padding: 0 55px;
    position: absolute;
    transform: translateX(-50%);
  }
  .embed-shell {
    background: #f5f0e8;
    padding: clamp(10px, 2vw, 22px);
  }
  .loading-player {
    align-items: center;
    color: var(--muted);
    display: flex;
    font-size: 0.75rem;
    gap: 9px;
    height: 500px;
    justify-content: center;
  }
  .loading-player span {
    animation: pulse 800ms infinite alternate;
    background: var(--accent);
    border-radius: 50%;
    height: 8px;
    width: 8px;
  }
  @keyframes pulse {
    to {
      opacity: 0.3;
    }
  }
  .guide-page {
    background: white;
    border: 1px solid var(--line);
    box-shadow: var(--shadow-sm);
    margin: 0 auto;
    max-width: 860px;
    padding: clamp(28px, 6vw, 76px);
  }
  .guide-page > header {
    border-bottom: 1px solid var(--line);
    padding-bottom: 30px;
    position: relative;
  }
  .guide-brand {
    align-items: center;
    display: flex;
    font-size: 0.75rem;
    font-weight: 690;
    gap: 7px;
  }
  .guide-brand i {
    align-items: center;
    background: var(--ink);
    border-radius: 5px;
    color: white;
    display: flex;
    font-size: 0.75rem;
    font-style: normal;
    height: 22px;
    justify-content: center;
    width: 22px;
  }
  .guide-version {
    color: var(--muted);
    font-size: 0.75rem;
    position: absolute;
    right: 0;
    top: 4px;
  }
  .guide-page h1 {
    font-size: clamp(2rem, 5vw, 3.4rem);
    letter-spacing: -0.04em;
    line-height: 1.02;
    margin: 46px 0 13px;
  }
  .guide-page header > p {
    color: var(--muted);
    font-size: 0.85rem;
    line-height: 1.55;
    max-width: 62ch;
  }
  .guide-proof {
    align-items: center;
    background: var(--pass-soft);
    border: 1px solid #bcd9ca;
    border-radius: 8px;
    color: var(--pass);
    display: inline-flex;
    gap: 8px;
    margin-top: 13px;
    padding: 9px 11px;
  }
  .guide-proof strong,
  .guide-proof small {
    display: block;
  }
  .guide-proof.unverified {
    background: var(--changed-soft);
    border-color: color-mix(in srgb, var(--changed) 28%, transparent);
    color: var(--changed);
  }
  .guide-proof strong {
    font-size: 0.75rem;
  }
  .guide-proof small {
    font-size: 0.75rem;
    opacity: 0.78;
  }
  .guide-page ol {
    display: grid;
    gap: 56px;
    list-style: none;
    margin: 48px 0 0;
    padding: 0;
  }
  .guide-page li {
    display: grid;
    gap: 9px 14px;
    grid-template-columns: 30px 1fr;
  }
  .guide-step-number {
    color: var(--accent);
    font-size: 0.75rem;
    padding-top: 4px;
  }
  .guide-copy h2 {
    font-size: 1.2rem;
    letter-spacing: -0.025em;
    margin: 0 0 5px;
  }
  .guide-copy p {
    color: var(--muted);
    font-size: 0.76rem;
    margin: 0;
  }
  .guide-figure {
    grid-column: 2;
    margin: 11px 0 0;
  }
  .guide-figure :global([data-presentation-preview]) {
    border: 1px solid var(--line);
    border-radius: 9px;
  }
  .guide-caption {
    color: var(--muted);
    font-size: 0.75rem;
    margin-top: 8px;
  }
  .guide-choice {
    align-items: center;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 8px;
    display: flex;
    font-size: 0.75rem;
    gap: 8px;
    grid-column: 2;
    padding: 10px;
  }
  .motion-preview {
    display: grid;
    gap: 20px;
    grid-template-columns: minmax(0, 1fr) 280px;
    margin: 0 auto;
    max-width: 1160px;
  }
  .motion-frame {
    aspect-ratio: 16 / 9;
    background: var(--ink);
    border-radius: 10px;
    box-shadow: var(--shadow-md);
    overflow: hidden;
    position: relative;
  }
  .motion-frame :global([data-presentation-preview]) {
    height: 100%;
    width: 100%;
  }
  .preview-empty {
    align-items: center;
    color: #c7c0b7;
    display: flex;
    flex-direction: column;
    gap: 6px;
    inset: 0;
    justify-content: center;
    position: absolute;
  }
  .preview-empty strong {
    color: white;
    font-size: 0.78rem;
  }
  .preview-empty span {
    font-size: 0.75rem;
  }
  .motion-caption {
    background: rgba(25, 24, 22, 0.9);
    bottom: 24px;
    color: white;
    left: 24px;
    max-width: 430px;
    padding: 14px 16px;
    position: absolute;
  }
  .motion-caption .mono {
    color: #e58c78;
    font-size: 0.75rem;
  }
  .motion-caption strong {
    display: block;
    font-size: 1rem;
    margin-top: 3px;
  }
  .motion-caption p {
    color: #cbc5bd;
    font-size: 0.75rem;
    margin: 4px 0 0;
  }
  .motion-controls {
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 9px;
    display: flex;
    gap: 5px;
    grid-column: 1;
    padding: 7px;
  }
  .motion-play {
    align-items: center;
    background: var(--ink);
    border: 0;
    border-radius: 7px;
    color: white;
    display: flex;
    font-size: 0.75rem;
    gap: 6px;
    height: 35px;
    padding: 0 12px;
  }
  .motion-timeline {
    display: flex;
    flex: 1;
    gap: 2px;
    height: 24px;
    margin-left: 6px;
  }
  .motion-timeline button {
    background: transparent;
    border: 0;
    padding: 8px 1px;
  }
  .motion-timeline span {
    background: var(--line);
    display: block;
    height: 5px;
  }
  .motion-timeline button.active span {
    background: var(--accent);
  }
  .motion-settings {
    align-content: start;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    grid-column: 2;
    grid-row: 1 / span 2;
    padding: 19px;
  }
  .motion-settings h2 {
    font-size: 1.2rem;
    letter-spacing: -0.03em;
    margin: 8px 0;
  }
  .motion-settings > p {
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1.55;
  }
  .motion-settings dl {
    display: grid;
    gap: 0;
    margin: 18px 0 0;
  }
  .motion-settings dl div {
    border-top: 1px solid var(--line);
    padding: 10px 0;
  }
  dt {
    color: var(--faint);
    font-size: 0.75rem;
    margin-bottom: 3px;
    text-transform: uppercase;
  }
  dd {
    font-size: 0.75rem;
    margin: 0;
  }
  .social-grid {
    display: grid;
    gap: 15px;
    grid-template-columns: 1.3fr 0.8fr 270px;
    margin: 0 auto;
    max-width: 1160px;
  }
  .og-card {
    aspect-ratio: 1200 / 630;
    background: var(--paper);
    border: 1px solid var(--line);
    display: grid;
    padding: clamp(22px, 4vw, 50px);
    position: relative;
  }
  .og-card h2 {
    align-self: end;
    font-size: clamp(1.5rem, 3vw, 3rem);
    letter-spacing: -0.04em;
    line-height: 1;
    margin: 0 0 10px;
    max-width: 80%;
  }
  .og-card > p {
    color: var(--muted);
    font-size: 0.75rem;
    margin: 0;
    max-width: 60%;
  }
  .og-card footer {
    align-items: end;
    display: flex;
    font-size: 0.75rem;
    justify-content: space-between;
  }
  .og-card footer span {
    color: var(--muted);
  }
  .og-route {
    height: 65px;
    position: absolute;
    right: 34px;
    top: 32px;
    width: 100px;
  }
  .og-route i {
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    height: 42px;
    position: absolute;
    width: 65px;
  }
  .og-route i:nth-child(2) {
    left: 13px;
    top: 10px;
  }
  .og-route i:nth-child(3) {
    left: 26px;
    top: 20px;
  }
  .og-route b {
    background: var(--accent);
    border-radius: 999px;
    bottom: 3px;
    height: 3px;
    left: 4px;
    position: absolute;
    width: 83px;
  }
  .readme-card {
    align-items: center;
    background: var(--ink);
    color: white;
    display: flex;
    justify-content: space-between;
    padding: 24px;
  }
  .readme-card h2 {
    font-size: 1.25rem;
    letter-spacing: -0.03em;
    margin: 8px 0 4px;
  }
  .readme-card p {
    color: #c5beb5;
    font-size: 0.75rem;
    margin: 0;
  }
  .play-mark {
    align-items: center;
    background: var(--accent);
    border-radius: 50%;
    display: flex;
    height: 48px;
    justify-content: center;
    width: 48px;
  }
  .social-square {
    aspect-ratio: 1;
    background: var(--ink);
    grid-column: 1 / 3;
    max-width: 540px;
    overflow: hidden;
    position: relative;
  }
  .social-square > :global([data-presentation-preview]) {
    height: 100%;
    opacity: 0.68;
    position: absolute;
    width: 100%;
  }
  .social-square > .social-copy {
    bottom: 0;
    color: white;
    left: 0;
    padding: 28px;
    position: absolute;
    right: 0;
  }
  .social-square .mono {
    color: #ef9d8a;
    font-size: 0.75rem;
  }
  .social-square h2 {
    font-size: 1.6rem;
    margin: 7px 0;
  }
  .social-square p {
    color: #d2ccc3;
    font-size: 0.75rem;
    margin: 0;
  }
  .social-grid aside {
    background: var(--surface);
    border: 1px solid var(--line);
    grid-column: 3;
    grid-row: 1 / span 2;
    padding: 17px;
  }
  .social-grid aside h3 {
    font-size: 0.75rem;
    margin: 0 0 12px;
  }
  .social-grid aside p {
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1.55;
    margin: 0 0 14px;
  }
  .social-grid aside button {
    align-items: center;
    background: transparent;
    border: 0;
    border-top: 1px solid var(--line);
    display: grid;
    gap: 8px;
    grid-template-columns: auto 1fr;
    padding: 11px 0;
    text-align: left;
    width: 100%;
  }
  @media (pointer: coarse) {
    .preview-toolbar button,
    .motion-controls button,
    .social-grid aside button {
      min-height: 44px;
    }
    .motion-controls .icon-button {
      min-width: 44px;
    }
  }
  @media (max-width: 950px) {
    .preview-toolbar {
      grid-template-columns: 1fr auto;
    }
    .viewport-switch {
      display: none;
    }
    .motion-preview {
      grid-template-columns: 1fr;
    }
    .motion-settings {
      grid-column: 1;
      grid-row: auto;
    }
    .social-grid {
      grid-template-columns: 1fr 1fr;
    }
    .social-grid aside {
      grid-column: 1 / -1;
      grid-row: auto;
    }
  }
  @media (max-width: 660px) {
    .preview-toolbar {
      grid-template-columns: minmax(0, 1fr);
    }
    .mode-switch {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      justify-self: stretch;
      min-width: 0;
      width: 100%;
    }
    .mode-switch button {
      font-size: 0.78rem;
      justify-content: center;
      min-width: 0;
      padding: 0 6px;
    }
    .preview-actions {
      justify-self: stretch;
      position: static;
    }
    .preview-actions .button {
      width: 100%;
    }
    .preview-stage {
      padding: 12px;
    }
    .address-bar i {
      padding: 0 25px;
    }
    .guide-page {
      padding: 28px 20px;
    }
    .guide-version {
      display: none;
    }
    .guide-page li {
      grid-template-columns: 24px 1fr;
    }
    .motion-caption {
      bottom: 10px;
      left: 10px;
      right: 10px;
    }
    .social-grid {
      grid-template-columns: 1fr;
    }
    .social-square,
    .social-grid aside {
      grid-column: 1;
    }
    .readme-card {
      min-height: 170px;
    }
  }
</style>
