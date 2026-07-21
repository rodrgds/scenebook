import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, type Locator, type Page } from '@playwright/test';
import { format, resolveConfig } from 'prettier';
import { stringify } from 'yaml';

const repositoryRoot = resolve(import.meta.dir, '..');
const sceneDirectory = join(repositoryRoot, 'examples/acme-product/scenes/invite-member.scene');
const outputAssets = join(sceneDirectory, 'assets');
const baseUrl = 'http://127.0.0.1:4174';
const createdAt = '2026-07-20T12:00:00.000Z';

type Asset = {
  sha256: string;
  path: string;
  mediaType: 'image/png';
  byteLength: number;
  role: 'screenshot';
  width: number;
  height: number;
};

type Target = {
  role: string;
  accessibleName: string;
  selectors: Array<{ engine: string; value: string; confidence: number; generated: boolean }>;
  normalizedRect: { x: number; y: number; width: number; height: number };
  visible: true;
  occluded: false;
};

function normalized(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(6))));
}

async function target(
  page: Page,
  locator: Locator,
  role: string,
  name: string,
  selector: string,
): Promise<Target> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Target ${name} is not visible`);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('A fixed viewport is required');
  const cssId = await locator.getAttribute('id');
  const x = normalized(box.x / viewport.width);
  const y = normalized(box.y / viewport.height);
  return {
    role,
    accessibleName: name,
    selectors: [
      { engine: 'role', value: selector, confidence: 0.99, generated: false },
      ...(cssId ? [{ engine: 'css', value: `#${cssId}`, confidence: 0.8, generated: true }] : []),
    ],
    normalizedRect: {
      x,
      y,
      width: Math.min(normalized(box.width / viewport.width), 1 - x),
      height: Math.min(normalized(box.height / viewport.height), 1 - y),
    },
    visible: true,
    occluded: false,
  };
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('Example application did not start');
}

