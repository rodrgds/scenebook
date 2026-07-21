import { z } from 'zod';

import {
  AssetRefSchema,
  IdSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  LocaleSchema,
  NormalizedPointSchema,
  NormalizedRectSchema,
  RelativePathSchema,
  RouteSchema,
  SCHEMA_VERSION,
  SlugSchema,
  SourceLocationSchema,
  TargetSchema,
  ViewportSchema,
} from './common.js';

export const SceneStatusSchema = z.enum(['draft', 'published', 'archived']);
export const SceneCapabilitySchema = z.enum(['captured', 'monitored', 'verified']);
export const SceneCriticalitySchema = z.enum(['low', 'normal', 'important', 'critical']);
export const StepKindSchema = z.enum([
  'browser',
  'intro',
  'separator',
  'explanation',
  'choice',
  'end',
]);

export const CropSchema = z
  .object({
    rect: NormalizedRectSchema,
    focalPoint: NormalizedPointSchema.optional(),
    zoom: z.number().min(1).max(10).default(1),
  })
  .strict();

export const FrameSchema = z
  .object({
    kind: z.enum(['none', 'browser', 'device']).default('browser'),
    preset: z.string().min(1).max(100).optional(),
    title: z.string().max(500).optional(),
    showAddressBar: z.boolean().default(true),
  })
  .strict();

export const CursorKeyframeSchema = z
  .object({
    atMs: z.number().int().nonnegative(),
    point: NormalizedPointSchema,
  })
  .strict();

export const CursorPresentationSchema = z
  .object({
    visible: z.boolean().default(true),
    position: NormalizedPointSchema.optional(),
    path: z.array(CursorKeyframeSchema).max(500).default([]),
    clickAtMs: z.number().int().nonnegative().optional(),
    style: z.enum(['default', 'pointer', 'dot']).default('default'),
  })
  .strict()
  .superRefine((cursor, context) => {
    for (let index = 1; index < cursor.path.length; index += 1) {
      const previous = cursor.path[index - 1];
      const current = cursor.path[index];
      if (previous && current && current.atMs < previous.atMs) {
        context.addIssue({
          code: 'custom',
          message: 'Cursor keyframes must be ordered by atMs',
          path: ['path', index, 'atMs'],
        });
      }
    }
  });

export const AnnotationSchema = z
  .object({
    id: IdSchema,
    kind: z.enum(['hotspot', 'spotlight', 'callout', 'arrow', 'text']),
    rect: NormalizedRectSchema.optional(),
    from: NormalizedPointSchema.optional(),
    to: NormalizedPointSchema.optional(),
    text: z.string().max(2_000).optional(),
    label: z.string().max(500).optional(),
    color: z.string().max(100).optional(),
  })
  .strict()
  .superRefine((annotation, context) => {
    if (
      ['hotspot', 'spotlight', 'callout'].includes(annotation.kind) &&
      annotation.rect === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: `${annotation.kind} requires a rect`,
        path: ['rect'],
      });
    }
    if (
      annotation.kind === 'arrow' &&
      (annotation.from === undefined || annotation.to === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An arrow requires from and to points',
        path: ['from'],
      });
    }
    if (['callout', 'text'].includes(annotation.kind) && annotation.text === undefined) {
      context.addIssue({
        code: 'custom',
        message: `${annotation.kind} requires text`,
        path: ['text'],
      });
    }
  });

export const OutputVisibilitySchema = z
  .object({
    interactive: z.boolean().default(true),
    guide: z.boolean().default(true),
    motion: z.boolean().default(true),
    launchMedia: z.boolean().default(true),
  })
  .strict();

export const StepPresentationSchema = z
  .object({
    durationMs: z.number().int().min(250).max(120_000).default(3_000),
    crop: CropSchema.optional(),
    frame: FrameSchema.optional(),
    cursor: CursorPresentationSchema.optional(),
    annotations: z.array(AnnotationSchema).max(200).default([]),
    autoAdvance: z.boolean().default(false),
    transition: z.enum(['none', 'fade', 'slide', 'zoom']).default('fade'),
    state: z.enum(['before', 'after', 'both']).default('before'),
    visibility: OutputVisibilitySchema.default({
      interactive: true,
      guide: true,
      motion: true,
      launchMedia: true,
    }),
    practiceMode: z.boolean().default(false),
  })
  .strict();

