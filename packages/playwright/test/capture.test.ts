import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import { captureState } from '../src/capture.js';

describe('captureState', () => {
  it('asks Playwright to apply automatic and locator masks before a screenshot is persisted', async () => {
    const bytes = Buffer.from('already-masked-pixels');
    const automaticLocator = { kind: 'automatic' };
    const customLocator = { kind: 'custom' };
    const screenshot = vi.fn(async () => bytes);
    const page = {
      screenshot,
      locator: vi.fn((selector: string) =>
        selector === '.private' ? customLocator : automaticLocator,
      ),
      viewportSize: () => ({ width: 1280, height: 720 }),
      url: () => 'https://example.test/settings?token=must-not-persist',
      evaluate: vi.fn(async () => ({
        title: 'Invite ana@example.com',
        language: 'en',
        text: ['Send to ana@example.com', 'Token ghp_abcdefghijklmnopqrstuvwxyz123456'],
        nodes: [
          {
            role: 'button',
            name: 'Invite ana@example.com',
            states: { disabled: false, expanded: true },
          },
        ],
      })),
    } as unknown as Page;
    const target = {
      page: () => page,
      boundingBox: async () => ({ x: 640, y: 72, width: 256, height: 72 }),
      evaluate: async () => ({
        role: 'button',
        accessibleName: 'Invite ana@example.com',
        nearbyText: 'Invite ana@example.com',
        visible: true,
        occluded: false,
      }),
    } as unknown as Locator;
    const attach = vi.fn(async () => undefined);
    const testInfo = { attach } as unknown as TestInfo;
    const state = await captureState(
      page,
      testInfo,
      'invite-member',
      'open-form',
      'before',
      { masks: ['.private'], target, targetSelector: '[data-testid="invite"]' },
      {
        automaticMasks: true,
        maskColor: '#151515',
        captureSemanticProjection: true,
        animations: 'disabled',
        scale: 'css',
      },
    );
    expect(screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ mask: [automaticLocator, customLocator], maskColor: '#151515' }),
    );
    expect(attach).toHaveBeenCalledWith(
      expect.stringMatching(/^scenebook-state-/u),
      expect.objectContaining({ body: bytes, contentType: 'image/png' }),
    );
    expect(state.route).toBe('https://example.test/settings');
    expect(state.screenshotHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(JSON.stringify(state.semantic)).not.toContain('ana@example.com');
    expect(JSON.stringify(state.semantic)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(state.semantic?.nodes).toEqual([
      {
        role: 'button',
        name: 'Invite [REDACTED]',
        states: { disabled: false, expanded: true },
      },
    ]);
    expect(state.privacy?.status).toBe('blocked');
    expect(JSON.stringify(state.privacy)).not.toContain('ana@example.com');
    expect(JSON.stringify(state.privacy)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(state.target).toMatchObject({
      role: 'button',
      accessibleName: 'Invite [REDACTED]',
      normalizedRect: { x: 0.5, y: 0.1, width: 0.2, height: 0.1 },
      selectors: [{ engine: 'css', value: '[data-testid="invite"]', generated: false }],
    });
  });

  it('keeps capture privacy unknown until exact screenshot OCR and never requests raw body innerText', async () => {
    const evaluate = vi.fn(async (_callback?: unknown) => ({
      title: 'Dashboard',
      language: 'en',
      text: ['Welcome back', 'Deployment completed'],
      nodes: [],
    }));
    const page = {
      screenshot: vi.fn(async () => Buffer.from('masked pixels')),
      locator: vi.fn(() => ({ kind: 'automatic' })),
      viewportSize: () => ({ width: 800, height: 600 }),
      url: () => 'https://example.test/dashboard',
      evaluate,
    } as unknown as Page;
    const state = await captureState(
      page,
      { attach: vi.fn(async () => undefined) } as unknown as TestInfo,
      'dashboard',
      'outcome',
      'after',
      {},
      {
        automaticMasks: true,
        maskColor: '#151515',
        captureSemanticProjection: true,
        animations: 'disabled',
        scale: 'css',
      },
    );
    expect(state.privacy).toMatchObject({ status: 'unknown', findings: [] });
    const browserExtractor = String(evaluate.mock.calls[0]?.[0]);
    expect(browserExtractor).toContain('createTreeWalker');
    expect(browserExtractor).toContain('closest(sensitiveSelector)');
    expect(browserExtractor).not.toContain('innerText');
  });
});

describe('real browser capture fidelity', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  it('captures privacy-safe accessibility nodes and detects real target occlusion', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`<!doctype html>
      <html lang="en"><head><title>Team settings</title></head><body>
        <h1>Workspace members</h1>
        <label>Project name <input required value="internal launch codename"></label>
        <label>Email address <input type="email" value="private.person@example.test"></label>
        <button id="invite" aria-expanded="false"><span>Invite member</span></button>
        <div role="switch" aria-label="Deployment notifications" aria-checked="true"
          style="width:40px;height:20px"></div>
        <div data-scenebook-redact><button>Token ghp_abcdefghijklmnopqrstuvwxyz123456</button></div>
        <button style="display:none">Hidden action</button>
        <div id="cover" style="position:fixed;z-index:10;background:white"></div>
        <script>
          const target = document.querySelector('#invite').getBoundingClientRect();
          Object.assign(document.querySelector('#cover').style, {
            left: target.left + 'px', top: target.top + 'px',
            width: target.width + 'px', height: target.height + 'px'
          });
        </script>
      </body></html>`);
    const attach = vi.fn(async () => undefined);
    const fixture = {
      automaticMasks: true,
      maskColor: '#151515',
      captureSemanticProjection: true,
      animations: 'disabled' as const,
      scale: 'css' as const,
    };
    const covered = await captureState(
      page,
      { attach } as unknown as TestInfo,
      'invite-member',
      'open-form',
      'before',
      { target: page.locator('#invite'), targetSelector: '#invite' },
      fixture,
    );

    expect(covered.target).toMatchObject({ visible: true, occluded: true });
    expect(covered.semantic?.nodes).toEqual(
      expect.arrayContaining([
        { role: 'heading', name: 'Workspace members', level: 1, states: {} },
        {
          role: 'textbox',
          name: 'Project name',
          states: { disabled: false, required: true, readonly: false },
        },
        {
          role: 'button',
          name: 'Invite member',
          states: { disabled: false, expanded: false },
        },
        {
          role: 'switch',
          name: 'Deployment notifications',
          states: { disabled: false, checked: true },
        },
      ]),
    );
    expect(JSON.stringify(covered.semantic)).not.toContain('private.person@example.test');
    expect(JSON.stringify(covered.semantic)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(covered.semantic?.nodes.some((node) => node.name === 'Hidden action')).toBe(false);

    await page.locator('#cover').evaluate((element) => element.remove());
    const uncovered = await captureState(
      page,
      { attach } as unknown as TestInfo,
      'invite-member',
      'open-form',
      'after',
      { target: page.locator('#invite'), targetSelector: '#invite' },
      fixture,
    );
    expect(uncovered.target).toMatchObject({ visible: true, occluded: false });
    await page.close();
  });
});
