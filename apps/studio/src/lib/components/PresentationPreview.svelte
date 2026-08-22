<script lang="ts">
  import {
    effectiveCrop,
    mapPointToCrop,
    mapRectToCrop,
    safeImageSource,
    type Annotation,
    type PlayerStep,
    type PresentationPoint,
    type PresentationRect,
  } from '@scenebook/viewer';

  type PreviewAspect = 'standard' | 'wide' | 'square' | 'portrait';
  type PreviewAnnotation =
    | { kind: 'arrow'; annotation: Annotation; from: PresentationPoint; to: PresentationPoint }
    | { kind: 'rect'; annotation: Annotation; rect: PresentationRect };

  let {
    step,
    aspect = 'standard',
    decorative = false,
    compact = false,
  }: {
    step: PlayerStep;
    aspect?: PreviewAspect;
    decorative?: boolean;
    compact?: boolean;
  } = $props();

  const aspectRatios: Record<PreviewAspect, string> = {
    standard: '16 / 10',
    wide: '16 / 9',
    square: '1 / 1',
    portrait: '9 / 16',
  };

  let failedImageSource = $state<string>();

  let crop = $derived(effectiveCrop(step.crop));
  let frame = $derived(
    step.frame === 'mobile' || step.frame === 'none' || step.frame === 'browser'
      ? step.frame
      : 'browser',
  );
  let imageSource = $derived(safeImageSource(step.image, 'http://scenebook.local/'));
  let imageAvailable = $derived(Boolean(imageSource && failedImageSource !== imageSource));
  let masks = $derived.by(() =>
    (step.masks ?? []).flatMap((mask) => {
      const rect = mapRectToCrop(mask, crop);
      return rect ? [{ mask, rect }] : [];
    }),
  );
  let annotations = $derived.by(() => {
    const result: PreviewAnnotation[] = [];
    for (const annotation of step.annotations ?? []) {
      if (annotation.kind === 'arrow') {
        const from = mapPointToCrop(
          { x: annotation.fromX ?? annotation.x - 0.08, y: annotation.fromY ?? annotation.y },
          crop,
        );
        const to = mapPointToCrop(annotation, crop);
        if (from && to) result.push({ kind: 'arrow', annotation, from, to });
        continue;
      }
      const width = annotation.width ?? (annotation.kind === 'spotlight' ? 0.16 : 0.2);
      const height = annotation.height ?? (annotation.kind === 'spotlight' ? 0.16 : 0.1);
      const rect = mapRectToCrop(
        { x: annotation.x - width / 2, y: annotation.y - height / 2, width, height },
        crop,
      );
      if (rect) result.push({ kind: 'rect', annotation, rect });
    }
    return result;
  });
  let cursor = $derived(step.cursor?.visible ? mapPointToCrop(step.cursor, crop) : undefined);
  let hotspot = $derived.by(() => {
    if (!step.hotspot) return undefined;
    const width = Math.max(0, Math.min(1, step.hotspot.width ?? 0));
    const height = Math.max(0, Math.min(1, step.hotspot.height ?? 0));
    const rect =
      width > 0 && height > 0
        ? mapRectToCrop(
            {
              x: step.hotspot.x - width / 2,
              y: step.hotspot.y - height / 2,
              width,
              height,
            },
            crop,
          )
        : undefined;
    return rect
      ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      : mapPointToCrop(step.hotspot, crop);
  });
  let hotspotHasCursor = $derived(
    Boolean(hotspot && cursor && Math.hypot(hotspot.x - cursor.x, hotspot.y - cursor.y) <= 0.08),
  );

  function position(value: number): string {
    return `${Math.max(0, Math.min(1, value)) * 100}%`;
  }

  function stepLabel(type: PlayerStep['type']): string {
    if (type === 'choice') return 'Choose a path';
    if (type === 'end') return 'Complete';
    if (type === 'intro' || type === 'separator') return 'Chapter';
    return 'Visual unavailable';
  }
</script>

<figure
  class="presentation-preview"
  style:aspect-ratio={aspectRatios[aspect]}
  aria-label={decorative ? undefined : step.title}
  aria-hidden={decorative ? 'true' : undefined}
  data-presentation-preview
  data-frame={frame}
  data-crop-x={crop.x}
  data-crop-y={crop.y}
  data-crop-zoom={1 / crop.width}
