import {
  canonicalStepCtas,
  type Scene,
  type SceneState,
  type Step,
  type Target,
} from '@scenebook/schema';
import type {
  LoadedScene,
  NormalizedAnnotation,
  NormalizedChoice,
  NormalizedCta,
  NormalizedMask,
  NormalizedScene,
  NormalizedStep,
  NormalizedTarget,
} from './types.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function assetReference(state?: SceneState): string | undefined {
  return state?.screenshot?.path;
}

export function stepImageReference(step: unknown): string | undefined {
  const candidate = step as Partial<Step>;
  const selection = candidate.presentation?.state ?? 'before';
  const before = assetReference(candidate.states?.before);
  const after = assetReference(candidate.states?.after);
  return selection === 'after' ? (after ?? before) : (before ?? after);
}

function selectedStates(step: Step): { primary?: SceneState; secondary?: SceneState } {
  if (step.presentation.state === 'after') {
    return {
      ...(step.states.after ? { primary: step.states.after } : {}),
      ...(step.states.before ? { secondary: step.states.before } : {}),
    };
  }
  if (step.presentation.state === 'both') {
    return {
      ...(step.states.before ? { primary: step.states.before } : {}),
      ...(step.states.after ? { secondary: step.states.after } : {}),
    };
  }
  return {
    ...(step.states.before ? { primary: step.states.before } : {}),
    ...(step.states.after ? { secondary: step.states.after } : {}),
  };
}

function normalizedTarget(target?: Target): NormalizedTarget | undefined {
  const rect = target?.normalizedRect;
  if (!rect) return undefined;
  return {
    ...rect,
    ...(target.accessibleName ? { label: target.accessibleName } : {}),
    ...(target.role ? { role: target.role } : {}),
  };
}

function translatedStep(document: unknown, id: string): Record<string, unknown> | undefined {
  const source = record(document);
  const steps = source?.steps;
  if (Array.isArray(steps)) {
    return steps.map(record).find((step) => step?.id === id);
  }
  return record(record(steps)?.[id]);
}

function translationCandidates(
  scene: Scene,
  locales: Readonly<Record<string, unknown>>,
  requested?: string,
  fallback?: string,
): Array<{ locale: string; document?: unknown }> {
  const names = [
    requested,
    requested?.split('-')[0],
    fallback,
    fallback?.split('-')[0],
    scene.defaultLocale,
  ].filter((value): value is string => Boolean(value));
  const unique = [...new Set(names)];
  return unique.map((locale) => ({ locale, document: locales[locale] }));
}

function mergeRecords(base: unknown, overrides: unknown): unknown {
  const left = record(base);
  const right = record(overrides);
  if (!left || !right) return right ?? overrides ?? left ?? base;
  const result: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    result[key] = record(value) && record(left[key]) ? mergeRecords(left[key], value) : value;
  }
  return result;
}

function localeDocuments(
  scene: Scene,
  loaded: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const locales: Record<string, unknown> = { ...loaded };
  for (const [locale, translation] of Object.entries(scene.translations)) {
    locales[locale] = mergeRecords(locales[locale], translation);
  }
  return locales;
}

function localizedValue(
  documents: readonly unknown[],
  key: string,
  stepId?: string,
): string | undefined {
  for (const document of documents) {
    const source = stepId ? translatedStep(document, stepId) : record(document);
    const scene = stepId ? undefined : record(source?.scene);
    const value = nonEmpty(source?.[key]) ?? nonEmpty(scene?.[key]);
    if (value) return value;
  }
  return undefined;
}