async function main(): Promise<void> {
  const server = spawn('bun', ['run', 'dev'], {
    cwd: join(repositoryRoot, 'apps/example'),
    stdio: 'ignore',
  });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'scenebook-example-'));
  const stagingAssets = join(temporaryDirectory, 'assets');
  await mkdir(stagingAssets, { recursive: true });

  try {
    await waitForServer();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      reducedMotion: 'reduce',
      locale: 'en-US',
    });
    await page.goto(`${baseUrl}/?scenebook=1`, { waitUntil: 'networkidle' });
    await page.addStyleTag({
      content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });

    const assets: Asset[] = [];
    const capture = async (mask: Locator[] = []): Promise<Asset> => {
      const bytes = await page.screenshot({
        animations: 'disabled',
        mask: [page.locator('[data-scenebook-redact]'), ...mask],
        maskColor: '#171b24',
      });
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const path = `assets/${sha256}.png`;
      await writeFile(join(stagingAssets, `${sha256}.png`), bytes);
      const asset = {
        sha256,
        path,
        mediaType: 'image/png' as const,
        byteLength: bytes.byteLength,
        role: 'screenshot' as const,
        width: 1440,
        height: 900,
      };
      if (!assets.some((candidate) => candidate.sha256 === sha256)) assets.push(asset);
      return asset;
    };

    const inviteButton = page.getByRole('button', { name: 'Invite member' });
    const inviteTarget = await target(
      page,
      inviteButton,
      'button',
      'Invite member',
      "getByRole('button', { name: 'Invite member' })",
    );
    const membersState = await capture();
    await inviteButton.click();

    const emailInput = page.getByLabel('Email address');
    const emailTarget = await target(
      page,
      emailInput,
      'textbox',
      'Email address',
      "getByLabel('Email address')",
    );
    const formState = await capture([emailInput]);
    await emailInput.fill('ana@example.test');

    const sendButton = page.getByRole('button', { name: 'Send invitation' });
    const sendTarget = await target(
      page,
      sendButton,
      'button',
      'Send invitation',
      "getByRole('button', { name: 'Send invitation' })",
    );
    const completedFormState = await capture([emailInput]);
    await sendButton.click();
    await page.getByText('Invitation sent').waitFor();
    const successState = await capture();
    await browser.close();

    const state = (id: string, screenshot: Asset) => ({
      id,
      route: '/?scenebook=1',
      screenshot,
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false },
      scroll: { x: 0, y: 0 },
      capturedAt: createdAt,
    });
    const presentation = (
      annotationId: string,
      hotspot?: Target['normalizedRect'],
      selectedState: 'before' | 'after' = 'before',
    ) => ({
      durationMs: 2600,
      annotations: hotspot ? [{ id: annotationId, kind: 'hotspot', rect: hotspot }] : [],
      autoAdvance: false,
      transition: 'fade',
      state: selectedState,
      visibility: { interactive: true, guide: true, motion: true, launchMedia: true },
      practiceMode: false,
    });
    const emailMask = {
      id: 'invitee-email-mask',
      mode: 'opaque',
      source: 'attribute',
      scope: 'both',
      rect: emailTarget.normalizedRect,
      reason: 'Example invitee address',
      classification: 'email',
    };

    const scene = {
      schemaVersion: 1,
      id: 'invite-member',
      slug: 'invite-member',
      title: 'Invite a teammate',
      description: 'Add a teammate to the Acme Studio workspace and confirm their invitation.',
      status: 'published',
      capability: 'verified',
      criticality: 'important',
      audience: ['workspace-admin'],
      tags: ['team-management', 'onboarding'],
      defaultLocale: 'en',
      locales: [],
      theme: { file: 'theme.yaml', variables: {} },
      steps: [
        {
          id: 'open-invitation-form',
          kind: 'browser',
          title: 'Open the invitation form',
          instruction: 'Choose Invite member.',
          caption: 'Start from the Members page and open a new invitation.',
          altText: 'Acme Studio Members page with the Invite member button highlighted.',
          states: { before: state('members-before-invite', membersState) },
          target: inviteTarget,
          actions: [{ id: 'click-invite', kind: 'click', target: inviteTarget }],
          checks: [],
          presentation: presentation('open-invitation-hotspot', inviteTarget.normalizedRect),
          masks: [],
          choices: [],
        },
        {
          id: 'enter-invitee',
          kind: 'browser',
          title: 'Enter your teammate’s email',
          instruction:
            'Enter the teammate’s work email. Scenebook masks this field before capture.',
          caption:
            'Add the person you want to invite. Sensitive values stay out of the Scene source.',
          altText: 'Invitation dialog with the email field irreversibly masked.',
          states: { before: state('invite-form-empty', formState) },
          target: emailTarget,
          actions: [
            {
              id: 'fill-email',
              kind: 'fill',
              target: emailTarget,
              value: { kind: 'fixture', name: 'invitee_email', sensitive: true },
            },
          ],
          checks: [],
          presentation: presentation('invitee-email-hotspot', emailTarget.normalizedRect),
          masks: [emailMask],
          choices: [],
        },
        {
          id: 'send-invitation',
          kind: 'browser',
          title: 'Send the invitation',
          instruction: 'Review the selected role, then send the invitation.',
          caption: 'The new member starts with the Member role. You can change it before sending.',
          altText:
            'Completed invitation form with the Send invitation button highlighted and email masked.',
          states: { before: state('invite-form-complete', completedFormState) },
          target: sendTarget,
          actions: [{ id: 'click-send', kind: 'click', target: sendTarget }],
          checks: [],
          presentation: presentation('send-invitation-hotspot', sendTarget.normalizedRect),
          masks: [emailMask],
          choices: [],
        },
        {
          id: 'confirm-invitation',
          kind: 'browser',
          title: 'Confirm the invitation',
          instruction: 'Look for the confirmation and the new pending member.',
          caption: 'The invitation is sent and the teammate appears in the member list.',
          altText: 'Members page showing an invitation sent confirmation and a pending member.',
          states: { after: state('invite-sent', successState) },
          actions: [],
          checks: [
            {
              id: 'invitation-sent-visible',
              kind: 'visible',
              description: 'Invitation sent confirmation is visible',
              critical: true,
            },
          ],
          presentation: presentation('confirmation-state', undefined, 'after'),
          masks: [],
          choices: [],
        },
        {
          id: 'invite-another',
          kind: 'end',
          title: 'Your teammate is on the way',
          caption: 'Share this guide with another workspace admin, or return to the product.',
          states: {},
          actions: [],
          checks: [],
          presentation: presentation('end-state'),
          masks: [],
          choices: [],
          cta: { kind: 'restart', label: 'Watch again', fields: [] },
        },
      ],
      assets,
      automation: {
        level: 'verified',
        framework: 'playwright',
        replayPath: 'automation/replay.ts',
      },
      createdAt,
      updatedAt: createdAt,
      metadata: { owner: 'Developer Experience', environment: 'example', release: '2026.7' },
    };

    await mkdir(sceneDirectory, { recursive: true });
    await rm(outputAssets, { recursive: true, force: true });
    await rename(stagingAssets, outputAssets);
    const source = stringify(scene, { lineWidth: 110, aliasDuplicateObjects: false });
    const scenePath = join(sceneDirectory, 'scene.yaml');
    const prettierConfig = await resolveConfig(scenePath);
    await writeFile(scenePath, await format(source, { ...prettierConfig, parser: 'yaml' }));
    const written = await readFile(scenePath, 'utf8');
    if (!written.includes('invite-member')) throw new Error('Scene source was not written');
  } finally {
    server.kill('SIGTERM');
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