export const RedactionMaskSchema = z
  .object({
    id: IdSchema,
    mode: z.enum(['opaque', 'blur']).default('opaque'),
    source: z.enum(['automatic', 'locator', 'attribute', 'manual']),
    scope: z.enum(['capture', 'publication', 'both']).default('both'),
    locator: z.string().min(1).max(4_096).optional(),
    rect: NormalizedRectSchema.optional(),
    reason: z.string().max(500).optional(),
    classification: z
      .enum([
        'password',
        'token',
        'payment',
        'email',
        'phone',
        'personal-data',
        'authentication',
        'custom',
      ])
      .default('custom'),
  })
  .strict()
  .superRefine((mask, context) => {
    if (mask.locator === undefined && mask.rect === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A redaction mask requires a locator or rect',
        path: ['locator'],
      });
    }
    if (mask.mode === 'blur' && (mask.source !== 'manual' || mask.classification !== 'custom')) {
      context.addIssue({
        code: 'custom',
        message:
          'Blur is limited to manual custom presentation regions; privacy masks must use irreversible opaque redaction',
        path: ['mode'],
      });
    }
  });

export const SceneStateSchema = z
  .object({
    id: IdSchema,
    route: RouteSchema,
    title: z.string().max(1_000).optional(),
    screenshot: AssetRefSchema.optional(),
    viewport: ViewportSchema,
    scroll: NormalizedPointSchema.default({ x: 0, y: 0 }),
    capturedAt: IsoDateTimeSchema.optional(),
  })
  .strict();

const ActionBaseShape = {
  id: IdSchema,
  source: SourceLocationSchema.optional(),
  offsetMs: z.number().int().nonnegative().optional(),
};

export const ValueReferenceSchema = z
  .object({
    kind: z.enum(['fixture', 'literal', 'redacted']),
    value: z.string().max(10_000).optional(),
    name: IdSchema.optional(),
    sensitive: z.boolean().default(false),
  })
  .strict()
  .superRefine((reference, context) => {
    if (reference.kind === 'fixture' && reference.name === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Fixture values require a name',
        path: ['name'],
      });
    }
    if (reference.kind === 'fixture' && reference.value !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Fixture values reference a name and cannot retain raw content',
        path: ['value'],
      });
    }
    if (reference.kind === 'literal' && reference.value === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Literal values require a value',
        path: ['value'],
      });
    }
    if (reference.kind === 'redacted' && reference.value !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Redacted values cannot retain raw content',
        path: ['value'],
      });
    }
    if (reference.sensitive && reference.kind === 'literal') {
      context.addIssue({
        code: 'custom',
        message: 'Sensitive values must be fixture-backed or redacted, never literal',
        path: ['kind'],
      });
    }
  });

export const ActionSchema = z.discriminatedUnion('kind', [
  z.object({ ...ActionBaseShape, kind: z.literal('navigate'), route: RouteSchema }).strict(),
  z.object({ ...ActionBaseShape, kind: z.literal('click'), target: TargetSchema }).strict(),
  z
    .object({
      ...ActionBaseShape,
      kind: z.literal('fill'),
      target: TargetSchema,
      value: ValueReferenceSchema,
    })
    .strict(),
  z
    .object({
      ...ActionBaseShape,
      kind: z.literal('select'),
      target: TargetSchema,
      values: z.array(ValueReferenceSchema).min(1).max(100),
    })
    .strict(),
  z
    .object({
      ...ActionBaseShape,
      kind: z.literal('check'),
      target: TargetSchema,
      checked: z.boolean(),
    })
    .strict(),
  z.object({ ...ActionBaseShape, kind: z.literal('hover'), target: TargetSchema }).strict(),
  z
    .object({
      ...ActionBaseShape,
      kind: z.literal('upload'),
      target: TargetSchema,
      fixtures: z.array(IdSchema).min(1).max(100),
    })
    .strict(),
  z
    .object({ ...ActionBaseShape, kind: z.literal('keypress'), key: z.string().min(1).max(100) })
    .strict(),
  z.object({ ...ActionBaseShape, kind: z.literal('scroll'), to: NormalizedPointSchema }).strict(),
  z
    .object({
      ...ActionBaseShape,
      kind: z.literal('wait'),
      durationMs: z.number().int().min(0).max(120_000),
    })
    .strict(),
  z
    .object({
      ...ActionBaseShape,
      kind: z.literal('custom'),
      name: IdSchema,
      parameters: z.record(z.string(), JsonValueSchema).default({}),
    })
    .strict(),
]);

