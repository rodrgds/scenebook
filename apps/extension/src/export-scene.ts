import { zipSync, strToU8 } from 'fflate';
import { stringify } from 'yaml';
import { getAsset } from './asset-store';
import { sanitizeRecordedText, type RecorderSession, type TargetSnapshot } from './protocol';

function locatorExpression(target: TargetSnapshot): string | undefined {
  const generatedRole = target.selectors
    .map((selector) => /^getByRole\('([a-z][a-z0-9-]{0,99})'/u.exec(selector)?.[1])
    .find((role) => role !== undefined);
  const role = target.role ?? generatedRole;
  if (role && target.accessibleName) {
    return `page.getByRole(${JSON.stringify(role)} as never, { name: ${JSON.stringify(target.accessibleName)}, exact: true })`;
  }
  if (target.accessibleName) {
    return `page.getByText(${JSON.stringify(target.accessibleName)}, { exact: true })`;
  }
  const css = target.selectors.find((selector) => !selector.startsWith('getBy'));
  return css ? `page.locator(${JSON.stringify(css)})` : undefined;
}

function createPlaywrightDraft(session: RecorderSession): string | undefined {
  const replayable = session.steps.flatMap((step) => {
    const locator = step.target ? locatorExpression(step.target) : undefined;
    return locator ? [{ step, locator }] : [];
  });
  if (replayable.length === 0) return undefined;

  const firstRoute = session.steps.find((step) => /^https?:\/\//u.test(step.route))?.route;
  const lines = [
    "import { expect, test } from '@playwright/test';",
    '',
    '// Generated as an editable draft from local browser evidence.',
    '// Replace captured routes and locator candidates with deterministic fixtures before CI.',
    `test(${JSON.stringify(sanitizeRecordedText(session.title))}, async ({ page }) => {`,
  ];
  if (firstRoute) lines.push(`  await page.goto(${JSON.stringify(firstRoute)});`);
  for (const { step, locator } of replayable) {
    lines.push(
      `  await test.step(${JSON.stringify(sanitizeRecordedText(step.title))}, async () => {`,
      `    const target = ${locator};`,
      '    await expect(target).toBeVisible();',
      '    await target.click();',
      '  });',
    );
  }
  lines.push('});', '');
  return lines.join('\n');
}

export async function createSceneArchive(session: RecorderSession): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const steps: Record<string, unknown>[] = [];
  const assets: Record<string, unknown>[] = [];

  const serializeTarget = (target: NonNullable<(typeof session.steps)[number]['target']>) => ({
    role: target.role,
    accessibleName: target.accessibleName,
    nearbyText: target.nearbyText,
    selectors: target.selectors.map((value, index) => ({
      engine: value.startsWith('getByRole')
        ? 'role'
        : value.startsWith('getByLabel')
          ? 'label'
          : value.startsWith('getByTestId')
            ? 'testId'
            : 'css',
      value,
      confidence: Math.max(0.55, 0.95 - index * 0.1),
      generated: true,
    })),
    normalizedRect: target.rect,
    visible: target.visible ?? Boolean(target.rect),
    occluded: target.occluded ?? false,
  });

  for (const step of session.steps) {
    const asset = await getAsset(step.assetHash);
    if (!asset) throw new Error(`Missing captured asset ${step.assetHash}`);
    const assetPath = `assets/${step.assetHash}.png`;
    files[assetPath] = asset;
    if (!assets.some((candidate) => candidate.sha256 === step.assetHash)) {
      assets.push({
        sha256: step.assetHash,
        path: assetPath,
        mediaType: step.assetMime,
        byteLength: asset.byteLength,
        role: 'screenshot',
        width: Math.round(step.viewport.width * step.viewport.devicePixelRatio),
        height: Math.round(step.viewport.height * step.viewport.devicePixelRatio),
      });
    }
    steps.push({
      id: step.id,
      kind: 'browser',
      title: sanitizeRecordedText(step.title),
      caption: sanitizeRecordedText(step.caption),
      altText: sanitizeRecordedText(step.caption),
      states: {
        before: {
          id: `${step.id}-before`,
          route: step.route,
          screenshot: assets.find((candidate) => candidate.sha256 === step.assetHash),
          viewport: {
            width: step.viewport.width,
            height: step.viewport.height,
            deviceScaleFactor: step.viewport.devicePixelRatio,
            isMobile: step.viewport.width < 640,
          },
          scroll: { x: 0, y: 0 },
          capturedAt: step.createdAt,
        },
      },
      target: step.target ? serializeTarget(step.target) : undefined,
      actions: step.target
        ? [
            {
              id: `${step.id}-click`,
              kind: 'click',
              target: serializeTarget(step.target),
            },
          ]
        : [],
      checks:
        step === session.steps.at(-1)
          ? session.checks.map((check) => ({
              id: check.id,
              kind: check.kind,
              description: check.label,
              target: serializeTarget(check.target),
              critical: true,
            }))
          : [],
      presentation: {
        durationMs: 2200,
        annotations: step.target?.rect
          ? [{ id: `${step.id}-hotspot`, kind: 'hotspot', rect: step.target.rect }]
          : [],
        autoAdvance: false,
        transition: 'fade',
        state: 'before',
        visibility: { interactive: true, guide: true, motion: true, launchMedia: true },
        practiceMode: false,
      },
      masks: step.masks.map((mask, index) => {
        const { reason, ...rect } = mask;
        return {
          id: `${step.id}-mask-${index + 1}`,
          mode: 'opaque',
          source: reason === 'author' ? 'manual' : 'automatic',
          scope: 'both',
          reason,
          classification:
            reason === 'payment'
              ? 'payment'
              : reason === 'personal-data'
                ? 'personal-data'
                : reason === 'secret'
                  ? 'token'
                  : 'custom',
          rect,
        };
      }),
      choices: [],
    });
  }

  const source = {
    schemaVersion: 1,
    id: session.sceneId,
    slug: session.sceneId,
    title: sanitizeRecordedText(session.title),
    description: `A product story captured locally on ${new Date(session.startedAt).toLocaleDateString()}.`,
    status: 'draft',
    capability: 'captured',
    criticality: 'normal',
    createdAt: session.startedAt,
    updatedAt: new Date().toISOString(),
    defaultLocale: 'en',
    audience: [],
    tags: ['browser-recording'],
    locales: [],
    steps,
    assets,
    automation: { level: 'none' },
    metadata: {
      recorder: 'browser-extension',
      verified: false,
      replayDraft: session.steps.some(
        (step) => step.target && locatorExpression(step.target) !== undefined,
      ),
    },
  };

  files['scene.yaml'] = strToU8(
    stringify(source, { lineWidth: 100, aliasDuplicateObjects: false }),
  );
  const replay = createPlaywrightDraft(session);
  if (replay) files['automation/replay.ts'] = strToU8(replay);
  files['README.md'] = strToU8(
    `# ${sanitizeRecordedText(session.title)}\n\nPortable Scenebook source captured locally. Open this folder in Scenebook Studio to edit and publish it.${replay ? ' The generated Playwright file is an unverified draft; connect deterministic fixtures and assertions before promoting this Scene beyond Captured.' : ''}\n`,
  );
  return zipSync(files, { level: 6 });
}