function themeVariables(scene: Scene, loaded?: LoadedScene): Record<string, string> {
  const variables: Record<string, string> = {};
  const source = loaded?.theme;
  const nested = record(source?.variables);
  for (const [key, value] of Object.entries(nested ?? source ?? {})) {
    if (typeof value === 'string') variables[key] = value;
  }
  if (source) {
    const aliases: Readonly<Record<string, string>> = {
      background: 'paper',
      surface: 'card',
      foreground: 'ink',
      muted: 'muted',
      accent: 'accent',
      fontFamily: 'font-family',
      headingFontFamily: 'heading-font-family',
    };
    for (const [sourceName, targetName] of Object.entries(aliases)) {
      const value = source[sourceName];
      if (typeof value === 'string') variables[targetName] = value;
    }
    if (typeof source.radius === 'number' && Number.isFinite(source.radius)) {
      variables.radius = `${source.radius}px`;
    }
  }
  for (const [key, value] of Object.entries(scene.theme?.variables ?? {})) {
    variables[key] =
      key.replace(/^--(?:sb-)?/u, '') === 'radius' && /^\d+(?:\.\d+)?$/u.test(value)
        ? `${value}px`
        : value;
  }
  return Object.fromEntries(
    Object.entries(variables).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function annotations(step: Step): NormalizedAnnotation[] {
  return step.presentation.annotations.map((annotation) => ({
    id: annotation.id,
    kind: annotation.kind,
    ...(annotation.rect ? { rect: annotation.rect } : {}),
    ...(annotation.from ? { from: annotation.from } : {}),
    ...(annotation.to ? { to: annotation.to } : {}),
    ...(annotation.text ? { text: annotation.text } : {}),
    ...(annotation.label ? { label: annotation.label } : {}),
    ...(annotation.color ? { color: annotation.color } : {}),
  }));
}

function masks(step: Step): NormalizedMask[] {
  return step.masks
    .filter(
      (mask): mask is typeof mask & { rect: NonNullable<typeof mask.rect> } =>
        mask.rect !== undefined && (mask.scope === 'publication' || mask.scope === 'both'),
    )
    .map((mask) => ({
      id: mask.id,
      mode: mask.mode,
      rect: mask.rect,
      source: mask.source,
      classification: mask.classification,
      ...(mask.reason ? { reason: mask.reason } : {}),
    }));
}

function translatedSteps(documents: readonly unknown[], stepId: string): Record<string, unknown>[] {
  return documents.flatMap((document) => {
    const translated = translatedStep(document, stepId);
    return translated ? [translated] : [];
  });
}

function firstTranslation(
  translations: readonly (Record<string, unknown> | undefined)[],
  key: string,
): string | undefined {
  for (const translation of translations) {
    const value = nonEmpty(translation?.[key]);
    if (value) return value;
  }
  return undefined;
}

function choices(step: Step, translationDocuments: readonly unknown[]): NormalizedChoice[] {
  const translations = translatedSteps(translationDocuments, step.id);
  return step.choices.map((choice) => {
    const localized = translations.map((translation) =>
      record(record(translation.choices)?.[choice.id]),
    );
    const description = firstTranslation(localized, 'description') ?? choice.description;
    return {
      id: choice.id,
      label: firstTranslation(localized, 'label') ?? choice.label,
      ...(description ? { description } : {}),
      targetSceneId: choice.targetSceneId,
      ...(choice.targetStepId ? { targetStepId: choice.targetStepId } : {}),
    };
  });
}

function ctas(step: Step, translationDocuments: readonly unknown[]): NormalizedCta[] {
  const translations = translatedSteps(translationDocuments, step.id);
  const authored = canonicalStepCtas(step);
  return authored.map((cta, index) => {
    const localized = translations.map(
      (translation) =>
        record(record(translation.ctas)?.[cta.id]) ??
        (index === 0 ? record(translation.cta) : undefined),
    );
    return {
      id: cta.id,
      variant: cta.variant,
      kind: cta.kind,
      label: firstTranslation(localized, 'label') ?? cta.label,
      ...(cta.url ? { url: cta.url } : {}),
      ...(cta.targetSceneId ? { targetSceneId: cta.targetSceneId } : {}),
      ...(cta.webhookId ? { webhookId: cta.webhookId } : {}),
      fields: cta.fields.map((field) => {
        const translatedFields = localized.map((translation) =>
          record(record(translation?.fields)?.[field.id]),
        );
        return {
          id: field.id,
          label: firstTranslation(translatedFields, 'label') ?? field.label,
          type: field.type,
          required: field.required,
          consent: field.consent,
        };
      }),
    };
  });
}

export function normalizeScene(
  scene: Scene,
  options: {
    readonly loaded?: LoadedScene;
    readonly locale?: string;
    readonly fallbackLocale?: string;
  } = {},
): NormalizedScene {
  const candidates = translationCandidates(
    scene,
    localeDocuments(scene, options.loaded?.locales ?? {}),
    options.locale,
    options.fallbackLocale,
  );
  const translationDocuments = candidates.map((candidate) => candidate.document).filter(Boolean);
  const selectedLocale =
    candidates.find((candidate) => candidate.document)?.locale ?? scene.defaultLocale;
  const steps: NormalizedStep[] = scene.steps.map((step) => {
    const selected = selectedStates(step);
    const title = localizedValue(translationDocuments, 'title', step.id) ?? step.title;
    const instruction =
      localizedValue(translationDocuments, 'instruction', step.id) ?? step.instruction;
    const caption = localizedValue(translationDocuments, 'caption', step.id) ?? step.caption;
    const altText = localizedValue(translationDocuments, 'altText', step.id) ?? step.altText;
    const localizedCtas = ctas(step, translationDocuments);
    return {
      id: step.id,
      kind: step.kind,
      title,
      ...(instruction ? { instruction } : {}),
      ...(caption ? { caption } : {}),
      ...(altText ? { altText } : {}),
      ...(selected.primary?.screenshot
        ? {
            imageReference: selected.primary.screenshot.path,
            ...(selected.primary.screenshot.width
              ? { imageWidth: selected.primary.screenshot.width }
              : {}),
            ...(selected.primary.screenshot.height
              ? { imageHeight: selected.primary.screenshot.height }
              : {}),
          }
        : {}),
      ...(step.presentation.state === 'both' && selected.secondary?.screenshot
        ? {
            secondaryImageReference: selected.secondary.screenshot.path,
            ...(selected.secondary.screenshot.width
              ? { secondaryImageWidth: selected.secondary.screenshot.width }
              : {}),
            ...(selected.secondary.screenshot.height
              ? { secondaryImageHeight: selected.secondary.screenshot.height }
              : {}),
          }
        : {}),
      ...(normalizedTarget(step.target) ? { target: normalizedTarget(step.target) } : {}),
      durationMs: step.presentation.durationMs,
      ...(step.presentation.crop ? { crop: step.presentation.crop } : {}),
      ...(step.presentation.frame ? { frame: step.presentation.frame } : {}),
      ...(step.presentation.cursor ? { cursor: step.presentation.cursor } : {}),
      annotations: annotations(step),
      masks: masks(step),
      autoAdvance: step.presentation.autoAdvance,
      transition: step.presentation.transition,
      practiceMode: step.presentation.practiceMode,
      choices: choices(step, translationDocuments),
      ctas: localizedCtas,
      ...(localizedCtas[0] ? { cta: localizedCtas[0] } : {}),
      hidden: false,
      visibility: step.presentation.visibility,
    };
  });

  return {
    id: scene.id,
    slug: scene.slug,
    title: localizedValue(translationDocuments, 'title') ?? scene.title,
    ...((localizedValue(translationDocuments, 'description') ?? scene.description)
      ? { description: localizedValue(translationDocuments, 'description') ?? scene.description }
      : {}),
    capability: scene.capability,
    locale: selectedLocale,
    defaultLocale: scene.defaultLocale,
    theme: themeVariables(scene, options.loaded),
    tags: scene.tags,
    steps,
  };
}