export const CheckSchema = z
  .object({
    id: IdSchema,
    kind: z.enum(['visible', 'hidden', 'text', 'value', 'url', 'count', 'screenshot', 'custom']),
    target: TargetSchema.optional(),
    expected: JsonValueSchema.optional(),
    description: z.string().min(1).max(1_000),
    source: SourceLocationSchema.optional(),
    critical: z.boolean().default(true),
  })
  .strict();

export const BranchChoiceSchema = z
  .object({
    id: IdSchema,
    label: z.string().min(1).max(500),
    description: z.string().max(1_000).optional(),
    targetSceneId: IdSchema,
    targetStepId: IdSchema.optional(),
  })
  .strict();

const CtaCoreShape = {
  kind: z.enum([
    'open-product',
    'read-docs',
    'restart',
    'view-scene',
    'book-call',
    'external',
    'form',
  ]),
  label: z.string().min(1).max(500),
  url: z
    .string()
    .url()
    .refine((value) => ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol), {
      message: 'CTA URLs must use HTTP, HTTPS, or mailto',
    })
    .optional(),
  targetSceneId: IdSchema.optional(),
  webhookId: IdSchema.optional(),
  fields: z
    .array(
      z
        .object({
          id: IdSchema,
          label: z.string().min(1).max(200),
          type: z.enum(['email', 'text', 'checkbox']),
          required: z.boolean().default(false),
          consent: z.boolean().default(false),
        })
        .strict(),
    )
    .max(20)
    .default([]),
};

const CtaCoreSchema = z.object(CtaCoreShape).strict();

function validateCta(cta: z.infer<typeof CtaCoreSchema>, context: z.RefinementCtx): void {
  if (
    ['open-product', 'read-docs', 'book-call', 'external'].includes(cta.kind) &&
    cta.url === undefined
  ) {
    context.addIssue({ code: 'custom', message: `${cta.kind} requires a URL`, path: ['url'] });
  }
  if (cta.kind === 'view-scene' && cta.targetSceneId === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'view-scene requires targetSceneId',
      path: ['targetSceneId'],
    });
  }
  if (cta.kind === 'form' && cta.fields.length === 0) {
    context.addIssue({
      code: 'custom',
      message: 'A form CTA requires at least one field',
      path: ['fields'],
    });
  }
  for (const [index, field] of cta.fields.entries()) {
    if (field.type === 'checkbox' && field.consent === false && field.required) {
      context.addIssue({
        code: 'custom',
        message: 'A required checkbox must be explicitly identified as consent',
        path: ['fields', index, 'consent'],
      });
    }
  }
}

/** Legacy single-CTA contract retained for existing schemaVersion 1 producers. */
export const CtaSchema = CtaCoreSchema.superRefine(validateCta);

/** Canonical authored CTA entry. Step.ctas takes precedence when it is non-empty. */
export const StepCtaSchema = z
  .object({
    id: IdSchema,
    variant: z.enum(['primary', 'secondary']).default('primary'),
    ...CtaCoreShape,
  })
  .strict()
  .superRefine(validateCta);

