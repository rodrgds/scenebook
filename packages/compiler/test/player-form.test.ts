import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, SceneSchema, serializeSceneYaml } from '@scenebook/schema';
import { compileScenes, type PrivacyGate, type PublicationPlan } from '../src/index.js';

const directories: string[] = [];
const passedPrivacy: PrivacyGate = async () => ({
  status: 'passed',
  scanner: 'test-ocr:1',
  findings: [],
});
const ANALYTICS_ENDPOINT =
  'https://api.example.test/v1/public/workspaces/workspace-1/projects/product-1/channels/public/analytics';
const CTA_ENDPOINT =
  'https://api.example.test/v1/public/workspaces/workspace-1/projects/product-1/channels/public/cta';
const ANALYTICS_TOKEN = 'public-channel-token-for-static-player';
const CTA_TOKEN = 'public-channel-token-for-form-submission';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  await browser?.close();
});

async function formFixture(
  options: { readonly analytics?: boolean; readonly cta?: boolean } = {},
): Promise<{ output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-form-player-test-'));
  directories.push(root);
  const scene = join(root, 'scenes', 'request-demo.scene');
  const detailsScene = join(root, 'scenes', 'details.scene');
  const output = join(root, 'dist');
  await mkdir(scene, { recursive: true });
  await mkdir(detailsScene, { recursive: true });
  await writeFile(
    join(scene, 'scene.yaml'),
    serializeSceneYaml(
      SceneSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        id: 'request-demo',
        slug: 'request-demo',
        title: 'Request a demo',
        steps: [
          { id: 'welcome', kind: 'intro', title: 'Request a tailored demo' },
          {
            id: 'route',
            kind: 'choice',
            title: 'Choose what happens next',
            choices: [{ id: 'details', label: 'Read the details', targetSceneId: 'details' }],
          },
          {
            id: 'contact',
            kind: 'end',
            title: 'Tell us about yourself',
            ctas: [
              {
                id: 'request-demo',
                variant: 'primary',
                kind: 'form',
                label: 'Send request',
                webhookId: 'qualified-leads',
                fields: [
                  { id: 'email', label: 'Work email', type: 'email', required: true },
                  { id: 'company', label: 'Company', type: 'text' },
                  {
                    id: 'consent',
                    label: 'I agree to be contacted',
                    type: 'checkbox',
                    required: true,
                    consent: true,
                  },
                ],
              },
              {
                id: 'restart',
                variant: 'secondary',
                kind: 'restart',
                label: 'Start again',
              },
            ],
          },
        ],
      }),
    ),
  );
  await writeFile(
    join(detailsScene, 'scene.yaml'),
    serializeSceneYaml(
      SceneSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        id: 'details',
        slug: 'details',
        title: 'Details',
        steps: [{ id: 'done', kind: 'end', title: 'Done' }],
      }),
    ),
  );
  const publicationPlan: PublicationPlan | undefined =
    options.analytics || options.cta
      ? {
          format: 'scenebook-publication-plan',
          version: 1,
          selection: { mode: 'project', projectId: 'product-1', collectionIds: [] },
          title: 'Public product stories',
          distribution: {
            seo: { index: false, follow: false },
            attribution: true,
            remix: true,
            ...(options.analytics
              ? {
                  analytics: {
                    endpoint: ANALYTICS_ENDPOINT,
                    releaseId: 'release-1',
                    respectDoNotTrack: true,
                  },
                }
              : {}),
            ...(options.cta ? { cta: { endpoint: CTA_ENDPOINT, releaseId: 'release-1' } } : {}),
          },
          groups: [],
          policy: {
            missingSceneEntry: 'error',
            duplicateScenePlacement: 'first-occurrence-wins',
            ungroupedScenes: 'include',
          },
        }
      : undefined;
  await compileScenes({
    scenes: [scene, detailsScene],
    outputDirectory: output,
    formats: ['standalone-html', 'web-component', 'iframe'],
    privacyGate: passedPrivacy,
    ...(publicationPlan ? { publicationPlan } : {}),
    ...(options.analytics
      ? {
          publicAnalytics: {
            endpoint: ANALYTICS_ENDPOINT,
            token: ANALYTICS_TOKEN,
            releaseId: 'release-1',
            respectDoNotTrack: true,
          },
        }
      : {}),
    ...(options.cta
      ? {
          publicCta: {
            endpoint: CTA_ENDPOINT,
            token: CTA_TOKEN,
            releaseId: 'release-1',
          },
        }
      : {}),
  });
  return { output };
}

