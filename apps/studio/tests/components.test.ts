import { createRawSnippet, tick } from 'svelte';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { demoScene } from '../src/lib/demo';
import * as evidenceModule from '../src/lib/evidence';
import type { EvidenceImportInspection } from '../src/lib/evidence';
import { createLocalMediaUrl, getLocalMediaBlob } from '../src/lib/local-media';
import { cloneScene } from '../src/lib/model';
import * as portableModule from '../src/lib/portable';
import { defaultProject, exportSceneYaml } from '../src/lib/portable';
import type { PortableImportResult } from '../src/lib/portable';
import {
  releaseLocalMediaUrls,
  STUDIO_PROJECT_CHANGED_EVENT,
  studioSceneLibrary,
  type ImportRunEvidenceResult,
  type ImportScenesResult,
} from '../src/lib/scene-library';
import { studioThemeLibrary } from '../src/lib/theme-library';
import AppShell from '../src/lib/components/AppShell.svelte';
import CatalogView from '../src/lib/components/CatalogView.svelte';
import EvidenceImportDialog from '../src/lib/components/EvidenceImportDialog.svelte';
import SceneCreateDialog from '../src/lib/components/SceneCreateDialog.svelte';
import SceneEditor from '../src/lib/components/SceneEditor.svelte';
import SceneHealth from '../src/lib/components/SceneHealth.svelte';
import SceneImportDialog from '../src/lib/components/SceneImportDialog.svelte';
import ScenePreview from '../src/lib/components/ScenePreview.svelte';
import ScenePublish from '../src/lib/components/ScenePublish.svelte';
import SceneVersions from '../src/lib/components/SceneVersions.svelte';
import ScenePage from '../src/routes/scenes/[id]/+page.svelte';

const navigation = vi.hoisted(() => ({ goto: vi.fn(async () => undefined) }));
const appPage = vi.hoisted(() => ({
  url: new URL('http://scenebook.test/'),
  params: {} as Record<string, string>,
}));

vi.mock('$app/navigation', () => navigation);
vi.mock('$app/state', () => ({ page: appPage }));