>
  <div
    class:frame-browser={frame === 'browser'}
    class:frame-mobile={frame === 'mobile'}
    class:frame-none={frame === 'none'}
    class="presentation-frame"
  >
    {#if frame === 'browser'}
      <div class="browser-chrome" aria-hidden="true">
        <i></i><i></i><i></i><span>{step.title}</span>
      </div>
    {:else if frame === 'mobile'}
      <div class="mobile-chrome" aria-hidden="true"></div>
    {/if}
    <div class="media-viewport">
      {#if imageAvailable && imageSource}
        <div
          class="image-plane"
          style:left={`${(-crop.x / crop.width) * 100}%`}
          style:top={`${(-crop.y / crop.height) * 100}%`}
          style:width={`${(1 / crop.width) * 100}%`}
          style:height={`${(1 / crop.height) * 100}%`}
        >
          <img
            src={imageSource}
            alt={decorative ? '' : (step.alt ?? '')}
            draggable="false"
            onerror={() => (failedImageSource = imageSource)}
          />
        </div>
        <div class="overlays">
          {#each masks as item (item.mask.id)}
            <span
              class="mask"
              role="img"
              aria-label={item.mask.label ?? 'Redacted content'}
              style:left={position(item.rect.x)}
              style:top={position(item.rect.y)}
              style:width={position(item.rect.width)}
              style:height={position(item.rect.height)}
            ></span>
          {/each}
          {#each annotations as item (item.annotation.id)}
            {#if item.kind === 'arrow'}
              <svg
                class="annotation-arrow"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                role="img"
                aria-label={item.annotation.text}
              >
                <defs>
                  <marker
                    id={`preview-arrow-${item.annotation.id}`}
                    markerWidth="5"
                    markerHeight="5"
                    refX="4"
                    refY="2.5"
                    orient="auto"
                  >
                    <path d="M0,0 L5,2.5 L0,5 Z" fill={item.annotation.color ?? 'var(--accent)'}
                    ></path>
                  </marker>
                </defs>
                <line
                  x1={item.from.x * 100}
                  y1={item.from.y * 100}
                  x2={item.to.x * 100}
                  y2={item.to.y * 100}
                  stroke={item.annotation.color ?? 'var(--accent)'}
                  marker-end={`url(#preview-arrow-${item.annotation.id})`}
                ></line>
              </svg>
            {:else}
              <span
                class:spotlight={item.annotation.kind === 'spotlight'}
                class="annotation"
                role="note"
                style:left={position(item.rect.x)}
                style:top={position(item.rect.y)}
                style:width={position(item.rect.width)}
                style:height={position(item.rect.height)}
                style:--annotation-color={item.annotation.color ?? 'var(--accent)'}
                >{item.annotation.kind === 'spotlight' ? '' : item.annotation.text}</span
              >
            {/if}
          {/each}
          {#if cursor}
            <span
              class:click={step.cursor?.click}
              class:dot={step.cursor?.style === 'dot'}
              class:pointer={step.cursor?.style === 'pointer'}
              class="cursor"
              aria-hidden="true"
              style:left={position(cursor.x)}
              style:top={position(cursor.y)}
            >
              <svg viewBox="0 0 24 32" focusable="false">
                <path
                  d="M2 2v24l6-6 4 10 5-2-4-9h8z"
                  fill="white"
                  stroke="#171512"
                  stroke-width="2"
                  stroke-linejoin="round"
                ></path>
              </svg>
            </span>
          {/if}
          {#if hotspot && !hotspotHasCursor}
            <span
              class="hotspot"
              role="img"
              aria-label={step.hotspot?.label ?? 'Interactive target'}
              style:left={position(hotspot.x)}
              style:top={position(hotspot.y)}><i></i></span
            >
          {/if}
        </div>
      {:else}
        <div class:compact class="presentation-card" data-presentation-fallback>
          <span class="card-label">{stepLabel(step.type)}</span>
          <div class="card-copy">
            <h2>{step.title}</h2>
            {#if step.instruction || step.caption}<p>{step.instruction ?? step.caption}</p>{/if}
          </div>
          {#if step.type === 'choice' && step.choices?.length}
            <div class="card-options">
              {#each step.choices.slice(0, 3) as choice (choice.id)}
                <span
                  ><strong>{choice.label}</strong>{#if choice.description}<small
                      >{choice.description}</small
                    >{/if}</span
                >
              {/each}
            </div>
          {:else if step.ctas?.length}
            <div class="card-actions">
              {#each step.ctas.slice(0, 2) as cta (cta.id)}<span
                  class:primary={cta.variant === 'primary'}>{cta.label}</span
                >{/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</figure>

<style>
  .presentation-preview {
    align-items: center;
    background: #24221f;
    container-type: inline-size;
    display: flex;
    justify-content: center;
    margin: 0;
    overflow: hidden;
    position: relative;
    width: 100%;
  }
  .presentation-frame {
    display: flex;
    flex-direction: column;
    max-height: 94%;
    max-width: 96%;
    overflow: hidden;
    position: relative;
  }
  .frame-none {
    height: 100%;
    max-height: none;
    max-width: none;
    width: 100%;
  }
  .frame-browser {
    background: #ded8cd;
    border: 1px solid rgb(255 255 255 / 28%);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgb(0 0 0 / 22%);
    height: 94%;
    width: 94%;
  }
  .frame-mobile {
    aspect-ratio: 390 / 844;
    background: #111;
    border: 2px solid #4d4944;
    border-radius: clamp(13px, 4cqw, 24px);
    box-shadow: 0 4px 16px rgb(0 0 0 / 26%);
    height: 94%;
    padding: clamp(4px, 1.2cqw, 8px);
  }
  .browser-chrome {
    align-items: center;
    background: #f2eee6;
    border-bottom: 1px solid #cfc8bc;
    color: #706a62;
    display: flex;
    flex: 0 0 clamp(20px, 5cqw, 30px);
    font-size: clamp(6px, 1.5cqw, 10px);
    gap: 4px;
    min-width: 0;
    padding: 0 8px;
  }
  .browser-chrome i {
    background: #aaa39a;
    border-radius: 50%;
    height: 5px;
    width: 5px;
  }
  .browser-chrome i:first-child {
    background: #d15c48;
  }
  .browser-chrome span {
    overflow: hidden;
    padding-left: 4px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mobile-chrome {
    align-self: center;
    background: #050505;
    border-radius: 999px;
    height: 5px;
    margin-bottom: 4px;
    width: 34%;
  }
  .media-viewport {
    background: #181715;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    position: relative;
    width: 100%;
  }
  .presentation-card {
    align-content: safe center;
    background: #191816;
    color: #fffdf8;
    display: grid;
    gap: clamp(10px, 2.5cqw, 22px);
    height: 100%;
    overflow: auto;
    overscroll-behavior: contain;
    padding: clamp(18px, 6cqw, 56px);
    width: 100%;
  }
  .presentation-card.compact {
    gap: clamp(6px, 1.5cqw, 12px);
    grid-template-rows: auto minmax(0, 1fr);
    padding: clamp(10px, 3cqw, 24px);
  }
  .presentation-card.compact .card-copy {
    display: none;
  }
  .presentation-card.compact .card-options {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    max-width: none;
  }
  .presentation-card.compact .card-options > span {
    align-content: center;
  }
  @container (max-width: 420px) {
    .presentation-card.compact .card-options small {
      display: none;
    }
  }
  .card-label {
    color: #c7c0b7;
    font-size: clamp(8px, 1.35cqw, 12px);
    font-weight: 650;
  }
  .card-copy {
    display: grid;
    gap: clamp(5px, 1.2cqw, 10px);
    max-width: 66ch;
  }
  .card-copy h2 {
    font-size: clamp(20px, 4.4cqw, 46px);
    letter-spacing: -0.035em;
    line-height: 1.04;
    margin: 0;
    max-width: 19ch;
    overflow-wrap: anywhere;
    text-wrap: balance;
  }
  .card-copy p {
    color: #c7c0b7;
    font-size: clamp(10px, 1.8cqw, 17px);
    line-height: 1.4;
    margin: 0;
    max-width: 58ch;
    text-wrap: pretty;
  }
  .card-options,
  .card-actions {
    display: grid;
    gap: clamp(6px, 1.3cqw, 10px);
    grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr));
    max-width: 760px;
  }
  .card-options > span,
  .card-actions > span {
    background: #2c2a27;
    border: 1px solid #5e5851;
    border-radius: 9px;
    display: grid;
    gap: 2px;
    min-width: 0;
    padding: clamp(8px, 1.7cqw, 14px);
  }
  .card-options strong,
  .card-actions > span {
    font-size: clamp(10px, 1.7cqw, 16px);
  }
  .card-options small {
    color: #c7c0b7;
    font-size: clamp(8px, 1.3cqw, 12px);
    line-height: 1.35;
  }
  .card-actions {
    display: flex;
    flex-wrap: wrap;
  }
  .card-actions > span {
    min-width: min(190px, 100%);
    text-align: center;
  }
  .card-actions > span.primary {
    background: var(--accent);
    border-color: var(--accent);
  }
  .frame-mobile .media-viewport {
    border-radius: clamp(8px, 3cqw, 15px);
  }
  .image-plane {
    position: absolute;
  }
  .image-plane img {
    display: block;
    height: 100%;
    object-fit: fill;
    user-select: none;
    width: 100%;
  }
  .overlays {
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    position: absolute;
  }
  .mask {
    background: #191816;
    border: 1px solid rgb(255 255 255 / 25%);
    border-radius: 4px;
    position: absolute;
    z-index: 1;
  }
  .annotation {
    background: #fffdf8;
    border: 1px solid #d9d2c5;
    border-radius: 8px;
    box-shadow: 0 7px 24px rgb(25 24 22 / 20%);
    color: #191816;
    font-size: clamp(7px, 1.8cqw, 12px);
    font-weight: 650;
    align-items: center;
    display: flex;
    justify-content: center;
    padding: clamp(4px, 1.2cqw, 8px) clamp(5px, 1.5cqw, 10px);
    position: absolute;
    line-height: 1.15;
    min-width: 0;
    overflow: hidden;
    overflow-wrap: anywhere;
    text-align: center;
    z-index: 3;
  }
  .annotation.spotlight {
    background: transparent;
    border: 3px solid var(--annotation-color);
    border-radius: 50%;
    box-shadow: 0 0 0 999px rgb(0 0 0 / 32%);
    color: transparent;
    overflow: hidden;
    padding: 0;
  }
  .annotation-arrow {
    height: 100%;
    inset: 0;
    overflow: visible;
    position: absolute;
    width: 100%;
    z-index: 2;
  }
  .annotation-arrow line {
    stroke-linecap: round;
    stroke-width: 0.8;
  }
  .cursor {
    filter: drop-shadow(0 2px 2px rgb(0 0 0 / 45%));
    height: clamp(16px, 5cqw, 28px);
    position: absolute;
    transform: translate(-4px, -3px);
    width: clamp(13px, 4cqw, 22px);
    z-index: 5;
  }
  .cursor svg {
    display: block;
    height: 100%;
    width: 100%;
  }
  .cursor.dot {
    background: white;
    border: 3px solid var(--accent);
    border-radius: 50%;
    height: clamp(11px, 3cqw, 17px);
    transform: translate(-50%, -50%);
    width: clamp(11px, 3cqw, 17px);
  }
  .cursor.dot svg {
    display: none;
  }
  .cursor.pointer svg path {
    fill: var(--accent-soft, #f4ded7);
  }
  .cursor.click::after {
    animation: preview-click 900ms ease-out infinite;
    border: 3px solid var(--accent);
    border-radius: 50%;
    content: '';
    height: clamp(22px, 7cqw, 36px);
    left: -12px;
    position: absolute;
    top: -12px;
    width: clamp(22px, 7cqw, 36px);
  }
  .hotspot {
    align-items: center;
    background: #fffdf8;
    border: 2px solid var(--accent);
    border-radius: 50%;
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 25%, transparent);
    display: flex;
    height: clamp(20px, 6cqw, 36px);
    justify-content: center;
    position: absolute;
    transform: translate(-50%, -50%);
    width: clamp(20px, 6cqw, 36px);
    z-index: 4;
  }
  .hotspot i {
    background: var(--accent);
    border-radius: 50%;
    height: 30%;
    width: 30%;
  }
  @keyframes preview-click {
    from {
      opacity: 0.9;
      transform: scale(0.35);
    }
    to {
      opacity: 0;
      transform: scale(1.3);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .cursor.click::after {
      animation: none;
      opacity: 0.7;
    }
  }
  @media (forced-colors: active) {
    .annotation,
    .cursor,
    .hotspot,
    .mask {
      forced-color-adjust: auto;
    }
  }
</style>