async function openStandalone(page: Page, output: string, initialStep?: string): Promise<string> {
  const html = await readFile(join(output, 'standalone/request-demo.html'), 'utf8');
  const pageUrl = 'https://player.example.test/standalone/request-demo.html';
  await page.route(pageUrl, async (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );
  await page.goto(`${pageUrl}${initialStep ? `#step=${encodeURIComponent(initialStep)}` : ''}`, {
    waitUntil: 'load',
  });
  await expect
    .poll(() =>
      page
        .locator('scenebook-player')
        .evaluate((element) => Boolean((element as never as { scene: unknown }).scene)),
    )
    .toBe(true);
  return html;
}

async function collectEvents(page: Page): Promise<void> {
  await page.locator('scenebook-player').evaluate((element) => {
    const target = window as typeof window & {
      __events?: Array<{ type: string; detail: unknown }>;
    };
    target.__events = [];
    for (const type of [
      'scenebook:stepchange',
      'scenebook:branch',
      'scenebook:cta',
      'scenebook:complete',
    ]) {
      element.addEventListener(type, (event) => {
        if (type === 'scenebook:branch') event.preventDefault();
        target.__events?.push({ type, detail: (event as CustomEvent).detail });
      });
    }
  });
}

async function fillAndSubmit(page: Page): Promise<void> {
  const player = page.locator('scenebook-player');
  await player.locator('input[name="email"]').fill('person@example.test');
  await player.locator('input[name="company"]').fill('Acme & Sons');
  await player.locator('input[name="consent"]').check();
  await player.locator('button[type="submit"]').click();
}

const expectedDetail = {
  sceneId: 'request-demo',
  stepId: 'contact',
  ctaId: 'request-demo',
  webhookId: 'qualified-leads',
  fields: {
    email: 'person@example.test',
    company: 'Acme & Sons',
    consent: true,
  },
};