function matchMedia(matches: boolean): typeof window.matchMedia {
  return vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('Studio component workflows', () => {
  beforeEach(() => {
    navigation.goto.mockClear();
    appPage.url = new URL('http://scenebook.test/');
    appPage.params = {};
    window.matchMedia = matchMedia(false);
  });

  it('makes the closed mobile navigation inert and restores focus when it closes', async () => {
    window.matchMedia = matchMedia(true);
    render(AppShell, {
      props: {
        children: createRawSnippet(() => ({ render: () => '<p>Workbench</p>' })),
      },
    });
    await tick();

    const menu = screen.getByRole('button', { name: 'Open navigation' });
    const sidebar = document.querySelector<HTMLElement>('.sidebar')!;
    expect(sidebar.getAttribute('aria-hidden')).toBe('true');
    expect(sidebar.hasAttribute('inert')).toBe(true);

    await fireEvent.click(menu);
    expect(sidebar.getAttribute('aria-hidden')).toBe('false');
    expect(sidebar.hasAttribute('inert')).toBe(false);

    await fireEvent.click(within(sidebar).getByRole('button', { name: 'Close navigation' }));
    await tick();
    expect(sidebar.getAttribute('aria-hidden')).toBe('true');
    expect(sidebar.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(menu);
  });

  it('submits global catalog search and exposes no fake account or project controls', async () => {
    render(AppShell, {
      props: {
        children: createRawSnippet(() => ({ render: () => '<p>Workbench</p>' })),
      },
    });
    const input = screen.getByPlaceholderText('Search scenes…');
    await fireEvent.input(input, { target: { value: 'release tour' } });
    await fireEvent.submit(input.closest('form')!);
    expect(navigation.goto).toHaveBeenCalledWith('/catalog?q=release%20tour');
    expect(screen.queryByRole('button', { name: 'Switch project' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Account menu' })).toBeNull();
    expect(screen.queryByText('Record scene')).toBeNull();
    expect(screen.getByRole('link', { name: 'Review' }).getAttribute('href')).toBe('/changes');
    expect(screen.getByRole('link', { name: 'Collections' }).getAttribute('href')).toBe(
      '/collections',
    );
    expect(screen.getByRole('link', { name: 'Release' }).getAttribute('href')).toBe('/publish');
    expect(screen.getByRole('link', { name: 'Runs' }).getAttribute('href')).toBe('/runs');
    expect(screen.getByRole('link', { name: 'Coverage' }).getAttribute('href')).toBe('/insights');
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings');
    expect(document.querySelector('.nav-disabled')).toBeNull();
  });

  it('shows the durable Project identity and follows same-window Project changes', async () => {
    const project = { ...defaultProject([demoScene]), name: 'Imported workspace' };
    const loadProject = vi.spyOn(studioSceneLibrary, 'loadProject').mockResolvedValue(project);
    try {
      render(AppShell, {
        props: {
          children: createRawSnippet(() => ({ render: () => '<p>Workbench</p>' })),
        },
      });
      expect(
        await within(screen.getByLabelText('Current project')).findByText('Imported workspace'),
      ).toBeTruthy();

      window.dispatchEvent(
        new CustomEvent(STUDIO_PROJECT_CHANGED_EVENT, {
          detail: { ...project, name: 'Renamed workspace' },
        }),
      );
      await tick();
      expect(
        within(screen.getByLabelText('Current project')).getByText('Renamed workspace'),
      ).toBeTruthy();
    } finally {
      loadProject.mockRestore();
    }
  });

  it('opens the real create dialog from the shell action', async () => {
    render(AppShell, {
      props: {
        children: createRawSnippet(() => ({ render: () => '<p>Workbench</p>' })),
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'New scene' }));
    expect(await screen.findByRole('heading', { name: 'Create a scene' })).toBeTruthy();
    expect(screen.getByLabelText('Scene name')).toBe(document.activeElement);
  });

  it('keeps keyboard focus cycling inside an open create dialog', async () => {
    render(SceneCreateDialog, { props: { visible: true, onclose: vi.fn() } });
    await tick();

    const first = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'Create scene' });
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')!;
    dialog.focus();
    await fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    last.focus();
    await fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    await fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('closes a completed create dialog before navigation without reopening it', async () => {
    const created = cloneScene(demoScene);
    created.id = 'created-scene';
    created.title = 'Created scene';
    const create = vi.spyOn(studioSceneLibrary, 'create').mockResolvedValue(created);
    const onclose = vi.fn();
    render(SceneCreateDialog, { props: { visible: true, onclose } });

    await fireEvent.input(screen.getByLabelText('Scene name'), {
      target: { value: 'Created scene' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Create scene' }));

    await waitFor(() => expect(onclose).toHaveBeenCalledOnce());
    expect(navigation.goto).toHaveBeenCalledWith('/scenes/created-scene');
    expect(document.querySelector('dialog[open]')).toBeNull();
    create.mockRestore();
  });

  it('keeps scene creation single-flight while the durable write is pending', async () => {
    const write = deferred<ReturnType<typeof cloneScene>>();
    const create = vi.spyOn(studioSceneLibrary, 'create').mockReturnValue(write.promise);
    try {
      render(SceneCreateDialog, { props: { visible: true, onclose: vi.fn() } });
      const title = screen.getByLabelText('Scene name') as HTMLInputElement;
      await fireEvent.input(title, { target: { value: 'Pending scene' } });
      await fireEvent.click(screen.getByRole('button', { name: 'Create scene' }));
      const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')!;

      await waitFor(() => expect(dialog.getAttribute('aria-busy')).toBe('true'));
      expect(document.activeElement).toBe(dialog);
      expect(title.disabled).toBe(true);
      expect((screen.getByLabelText(/Description/u) as HTMLTextAreaElement).disabled).toBe(true);
      await fireEvent.submit(dialog.querySelector('form')!);
      expect(create).toHaveBeenCalledOnce();
      const cancel = new Event('cancel', { cancelable: true });
      dialog.dispatchEvent(cancel);
      expect(cancel.defaultPrevented).toBe(true);
      expect(dialog.open).toBe(true);

      const created = cloneScene(demoScene);
      created.id = 'pending-scene';
      write.resolve(created);
      await waitFor(() => expect(dialog.open).toBe(false));
    } finally {
      create.mockRestore();
    }
  });

  it('shows actionable invalid-file UX before an import can mutate the catalog', async () => {
    render(SceneImportDialog, { props: { visible: true, onclose: vi.fn() } });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['not a Scene'], 'notes.txt', { type: 'text/plain' });
    await fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText('Choose a .yaml, .yml, or .zip Scenebook file.')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Choose another file' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.querySelector<HTMLInputElement>('input[type="file"]'),
      ),
    );
  });

  it('uses a dedicated fail-closed Run evidence importer', async () => {
    render(EvidenceImportDialog, { props: { visible: true, onclose: vi.fn() } });
    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"][accept*="application/json"]',
    )!;
    await fireEvent.change(input, {
      target: {
        files: [
          new File(['{"kind":"run","kind":"review"}'], 'tampered.json', {
            type: 'application/json',
          }),
        ],
      },
    });
    expect(
      await screen.findByText('Evidence JSON is invalid or contains duplicate keys.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attach verified evidence' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Choose another file set' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.querySelector<HTMLInputElement>('input[type="file"]'),
      ),
    );
  });

  it('does not race a second scene file inspection against the first', async () => {
    const reading = deferred<PortableImportResult>();
    const inspect = vi
      .spyOn(portableModule, 'importPortableBytes')
      .mockReturnValue(reading.promise);
    try {
      render(SceneImportDialog, { props: { visible: true, onclose: vi.fn() } });
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      await fireEvent.change(input, {
        target: { files: [new File(['first'], 'first.yaml', { type: 'application/yaml' })] },
      });

      expect(input.disabled).toBe(true);
      expect(document.activeElement).toBe(input.closest('dialog'));
      await fireEvent.change(input, {
        target: { files: [new File(['second'], 'second.yaml', { type: 'application/yaml' })] },
      });
      expect(inspect).toHaveBeenCalledOnce();

      reading.resolve({ kind: 'scene', scenes: [cloneScene(demoScene)], warnings: [] });
      expect(await screen.findByText('first.yaml')).toBeTruthy();
    } finally {
      inspect.mockRestore();
    }
  });

  it('does not race a second evidence inspection against the first', async () => {
    const reading = deferred<EvidenceImportInspection>();
    const inspect = vi
      .spyOn(evidenceModule, 'inspectEvidenceFiles')
      .mockReturnValue(reading.promise);
    try {
      render(EvidenceImportDialog, { props: { visible: true, onclose: vi.fn() } });
      const input = document.querySelector<HTMLInputElement>(
        'input[type="file"][accept*="application/json"]',
      )!;
      await fireEvent.change(input, {
        target: { files: [new File(['first'], 'first.json', { type: 'application/json' })] },
      });

      expect(input.disabled).toBe(true);
      expect(document.activeElement).toBe(input.closest('dialog'));
      await fireEvent.change(input, {
        target: { files: [new File(['second'], 'second.json', { type: 'application/json' })] },
      });
      expect(inspect).toHaveBeenCalledOnce();

      reading.resolve({ candidates: [], warnings: [], ignoredFiles: [], buildCount: 0 });
      expect(await screen.findByText(/0 exact run artifacts/u)).toBeTruthy();
    } finally {
      inspect.mockRestore();
    }
  });

  it('keeps scene import controls locked while the atomic write is pending', async () => {
    const source = cloneScene(demoScene);
    for (const step of source.steps) {
      if (step.image) {
        step.image =
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
      }
    }
    const exported = await exportSceneYaml(source);
    const write = deferred<ImportScenesResult>();
    const importScenes = vi
      .spyOn(studioSceneLibrary, 'importScenes')
      .mockReturnValue(write.promise);
    try {
      render(SceneImportDialog, { props: { visible: true, onclose: vi.fn() } });
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      await fireEvent.change(input, {
        target: {
          files: [
            new File([exported.bytes.slice().buffer], exported.filename, {
              type: exported.mediaType,
            }),
          ],
        },
      });

      const submit = await screen.findByRole('button', { name: 'Import source' });
      await fireEvent.click(submit);
      const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')!;
      await waitFor(() => expect(dialog.getAttribute('aria-busy')).toBe('true'));

      expect(document.activeElement).toBe(dialog);
      expect(
        (screen.getByRole('button', { name: 'Choose another' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      const cancel = new Event('cancel', { cancelable: true });
      dialog.dispatchEvent(cancel);
      expect(cancel.defaultPrevented).toBe(true);
      expect(dialog.open).toBe(true);

      write.resolve({ imported: [cloneScene(demoScene)], skipped: [], renamed: [] });
      await waitFor(() => expect(dialog.open).toBe(false));
    } finally {
      importScenes.mockRestore();
    }
  });

  it('keeps evidence import controls locked while the atomic write is pending', async () => {
    const inspection = {
      candidates: [
        {
          sceneId: demoScene.id,
          evidence: {
            runRevision: 'a'.repeat(64),
            run: {
              id: 'run-1',
              sceneId: demoScene.id,
              runTargetId: 'desktop',
              durationMs: 20,
              status: 'passed',
              changeState: 'passed',
            },
            verifiedAssetHashes: [],
            missingAssetHashes: [],
          },
          assets: [],
        },
      ],
      warnings: [],
      ignoredFiles: [],
      buildCount: 0,
    } as unknown as EvidenceImportInspection;
    const inspect = vi.spyOn(evidenceModule, 'inspectEvidenceFiles').mockResolvedValue(inspection);
    const write = deferred<ImportRunEvidenceResult>();
    const importEvidence = vi
      .spyOn(studioSceneLibrary, 'importRunEvidence')
      .mockReturnValue(write.promise);
    try {
      render(EvidenceImportDialog, { props: { visible: true, onclose: vi.fn() } });
      const input = document.querySelector<HTMLInputElement>(
        'input[type="file"][accept*="application/json"]',
      )!;
      await fireEvent.change(input, {
        target: { files: [new File(['{}'], 'run.json', { type: 'application/json' })] },
      });

      const submit = await screen.findByRole('button', { name: 'Attach verified evidence' });
      await fireEvent.click(submit);
      const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')!;
      await waitFor(() => expect(dialog.getAttribute('aria-busy')).toBe('true'));

      expect(document.activeElement).toBe(dialog);
      expect(
        (screen.getByRole('button', { name: 'Choose another' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      const cancel = new Event('cancel', { cancelable: true });
      dialog.dispatchEvent(cancel);
      expect(cancel.defaultPrevented).toBe(true);
      expect(dialog.open).toBe(true);

      write.resolve({ scenes: [], runCount: 1 });
      await waitFor(() => expect(dialog.open).toBe(false));
    } finally {
      importEvidence.mockRestore();
      inspect.mockRestore();
    }
  });

  it('keeps duplicate-scene failures inside the modal when Escape is pressed while pending', async () => {
    appPage.url = new URL(`http://scenebook.test/scenes/${demoScene.id}?tab=health`);
    appPage.params = { id: demoScene.id };
    const load = vi.spyOn(studioSceneLibrary, 'load').mockResolvedValue({
      scene: cloneScene(demoScene),
      saved: null,
      recovery: null,
      migratedLegacy: false,
    });
    const duplicateResult = deferred<ReturnType<typeof cloneScene>>();
    const duplicate = vi
      .spyOn(studioSceneLibrary, 'duplicate')
      .mockReturnValue(duplicateResult.promise);
    try {
      render(ScenePage);
      await fireEvent.click(await screen.findByRole('button', { name: 'More scene actions' }));
      await fireEvent.click(screen.getByRole('button', { name: /Duplicate scene/u }));
      const dialog = screen.getByRole('dialog', { name: 'Scene actions' }) as HTMLDialogElement;
      const cancel = new Event('cancel', { cancelable: true });
      dialog.dispatchEvent(cancel);

      expect(cancel.defaultPrevented).toBe(true);
      expect(dialog.open).toBe(true);
      duplicateResult.reject(new Error('The duplicate write failed.'));
      expect((await within(dialog).findByRole('alert')).textContent).toContain(
        'The duplicate write failed.',
      );
      expect(dialog.open).toBe(true);
    } finally {
      duplicate.mockRestore();
      load.mockRestore();
    }
  });

  it('keeps core editor controls functional without a browser automation backend', async () => {
    const preview = vi.fn();
    render(SceneEditor, { props: { scene: cloneScene(demoScene), onpreview: preview } });
    const initialCount = demoScene.steps.length;
    expect(screen.getByText(`${initialCount} total`)).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Duplicate step' }));
    expect(screen.getByText(`${initialCount + 1} total`)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(preview).toHaveBeenCalledOnce();

    await waitFor(() => {
      expect(
        screen.getByText(/Unsaved changes|Saving…|Saved locally|Save failed · Retry/u),
      ).toBeTruthy();
    });
  });

  it('keeps the mobile editor to one navigable pane and collapses advanced authoring controls', async () => {
    window.matchMedia = matchMedia(true);
    render(SceneEditor, { props: { scene: cloneScene(demoScene) } });
    const paneTabs = screen.getByRole('tablist', { name: 'Editor view' });
    const canvasTab = within(paneTabs).getByRole('tab', { name: 'Canvas' });
    expect(canvasTab.getAttribute('aria-selected')).toBe('true');

    await fireEvent.keyDown(canvasTab, { key: 'ArrowRight' });
    const inspectorTab = within(paneTabs).getByRole('tab', { name: 'Inspector' });
    expect(inspectorTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(inspectorTab);
    expect(document.querySelector('.content-details')?.hasAttribute('open')).toBe(false);
    expect(screen.getByText('Interaction').closest('details')?.hasAttribute('open')).toBe(false);

    await fireEvent.click(within(paneTabs).getByRole('tab', { name: 'Steps' }));
    const firstStep = document.querySelector<HTMLButtonElement>('.step-select')!;
    firstStep.focus();
    await fireEvent.click(firstStep);
    await waitFor(() => {
      expect(canvasTab.getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe(canvasTab);
    });
  });

  it('keeps responsive tool menus named and restores focus after choosing a tool', async () => {
    render(SceneEditor, { props: { scene: cloneScene(demoScene) } });
    const annotateSummary = screen.getByLabelText('Annotate tools');
    const annotateMenu = annotateSummary.closest('details')!;
    expect(annotateSummary.getAttribute('aria-label')).toBe('Annotate tools');
    expect(screen.getByLabelText('Privacy tools')).toBeTruthy();

    await fireEvent.click(annotateSummary);
    const callout = within(annotateMenu).getByRole('button', { name: 'Callout' });
    callout.focus();
    await fireEvent.click(callout);

    expect(annotateMenu.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(annotateSummary);
  });

  it('authors and keyboard-edits callouts, spotlights, arrows, and masks on the canvas', async () => {
    render(SceneEditor, { props: { scene: cloneScene(demoScene) } });

    const existingCallout = screen.getByRole('button', {
      name: /Callout 1: Only workspace admins/iu,
    });
    await fireEvent.click(existingCallout);
    expect(screen.getByLabelText('Selected annotation controls')).toBeTruthy();
    const canvas = document.querySelector<HTMLElement>('.canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1_000,
      bottom: 500,
      width: 1_000,
      height: 500,
      toJSON: () => ({}),
    });
    const initialCalloutLeft = existingCallout.closest<HTMLElement>('.canvas-annotation-object')!
      .style.left;
    await fireEvent.pointerDown(existingCallout, { clientX: 100, clientY: 100 });
    await fireEvent.pointerMove(window, { clientX: 200, clientY: 150 });
    await fireEvent.pointerUp(window);
    expect(
      screen
        .getByRole('button', { name: /Callout 1: Only workspace admins/iu })
        .closest<HTMLElement>('.canvas-annotation-object')!.style.left,
    ).not.toBe(initialCalloutLeft);

    await fireEvent.click(screen.getByRole('button', { name: 'Spotlight' }));
    await fireEvent.keyDown(screen.getByRole('button', { name: /Place spotlight on/iu }), {
      key: 'Enter',
    });
    let spotlight = screen.getByRole('button', { name: /Spotlight 2: Spotlight/iu });
    const spotlightObject = spotlight.closest<HTMLElement>('.canvas-annotation-object')!;
    const initialLeft = spotlightObject.style.left;
    await fireEvent.keyDown(spotlight, { key: 'ArrowRight' });
    spotlight = screen.getByRole('button', { name: /Spotlight 2: Spotlight/iu });
    expect(spotlight.closest<HTMLElement>('.canvas-annotation-object')!.style.left).not.toBe(
      initialLeft,
    );

    const width = screen.getByLabelText('width');
    await fireEvent.input(width, { target: { value: '30' } });
    expect(
      screen
        .getByRole('button', { name: /Spotlight 2: Spotlight/iu })
        .closest<HTMLElement>('.canvas-annotation-object')!.style.width,
    ).toBe('30%');
    await fireEvent.keyDown(screen.getByRole('button', { name: /Spotlight 2: Spotlight/iu }), {
      key: 'Delete',
    });
    expect(screen.queryByRole('button', { name: /Spotlight 2: Spotlight/iu })).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Arrow' }));
    await fireEvent.keyDown(screen.getByRole('button', { name: /Place arrow on/iu }), {
      key: 'Enter',
    });
    const arrow = screen.getByRole('button', { name: /Arrow 2: Arrow/iu });
    expect(screen.getByRole('button', { name: /Resize arrow 2/iu })).toBeTruthy();
    await fireEvent.keyDown(arrow, { key: 'ArrowDown', altKey: true });
    expect(screen.getByLabelText('Start X')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Mask' }));
    await fireEvent.keyDown(screen.getByRole('button', { name: /Place mask on/iu }), {
      key: 'Enter',
    });
    const mask = screen.getByRole('button', { name: /Mask 1: Redacted content/iu });
    expect(screen.getByLabelText('Selected mask controls')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resize mask 1' })).toBeTruthy();
    await fireEvent.keyDown(mask, { key: 'ArrowLeft', shiftKey: true });
    await fireEvent.keyDown(screen.getByRole('button', { name: /Mask 1: Redacted content/iu }), {
      key: 'Delete',
    });
    expect(screen.queryByRole('button', { name: /Mask 1: Redacted content/iu })).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Blur' }));
    await fireEvent.keyDown(screen.getByRole('button', { name: /Place blur on/iu }), {
      key: 'Enter',
    });
    const blur = screen.getByRole('button', { name: /Blur 1: Blurred region/iu });
    expect(blur.classList.contains('blur')).toBe(true);
    expect((screen.getByLabelText('Mask type') as HTMLSelectElement).value).toBe('blur');
    expect(screen.getByText(/Publication exports rasterize this blur/iu)).toBeTruthy();
  });

  it('saves, applies, updates, and deletes reusable themes', async () => {
    studioThemeLibrary.save('Release night', {
      accent: '#336699',
      paper: '#111111',
      ink: '#f5f5f5',
      radius: 22,
      frame: 'dark',
    });
    render(SceneEditor, { props: { scene: cloneScene(demoScene) } });

    await waitFor(() => {
      expect((screen.getByLabelText('Saved theme') as HTMLSelectElement).value).toBe(
        'release-night',
      );
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Apply theme' }));
    expect((screen.getByLabelText('Accent') as HTMLInputElement).value).toBe('#336699');
    expect((screen.getByLabelText('Corner radius') as HTMLInputElement).value).toBe('22');

    await fireEvent.input(screen.getByLabelText('Theme name'), {
      target: { value: 'Product launch' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /Save current/iu }));
    expect(studioThemeLibrary.list().map((theme) => theme.name)).toEqual([
      'Product launch',
      'Release night',
    ]);
    expect(screen.getByText('Saved Product launch.')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Delete saved theme' }));
    expect(studioThemeLibrary.list().map((theme) => theme.name)).toEqual(['Release night']);
  });

  it('authors cursor position, path, style, click timing, and undo state', async () => {
    render(SceneEditor, { props: { scene: cloneScene(demoScene) } });
    expect(screen.getAllByLabelText(/Cursor path point \d+ time/iu)).toHaveLength(2);

    await fireEvent.change(screen.getByLabelText('Cursor style'), { target: { value: 'dot' } });
    expect(document.querySelector('.canvas-cursor.dot')).toBeTruthy();

    await fireEvent.input(screen.getByLabelText('Click timing (ms)'), {
      target: { value: '1200' },
    });
    expect((screen.getByLabelText('Click timing (ms)') as HTMLInputElement).value).toBe('1200');
    await fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect((screen.getByLabelText('Click timing (ms)') as HTMLInputElement).value).toBe('850');

    await fireEvent.click(screen.getByRole('button', { name: 'Add path point' }));
    expect(screen.getAllByLabelText(/Cursor path point \d+ time/iu)).toHaveLength(3);
    await fireEvent.click(screen.getByRole('button', { name: 'Cursor' }));
    await fireEvent.keyDown(screen.getByRole('button', { name: /Place cursor on/iu }), {
      key: 'Enter',
    });
    expect((screen.getByLabelText('Show cursor') as HTMLInputElement).checked).toBe(true);
  });

  it('splits and merges screen Steps with meaningful content semantics', async () => {
    const scene = cloneScene(demoScene);
    scene.steps[0]!.instruction =
      'Open the member directory. Then choose Invite member to continue.';
    render(SceneEditor, { props: { scene } });
    const initialCount = scene.steps.length;

    await fireEvent.click(screen.getByRole('button', { name: 'Split step' }));
    expect(screen.getByText(`${initialCount + 1} total`)).toBeTruthy();
    expect(screen.getByDisplayValue('Then choose Invite member to continue.')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Merge previous' }));
    expect(screen.getByText(`${initialCount} total`)).toBeTruthy();
    expect(
      screen.getByDisplayValue('Open the member directory. Then choose Invite member to continue.'),
    ).toBeTruthy();
  });

  it('supports editor keyboard duplication and durable translation authoring', async () => {
    render(SceneEditor, { props: { scene: cloneScene(demoScene) } });
    const initialCount = demoScene.steps.length;
    await fireEvent.keyDown(window, { key: 'd', metaKey: true });
    expect(screen.getByText(`${initialCount + 1} total`)).toBeTruthy();

    const translations = screen.getByRole('heading', { name: 'Translations' }).closest('section')!;
    await fireEvent.input(within(translations).getByLabelText('New language tag'), {
      target: { value: 'pt-PT' },
    });
    await fireEvent.click(within(translations).getByRole('button', { name: 'Add language' }));
    const translatedTitle = within(translations).getByLabelText('Translated Step title');
    await fireEvent.input(translatedTitle, { target: { value: 'Abrir o convite' } });
    expect((translatedTitle as HTMLInputElement).value).toBe('Abrir o convite');
    expect(within(translations).getByRole('button', { name: 'Remove pt-PT' })).toBeTruthy();
  });

  it('rejects active screenshot files in the editor before they enter Scene state', async () => {
    render(SceneEditor, { props: { scene: cloneScene(demoScene) } });
    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"][accept*="image/png"]',
    )!;
    const file = new File(['<svg><script>alert(1)</script></svg>'], 'unsafe.svg', {
      type: 'image/svg+xml',
    });
    await fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText(/Active content is not allowed/u)).toBeTruthy();
  });

  it('durably starts a new-media save even when the editor is destroyed during navigation', async () => {
    const recovery = vi.spyOn(studioSceneLibrary, 'writeRecovery').mockImplementation((scene) => ({
      id: scene.id,
      scene: cloneScene(scene),
      updatedAt: Date.now(),
      token: 91,
    }));
    const save = vi.spyOn(studioSceneLibrary, 'save').mockImplementation(async (scene) => ({
      id: scene.id,
      scene: cloneScene(scene),
      savedAt: Date.now(),
      revision: 2,
    }));
    const rendered = render(SceneEditor, { props: { scene: cloneScene(demoScene) } });
    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"][accept*="image/png"]',
    )!;
    const payload = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwO0GQAAAABJRU5ErkJggg==',
      ),
      (character) => character.charCodeAt(0),
    );
    await fireEvent.change(input, {
      target: { files: [new File([payload], 'replacement.png', { type: 'image/png' })] },
    });
    rendered.unmount();

    await waitFor(() => expect(save).toHaveBeenCalled());
    const savedScene = save.mock.calls.at(-1)![0];
    expect(savedScene.steps[0]!.image).toMatch(/^blob:/u);
    expect(recovery).toHaveBeenCalled();
    releaseLocalMediaUrls(savedScene);
    save.mockRestore();
    recovery.mockRestore();
  });

  it('flushes a debounced edit when switching away destroys the editor tab', async () => {
    const recovery = vi.spyOn(studioSceneLibrary, 'writeRecovery').mockImplementation((scene) => ({
      id: scene.id,
      scene: cloneScene(scene),
      updatedAt: Date.now(),
      token: 92,
    }));
    const save = vi.spyOn(studioSceneLibrary, 'save').mockImplementation(async (scene) => ({
      id: scene.id,
      scene: cloneScene(scene),
      savedAt: Date.now(),
      revision: 2,
    }));
    const rendered = render(SceneEditor, { props: { scene: cloneScene(demoScene) } });
    await fireEvent.click(screen.getByRole('button', { name: 'Duplicate step' }));
    rendered.unmount();

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0].steps).toHaveLength(demoScene.steps.length + 1);
    save.mockRestore();
    recovery.mockRestore();
  });

  it('does not revoke current Blob media when editor history is destroyed on a tab switch', async () => {
    const scene = cloneScene(demoScene);
    const mediaUrl = createLocalMediaUrl(new Uint8Array([1, 2, 3]).buffer, 'image/png');
    scene.steps[0]!.image = mediaUrl;
    const recovery = vi.spyOn(studioSceneLibrary, 'writeRecovery').mockImplementation((value) => ({
      id: value.id,
      scene: cloneScene(value),
      updatedAt: Date.now(),
      token: 93,
    }));
    const save = vi.spyOn(studioSceneLibrary, 'save').mockImplementation(async (value) => ({
      id: value.id,
      scene: cloneScene(value),
      savedAt: Date.now(),
      revision: 2,
    }));
    const rendered = render(SceneEditor, { props: { scene } });
    await fireEvent.click(screen.getByRole('button', { name: 'Duplicate step' }));
    rendered.unmount();
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(getLocalMediaBlob(mediaUrl)).not.toBeNull();
    releaseLocalMediaUrls(scene, save.mock.calls[0]![0]);
    save.mockRestore();
    recovery.mockRestore();
  });

  it('revokes catalog previews that arrive after the catalog view is destroyed', async () => {
    const mediaUrl = createLocalMediaUrl(new Uint8Array([1]).buffer, 'image/png');
    let resolvePage!: (value: Awaited<ReturnType<typeof studioSceneLibrary.listPage>>) => void;
    const page = new Promise<Awaited<ReturnType<typeof studioSceneLibrary.listPage>>>((resolve) => {
      resolvePage = resolve;
    });
    const listPage = vi.spyOn(studioSceneLibrary, 'listPage').mockReturnValue(page);
    const rendered = render(CatalogView);
    rendered.unmount();
    resolvePage({
      items: [
        {
          id: 'late-preview',
          title: 'Late preview',
          description: '',
          stepCount: 1,
          savedAt: Date.now(),
          revision: 1,
          firstImage: mediaUrl,
          finalImage: mediaUrl,
          tags: [],
          publicationStatus: 'draft',
          audiences: [],
          capability: 'captured',
          runStatus: 'stale',
          evidenceRuns: [],
          automationLevel: 'none',
          checkCount: 0,
          translationCount: 0,
          screenStepCount: 1,
          screenAssetCount: 1,
          opaqueMaskCount: 0,
          hiddenStepCount: 0,
          sample: false,
        },
      ],
      nextCursor: null,
    });

    await waitFor(() => expect(getLocalMediaBlob(mediaUrl)).toBeNull());
    listPage.mockRestore();
  });

  it('uses authored audience and publication state in the local catalog', async () => {
    const listPage = vi.spyOn(studioSceneLibrary, 'listPage').mockResolvedValue({
      items: [
        {
          id: 'published-onboarding',
          title: 'Published onboarding',
          description: 'A customer-facing flow.',
          stepCount: 2,
          savedAt: Date.now(),
          revision: 4,
          tags: ['onboarding'],
          publicationStatus: 'published',
          audiences: ['workspace-admins', 'new-customers'],
          capability: 'verified',
          runStatus: 'passed',
          evidenceRuns: [],
          automationLevel: 'verified',
          checkCount: 2,
          translationCount: 1,
          screenStepCount: 2,
          screenAssetCount: 2,
          opaqueMaskCount: 1,
          hiddenStepCount: 0,
          sample: false,
        },
        {
          id: 'private-draft',
          title: 'Private draft',
          description: 'An unpublished internal flow.',
          stepCount: 1,
          savedAt: Date.now(),
          revision: 1,
          tags: ['internal'],
          publicationStatus: 'draft',
          audiences: ['support'],
          capability: 'captured',
          runStatus: 'stale',
          evidenceRuns: [],
          automationLevel: 'none',
          checkCount: 0,
          translationCount: 0,
          screenStepCount: 1,
          screenAssetCount: 0,
          opaqueMaskCount: 0,
          hiddenStepCount: 0,
          sample: false,
        },
      ],
      nextCursor: null,
    });
    try {
      render(CatalogView);
      const title = await screen.findByText('Published onboarding');
      const card = title.closest('article');
      expect(card).not.toBeNull();
      expect(within(card!).getByText('Published')).toBeTruthy();
      expect(within(card!).getByText('workspace-admins, new-customers')).toBeTruthy();
      expect(screen.queryByText('Local workspace')).toBeNull();
      expect(within(card!).queryByText('Unpublished')).toBeNull();

      const publicationFilter = screen.getByRole('combobox', {
        name: 'Filter by publication state',
      }) as HTMLSelectElement;
      publicationFilter.value = 'draft';
      await fireEvent.change(publicationFilter);
      await waitFor(() => expect(screen.queryByText('Published onboarding')).toBeNull());
      expect(screen.getByText('Private draft')).toBeTruthy();
    } finally {
      listPage.mockRestore();
    }
  });

  it('revokes a selected revision that hydrates after Versions is destroyed', async () => {
    const mediaUrl = createLocalMediaUrl(new Uint8Array([2]).buffer, 'image/png');
    let resolveVersion!: (
      value: Awaited<ReturnType<typeof studioSceneLibrary.loadVersion>>,
    ) => void;
    const version = new Promise<Awaited<ReturnType<typeof studioSceneLibrary.loadVersion>>>(
      (resolve) => {
        resolveVersion = resolve;
      },
    );
    const summaries = vi.spyOn(studioSceneLibrary, 'listVersionSummaries').mockResolvedValue({
      items: [
        {
          id: demoScene.id,
          revision: 1,
          savedAt: Date.now(),
          title: demoScene.title,
          stepCount: demoScene.steps.length,
          translationCount: 0,
          hasPortableSource: false,
          verification: null,
          runRevisions: [],
          theme: { ...demoScene.theme },
          steps: demoScene.steps.map((step) => ({
            id: step.id,
            title: step.title,
            type: step.type,
          })),
        },
      ],
      nextCursor: null,
    });
    const loadVersion = vi.spyOn(studioSceneLibrary, 'loadVersion').mockReturnValue(version);
    const rendered = render(SceneVersions, { props: { scene: cloneScene(demoScene) } });
    await waitFor(() => expect(loadVersion).toHaveBeenCalled());
    rendered.unmount();
    const hydrated = cloneScene(demoScene);
    hydrated.steps[0]!.image = mediaUrl;
    resolveVersion({
      id: hydrated.id,
      scene: hydrated,
      savedAt: Date.now(),
      revision: 1,
    });

    await waitFor(() => expect(getLocalMediaBlob(mediaUrl)).toBeNull());
    loadVersion.mockRestore();
    summaries.mockRestore();
  });

  it('applies authored presentation geometry in every Studio output preview', async () => {
    const scene = cloneScene(demoScene);
    for (const step of scene.steps) {
      step.outputVisibility = { interactive: false, guide: false, motion: false, social: false };
    }
    const step = scene.steps[0]!;
    step.outputVisibility = { interactive: true, guide: true, motion: true, social: true };
    step.crop = { x: 0.75, y: 0.25, zoom: 2 };
    step.frame = 'mobile';
    step.cursor = { x: 0.8, y: 0.35, visible: true, click: true };
    step.masks = [
      {
        id: 'bounded-mask',
        mode: 'opaque',
        source: 'manual',
        scope: 'both',
        classification: 'custom',
        x: 0.7,
        y: 0.3,
        width: 0.5,
        height: 0.5,
      },
    ];
    step.annotations = [
      { id: 'bounded-note', x: 0.76, y: 0.2, text: 'Mapped note', kind: 'callout' },
    ];

    render(ScenePreview, { props: { scene } });
    await waitFor(() => {
      const player = document.querySelector<HTMLElement>('scenebook-player');
      expect(player?.shadowRoot?.querySelector('.stage')?.getAttribute('data-frame')).toBe(
        'mobile',
      );
      expect(player?.shadowRoot?.querySelector('.cursor.click')).toBeTruthy();
      expect(
        player?.shadowRoot?.querySelector('.control[data-next]')?.getAttribute('aria-label'),
      ).toMatch(/^(Next step|Finish walkthrough)$/u);
    });

    for (const mode of ['Guide', 'Motion', 'Launch media']) {
      await fireEvent.click(screen.getByRole('tab', { name: mode }));
      const preview = document.querySelector<HTMLElement>('[data-presentation-preview]')!;
      expect(preview.dataset.frame).toBe('mobile');
      expect(preview.dataset.cropZoom).toBe('2');
      expect(preview.querySelector('.cursor.click')).toBeTruthy();
      for (const overlay of preview.querySelectorAll<HTMLElement>(
        '.mask,.annotation,.cursor,.hotspot',
      )) {
        expect(Number.parseFloat(overlay.style.left)).toBeGreaterThanOrEqual(0);
        expect(Number.parseFloat(overlay.style.left)).toBeLessThanOrEqual(100);
        expect(Number.parseFloat(overlay.style.top)).toBeGreaterThanOrEqual(0);
        expect(Number.parseFloat(overlay.style.top)).toBeLessThanOrEqual(100);
      }
    }
  });

  it('provides roving keyboard tabs for output previews without hiding mobile labels', async () => {
    render(ScenePreview, { props: { scene: cloneScene(demoScene) } });
    const previewTabs = screen.getByRole('tablist', { name: 'Output preview' });
    expect(
      within(previewTabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent?.trim()),
    ).toEqual(['Walkthrough', 'Guide', 'Motion', 'Launch media']);
    const walkthrough = screen.getByRole('tab', { name: 'Walkthrough' });
    const guide = screen.getByRole('tab', { name: 'Guide' });
    expect(walkthrough.getAttribute('tabindex')).toBe('0');
    expect(guide.getAttribute('tabindex')).toBe('-1');

    await fireEvent.keyDown(walkthrough, { key: 'ArrowRight' });
    expect(guide.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(guide);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('preview-tab-guide');
  });

  it('separates irreversible privacy masks from reversible presentation blurs', async () => {
    const scene = cloneScene(demoScene);
    for (const step of scene.steps) step.masks = [];
    scene.steps[0]!.masks = [
      {
        id: 'opaque-mask',
        mode: 'opaque',
        source: 'manual',
        scope: 'both',
        classification: 'custom',
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.1,
      },
      {
        id: 'presentation-blur',
        mode: 'blur',
        source: 'manual',
        scope: 'both',
        classification: 'custom',
        x: 0.4,
        y: 0.4,
        width: 0.2,
        height: 0.1,
      },
    ];
    render(SceneHealth, { props: { scene } });
    await fireEvent.click(screen.getByText('Redactions').closest('summary')!);

    expect(within(screen.getByText('Opaque masks').closest('div')!).getByText('1')).toBeTruthy();
    expect(
      within(screen.getByText('Presentation blurs').closest('div')!).getByText('1'),
    ).toBeTruthy();
    expect(screen.getByText(/Presentation blurs are reversible/iu)).toBeTruthy();
  });

  it('edits form and cross-Scene CTA configuration without placeholder controls', async () => {
    render(SceneEditor, { props: { scene: cloneScene(demoScene) } });
    await fireEvent.click(screen.getByText('Your teammate is invited').closest('button')!);
    const actions = screen.getByRole('heading', { name: 'End card actions' }).closest('section')!;
    const type = within(actions).getAllByLabelText('Action type')[0]!;

    await fireEvent.change(type, { target: { value: 'form' } });
    expect(within(actions).getByLabelText('Webhook ID')).toBeTruthy();
    expect(within(actions).getByDisplayValue('Work email')).toBeTruthy();
    await fireEvent.input(within(actions).getByLabelText('Webhook ID'), {
      target: { value: 'lead-capture' },
    });
    expect((within(actions).getByLabelText('Webhook ID') as HTMLInputElement).value).toBe(
      'lead-capture',
    );

    await fireEvent.change(type, { target: { value: 'view-scene' } });
    expect(within(actions).getByLabelText('Destination Scene ID')).toBeTruthy();
    expect(within(actions).queryByLabelText('Webhook ID')).toBeNull();
  });

  it('presents the complete production publish handoff without claiming external side effects', async () => {
    const scene = cloneScene(demoScene);
    scene.steps[0]!.masks = [
      {
        id: 'private-email',
        mode: 'opaque',
        source: 'automatic',
        scope: 'publication',
        classification: 'email',
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.1,
      },
      {
        id: 'decorative-blur',
        mode: 'blur',
        source: 'manual',
        scope: 'publication',
        classification: 'custom',
        x: 0.4,
        y: 0.4,
        width: 0.2,
        height: 0.1,
      },
    ];
    render(ScenePublish, { props: { scene } });

    expect(
      screen.getByRole('heading', {
        name: 'Export this scene',
      }),
    ).toBeTruthy();
    expect(screen.getByText(/\d+ opaque masks/u)).toBeTruthy();
    expect(screen.getByText(/\d+ manual blurs/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download scene YAML' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download scene ZIP' })).toBeTruthy();

    for (const disclosure of [
      'Safe public-distribution contract',
      'Production compiler matrix',
      'Verified CLI handoff',
      'Share and deploy',
    ]) {
      await fireEvent.click(screen.getByText(disclosure).closest('summary')!);
    }

    for (const format of [
      'Catalog',
      'Standalone HTML',
      'Web Component',
      'Iframe',
      'Markdown',
      'MDX',
      'HTML guide',
      'PDF',
      'MP4',
      'WebM',
      'GIF',
      'README card',
      'Open Graph',
      'Social images',
      'Remix source',
    ]) {
      expect(screen.getByText(format)).toBeTruthy();
    }
    expect(screen.getByText('SEO is noindex, nofollow')).toBeTruthy();
    expect(screen.getByText('Analytics is opt-in')).toBeTruthy();
    expect(screen.getByText('Form delivery is opt-in')).toBeTruthy();
    expect(screen.getByText(/OIDC uploads a deterministic archive and evidence/iu)).toBeTruthy();
    expect(screen.getByText(/does not deploy the static site/iu)).toBeTruthy();
    expect(screen.getByText(/privacy scan --provider tesseract/u)).toBeTruthy();
    expect(
      screen.getByText(/publish --channel public --destination public\/scenebook/u),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Deploy|Promote|Upload/iu })).toBeNull();
  });
});