export const StepSchema = z
  .object({
    id: IdSchema,
    kind: StepKindSchema.default('browser'),
    title: z.string().min(1).max(500),
    instruction: z.string().max(5_000).optional(),
    caption: z.string().max(5_000).optional(),
    notes: z.string().max(10_000).optional(),
    altText: z.string().max(2_000).optional(),
    states: z
      .object({
        before: SceneStateSchema.optional(),
        after: SceneStateSchema.optional(),
      })
      .strict()
      .default({}),
    target: TargetSchema.optional(),
    actions: z.array(ActionSchema).max(10_000).default([]),
    checks: z.array(CheckSchema).max(1_000).default([]),
    presentation: StepPresentationSchema.default({
      durationMs: 3_000,
      annotations: [],
      autoAdvance: false,
      transition: 'fade',
      state: 'before',
      visibility: { interactive: true, guide: true, motion: true, launchMedia: true },
      practiceMode: false,
    }),
    masks: z.array(RedactionMaskSchema).max(1_000).default([]),
    choices: z.array(BranchChoiceSchema).max(20).default([]),
    ctas: z.array(StepCtaSchema).max(20).default([]),
    /** @deprecated Use ctas. Retained as a schemaVersion 1 compatibility fallback. */
    cta: CtaSchema.optional(),
    source: SourceLocationSchema.optional(),
  })
  .strict()
  .superRefine((step, context) => {
    const requireUniqueIds = (
      values: readonly { id: string }[],
      key: 'actions' | 'checks' | 'masks' | 'choices' | 'annotations',
    ): void => {
      const ids = new Set<string>();
      for (const [index, value] of values.entries()) {
        if (ids.has(value.id)) {
          context.addIssue({
            code: 'custom',
            message: `Duplicate ${key} id: ${value.id}`,
            path: [
              key === 'annotations' ? 'presentation' : key,
              ...(key === 'annotations' ? ['annotations'] : []),
              index,
              'id',
            ],
          });
        }
        ids.add(value.id);
      }
    };
    requireUniqueIds(step.actions, 'actions');
    requireUniqueIds(step.checks, 'checks');
    requireUniqueIds(step.masks, 'masks');
    requireUniqueIds(step.choices, 'choices');
    requireUniqueIds(step.presentation.annotations, 'annotations');

    const ctaIds = new Set<string>();
    for (const [ctaIndex, cta] of step.ctas.entries()) {
      if (ctaIds.has(cta.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate CTA id: ${cta.id}`,
          path: ['ctas', ctaIndex, 'id'],
        });
      }
      ctaIds.add(cta.id);
    }
    for (const [ctaIndex, cta] of [...step.ctas, ...(step.cta ? [step.cta] : [])].entries()) {
      const ctaFieldIds = new Set<string>();
      for (const [fieldIndex, field] of cta.fields.entries()) {
        if (ctaFieldIds.has(field.id)) {
          context.addIssue({
            code: 'custom',
            message: `Duplicate CTA field id: ${field.id}`,
            path:
              ctaIndex < step.ctas.length
                ? ['ctas', ctaIndex, 'fields', fieldIndex, 'id']
                : ['cta', 'fields', fieldIndex, 'id'],
          });
        }
        ctaFieldIds.add(field.id);
      }
    }
    if (step.kind === 'choice' && step.choices.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'A choice Step requires choices',
        path: ['choices'],
      });
    }
    if (step.kind !== 'choice' && step.choices.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Only choice Steps can contain choices',
        path: ['choices'],
      });
    }
    if (
      step.kind === 'browser' &&
      step.states.before === undefined &&
      step.states.after === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A browser Step requires at least one captured State',
        path: ['states'],
      });
    }
    if (
      step.presentation.state === 'before' &&
      step.kind === 'browser' &&
      step.states.before === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Presentation selects a missing before State',
        path: ['presentation', 'state'],
      });
    }
    if (
      step.presentation.state === 'after' &&
      step.kind === 'browser' &&
      step.states.after === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Presentation selects a missing after State',
        path: ['presentation', 'state'],
      });
    }
    if (
      step.presentation.state === 'both' &&
      step.kind === 'browser' &&
      (step.states.before === undefined || step.states.after === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Presentation state "both" requires before and after States',
        path: ['presentation', 'state'],
      });
    }
    for (const [index, keyframe] of (step.presentation.cursor?.path ?? []).entries()) {
      if (keyframe.atMs > step.presentation.durationMs) {
        context.addIssue({
          code: 'custom',
          message: 'Cursor keyframes cannot occur after the Step duration',
          path: ['presentation', 'cursor', 'path', index, 'atMs'],
        });
      }
    }
    if (
      step.presentation.cursor?.clickAtMs !== undefined &&
      step.presentation.cursor.clickAtMs > step.presentation.durationMs
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Cursor click feedback cannot occur after the Step duration',
        path: ['presentation', 'cursor', 'clickAtMs'],
      });
    }
    if (step.presentation.practiceMode && step.target === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Practice mode requires a primary target',
        path: ['target'],
      });
    }
  });

export const LocaleDescriptorSchema = z
  .object({
    locale: LocaleSchema,
    file: RelativePathSchema,
    label: z.string().min(1).max(100).optional(),
    complete: z.boolean().default(false),
  })
  .strict();

export const StepTranslationSchema = z
  .object({
    title: z.string().max(500).optional(),
    instruction: z.string().max(5_000).optional(),
    caption: z.string().max(5_000).optional(),
    altText: z.string().max(2_000).optional(),
    choices: z
      .record(
        IdSchema,
        z
          .object({
            label: z.string().max(500).optional(),
            description: z.string().max(1_000).optional(),
          })
          .strict(),
      )
      .default({}),
    ctas: z
      .record(
        IdSchema,
        z
          .object({
            label: z.string().max(500).optional(),
            fields: z
              .record(IdSchema, z.object({ label: z.string().max(200).optional() }).strict())
              .default({}),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();

export const SceneTranslationSchema = z
  .object({
    title: z.string().max(500).optional(),
    description: z.string().max(10_000).optional(),
    steps: z.record(IdSchema, StepTranslationSchema).default({}),
  })
  .strict();

export const ThemeReferenceSchema = z
  .object({
    id: IdSchema.optional(),
    file: RelativePathSchema.optional(),
    variables: z.record(z.string(), z.string().max(2_000)).default({}),
  })
  .strict()
  .refine(
    (theme) =>
      theme.id !== undefined || theme.file !== undefined || Object.keys(theme.variables).length > 0,
    {
      message: 'A theme reference cannot be empty',
    },
  );

export const AutomationReferenceSchema = z
  .object({
    level: z.enum(['none', 'monitored', 'verified']).default('none'),
    framework: z.literal('playwright').optional(),
    replayPath: RelativePathSchema.optional(),
    linkedTest: z
      .object({
        path: RelativePathSchema,
        title: z.string().min(1).max(1_000),
        project: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((automation, context) => {
    if (automation.level !== 'none' && automation.framework !== 'playwright') {
      context.addIssue({
        code: 'custom',
        message: 'Monitored and Verified Scenes require Playwright',
        path: ['framework'],
      });
    }
    if (
      automation.level === 'verified' &&
      automation.replayPath === undefined &&
      automation.linkedTest === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A Verified Scene requires replayPath or linkedTest',
        path: ['replayPath'],
      });
    }
  });

/**
 * Deterministic identity for a deprecated single CTA when it is projected into
 * the canonical multi-CTA model. The truncation keeps the derived value inside
 * IdSchema's 128-character limit even when the Step id uses the full budget.
 */
export function legacyStepCtaId(stepId: string): string {
  return `${stepId.slice(0, 124)}-cta`;
}

/**
 * Resolve the authored CTA contract. A non-empty Step.ctas is authoritative;
 * Step.cta is used only as a schemaVersion 1 compatibility fallback.
 */
export function canonicalStepCtas(step: Pick<Step, 'id' | 'ctas' | 'cta'>): readonly StepCta[] {
  if (step.ctas.length > 0) return step.ctas;
  return step.cta ? [{ id: legacyStepCtaId(step.id), variant: 'primary', ...step.cta }] : [];
}

export const SceneSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: IdSchema,
    title: z.string().min(1).max(500),
    slug: SlugSchema,
    description: z.string().max(10_000).optional(),
    status: SceneStatusSchema.default('draft'),
    capability: SceneCapabilitySchema.default('captured'),
    criticality: SceneCriticalitySchema.default('normal'),
    audience: z.array(IdSchema).max(100).default([]),
    tags: z.array(IdSchema).max(200).default([]),
    defaultLocale: LocaleSchema.default('en'),
    locales: z.array(LocaleDescriptorSchema).max(100).default([]),
    /** Inline locale overrides are portable in YAML-only and ZIP workflows. */
    translations: z.record(LocaleSchema, SceneTranslationSchema).default({}),
    narrativeFile: RelativePathSchema.optional(),
    theme: ThemeReferenceSchema.optional(),
    steps: z.array(StepSchema).min(1).max(10_000),
    assets: z.array(AssetRefSchema).max(100_000).default([]),
    automation: AutomationReferenceSchema.default({ level: 'none' }),
    createdAt: IsoDateTimeSchema.optional(),
    updatedAt: IsoDateTimeSchema.optional(),
    metadata: z.record(z.string(), JsonValueSchema).default({}),
  })
  .strict()
  .superRefine((scene, context) => {
    const seenStepIds = new Set<string>();
    const stepsById = new Map<string, (typeof scene.steps)[number]>();
    const seenStateIds = new Set<string>();
    const seenAssetHashes = new Set<string>();
    const seenAssetPaths = new Set<string>();
    for (const [index, step] of scene.steps.entries()) {
      if (seenStepIds.has(step.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate Step id: ${step.id}`,
          path: ['steps', index, 'id'],
        });
      }
      seenStepIds.add(step.id);
      stepsById.set(step.id, step);
      for (const phase of ['before', 'after'] as const) {
        const state = step.states[phase];
        if (state !== undefined) {
          if (seenStateIds.has(state.id)) {
            context.addIssue({
              code: 'custom',
              message: `Duplicate State id: ${state.id}`,
              path: ['steps', index, 'states', phase, 'id'],
            });
          }
          seenStateIds.add(state.id);
        }
      }
    }
    for (const [index, asset] of scene.assets.entries()) {
      if (seenAssetHashes.has(asset.sha256)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate asset hash: ${asset.sha256}`,
          path: ['assets', index, 'sha256'],
        });
      }
      seenAssetHashes.add(asset.sha256);
      if (seenAssetPaths.has(asset.path)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate asset path: ${asset.path}`,
          path: ['assets', index, 'path'],
        });
      }
      seenAssetPaths.add(asset.path);
    }
    const localeNames = new Set(scene.locales.map((locale) => locale.locale));
    if (scene.locales.length > 0 && !localeNames.has(scene.defaultLocale)) {
      context.addIssue({
        code: 'custom',
        message: 'defaultLocale must be present in locales when locale sidecars are configured',
        path: ['defaultLocale'],
      });
    }
    if (localeNames.size !== scene.locales.length) {
      context.addIssue({
        code: 'custom',
        message: 'Locale descriptors must be unique',
        path: ['locales'],
      });
    }
    for (const [locale, translation] of Object.entries(scene.translations)) {
      for (const [stepId, stepTranslation] of Object.entries(translation.steps)) {
        const sourceStep = stepsById.get(stepId);
        if (!sourceStep) {
          context.addIssue({
            code: 'custom',
            message: `Translation ${locale} references missing Step ${stepId}`,
            path: ['translations', locale, 'steps', stepId],
          });
          continue;
        }
        const choiceIds = new Set(sourceStep.choices.map((choice) => choice.id));
        for (const choiceId of Object.keys(stepTranslation.choices)) {
          if (!choiceIds.has(choiceId)) {
            context.addIssue({
              code: 'custom',
              message: `Translation ${locale} references missing choice ${choiceId}`,
              path: ['translations', locale, 'steps', stepId, 'choices', choiceId],
            });
          }
        }
        const authoredCtas = canonicalStepCtas(sourceStep);
        const ctasById = new Map(authoredCtas.map((cta) => [cta.id, cta]));
        for (const [ctaId, ctaTranslation] of Object.entries(stepTranslation.ctas)) {
          const sourceCta = ctasById.get(ctaId);
          if (!sourceCta) {
            context.addIssue({
              code: 'custom',
              message: `Translation ${locale} references missing CTA ${ctaId}`,
              path: ['translations', locale, 'steps', stepId, 'ctas', ctaId],
            });
            continue;
          }
          const fieldIds = new Set(sourceCta.fields.map((field) => field.id));
          for (const fieldId of Object.keys(ctaTranslation.fields)) {
            if (!fieldIds.has(fieldId)) {
              context.addIssue({
                code: 'custom',
                message: `Translation ${locale} references missing CTA field ${fieldId}`,
                path: ['translations', locale, 'steps', stepId, 'ctas', ctaId, 'fields', fieldId],
              });
            }
          }
        }
      }
    }
    if (
      scene.capability !== scene.automation.level &&
      !(scene.capability === 'captured' && scene.automation.level === 'none')
    ) {
      context.addIssue({
        code: 'custom',
        message: `Scene capability ${scene.capability} must match automation level ${scene.automation.level}`,
        path: ['capability'],
      });
    }
  });

// The portable authored Scene is the public Scene model. The alias makes the
// three-layer distinction explicit without forcing consumers to rename imports.
export const PortableSceneSchema = SceneSchema;

export type Action = z.infer<typeof ActionSchema>;
export type AutomationReference = z.infer<typeof AutomationReferenceSchema>;
export type Check = z.infer<typeof CheckSchema>;
export type Cta = z.infer<typeof CtaSchema>;
export type SceneTranslation = z.infer<typeof SceneTranslationSchema>;
export type StepCta = z.infer<typeof StepCtaSchema>;
export type StepTranslation = z.infer<typeof StepTranslationSchema>;
export type PortableScene = z.infer<typeof PortableSceneSchema>;
export type RedactionMask = z.infer<typeof RedactionMaskSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type SceneCapability = z.infer<typeof SceneCapabilitySchema>;
export type SceneState = z.infer<typeof SceneStateSchema>;
export type Step = z.infer<typeof StepSchema>;
export type StepPresentation = z.infer<typeof StepPresentationSchema>;