describe('generated canonical-viewer players', () => {
  it('keeps lifecycle, deep-link, branch, transcript, input guards, and multiple CTA behavior aligned', async () => {
    const { output } = await formFixture();
    const page = await browser.newPage();
    try {
      const html = await openStandalone(page, output, 'route');
      expect(html).toContain('new URL(document.referrer).origin');
      expect(html).toContain('detail: bridgeDetail(name, detail)');
      expect(html).toContain('fields: _fields');
      expect(html).not.toMatch(/postMessage\([^)]*,\s*["']\*["']\)/u);

      const player = page.locator('scenebook-player');
      const transcript = player.locator('.transcript');
      await playwrightExpect(transcript).toBeVisible();
      await playwrightExpect(transcript).not.toHaveAttribute('open', '');
      await transcript.locator('summary').click();
      await playwrightExpect(transcript).toHaveAttribute('open', '');
      await expect
        .poll(() =>
          player.evaluate((element) => (element as never as { currentStep: number }).currentStep),
        )
        .toBe(1);
      await player.locator('[data-jump="0"]').click();
      await expect.poll(() => page.evaluate(() => location.hash)).toBe('#step=welcome');
      await collectEvents(page);
      await player.locator('[data-next]').click();
      await playwrightExpect(player.locator('[data-choice]')).toHaveText(/Read the details/u);
      await player.locator('[data-choice]').click();
      await player.locator('[data-jump="2"]').click();
      await playwrightExpect(player.locator('[data-cta]')).toHaveCount(1);
      await playwrightExpect(player.locator('[data-cta-form]')).toHaveCount(0);
      await playwrightExpect(player.locator('.cta-result')).toContainText(/unavailable/iu);
      await player.locator('[data-cta]').click();
      await playwrightExpect(player.locator('[aria-current="step"]')).toContainText(
        'Request a tailored demo',
      );

      const events = await page.evaluate(
        () =>
          (window as typeof window & { __events?: Array<{ type: string; detail: unknown }> })
            .__events ?? [],
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'scenebook:branch',
            detail: expect.objectContaining({
              stepId: 'route',
              resolved: true,
              choice: expect.objectContaining({ id: 'details' }),
            }),
          }),
          expect.objectContaining({
            type: 'scenebook:complete',
            detail: expect.objectContaining({ stepId: 'contact', complete: true }),
          }),
          expect.objectContaining({
            type: 'scenebook:cta',
            detail: expect.objectContaining({ cta: expect.objectContaining({ id: 'restart' }) }),
          }),
        ]),
      );

      const componentPage = await browser.newPage();
      try {
        await componentPage.setContent(
          '<scenebook-player data-scene="request-demo"></scenebook-player><script>window.__events=[];document.querySelector("scenebook-player").addEventListener("scenebook:ready",event=>window.__events.push(event.detail))</script>',
        );
        const existingViewer = (
          await readFile(join(output, 'components/details.js'), 'utf8')
        ).replaceAll('import.meta.url', '"https://player.example.test/components/details.js"');
        await componentPage.addScriptTag({ type: 'module', content: existingViewer });
        const component = (
          await readFile(join(output, 'components/request-demo.js'), 'utf8')
        ).replaceAll('import.meta.url', '"https://player.example.test/components/request-demo.js"');
        await componentPage.addScriptTag({ type: 'module', content: component });
        await expect
          .poll(() =>
            componentPage
              .locator('scenebook-player')
              .evaluate((element) => Boolean((element as never as { scene: unknown }).scene)),
          )
          .toBe(true);
        const componentPlayer = componentPage.locator('scenebook-player');
        await componentPlayer.evaluate((element) =>
          (element as never as { goTo(index: number, source: string): void }).goTo(2, 'test'),
        );
        await playwrightExpect(componentPlayer.locator('[data-cta]')).toHaveText('Start again');
        await playwrightExpect(componentPlayer.locator('[data-cta-form]')).toHaveCount(1);
      } finally {
        await componentPage.close();
      }
    } finally {
      await page.close();
    }
  });

  it('honors reduced motion and protects form inputs from global keyboard navigation', async () => {
    const { output } = await formFixture({ analytics: true, cta: true });
    const page = await browser.newPage();
    let analyticsRequests = 0;
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'doNotTrack', {
        configurable: true,
        get: () => '1',
      });
    });
    await page.route(ANALYTICS_ENDPOINT, async (route) => {
      analyticsRequests += 1;
      await route.fulfill({ status: 202, body: '' });
    });
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openStandalone(page, output);
      const player = page.locator('scenebook-player');
      await player.evaluate((element) => {
        const instance = element as never as {
          scene: { steps: Array<{ autoAdvance?: boolean; durationMs?: number }> };
          goTo(index: number, source: string): void;
        };
        instance.scene.steps[0]!.autoAdvance = true;
        instance.scene.steps[0]!.durationMs = 250;
        instance.goTo(0, 'test');
      });
      await page.waitForTimeout(900);
      await expect
        .poll(() =>
          player.evaluate((element) => (element as never as { currentStep: number }).currentStep),
        )
        .toBe(0);

      await player.evaluate((element) =>
        (element as never as { goTo(index: number, source: string): void }).goTo(2, 'test'),
      );
      const email = player.locator('input[name="email"]');
      await email.focus();
      await email.press('ArrowLeft');
      await expect
        .poll(() =>
          player.evaluate((element) => (element as never as { currentStep: number }).currentStep),
        )
        .toBe(2);
      await player.press('Home');
      await expect
        .poll(() =>
          player.evaluate((element) => (element as never as { currentStep: number }).currentStep),
        )
        .toBe(0);
      await page.waitForTimeout(200);
      expect(analyticsRequests).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('submits reviewed fields with retry-safe idempotency and anonymous lifecycle analytics', async () => {
    const { output } = await formFixture({ analytics: true, cta: true });
    const page = await browser.newPage();
    const analytics: Array<Record<string, unknown>> = [];
    const submissions: Array<Record<string, unknown>> = [];
    let attempt = 0;
    await page.route(ANALYTICS_ENDPOINT, async (route) => {
      analytics.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 202, body: '' });
    });
    await page.route(CTA_ENDPOINT, async (route) => {
      submissions.push(route.request().postDataJSON() as Record<string, unknown>);
      attempt += 1;
      await route.fulfill({ status: attempt === 1 ? 503 : 202, body: '' });
    });
    try {
      await openStandalone(page, output);
      const player = page.locator('scenebook-player');
      await collectEvents(page);
      await player.evaluate((element) =>
        (element as never as { goTo(index: number, source: string): void }).goTo(2, 'transcript'),
      );
      await fillAndSubmit(page);
      await playwrightExpect(player.locator('.cta-result')).toHaveText(
        'Your response could not be sent. Check your connection and try again.',
      );
      await player.locator('button[type="submit"]').click();
      await playwrightExpect(player.locator('.cta-result')).toHaveText('Your response was sent.');
      await expect.poll(() => submissions.length).toBe(2);
      await expect.poll(() => analytics.some((event) => event.type === 'cta')).toBe(true);

      for (const submission of submissions) {
        expect(submission).toMatchObject({
          releaseId: 'release-1',
          ...expectedDetail,
        });
        expect(submission.id).toMatch(/^cta-[a-f0-9]{32}$/u);
      }
      expect(submissions[0]?.id).toBe(submissions[1]?.id);
      for (const event of analytics) {
        expect(JSON.stringify(event)).not.toMatch(/person@example\.test|Acme & Sons|"fields"/u);
        expect(event).not.toHaveProperty('anonymousId');
        expect(event).not.toHaveProperty('sessionId');
      }
      const hostEvents = await page.evaluate(
        () =>
          (window as typeof window & { __events?: Array<{ type: string; detail: unknown }> })
            .__events ?? [],
      );
      expect(hostEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'scenebook:cta',
            detail: expect.objectContaining(expectedDetail),
          }),
        ]),
      );
    } finally {
      await page.close();
    }
  });
});
