<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  import {
    cloneScene,
    cloneEditorWorkingScene,
    defaultStep,
    duplicateStep,
    moveAnnotation,
    moveMask,
    moveStep,
    normalizedPoint,
    removeStep,
    resizeAnnotation,
    resizeMask,
  } from '../model';
  import type { EditorAnnotation, EditorCta, EditorScene, EditorStep, OutputKind } from '../model';
  import { PortableFileError, readScreenshotFile } from '../portable';
  import {
    releaseLocalMediaUrls,
    releaseLocalMediaUrlsExcept,
    SceneRevisionConflictError,
    studioSceneLibrary,
  } from '../scene-library';
  import { studioThemeLibrary, type SavedTheme } from '../theme-library';
  import Icon from './Icon.svelte';

  type CanvasTool =
    'select' | 'hotspot' | 'callout' | 'spotlight' | 'arrow' | 'mask' | 'blur' | 'cursor';
  type Aspect = '16:9' | '4:3' | '1:1' | '9:16';
  type CursorStyle = NonNullable<EditorStep['cursor']['style']>;
  type OverlaySelection = { kind: 'annotation' | 'mask'; id: string };
  type DragOperation = {
    selection: OverlaySelection;
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    source: EditorScene;
    changed: boolean;
  };

  let {
    scene = $bindable(),
    onpreview,
    onflushchange,
  }: {
    scene: EditorScene;
    onpreview?: () => void;
    onflushchange?: (flush: (() => Promise<void>) | null) => void;
  } = $props();

  let selectedIndex = $state(0);
  let history = $state<EditorScene[]>([]);
  let future = $state<EditorScene[]>([]);
  let activeTool = $state<CanvasTool>('select');
  let aspect = $state<Aspect>('16:9');
  let dragIndex = $state<number | null>(null);
  let saveState = $state<'saved' | 'saving' | 'unsaved' | 'error'>('saved');
  let saveError = $state('');
  let saveConflict = $state(false);
  let canvasElement: HTMLDivElement;
  let screenshotInput = $state<HTMLInputElement>();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSave: { snapshot: EditorScene; recoveryToken?: number } | null = null;
  let savesInFlight = 0;
  let destroyed = false;
  let imageError = $state('');
  let activeLocale = $state('source');
  let newLocale = $state('');
  let translationError = $state('');
  let selectedOverlay = $state<OverlaySelection | null>(null);
  let dragOperation = $state<DragOperation | null>(null);
  let savedThemes = $state<SavedTheme[]>([]);
  let selectedThemeId = $state('');
  let themeName = $state('');
  let themeLibraryError = $state('');
  let themeLibraryNotice = $state('');

  let selectedStep = $derived(scene.steps[selectedIndex] ?? scene.steps[0]!);
  let locales = $derived(Object.keys(scene.translations ?? {}).sort());
  let selectedTranslation = $derived(
    activeLocale === 'source'
      ? undefined
      : scene.translations?.[activeLocale]?.steps[selectedStep.id],
  );
  let displayTitle = $derived(selectedTranslation?.title || selectedStep.title);
  let displayInstruction = $derived(selectedTranslation?.instruction || selectedStep.instruction);
  let importedCheckCount = $derived(
    scene.portableSource?.steps.reduce((total, step) => total + step.checks.length, 0) ?? 0,
  );
  let canSplitSelected = $derived(
    selectedStep.type === 'screen' && Boolean(splitText(selectedStep.instruction)),
  );
  let selectedAnnotation = $derived(
    selectedOverlay?.kind === 'annotation'
      ? selectedStep.annotations.find((annotation) => annotation.id === selectedOverlay?.id)
      : undefined,
  );
  let selectedMask = $derived(
    selectedOverlay?.kind === 'mask'
      ? selectedStep.masks.find((mask) => mask.id === selectedOverlay?.id)
      : undefined,
  );
  let selectedSavedTheme = $derived(
    savedThemes.find((savedTheme) => savedTheme.id === selectedThemeId),
  );

  $effect(() => {
    if (activeLocale !== 'source' && !scene.translations?.[activeLocale]) {
      activeLocale = 'source';
    }
  });

  $effect(() => {
    selectedStep.id;
    if (
      selectedOverlay &&
      !selectedStep.annotations.some((annotation) => annotation.id === selectedOverlay?.id) &&
      !selectedStep.masks.some((mask) => mask.id === selectedOverlay?.id)
    ) {
      selectedOverlay = null;
    }
  });

  onDestroy(() => {
    if (dragOperation?.changed) capturePendingSave();
    const abandonedHistory = [...history, ...future];
    destroyed = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    void commitPendingSave(false);
    void studioSceneLibrary
      .waitForPendingSaves(scene.id)
      .catch(() => undefined)
      .then(() => releaseLocalMediaUrlsExcept(abandonedHistory, scene));
  });

  onMount(() => {
    refreshSavedThemes();
    onflushchange?.(() => commitPendingSave(true, true));
    return () => onflushchange?.(null);
  });

  function capturePendingSave() {
    saveState = 'unsaved';
    saveError = '';
    saveConflict = false;
    const snapshot = cloneScene(scene);
    let recoveryToken: number | undefined;
    try {
      recoveryToken = studioSceneLibrary.writeRecovery(snapshot).token;
    } catch (error) {
      saveState = 'error';
      saveError = error instanceof Error ? error.message : 'Crash recovery is unavailable.';
    }
    pendingSave = { snapshot, recoveryToken };
  }

  function queueSave(immediate = false): Promise<void> | undefined {
    capturePendingSave();
    if (saveTimer) clearTimeout(saveTimer);
    if (immediate) {
      saveTimer = undefined;
      return commitPendingSave();
    }
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void commitPendingSave();
    }, 520);
    return undefined;
  }

  async function commitPendingSave(updateUi = true, propagateError = false): Promise<void> {
    const pending = pendingSave;
    if (!pending) return;
    pendingSave = null;
    savesInFlight += 1;
    if (updateUi && !destroyed) saveState = 'saving';
    try {
      await studioSceneLibrary.save(pending.snapshot, pending.recoveryToken);
      if (updateUi && !destroyed && !pendingSave && savesInFlight === 1) {
        saveState = 'saved';
        saveError = '';
        saveConflict = false;
      }
    } catch (error) {
      if (updateUi && !destroyed) {
        saveState = 'error';
        saveError = error instanceof Error ? error.message : 'The Scene could not be saved.';
        saveConflict = error instanceof SceneRevisionConflictError;
      }
      if (propagateError) throw error;
    } finally {
      savesInFlight -= 1;
    }
  }

  function retrySave() {
    if (saveConflict) {
      window.location.reload();
      return;
    }
    queueSave();
  }

  function mutate(update: (draft: EditorScene) => void, immediateSave = false) {
    history = [...history.slice(-39), cloneEditorWorkingScene(scene)];
    future = [];
    const draft = cloneEditorWorkingScene(scene);
    update(draft);
    scene = draft;
    return queueSave(immediateSave);
  }

  function refreshSavedThemes(preferredId = '') {
    themeLibraryError = '';
    try {
      savedThemes = studioThemeLibrary.list();
      const preferred = savedThemes.find((savedTheme) => savedTheme.id === preferredId);
      const selected = preferred ?? savedThemes[0];
      selectedThemeId = selected?.id ?? '';
      themeName = selected?.name ?? `${scene.title} theme`.slice(0, 80);
    } catch (error) {
      savedThemes = [];
      selectedThemeId = '';
      themeLibraryError =
        error instanceof Error ? error.message : 'The saved theme library is unavailable.';
    }
  }

  function selectSavedTheme(id: string) {
    selectedThemeId = id;
    const selected = savedThemes.find((savedTheme) => savedTheme.id === id);
    if (selected) themeName = selected.name;
    themeLibraryError = '';
    themeLibraryNotice = '';
  }

  function applySavedTheme() {
    const saved = selectedSavedTheme;
    if (!saved) return;
    mutate((draft) => (draft.theme = { ...saved.theme }));
    themeLibraryError = '';
    themeLibraryNotice = `Applied ${saved.name}.`;
  }

  function saveCurrentTheme() {
    themeLibraryError = '';
    themeLibraryNotice = '';
    try {
      const saved = studioThemeLibrary.save(themeName, scene.theme);
      refreshSavedThemes(saved.id);
      themeLibraryNotice = `Saved ${saved.name}.`;
    } catch (error) {
      themeLibraryError = error instanceof Error ? error.message : 'The theme could not be saved.';
    }
  }

  function deleteSavedTheme() {
    const saved = selectedSavedTheme;
    if (!saved) return;
    themeLibraryError = '';
    themeLibraryNotice = '';
    try {
      if (studioThemeLibrary.delete(saved.id)) {
        refreshSavedThemes();
        themeLibraryNotice = `Deleted ${saved.name}.`;
      }
    } catch (error) {
      themeLibraryError =
        error instanceof Error ? error.message : 'The saved theme could not be deleted.';
    }
  }

  function updateStep(update: (step: EditorStep) => void, immediateSave = false) {
    return mutate((draft) => {
      const step = draft.steps[selectedIndex];
      if (step) update(step);
    }, immediateSave);
  }

  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    future = [cloneEditorWorkingScene(scene), ...future].slice(0, 40);
    scene = previous;
    history = history.slice(0, -1);
    selectedIndex = Math.min(selectedIndex, scene.steps.length - 1);
    queueSave();
  }

  function redo() {
    const next = future[0];
    if (!next) return;
    history = [...history, cloneEditorWorkingScene(scene)].slice(-40);
    scene = next;
    future = future.slice(1);
    selectedIndex = Math.min(selectedIndex, scene.steps.length - 1);
    queueSave();
  }

  function reorder(from: number, to: number) {
    if (from === to) return;
    mutate((draft) => (draft.steps = moveStep(draft.steps, from, to)));
    selectedIndex = to;
  }

  function uniqueStepId(base: string, steps: readonly EditorStep[]): string {
    const safeBase = base.replaceAll(/[^a-z0-9._:-]+/giu, '-').replaceAll(/-+$/gu, '') || 'step';
    const existing = new Set(steps.map((step) => step.id));
    let candidate = `${safeBase}-${Date.now().toString(36)}`;
    let suffix = 2;
    while (existing.has(candidate))
      candidate = `${safeBase}-${Date.now().toString(36)}-${suffix++}`;
    return candidate;
  }

  function splitText(value: string | undefined): [string, string] | null {
    const source = value?.trim() ?? '';
    if (source.length < 24) return null;
    const candidates = [...source.matchAll(/[.!?;:]\s+|,\s+/gu)]
      .map((match) => (match.index ?? 0) + match[0].length)
      .filter((index) => index >= 10 && source.length - index >= 10);
    const index = candidates.sort(
      (left, right) => Math.abs(source.length / 2 - left) - Math.abs(source.length / 2 - right),
    )[0];
    if (!index) return null;
    return [source.slice(0, index).trim(), source.slice(index).trim()];
  }

  function addStep(type: EditorStep['type'] = 'screen') {
    mutate((draft) => {
      const step = defaultStep(`step-${Date.now()}`, selectedStep?.image);
      step.type = type;
      if (type === 'choice') {
        step.title = 'Choose a path';
        step.hotspot = undefined;
        step.choices = [
          {
            id: `choice-${Date.now()}`,
            label: 'First path',
            sceneId: 'linked-scene',
            href: '/scenes/linked-scene',
          },
        ];
      }
      if (type === 'intro') {
        step.title = 'Introduce this journey';
        step.instruction = 'Set context before the first product interaction.';
        step.image = undefined;
        step.hotspot = undefined;
        step.cursor.visible = false;
      }
      if (type === 'separator') {
        step.title = 'Next chapter';
        step.instruction = 'Explain what changes in the next part of the journey.';
        step.image = undefined;
        step.hotspot = undefined;
        step.cursor.visible = false;
      }
      if (type === 'end') {
        step.title = 'Journey complete';
        step.hotspot = undefined;
        step.ctas = [
          {
            id: `cta-${Date.now()}`,
            label: 'Restart walkthrough',
            kind: 'restart',
            event: 'restart',
            fields: [],
            variant: 'primary',
          },
        ];
        step.ctaEdited = true;
      }
      draft.steps.splice(selectedIndex + 1, 0, step);
    });
    selectedIndex += 1;
  }

  function copySelected() {
    const sourceId = selectedStep.id;
    let duplicateId = '';
    mutate((draft) => {
      duplicateId = uniqueStepId(sourceId, draft.steps);
      draft.steps = duplicateStep(draft.steps, selectedIndex, (base) =>
        base === sourceId ? duplicateId : `${base}-${Date.now().toString(36)}`,
      );
      for (const translation of Object.values(draft.translations ?? {})) {
        const source = translation.steps[sourceId];
        if (source) translation.steps[duplicateId] = structuredClone(source);
      }
    });
    selectedIndex += 1;
  }

  function deleteSelected() {
    if (scene.steps.length <= 1) return;
    const deletedId = selectedStep.id;
    mutate((draft) => {
      draft.steps = removeStep(draft.steps, selectedIndex);
      for (const translation of Object.values(draft.translations ?? {})) {
        delete translation.steps[deletedId];
      }
    });
    selectedIndex = Math.min(selectedIndex, scene.steps.length - 1);
  }

  function splitSelected() {
    const parts = splitText(selectedStep.instruction);
    if (selectedStep.type !== 'screen' || !parts) return;
    const sourceId = selectedStep.id;
    let continuationId = '';
    mutate((draft) => {
      const source = draft.steps[selectedIndex];
      if (!source) return;
      continuationId = uniqueStepId(`${source.id}-continued`, draft.steps);
      const continuation = structuredClone(source);
      continuation.id = continuationId;
      continuation.title = `${source.title} · continued`;
      continuation.instruction = parts[1];
      continuation.annotations = continuation.annotations.map((annotation) => ({
        ...annotation,
        id: `${annotation.id}-${Date.now().toString(36)}`,
      }));
      continuation.masks = continuation.masks.map((mask) => ({
        ...mask,
        id: `${mask.id}-${Date.now().toString(36)}`,
      }));
      source.instruction = parts[0];
      draft.steps.splice(selectedIndex + 1, 0, continuation);
      for (const translation of Object.values(draft.translations ?? {})) {
        const translated = translation.steps[sourceId];
        if (!translated) continue;
        const translatedParts = splitText(translated.instruction ?? '');
        translation.steps[continuationId] = {
          ...structuredClone(translated),
          title: translated.title ? `${translated.title} · continued` : undefined,
          instruction: translatedParts?.[1] ?? translated.instruction,
        };
        if (translatedParts) translated.instruction = translatedParts[0];
      }
    });
    selectedIndex += 1;
  }

  function mergeWithPrevious() {
    if (selectedIndex <= 0 || selectedStep.type !== 'screen') return;
    const previous = scene.steps[selectedIndex - 1];
    if (!previous || previous.type !== 'screen') return;
    const currentId = selectedStep.id;
    const previousId = previous.id;
    mutate((draft) => {
      const current = draft.steps[selectedIndex];
      const target = draft.steps[selectedIndex - 1];
      if (!current || !target || current.type !== 'screen' || target.type !== 'screen') return;
      target.instruction = [target.instruction, current.instruction].filter(Boolean).join(' ');
      target.caption = [target.caption, current.caption].filter(Boolean).join(' ');
      target.alt = current.alt || target.alt;
      target.image = current.image || target.image;
      target.crop = structuredClone(current.crop);
      target.cursor = structuredClone(current.cursor);
      target.hotspot = structuredClone(current.hotspot);
      target.frame = current.frame;
      target.annotations = [...target.annotations, ...current.annotations];
      target.masks = [...target.masks, ...current.masks];
      target.durationMs = Math.min(120_000, (target.durationMs ?? 0) + (current.durationMs ?? 0));
      target.autoAdvance = current.autoAdvance;
      target.outputVisibility = {
        interactive: target.outputVisibility.interactive || current.outputVisibility.interactive,
        guide: target.outputVisibility.guide || current.outputVisibility.guide,
        motion: target.outputVisibility.motion || current.outputVisibility.motion,
        social: target.outputVisibility.social || current.outputVisibility.social,
      };
      draft.steps.splice(selectedIndex, 1);
      for (const translation of Object.values(draft.translations ?? {})) {
        const translatedCurrent = translation.steps[currentId];
        const translatedPrevious = translation.steps[previousId];
        if (translatedCurrent) {
          translation.steps[previousId] = {
            title: translatedPrevious?.title ?? translatedCurrent.title,
            instruction: [translatedPrevious?.instruction, translatedCurrent.instruction]
              .filter(Boolean)
              .join(' '),
            caption: [translatedPrevious?.caption, translatedCurrent.caption]
              .filter(Boolean)
              .join(' '),
            alt: translatedCurrent.alt ?? translatedPrevious?.alt,
          };
        }
        delete translation.steps[currentId];
      }
    });
    selectedIndex -= 1;
  }

  async function handleScreenshotFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    imageError = '';
    try {
      const image = await readScreenshotFile(file);
      await updateStep((step) => {
        step.image = image;
        step.crop = { x: 0.5, y: 0.5, zoom: 1 };
      }, true);
    } catch (error) {
      imageError =
        error instanceof PortableFileError
          ? [error.message, ...error.issues].join(' ')
          : 'The screenshot could not be imported.';
    }
  }

  function addLocale() {
    const locale = newLocale.trim();
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(locale)) {
      translationError = 'Use a language tag such as pt, en-GB, or zh-Hant.';
      return;
    }
    if (scene.translations?.[locale]) {
      translationError = 'That language is already present.';
      activeLocale = locale;
      return;
    }
    mutate((draft) => {
      draft.translations ??= {};
      draft.translations[locale] = { steps: {} };
    });
    newLocale = '';
    translationError = '';
    activeLocale = locale;
  }

  function removeActiveLocale() {
    if (activeLocale === 'source') return;
    const locale = activeLocale;
    mutate((draft) => {
      if (!draft.translations) return;
      delete draft.translations[locale];
      if (Object.keys(draft.translations).length === 0) delete draft.translations;
    });
    activeLocale = 'source';
  }

  function updateSceneTranslation(field: 'title' | 'description', value: string) {
    if (activeLocale === 'source') return;
    mutate((draft) => {
      draft.translations ??= {};
      draft.translations[activeLocale] ??= { steps: {} };
      draft.translations[activeLocale]![field] = value;
    });
  }

  function updateStepTranslation(
    field: 'title' | 'instruction' | 'caption' | 'alt',
    value: string,
  ) {
    if (activeLocale === 'source') return;
    mutate((draft) => {
      draft.translations ??= {};
      draft.translations[activeLocale] ??= { steps: {} };
      const translation = draft.translations[activeLocale]!;
      translation.steps[selectedStep.id] ??= {};
      translation.steps[selectedStep.id]![field] = value;
    });
  }

  function applyFrameAndCursorToAll() {
    const frame = selectedStep.frame;
    const cursor = structuredClone(selectedStep.cursor);
    mutate((draft) => {
      for (const step of draft.steps) {
        if (step.type !== 'screen') continue;
        step.frame = frame;
        step.cursor = structuredClone(cursor);
      }
    });
  }

  function applyOutputsToAll() {
    const visibility = structuredClone(selectedStep.outputVisibility);
    mutate((draft) => {
      for (const step of draft.steps) step.outputVisibility = structuredClone(visibility);
    });
  }

  function handleEditorKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
    const target = event.target;
    if (
      (target instanceof Element &&
        target.matches('input, textarea, select, [contenteditable="true"]')) ||
      (!event.metaKey && !event.ctrlKey)
    ) {
      if (event.key === 'Escape') activeTool = 'select';
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (key === 'y') {
      event.preventDefault();
      redo();
    } else if (key === 'd') {
      event.preventDefault();
      copySelected();
    }
  }

  function placeCanvasObject(tool: CanvasTool, x: number, y: number) {
    let selection: OverlaySelection | null = null;
    updateStep((step) => {
      if (tool === 'hotspot') {
        step.hotspot = { x, y, label: step.hotspot?.label ?? 'Continue' };
      } else if (tool === 'cursor') {
        step.cursor = { ...step.cursor, x, y, visible: true };
      } else if (tool === 'callout' || tool === 'spotlight' || tool === 'arrow') {
        const id = `${tool}-${Date.now().toString(36)}`;
        const annotation: EditorAnnotation = {
          id,
          x,
          y,
          text: tool === 'callout' ? 'New callout' : tool === 'spotlight' ? 'Spotlight' : 'Arrow',
          kind: tool,
          ...(tool === 'arrow'
            ? { fromX: normalizedPoint(x - 0.12), fromY: y }
            : {
                width: tool === 'spotlight' ? 0.16 : 0.2,
                height: tool === 'spotlight' ? 0.16 : 0.1,
              }),
        };
        step.annotations.push(moveAnnotation(annotation, 0, 0));
        selection = { kind: 'annotation', id };
      } else if (tool === 'mask' || tool === 'blur') {
        const id = `${tool}-${Date.now().toString(36)}`;
        step.masks.push(
          moveMask(
            {
              id,
              mode: tool === 'blur' ? 'blur' : 'opaque',
              source: 'manual',
              scope: 'both',
              classification: 'custom',
              x: normalizedPoint(x - 0.07),
              y: normalizedPoint(y - 0.025),
              width: 0.14,
              height: 0.05,
              label: tool === 'blur' ? 'Blurred region' : 'Redacted content',
            },
            0,
            0,
          ),
        );
        selection = { kind: 'mask', id };
      }
    });
    selectedOverlay = selection;
    activeTool = 'select';
  }

  function handleCanvasClick(event: MouseEvent) {
    if (activeTool === 'select' || !canvasElement) return;
    const rect = canvasElement.getBoundingClientRect();
    const x = normalizedPoint((event.clientX - rect.left) / rect.width);
    const y = normalizedPoint((event.clientY - rect.top) / rect.height);
    placeCanvasObject(activeTool, x, y);
  }

  function handleCanvasKeydown(event: KeyboardEvent) {
    if ((event.key !== 'Enter' && event.key !== ' ') || activeTool === 'select') {
      return;
    }
    event.preventDefault();
    const x = selectedStep.hotspot?.x ?? selectedStep.cursor.x ?? 0.5;
    const y = selectedStep.hotspot?.y ?? selectedStep.cursor.y ?? 0.5;
    placeCanvasObject(activeTool, x, y);
  }

  function deleteOverlay(selection: OverlaySelection) {
    updateStep((step) => {
      if (selection.kind === 'annotation') {
        step.annotations = step.annotations.filter((annotation) => annotation.id !== selection.id);
      } else {
        step.masks = step.masks.filter((mask) => mask.id !== selection.id);
      }
    });
    if (selectedOverlay?.kind === selection.kind && selectedOverlay.id === selection.id) {
      selectedOverlay = null;
    }
  }

  function transformOverlay(
    step: EditorStep,
    selection: OverlaySelection,
    mode: 'move' | 'resize',
    deltaX: number,
    deltaY: number,
  ) {
    if (selection.kind === 'annotation') {
      const index = step.annotations.findIndex((annotation) => annotation.id === selection.id);
      const annotation = step.annotations[index];
      if (!annotation) return;
      step.annotations[index] =
        mode === 'move'
          ? moveAnnotation(annotation, deltaX, deltaY)
          : resizeAnnotation(annotation, deltaX, deltaY);
    } else {
      const index = step.masks.findIndex((mask) => mask.id === selection.id);
      const mask = step.masks[index];
      if (!mask) return;
      step.masks[index] =
        mode === 'move' ? moveMask(mask, deltaX, deltaY) : resizeMask(mask, deltaX, deltaY);
    }
  }

  function beginOverlayPointer(
    event: PointerEvent,
    selection: OverlaySelection,
    mode: 'move' | 'resize',
  ) {
    if (activeTool !== 'select' || !canvasElement) return;
    event.preventDefault();
    event.stopPropagation();
    selectedOverlay = selection;
    dragOperation = {
      selection,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      source: cloneEditorWorkingScene(scene),
      changed: false,
    };
  }

  function handleOverlayPointerMove(event: PointerEvent) {
    if (!dragOperation || !canvasElement) return;
    const rect = canvasElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const deltaX = (event.clientX - dragOperation.startX) / rect.width;
    const deltaY = (event.clientY - dragOperation.startY) / rect.height;
    const draft = cloneEditorWorkingScene(dragOperation.source);
    const step = draft.steps[selectedIndex];
    if (!step) return;
    transformOverlay(step, dragOperation.selection, dragOperation.mode, deltaX, deltaY);
    scene = draft;
    dragOperation.changed = true;
    saveState = 'unsaved';
  }

  function finishOverlayPointer() {
    if (!dragOperation) return;
    if (dragOperation.changed) {
      history = [...history.slice(-39), dragOperation.source];
      future = [];
      queueSave();
    }
    dragOperation = null;
  }

  function handleOverlayKeydown(
    event: KeyboardEvent,
    selection: OverlaySelection,
    forceMode?: 'move' | 'resize',
  ) {
    selectedOverlay = selection;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteOverlay(selection);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      selectedOverlay = null;
      return;
    }
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = deltas[event.key];
    if (!direction) return;
    event.preventDefault();
    const increment = event.shiftKey ? 0.05 : 0.01;
    updateStep((step) =>
      transformOverlay(
        step,
        selection,
        forceMode ?? (event.altKey ? 'resize' : 'move'),
        direction[0] * increment,
        direction[1] * increment,
      ),
    );
  }

  function updateAnnotationGeometry(
    annotation: EditorAnnotation,
    field: 'x' | 'y' | 'width' | 'height' | 'fromX' | 'fromY',
    percentage: number,
  ) {
    const value = normalizedPoint(percentage / 100);
    updateStep((step) => {
      const index = step.annotations.findIndex((candidate) => candidate.id === annotation.id);
      const target = step.annotations[index];
      if (!target) return;
      if (field === 'x' || field === 'y') {
        const deltaX = field === 'x' ? value - target.x : 0;
        const deltaY = field === 'y' ? value - target.y : 0;
        step.annotations[index] = moveAnnotation(target, deltaX, deltaY);
      } else if (field === 'width' || field === 'height') {
        const width = target.width ?? (target.kind === 'spotlight' ? 0.16 : 0.2);
        const height = target.height ?? (target.kind === 'spotlight' ? 0.16 : 0.1);
        step.annotations[index] = resizeAnnotation(
          target,
          field === 'width' ? value - width : 0,
          field === 'height' ? value - height : 0,
        );
      } else {
        target[field] = value;
      }
    });
  }

  function updateMaskGeometry(
    id: string,
    field: 'x' | 'y' | 'width' | 'height',
    percentage: number,
  ) {
    const value = normalizedPoint(percentage / 100);
    updateStep((step) => {
      const index = step.masks.findIndex((mask) => mask.id === id);
      const target = step.masks[index];
      if (!target) return;
      step.masks[index] =
        field === 'x' || field === 'y'
          ? moveMask(
              target,
              field === 'x' ? value - target.x : 0,
              field === 'y' ? value - target.y : 0,
            )
          : resizeMask(
              target,
              field === 'width' ? value - target.width : 0,
              field === 'height' ? value - target.height : 0,
            );
    });
  }

  function addCursorKeyframe() {
    updateStep((step) => {
      const path = step.cursor.path ?? [];
      const previous = path.at(-1)?.atMs ?? 0;
      path.push({
        atMs: Math.min(step.durationMs ?? 2_400, previous + (path.length ? 300 : 0)),
        x: step.cursor.x,
        y: step.cursor.y,
      });
      step.cursor.path = path.sort((left, right) => left.atMs - right.atMs);
    });
  }

  function toggleOutput(output: OutputKind, value: boolean) {
    updateStep((step) => (step.outputVisibility[output] = value));
  }

  function ctaKind(cta: EditorCta): NonNullable<EditorCta['kind']> {
    return (
      cta.kind ??
      (cta.event === 'restart'
        ? 'restart'
        : cta.targetSceneId
          ? 'view-scene'
          : cta.fields?.length
            ? 'form'
            : 'external')
    );
  }

  function setCtaKind(index: number, kind: NonNullable<EditorCta['kind']>) {
    updateStep((step) => {
      const cta = step.ctas[index];
      if (!cta) return;
      cta.kind = kind;
      cta.event = kind === 'restart' ? 'restart' : undefined;
      if (!['open-product', 'read-docs', 'book-call', 'external'].includes(kind)) {
        cta.href = undefined;
      }
      if (kind !== 'view-scene') cta.targetSceneId = undefined;
      if (kind !== 'form') {
        cta.webhookId = undefined;
        cta.fields = [];
      } else if (!cta.fields?.length) {
        cta.fields = [
          {
            id: `email-${Date.now().toString(36)}`,
            label: 'Work email',
            type: 'email',
            required: true,
            consent: false,
          },
        ];
      }
      step.ctaEdited = true;
    });
  }

  function setStepType(type: EditorStep['type']) {
    updateStep((step) => {
      step.type = type;
      if (type === 'choice' && step.choices.length === 0) {
        step.choices = [
          {
            id: `choice-${Date.now()}`,
            label: 'First path',
            sceneId: 'linked-scene',
            href: '/scenes/linked-scene',
          },
        ];
      }
      if (type === 'choice') {
        step.hotspot = undefined;
        step.ctas = [];
        step.ctaEdited = true;
      }
      if (type === 'end' && step.ctas.length === 0) {
        step.ctas = [
          {
            id: `cta-${Date.now()}`,
            label: 'Restart walkthrough',
            kind: 'restart',
            event: 'restart',
            fields: [],
            variant: 'primary',
          },
        ];
        step.ctaEdited = true;
      }
      if (type === 'end') {
        step.hotspot = undefined;
        step.choices = [];
      }
      if (type === 'intro' || type === 'separator') {
        step.hotspot = undefined;
        step.choices = [];
        step.ctas = [];
        step.ctaEdited = true;
        step.cursor.visible = false;
      }
      if (type === 'screen') {
        step.choices = [];
        step.ctas = [];
        step.ctaEdited = true;
        step.hotspot ??= { x: 0.5, y: 0.5, label: 'Continue' };
      }
    });
  }

  const aspectValue: Record<Aspect, string> = {
    '16:9': '16 / 9',
    '4:3': '4 / 3',
    '1:1': '1 / 1',
    '9:16': '9 / 16',
  };
</script>

<svelte:window
  onkeydown={handleEditorKeydown}
  onpointermove={handleOverlayPointerMove}
  onpointerup={finishOverlayPointer}
  onpointercancel={finishOverlayPointer}
/>

<section class="editor" aria-label="Scene editor">
  <div class="editor-toolbar">
    <div class="history-controls" aria-label="Editing history">
      <button
        class="icon-button"
        type="button"
        aria-label="Undo"
        title="Undo (⌘Z)"
        disabled={!history.length}
        onclick={undo}><Icon name="undo" size={16} /></button
      >
      <button
        class="icon-button"
        type="button"
        aria-label="Redo"
        title="Redo (⇧⌘Z)"
        disabled={!future.length}
        onclick={redo}><Icon name="redo" size={16} /></button
      >
      <span class="toolbar-divider"></span>
      <button
        class="save-state"
        class:saving={saveState === 'saving'}
        class:error={saveState === 'error'}
        type="button"
        disabled={saveState !== 'error'}
        title={saveState === 'error'
          ? saveConflict
            ? `${saveError} Reload to review the recovered edit.`
            : `${saveError} Choose to retry.`
          : undefined}
        onclick={retrySave}
        aria-live="polite"
      >
        <Icon
          name={saveState === 'saved' ? 'check' : saveState === 'error' ? 'warning' : 'save'}
          size={13}
        />
        {saveState === 'saved'
          ? 'Saved locally'
          : saveState === 'saving'
            ? 'Saving…'
            : saveState === 'error'
              ? saveConflict
                ? 'Changed elsewhere · Reload'
                : 'Save failed · Retry'
              : 'Unsaved changes'}
      </button>
    </div>
    <div class="canvas-tools" role="toolbar" aria-label="Canvas tools">
      <button
        class:active={activeTool === 'select'}
        type="button"
        aria-pressed={activeTool === 'select'}
        title="Select"
        onclick={() => (activeTool = 'select')}
        ><Icon name="cursor" size={15} /><span>Select</span></button
      >
      <button
        class:active={activeTool === 'hotspot'}
        type="button"
        aria-pressed={activeTool === 'hotspot'}
        title="Place hotspot"
        onclick={() => (activeTool = 'hotspot')}
        ><Icon name="hotspot" size={15} /><span>Hotspot</span></button
      >
      <details class="tool-menu">
        <summary class:active={['callout', 'spotlight', 'arrow'].includes(activeTool)}>
          <Icon name="annotation" size={15} /><span>Annotate</span>
        </summary>
        <div class="tool-menu-popover">
          <button
            class:active={activeTool === 'callout'}
            type="button"
            aria-pressed={activeTool === 'callout'}
            onclick={() => (activeTool = 'callout')}
            ><Icon name="annotation" size={15} /><span>Callout</span></button
          >
          <button
            class:active={activeTool === 'spotlight'}
            type="button"
            aria-pressed={activeTool === 'spotlight'}
            onclick={() => (activeTool = 'spotlight')}
            ><Icon name="annotation" size={15} /><span>Spotlight</span></button
          >
          <button
            class:active={activeTool === 'arrow'}
            type="button"
            aria-pressed={activeTool === 'arrow'}
            onclick={() => (activeTool = 'arrow')}
            ><Icon name="annotation" size={15} /><span>Arrow</span></button
          >
        </div>
      </details>
      <details class="tool-menu">
        <summary class:active={['mask', 'blur'].includes(activeTool)}>
          <Icon name="mask" size={15} /><span>Privacy</span>
        </summary>
        <div class="tool-menu-popover">
          <button
            class:active={activeTool === 'mask'}
            type="button"
            aria-pressed={activeTool === 'mask'}
            onclick={() => (activeTool = 'mask')}
            title="Place an opaque privacy mask"
            ><Icon name="mask" size={15} /><span>Mask</span></button
          >
          <button
            class:active={activeTool === 'blur'}
            type="button"
            aria-pressed={activeTool === 'blur'}
            onclick={() => (activeTool = 'blur')}
            title="Place a presentation blur"
            ><Icon name="mask" size={15} /><span>Blur</span></button
          >
        </div>
      </details>
      <button
        class:active={activeTool === 'cursor'}
        type="button"
        aria-pressed={activeTool === 'cursor'}
        title="Position cursor"
        onclick={() => (activeTool = 'cursor')}
        ><Icon name="cursor" size={15} /><span>Cursor</span></button
      >
    </div>
    <div class="aspect-controls">
      <label>
        <span class="sr-only">Preview aspect ratio</span>
        <select bind:value={aspect} aria-label="Preview aspect ratio">
          <option>16:9</option><option>4:3</option><option>1:1</option><option>9:16</option>
        </select>
      </label>
      <button class="button" type="button" onclick={onpreview}
        ><Icon name="play" size={14} />Preview</button
      >
    </div>
  </div>

  <div class="editor-grid">
    <aside class="step-panel" aria-label="Ordered scene steps">
      <div class="panel-heading">
        <span><strong>Steps</strong><small>{scene.steps.length} total</small></span>
        <div class="add-menu">
          <button
            class="icon-button"
            type="button"
            aria-label="Add screen step"
            title="Add screen Step"
            onclick={() => addStep('screen')}><Icon name="plus" size={16} /></button
          >
        </div>
      </div>
      <ol class="step-list">
        {#each scene.steps as step, index (step.id)}
          <li
            class:selected={selectedIndex === index}
            draggable="true"
            ondragstart={() => (dragIndex = index)}
            ondragend={() => (dragIndex = null)}
            ondragover={(event) => event.preventDefault()}
            ondrop={() => {
              if (dragIndex !== null) reorder(dragIndex, index);
              dragIndex = null;
            }}
          >
            <button
              class="step-select"
              type="button"
              aria-current={selectedIndex === index ? 'step' : undefined}
              onclick={() => (selectedIndex = index)}
            >
              <span class="step-number mono">{String(index + 1).padStart(2, '0')}</span>
              <span class="thumbnail">
                {#if step.image && step.type === 'screen'}
                  <img src={step.image} alt="" />
                {:else}
                  <span class="special-step"
                    ><Icon
                      name={step.type === 'choice'
                        ? 'branch'
                        : step.type === 'end'
                          ? 'publish'
                          : 'file'}
                      size={18}
                    /></span
                  >
                {/if}
                {#if step.hotspot}<i
                    class="mini-hotspot"
                    style:left={`${step.hotspot.x * 100}%`}
                    style:top={`${step.hotspot.y * 100}%`}
                  ></i>{/if}
              </span>
              <span class="step-copy"
                ><strong>{step.title}</strong><small
                  >{step.type === 'screen'
                    ? `${step.durationMs ? (step.durationMs / 1000).toFixed(1) : '0'}s`
                    : step.type}</small
                ></span
              >
            </button>
            <div class="reorder-actions" aria-label={`Reorder ${step.title}`}>
              <button
                type="button"
                title="Move up"
                aria-label={`Move ${step.title} up`}
                disabled={index === 0}
                onclick={() => reorder(index, index - 1)}><Icon name="up" size={12} /></button
              >
              <button
                type="button"
                title="Move down"
                aria-label={`Move ${step.title} down`}
                disabled={index === scene.steps.length - 1}
                onclick={() => reorder(index, index + 1)}><Icon name="down" size={12} /></button
              >
            </div>
          </li>
        {/each}
      </ol>
      <div class="add-types">
        <button type="button" onclick={() => addStep('screen')}
          ><Icon name="plus" size={14} />Screen</button
        >
        <button type="button" onclick={() => addStep('intro')}
          ><Icon name="file" size={14} />Intro</button
        >
        <button type="button" onclick={() => addStep('separator')}
          ><Icon name="file" size={14} />Section</button
        >
        <button type="button" onclick={() => addStep('choice')}
          ><Icon name="branch" size={14} />Choice</button
        >
        <button type="button" onclick={() => addStep('end')}
          ><Icon name="publish" size={14} />End</button
        >
      </div>
    </aside>

    <div class="stage-column">
      <div class="stage-meta">
        <span class="mono">{selectedStep.id}</span>
        {#if activeTool !== 'select'}<span class="tool-hint"
            >Click the canvas to {activeTool === 'mask'
              ? 'place an opaque mask'
              : activeTool === 'blur'
                ? 'place a presentation blur'
                : activeTool === 'callout'
                  ? 'add a callout'
                  : activeTool === 'spotlight'
                    ? 'add a spotlight'
                    : activeTool === 'arrow'
                      ? 'add an arrow'
                      : activeTool === 'hotspot'
                        ? 'set the interaction target'
                        : 'position the cursor'}.</span
          >{/if}
        <span>{aspect} · {Math.round(selectedStep.crop.zoom * 100)}%</span>
      </div>
      <div class="stage-scroll">
        <div
          class="canvas-shell"
          class:portrait={aspect === '9:16'}
          style:aspect-ratio={aspectValue[aspect]}
        >
          <div class="browser-frame" class:frameless={selectedStep.frame === 'none'}>
            {#if selectedStep.frame !== 'none'}
              <div class="browser-bar">
                <span></span><span></span><span></span><i>/{scene.id}</i>
              </div>
            {/if}
            <div class="canvas" class:placing={activeTool !== 'select'} bind:this={canvasElement}>
              {#if activeTool !== 'select'}
                <button
                  class="placement-layer"
                  type="button"
                  aria-label={`Place ${activeTool} on ${selectedStep.title}`}
                  onclick={handleCanvasClick}
                  onkeydown={handleCanvasKeydown}
                ></button>
              {/if}
              {#if selectedStep.type === 'screen'}
                {#if selectedStep.image}
                  <img
                    class="canvas-image"
                    src={selectedStep.image}
                    alt={selectedStep.alt || ''}
                    draggable="false"
                    style:transform={`scale(${selectedStep.crop.zoom})`}
                    style:transform-origin={`${selectedStep.crop.x * 100}% ${selectedStep.crop.y * 100}%`}
                  />
                {:else}
                  <div class="canvas-empty">
                    <Icon name="camera" size={24} /><strong>No screenshot yet</strong><span
                      >Add a passive raster image for this state.</span
                    ><button
                      class="button inverse"
                      type="button"
                      onclick={() => screenshotInput?.click()}>Import screenshot</button
                    >
                  </div>
                {/if}
                {#if (selectedStep.cursor.path?.length ?? 0) > 1}
                  <svg
                    class="canvas-cursor-path"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <polyline
                      points={(selectedStep.cursor.path ?? [])
                        .map((keyframe) => `${keyframe.x * 100},${keyframe.y * 100}`)
                        .join(' ')}
                    ></polyline>
                    {#each selectedStep.cursor.path ?? [] as keyframe}
                      <circle cx={keyframe.x * 100} cy={keyframe.y * 100} r="0.8"></circle>
                    {/each}
                  </svg>
                {/if}
                <span id="overlay-keyboard-help" class="sr-only"
                  >Arrow keys move. Shift plus Arrow moves farther. Alt plus Arrow resizes. Delete
                  removes the selected object.</span
                >
                {#each selectedStep.masks as mask, index (mask.id)}
                  <div
                    class="canvas-object canvas-mask-object"
                    style:left={`${mask.x * 100}%`}
                    style:top={`${mask.y * 100}%`}
                    style:width={`${mask.width * 100}%`}
                    style:height={`${mask.height * 100}%`}
                  >
                    <button
                      class="canvas-mask object-surface"
                      class:blur={mask.mode === 'blur'}
                      class:selected={selectedOverlay?.kind === 'mask' &&
                        selectedOverlay.id === mask.id}
                      type="button"
                      title={mask.label}
                      aria-label={`${mask.mode === 'blur' ? 'Blur' : 'Mask'} ${index + 1}: ${mask.label ?? (mask.mode === 'blur' ? 'Blurred region' : 'Redacted content')}`}
                      aria-pressed={selectedOverlay?.kind === 'mask' &&
                        selectedOverlay.id === mask.id}
                      aria-describedby="overlay-keyboard-help"
                      onpointerdown={(event) =>
                        beginOverlayPointer(event, { kind: 'mask', id: mask.id }, 'move')}
                      onkeydown={(event) =>
                        handleOverlayKeydown(event, { kind: 'mask', id: mask.id })}
                      onclick={(event) => {
                        event.stopPropagation();
                        selectedOverlay = { kind: 'mask', id: mask.id };
                      }}
                    ></button>
                    {#if selectedOverlay?.kind === 'mask' && selectedOverlay.id === mask.id}
                      <button
                        class="resize-handle"
                        type="button"
                        aria-label={`Resize mask ${index + 1}`}
                        aria-describedby="overlay-keyboard-help"
                        onpointerdown={(event) =>
                          beginOverlayPointer(event, { kind: 'mask', id: mask.id }, 'resize')}
                        onkeydown={(event) =>
                          handleOverlayKeydown(event, { kind: 'mask', id: mask.id }, 'resize')}
                      ></button>
                    {/if}
                  </div>
                {/each}
                {#each selectedStep.annotations as annotation, index (annotation.id)}
                  {@const selection = { kind: 'annotation', id: annotation.id } as const}
                  {@const selected =
                    selectedOverlay?.kind === 'annotation' && selectedOverlay.id === annotation.id}
                  {#if annotation.kind === 'arrow'}
                    {@const fromX = annotation.fromX ?? normalizedPoint(annotation.x - 0.08)}
                    {@const fromY = annotation.fromY ?? annotation.y}
                    <svg
                      class="canvas-arrow-line"
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                    >
                      <defs>
                        <marker
                          id={`arrowhead-${annotation.id}`}
                          markerWidth="5"
                          markerHeight="5"
                          refX="4"
                          refY="2.5"
                          orient="auto"
                        >
                          <path d="M0,0 L5,2.5 L0,5 Z" fill={annotation.color ?? 'var(--accent)'}
                          ></path>
                        </marker>
                      </defs>
                      <line
                        x1={fromX * 100}
                        y1={fromY * 100}
                        x2={annotation.x * 100}
                        y2={annotation.y * 100}
                        stroke={annotation.color ?? 'var(--accent)'}
                        marker-end={`url(#arrowhead-${annotation.id})`}
                      ></line>
                    </svg>
                    <button
                      class="canvas-arrow-target object-surface"
                      class:selected
                      type="button"
                      style:left={`${((fromX + annotation.x) / 2) * 100}%`}
                      style:top={`${((fromY + annotation.y) / 2) * 100}%`}
                      aria-label={`Arrow ${index + 1}: ${annotation.text}`}
                      aria-pressed={selected}
                      aria-describedby="overlay-keyboard-help"
                      onpointerdown={(event) => beginOverlayPointer(event, selection, 'move')}
                      onkeydown={(event) => handleOverlayKeydown(event, selection)}
                      onclick={(event) => {
                        event.stopPropagation();
                        selectedOverlay = selection;
                      }}
                    ></button>
                    {#if selected}
                      <button
                        class="arrow-resize-handle resize-handle"
                        type="button"
                        style:left={`${annotation.x * 100}%`}
                        style:top={`${annotation.y * 100}%`}
                        aria-label={`Resize arrow ${index + 1}`}
                        aria-describedby="overlay-keyboard-help"
                        onpointerdown={(event) => beginOverlayPointer(event, selection, 'resize')}
                        onkeydown={(event) => handleOverlayKeydown(event, selection, 'resize')}
                      ></button>
                    {/if}
                  {:else}
                    <div
                      class="canvas-object canvas-annotation-object"
                      class:spotlight={annotation.kind === 'spotlight'}
                      style:left={`${annotation.x * 100}%`}
                      style:top={`${annotation.y * 100}%`}
                      style:width={`${(annotation.width ?? (annotation.kind === 'spotlight' ? 0.16 : 0.2)) * 100}%`}
                      style:height={`${(annotation.height ?? (annotation.kind === 'spotlight' ? 0.16 : 0.1)) * 100}%`}
                      style:--annotation-color={annotation.color ?? 'var(--accent)'}
                    >
                      <button
                        class="canvas-annotation object-surface"
                        class:selected
                        type="button"
                        aria-label={`${annotation.kind === 'spotlight' ? 'Spotlight' : 'Callout'} ${index + 1}: ${annotation.text}`}
                        aria-pressed={selected}
                        aria-describedby="overlay-keyboard-help"
                        onpointerdown={(event) => beginOverlayPointer(event, selection, 'move')}
                        onkeydown={(event) => handleOverlayKeydown(event, selection)}
                        onclick={(event) => {
                          event.stopPropagation();
                          selectedOverlay = selection;
                        }}>{annotation.kind === 'spotlight' ? '' : annotation.text}</button
                      >
                      {#if selected}
                        <button
                          class="resize-handle"
                          type="button"
                          aria-label={`Resize ${annotation.kind === 'spotlight' ? 'spotlight' : 'callout'} ${index + 1}`}
                          aria-describedby="overlay-keyboard-help"
                          onpointerdown={(event) => beginOverlayPointer(event, selection, 'resize')}
                          onkeydown={(event) => handleOverlayKeydown(event, selection, 'resize')}
                        ></button>
                      {/if}
                    </div>
                  {/if}
                {/each}
                {#if selectedStep.hotspot}
                  <span
                    class="canvas-hotspot"
                    style:left={`${selectedStep.hotspot.x * 100}%`}
                    style:top={`${selectedStep.hotspot.y * 100}%`}
                    role="img"
                    aria-label={`Hotspot: ${selectedStep.hotspot.label}`}
                    ><i></i><span>{selectedStep.hotspot.label}</span></span
                  >
                {/if}
                {#if selectedStep.cursor.visible}
                  <span
                    class="canvas-cursor"
                    class:clicking={selectedStep.cursor.click}
                    class:dot={selectedStep.cursor.style === 'dot'}
                    class:pointer={selectedStep.cursor.style === 'pointer'}
                    style:left={`${selectedStep.cursor.x * 100}%`}
                    style:top={`${selectedStep.cursor.y * 100}%`}
                    aria-hidden="true"><Icon name="cursor" size={22} /></span
                  >
                {/if}
              {:else if selectedStep.type === 'choice'}
                <div class="choice-canvas">
                  <span class="eyebrow">Choose a path</span>
                  <h2>{displayTitle}</h2>
                  <p>{displayInstruction}</p>
                  <div>
                    {#each selectedStep.choices as choice}<span class="choice-preview"
                        >{choice.label}<small>{choice.description}</small></span
                      >{/each}
                  </div>
                </div>
              {:else if selectedStep.type === 'end'}
                <div class="end-canvas">
                  <span class="eyebrow">Journey complete</span>
                  <h2>{displayTitle}</h2>
                  <p>{displayInstruction}</p>
                  <div>
                    {#each selectedStep.ctas as cta}<span
                        class="cta-preview"
                        class:primary={cta.variant === 'primary'}>{cta.label}</span
                      >{/each}
                  </div>
                </div>
              {:else}
                <div class="end-canvas narrative-canvas">
                  <span class="eyebrow"
                    >{selectedStep.type === 'intro' ? 'Introduction' : 'Section break'}</span
                  >
                  <h2>{displayTitle}</h2>
                  <p>{displayInstruction}</p>
                </div>
              {/if}
            </div>
          </div>
        </div>
      </div>
      <div class="developer-drawer">
        <span
          ><Icon name="code" size={14} /><strong>Source</strong><code
            >{scene.portableSource ? 'Imported canonical Scene' : 'Local Studio draft'}</code
          ></span
        >
        <span
          ><Icon name="check" size={14} /><strong>Checks</strong>{importedCheckCount
            ? `${importedCheckCount} imported`
            : 'None attached'}</span
        >
        <span class="mono">{scene.id}.scene.yaml</span>
      </div>
    </div>

    <aside class="inspector" aria-label="Step inspector">
      <div class="panel-heading inspector-heading">
        <span><strong>Inspector</strong><small>Step {selectedIndex + 1}</small></span>
      </div>

      <div class="inspector-scroll">
        <section class="inspector-section">
          <h3>Content</h3>
          <div class="field">
            <label for="step-type">Step type</label><select
              id="step-type"
              class="select"
              value={selectedStep.type}
              onchange={(event) => setStepType(event.currentTarget.value as EditorStep['type'])}
              ><option value="screen">Screen</option><option value="intro">Intro</option><option
                value="separator">Section break</option
              ><option value="choice">Choice</option><option value="end">End card</option></select
            >
          </div>
          <div class="field">
            <label for="step-title">Title</label><input
              id="step-title"
              class="input"
              value={selectedStep.title}
              oninput={(event) => updateStep((step) => (step.title = event.currentTarget.value))}
            />
          </div>
          <div class="field">
            <label for="step-instruction">Instruction</label><textarea
              id="step-instruction"
              class="textarea"
              value={selectedStep.instruction}
              oninput={(event) =>
                updateStep((step) => (step.instruction = event.currentTarget.value))}></textarea>
          </div>
          <div class="field">
            <label for="step-caption">Caption</label><textarea
              id="step-caption"
              class="textarea small"
              placeholder="Optional copy shown with guides and motion outputs"
              value={selectedStep.caption}
              oninput={(event) => updateStep((step) => (step.caption = event.currentTarget.value))}
            ></textarea>
          </div>
          <div class="field">
            <label for="step-notes">Creator notes</label><textarea
              id="step-notes"
              class="textarea small"
              placeholder="Private authoring context retained in portable source"
              value={selectedStep.notes}
              oninput={(event) => updateStep((step) => (step.notes = event.currentTarget.value))}
            ></textarea>
          </div>
          <div class="field">
            <label for="step-alt">Alt text</label><textarea
              id="step-alt"
              class="textarea small"
              placeholder="Describe the meaningful visual state"
              value={selectedStep.alt}
              oninput={(event) => updateStep((step) => (step.alt = event.currentTarget.value))}
            ></textarea><small class="field-help"
              >Used by guides and screen readers. Decorative screenshots can be empty.</small
            >
          </div>
          {#if selectedStep.type === 'screen'}
            <input
              class="sr-only"
              bind:this={screenshotInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif,.png,.jpg,.jpeg,.webp,.gif,.avif"
              onchange={handleScreenshotFile}
            />
            <button class="button full-width" type="button" onclick={() => screenshotInput?.click()}
              ><Icon name="camera" size={14} />{selectedStep.image
                ? 'Replace screenshot'
                : 'Import screenshot'}</button
            >
            <small class="field-help">PNG, JPEG, WebP, GIF, or AVIF · 25 MB maximum.</small>
            {#if imageError}<p class="inline-error" role="alert">{imageError}</p>{/if}
          {/if}
        </section>

        <section class="inspector-section inspector-disclosure-shell">
          <details class="inspector-disclosure">
            <summary
              ><h3>Translations</h3>
              <small>{locales.length} added</small></summary
            >
            <div class="field">
              <label for="translation-locale">Editing language</label><select
                id="translation-locale"
                class="select"
                bind:value={activeLocale}
                ><option value="source"
                  >Source ({scene.portableSource?.defaultLocale ?? 'en'})</option
                >{#each locales as locale}<option value={locale}>{locale}</option>{/each}</select
              >
            </div>
            <div class="locale-add">
              <input
                class="input"
                aria-label="New language tag"
                placeholder="pt-PT"
                bind:value={newLocale}
                onkeydown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addLocale();
                  }
                }}
              /><button class="button" type="button" onclick={addLocale}
                ><Icon name="plus" size={13} />Add</button
              >
            </div>
            {#if translationError}<p class="inline-error" role="alert">{translationError}</p>{/if}
            {#if activeLocale !== 'source'}
              <div class="field">
                <label for="translated-scene-title">Translated Scene title</label><input
                  id="translated-scene-title"
                  class="input"
                  value={scene.translations?.[activeLocale]?.title ?? ''}
                  placeholder={scene.title}
                  oninput={(event) => updateSceneTranslation('title', event.currentTarget.value)}
                />
              </div>
              <div class="field">
                <label for="translated-step-title">Translated Step title</label><input
                  id="translated-step-title"
                  class="input"
                  value={selectedTranslation?.title ?? ''}
                  placeholder={selectedStep.title}
                  oninput={(event) => updateStepTranslation('title', event.currentTarget.value)}
                />
              </div>
              <div class="field">
                <label for="translated-step-instruction">Translated instruction</label><textarea
                  id="translated-step-instruction"
                  class="textarea"
                  value={selectedTranslation?.instruction ?? ''}
                  placeholder={selectedStep.instruction}
                  oninput={(event) =>
                    updateStepTranslation('instruction', event.currentTarget.value)}></textarea>
              </div>
              <div class="field">
                <label for="translated-step-caption">Translated caption</label><textarea
                  id="translated-step-caption"
                  class="textarea small"
                  value={selectedTranslation?.caption ?? ''}
                  placeholder={selectedStep.caption || 'Translate the optional output caption'}
                  oninput={(event) => updateStepTranslation('caption', event.currentTarget.value)}
                ></textarea>
              </div>
              <div class="field">
                <label for="translated-step-alt">Translated alt text</label><textarea
                  id="translated-step-alt"
                  class="textarea small"
                  value={selectedTranslation?.alt ?? ''}
                  placeholder={selectedStep.alt || 'Describe this visual state'}
                  oninput={(event) => updateStepTranslation('alt', event.currentTarget.value)}
                ></textarea>
              </div>
              <button class="remove-object" type="button" onclick={removeActiveLocale}
                ><Icon name="trash" size={13} />Remove {activeLocale}</button
              >
            {:else}
              <p class="section-empty">
                Add a language to author durable translated Scene and Step copy. The canvas previews
                the selected language with source fallback.
              </p>
            {/if}
          </details>
        </section>

        {#if selectedStep.type === 'screen'}
          <details class="inspector-section inspector-disclosure" open>
            <summary
              ><span>Interaction</span><small
                >{selectedStep.hotspot ? 'Hotspot configured' : 'No hotspot'}</small
              ></summary
            >
            <div class="field">
              <label for="hotspot-label">Hotspot label</label><input
                id="hotspot-label"
                class="input"
                value={selectedStep.hotspot?.label ?? ''}
                placeholder="Choose Continue"
                oninput={(event) =>
                  updateStep(
                    (step) =>
                      (step.hotspot = {
                        ...(step.hotspot ?? { x: 0.5, y: 0.5 }),
                        label: event.currentTarget.value,
                      }),
                  )}
              />
            </div>
            <div class="coordinate-grid">
              <div class="field">
                <label for="hotspot-x">X position</label><input
                  id="hotspot-x"
                  class="input mono"
                  type="number"
                  min="0"
                  max="100"
                  value={Math.round((selectedStep.hotspot?.x ?? 0.5) * 100)}
                  oninput={(event) =>
                    updateStep((step) => {
                      if (step.hotspot)
                        step.hotspot.x = normalizedPoint(Number(event.currentTarget.value) / 100);
                    })}
                />
              </div>
              <div class="field">
                <label for="hotspot-y">Y position</label><input
                  id="hotspot-y"
                  class="input mono"
                  type="number"
                  min="0"
                  max="100"
                  value={Math.round((selectedStep.hotspot?.y ?? 0.5) * 100)}
                  oninput={(event) =>
                    updateStep((step) => {
                      if (step.hotspot)
                        step.hotspot.y = normalizedPoint(Number(event.currentTarget.value) / 100);
                    })}
                />
              </div>
            </div>
            <div class="toggle-row">
              <span><strong>Cursor</strong><small>Show a deterministic cursor position</small></span
              ><input
                type="checkbox"
                aria-label="Show cursor"
                checked={selectedStep.cursor.visible}
                onchange={(event) =>
                  updateStep((step) => (step.cursor.visible = event.currentTarget.checked))}
              />
            </div>
            <div class="toggle-row">
              <span><strong>Click pulse</strong><small>Animate the primary interaction</small></span
              ><input
                type="checkbox"
                aria-label="Animate click pulse"
                checked={selectedStep.cursor.click}
                onchange={(event) =>
                  updateStep((step) => {
                    step.cursor.click = event.currentTarget.checked;
                    step.cursor.clickAtMs = event.currentTarget.checked
                      ? Math.min(step.durationMs ?? 2_400, step.cursor.clickAtMs ?? 300)
                      : undefined;
                  })}
              />
            </div>
            <div class="coordinate-grid">
              <div class="field">
                <label for="cursor-x">Cursor X</label><input
                  id="cursor-x"
                  class="input mono"
                  type="number"
                  min="0"
                  max="100"
                  value={Math.round(selectedStep.cursor.x * 100)}
                  oninput={(event) =>
                    updateStep(
                      (step) =>
                        (step.cursor.x = normalizedPoint(Number(event.currentTarget.value) / 100)),
                    )}
                />
              </div>
              <div class="field">
                <label for="cursor-y">Cursor Y</label><input
                  id="cursor-y"
                  class="input mono"
                  type="number"
                  min="0"
                  max="100"
                  value={Math.round(selectedStep.cursor.y * 100)}
                  oninput={(event) =>
                    updateStep(
                      (step) =>
                        (step.cursor.y = normalizedPoint(Number(event.currentTarget.value) / 100)),
                    )}
                />
              </div>
            </div>
            <div class="field">
              <label for="cursor-style">Cursor style</label><select
                id="cursor-style"
                class="select"
                value={selectedStep.cursor.style ?? 'default'}
                onchange={(event) =>
                  updateStep(
                    (step) => (step.cursor.style = event.currentTarget.value as CursorStyle),
                  )}
                ><option value="default">Default arrow</option><option value="pointer"
                  >Accent pointer</option
                ><option value="dot">Dot</option></select
              >
            </div>
            {#if selectedStep.cursor.click}
              <div class="field">
                <label for="cursor-click-time">Click timing (ms)</label><input
                  id="cursor-click-time"
                  class="input mono"
                  type="number"
                  min="0"
                  max={selectedStep.durationMs}
                  step="50"
                  value={selectedStep.cursor.clickAtMs ?? 300}
                  oninput={(event) =>
                    updateStep(
                      (step) =>
                        (step.cursor.clickAtMs = Math.max(
                          0,
                          Math.min(
                            step.durationMs ?? 2_400,
                            Math.round(Number(event.currentTarget.value)),
                          ),
                        )),
                    )}
                />
              </div>
            {/if}
            <div class="cursor-path-editor">
              <span><strong>Cursor path</strong><small>Time and normalized position</small></span>
              {#each selectedStep.cursor.path ?? [] as keyframe, index}
                <div class="cursor-keyframe">
                  <label>
                    <span>Time</span>
                    <input
                      class="input mono"
                      type="number"
                      min="0"
                      max={selectedStep.durationMs}
                      step="50"
                      aria-label={`Cursor path point ${index + 1} time`}
                      value={keyframe.atMs}
                      oninput={(event) =>
                        updateStep((step) => {
                          const target = step.cursor.path?.[index];
                          if (target)
                            target.atMs = Math.max(
                              0,
                              Math.min(
                                step.durationMs ?? 2_400,
                                Math.round(Number(event.currentTarget.value)),
                              ),
                            );
                          step.cursor.path?.sort((left, right) => left.atMs - right.atMs);
                        })}
                    />
                  </label>
                  <label>
                    <span>X</span>
                    <input
                      class="input mono"
                      type="number"
                      min="0"
                      max="100"
                      aria-label={`Cursor path point ${index + 1} X`}
                      value={Math.round(keyframe.x * 100)}
                      oninput={(event) =>
                        updateStep((step) => {
                          const target = step.cursor.path?.[index];
                          if (target)
                            target.x = normalizedPoint(Number(event.currentTarget.value) / 100);
                        })}
                    />
                  </label>
                  <label>
                    <span>Y</span>
                    <input
                      class="input mono"
                      type="number"
                      min="0"
                      max="100"
                      aria-label={`Cursor path point ${index + 1} Y`}
                      value={Math.round(keyframe.y * 100)}
                      oninput={(event) =>
                        updateStep((step) => {
                          const target = step.cursor.path?.[index];
                          if (target)
                            target.y = normalizedPoint(Number(event.currentTarget.value) / 100);
                        })}
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={`Delete cursor path point ${index + 1}`}
                    onclick={() => updateStep((step) => step.cursor.path?.splice(index, 1))}
                    ><Icon name="trash" size={12} /></button
                  >
                </div>
              {/each}
              <button class="button" type="button" onclick={addCursorKeyframe}
                ><Icon name="plus" size={13} />Add path point</button
              >
            </div>
          </details>

          <details class="inspector-section inspector-disclosure">
            <summary><span>Crop & motion</span><small>Timing and framing</small></summary>
            <div class="range-field">
              <span
                ><label for="zoom">Zoom</label><output
                  >{Math.round(selectedStep.crop.zoom * 100)}%</output
                ></span
              ><input
                id="zoom"
                type="range"
                min="1"
                max="2.5"
                step=".05"
                value={selectedStep.crop.zoom}
                oninput={(event) =>
                  updateStep((step) => (step.crop.zoom = Number(event.currentTarget.value)))}
              />
            </div>
            <div class="range-field">
              <span
                ><label for="crop-x">Horizontal focus</label><output
                  >{Math.round(selectedStep.crop.x * 100)}%</output
                ></span
              ><input
                id="crop-x"
                type="range"
                min="0"
                max="1"
                step=".01"
                value={selectedStep.crop.x}
                oninput={(event) =>
                  updateStep((step) => (step.crop.x = Number(event.currentTarget.value)))}
              />
            </div>
            <div class="range-field">
              <span
                ><label for="crop-y">Vertical focus</label><output
                  >{Math.round(selectedStep.crop.y * 100)}%</output
                ></span
              ><input
                id="crop-y"
                type="range"
                min="0"
                max="1"
                step=".01"
                value={selectedStep.crop.y}
                oninput={(event) =>
                  updateStep((step) => (step.crop.y = Number(event.currentTarget.value)))}
              />
            </div>
            <div class="range-field">
              <span
                ><label for="duration">Step duration</label><output
                  >{((selectedStep.durationMs ?? 0) / 1000).toFixed(1)}s</output
                ></span
              ><input
                id="duration"
                type="range"
                min="800"
                max="8000"
                step="100"
                value={selectedStep.durationMs}
                oninput={(event) =>
                  updateStep((step) => (step.durationMs = Number(event.currentTarget.value)))}
              />
            </div>
            <div class="toggle-row">
              <span
                ><strong>Auto-advance</strong><small>Disabled when reduced motion is on</small
                ></span
              ><input
                type="checkbox"
                aria-label="Auto-advance this step"
                checked={selectedStep.autoAdvance}
                onchange={(event) =>
                  updateStep((step) => (step.autoAdvance = event.currentTarget.checked))}
              />
            </div>
          </details>

          <details class="inspector-section inspector-disclosure">
            <summary
              ><span>Annotations & privacy</span><small
                >{selectedStep.annotations.length + selectedStep.masks.length} placed</small
              ></summary
            >
            {#if selectedStep.annotations.length === 0 && selectedStep.masks.length === 0}<p
                class="section-empty"
              >
                Place callouts, spotlights, arrows, opaque privacy masks, and presentation blurs
                directly on the canvas.
              </p>{/if}
            {#each selectedStep.annotations as annotation, index (annotation.id)}
              <div
                class="object-row"
                class:selected={selectedOverlay?.kind === 'annotation' &&
                  selectedOverlay.id === annotation.id}
              >
                <button
                  class="object-select"
                  type="button"
                  aria-label={`Select ${annotation.kind === 'note' ? 'callout' : annotation.kind} ${index + 1}`}
                  aria-pressed={selectedOverlay?.kind === 'annotation' &&
                    selectedOverlay.id === annotation.id}
                  onclick={() => (selectedOverlay = { kind: 'annotation', id: annotation.id })}
                  ><Icon name="annotation" size={14} /><span
                    ><strong>{annotation.kind === 'note' ? 'Callout' : annotation.kind}</strong
                    ><small>{annotation.text}</small></span
                  ></button
                ><button
                  type="button"
                  aria-label={`Delete ${annotation.kind === 'note' ? 'callout' : annotation.kind} ${index + 1}`}
                  onclick={() => deleteOverlay({ kind: 'annotation', id: annotation.id })}
                  ><Icon name="trash" size={13} /></button
                >
              </div>
            {/each}
            {#each selectedStep.masks as mask, index (mask.id)}
              <div
                class="object-row"
                class:selected={selectedOverlay?.kind === 'mask' && selectedOverlay.id === mask.id}
              >
                <button
                  class="object-select"
                  type="button"
                  aria-label={`Select mask ${index + 1}`}
                  aria-pressed={selectedOverlay?.kind === 'mask' && selectedOverlay.id === mask.id}
                  onclick={() => (selectedOverlay = { kind: 'mask', id: mask.id })}
                  ><Icon name="mask" size={14} /><span
                    ><strong>{mask.mode === 'blur' ? 'Presentation blur' : 'Opaque mask'}</strong
                    ><small
                      >{mask.label ??
                        (mask.mode === 'blur' ? 'Blurred region' : 'Redacted content')}</small
                    ></span
                  ></button
                ><button
                  type="button"
                  aria-label={`Delete mask ${index + 1}`}
                  onclick={() => deleteOverlay({ kind: 'mask', id: mask.id })}
                  ><Icon name="trash" size={13} /></button
                >
              </div>
            {/each}
            {#if selectedAnnotation}
              <div class="object-editor" aria-label="Selected annotation controls">
                <div class="field">
                  <label for="annotation-kind">Annotation type</label><select
                    id="annotation-kind"
                    class="select"
                    value={selectedAnnotation.kind === 'note' ? 'callout' : selectedAnnotation.kind}
                    onchange={(event) =>
                      updateStep((step) => {
                        const annotation = step.annotations.find(
                          (candidate) => candidate.id === selectedAnnotation?.id,
                        );
                        if (!annotation) return;
                        const kind = event.currentTarget.value as 'callout' | 'spotlight' | 'arrow';
                        annotation.kind = kind;
                        if (kind === 'arrow') {
                          annotation.fromX ??= normalizedPoint(annotation.x - 0.12);
                          annotation.fromY ??= annotation.y;
                          delete annotation.width;
                          delete annotation.height;
                        } else {
                          annotation.width ??= kind === 'spotlight' ? 0.16 : 0.2;
                          annotation.height ??= kind === 'spotlight' ? 0.16 : 0.1;
                          delete annotation.fromX;
                          delete annotation.fromY;
                        }
                      })}
                    ><option value="callout">Callout</option><option value="spotlight"
                      >Spotlight</option
                    ><option value="arrow">Arrow</option></select
                  >
                </div>
                <div class="field">
                  <label for="annotation-text">Accessible label</label><input
                    id="annotation-text"
                    class="input"
                    value={selectedAnnotation.text}
                    oninput={(event) =>
                      updateStep((step) => {
                        const annotation = step.annotations.find(
                          (candidate) => candidate.id === selectedAnnotation?.id,
                        );
                        if (annotation) annotation.text = event.currentTarget.value;
                      })}
                  />
                </div>
                <div class="field color-field">
                  <label for="annotation-color">Color</label><input
                    id="annotation-color"
                    type="color"
                    value={selectedAnnotation.color ?? scene.theme.accent}
                    oninput={(event) =>
                      updateStep((step) => {
                        const annotation = step.annotations.find(
                          (candidate) => candidate.id === selectedAnnotation?.id,
                        );
                        if (annotation) annotation.color = event.currentTarget.value;
                      })}
                  />
                </div>
                <div class="coordinate-grid">
                  {#each ['x', 'y'] as field}
                    <div class="field">
                      <label for={`annotation-${field}`}>{field.toUpperCase()} position</label
                      ><input
                        id={`annotation-${field}`}
                        class="input mono"
                        type="number"
                        min="0"
                        max="100"
                        value={Math.round(selectedAnnotation[field as 'x' | 'y'] * 100)}
                        oninput={(event) =>
                          updateAnnotationGeometry(
                            selectedAnnotation!,
                            field as 'x' | 'y',
                            Number(event.currentTarget.value),
                          )}
                      />
                    </div>
                  {/each}
                </div>
                {#if selectedAnnotation.kind === 'arrow'}
                  <div class="coordinate-grid">
                    {#each ['fromX', 'fromY'] as field}
                      <div class="field">
                        <label for={`annotation-${field}`}
                          >{field === 'fromX' ? 'Start X' : 'Start Y'}</label
                        ><input
                          id={`annotation-${field}`}
                          class="input mono"
                          type="number"
                          min="0"
                          max="100"
                          value={Math.round(
                            (selectedAnnotation[field as 'fromX' | 'fromY'] ??
                              (field === 'fromX'
                                ? normalizedPoint(selectedAnnotation.x - 0.08)
                                : selectedAnnotation.y)) * 100,
                          )}
                          oninput={(event) =>
                            updateAnnotationGeometry(
                              selectedAnnotation!,
                              field as 'fromX' | 'fromY',
                              Number(event.currentTarget.value),
                            )}
                        />
                      </div>
                    {/each}
                  </div>
                {:else}
                  <div class="coordinate-grid">
                    {#each ['width', 'height'] as field}
                      <div class="field">
                        <label for={`annotation-${field}`}>{field}</label><input
                          id={`annotation-${field}`}
                          class="input mono"
                          type="number"
                          min="1"
                          max="100"
                          value={Math.round(
                            (selectedAnnotation[field as 'width' | 'height'] ??
                              (field === 'width'
                                ? selectedAnnotation.kind === 'spotlight'
                                  ? 0.16
                                  : 0.2
                                : selectedAnnotation.kind === 'spotlight'
                                  ? 0.16
                                  : 0.1)) * 100,
                          )}
                          oninput={(event) =>
                            updateAnnotationGeometry(
                              selectedAnnotation!,
                              field as 'width' | 'height',
                              Number(event.currentTarget.value),
                            )}
                        />
                      </div>
                    {/each}
                  </div>
                {/if}
                <button
                  class="remove-object"
                  type="button"
                  onclick={() => deleteOverlay({ kind: 'annotation', id: selectedAnnotation!.id })}
                  ><Icon name="trash" size={13} />Remove selected annotation</button
                >
              </div>
            {:else if selectedMask}
              <div class="object-editor" aria-label="Selected mask controls">
                <div class="field">
                  <label for="mask-mode">Mask type</label><select
                    id="mask-mode"
                    class="select"
                    value={selectedMask.mode ?? 'opaque'}
                    onchange={(event) =>
                      updateStep((step) => {
                        const mask = step.masks.find(
                          (candidate) => candidate.id === selectedMask?.id,
                        );
                        if (!mask) return;
                        const mode = event.currentTarget.value === 'blur' ? 'blur' : 'opaque';
                        if (
                          mode === 'blur' &&
                          (mask.source !== 'manual' || mask.classification !== 'custom')
                        ) {
                          return;
                        }
                        mask.mode = mode;
                      })}
                    ><option value="opaque">Opaque · privacy safe</option><option
                      value="blur"
                      disabled={selectedMask.source !== 'manual' ||
                        selectedMask.classification !== 'custom'}>Blur · presentation only</option
                    ></select
                  >
                </div>
                <div class="field">
                  <label for="mask-label">Accessible label</label><input
                    id="mask-label"
                    class="input"
                    value={selectedMask.label ?? 'Redacted content'}
                    oninput={(event) =>
                      updateStep((step) => {
                        const mask = step.masks.find(
                          (candidate) => candidate.id === selectedMask?.id,
                        );
                        if (mask) mask.label = event.currentTarget.value;
                      })}
                  />
                </div>
                <dl class="mask-metadata">
                  <div>
                    <dt>Source</dt>
                    <dd>{selectedMask.source}</dd>
                  </div>
                  <div>
                    <dt>Scope</dt>
                    <dd>{selectedMask.scope}</dd>
                  </div>
                  <div>
                    <dt>Classification</dt>
                    <dd>{selectedMask.classification}</dd>
                  </div>
                </dl>
                {#if selectedMask.source !== 'manual' || selectedMask.classification !== 'custom'}
                  <p class="privacy-note">
                    Sensitive and policy-created masks stay opaque. Blur is reversible in a live
                    page and is reserved for manual presentation regions.
                  </p>
                {:else if selectedMask.mode === 'blur'}
                  <p class="privacy-note">
                    Publication exports rasterize this blur into derivatives. Do not use blur for
                    passwords, tokens, personal data, or other secrets.
                  </p>
                {/if}
                <div class="coordinate-grid">
                  {#each ['x', 'y', 'width', 'height'] as field}
                    <div class="field">
                      <label for={`mask-${field}`}>{field}</label><input
                        id={`mask-${field}`}
                        class="input mono"
                        type="number"
                        min={field === 'width' || field === 'height' ? 1 : 0}
                        max="100"
                        value={Math.round(
                          selectedMask[field as 'x' | 'y' | 'width' | 'height'] * 100,
                        )}
                        oninput={(event) =>
                          updateMaskGeometry(
                            selectedMask!.id,
                            field as 'x' | 'y' | 'width' | 'height',
                            Number(event.currentTarget.value),
                          )}
                      />
                    </div>
                  {/each}
                </div>
                <button
                  class="remove-object"
                  type="button"
                  onclick={() => deleteOverlay({ kind: 'mask', id: selectedMask!.id })}
                  ><Icon name="trash" size={13} />Remove selected mask</button
                >
              </div>
            {/if}
          </details>
        {:else if selectedStep.type === 'choice'}
          <section class="inspector-section">
            <h3>Choices</h3>
            <p class="section-empty">
              Choices link to other linear, independently verifiable Scenes. Loops are not allowed.
            </p>
            {#each selectedStep.choices as choice, index (choice.id)}
              <div class="choice-editor">
                <div class="field">
                  <label for={`choice-${index}`}>Choice {index + 1}</label><input
                    id={`choice-${index}`}
                    class="input"
                    value={choice.label}
                    oninput={(event) =>
                      updateStep((step) => {
                        if (step.choices[index])
                          step.choices[index]!.label = event.currentTarget.value;
                      })}
                  />
                </div>
                <div class="field">
                  <label for={`choice-destination-${index}`}>Destination Scene ID</label><input
                    id={`choice-destination-${index}`}
                    class="input mono"
                    value={choice.sceneId}
                    placeholder="another-linear-scene"
                    oninput={(event) =>
                      updateStep((step) => {
                        if (step.choices[index])
                          step.choices[index]!.sceneId = event.currentTarget.value;
                      })}
                  />
                </div>
                <div class="field">
                  <label for={`choice-fallback-${index}`}>Portable fallback URL</label><input
                    id={`choice-fallback-${index}`}
                    class="input"
                    value={choice.href ?? ''}
                    placeholder="/scenes/another-linear-scene"
                    oninput={(event) =>
                      updateStep((step) => {
                        if (step.choices[index])
                          step.choices[index]!.href = event.currentTarget.value;
                      })}
                  />
                </div>
                <button
                  class="remove-object"
                  type="button"
                  onclick={() => updateStep((step) => step.choices.splice(index, 1))}
                  ><Icon name="trash" size={13} />Remove</button
                >
              </div>
            {/each}
            <button
              class="button"
              type="button"
              onclick={() =>
                updateStep((step) =>
                  step.choices.push({
                    id: `choice-${Date.now()}`,
                    label: 'New path',
                    sceneId: 'linked-scene',
                    href: '/scenes/linked-scene',
                  }),
                )}><Icon name="plus" size={14} />Add choice</button
            >
          </section>
        {:else if selectedStep.type === 'end'}
          <section class="inspector-section">
            <h3>End card actions</h3>
            {#each selectedStep.ctas as cta, index (cta.id)}
              <div class="choice-editor">
                <div class="field">
                  <label for={`cta-kind-${index}`}>Action type</label><select
                    id={`cta-kind-${index}`}
                    class="select"
                    value={ctaKind(cta)}
                    onchange={(event) =>
                      setCtaKind(
                        index,
                        event.currentTarget.value as NonNullable<EditorCta['kind']>,
                      )}
                    ><option value="open-product">Open product</option><option value="read-docs"
                      >Read documentation</option
                    ><option value="book-call">Book a call</option><option value="external"
                      >External link</option
                    ><option value="restart">Restart walkthrough</option><option value="view-scene"
                      >View another Scene</option
                    ><option value="form">Submit a form</option></select
                  >
                </div>
                <div class="field">
                  <label for={`cta-${index}`}>Button label</label><input
                    id={`cta-${index}`}
                    class="input"
                    value={cta.label}
                    oninput={(event) =>
                      updateStep((step) => {
                        if (step.ctas[index]) {
                          step.ctas[index]!.label = event.currentTarget.value;
                          step.ctaEdited = true;
                        }
                      })}
                  />
                </div>
                {#if ['open-product', 'read-docs', 'book-call', 'external'].includes(ctaKind(cta))}
                  <div class="field">
                    <label for={`cta-url-${index}`}>Destination URL</label><input
                      id={`cta-url-${index}`}
                      class="input"
                      type="url"
                      placeholder="https://product.example/path"
                      value={cta.href ?? ''}
                      oninput={(event) =>
                        updateStep((step) => {
                          const target = step.ctas[index];
                          if (target) {
                            target.href = event.currentTarget.value;
                            step.ctaEdited = true;
                          }
                        })}
                    />
                  </div>
                {:else if ctaKind(cta) === 'view-scene'}
                  <div class="field">
                    <label for={`cta-scene-${index}`}>Destination Scene ID</label><input
                      id={`cta-scene-${index}`}
                      class="input mono"
                      placeholder="next-linear-scene"
                      value={cta.targetSceneId ?? ''}
                      oninput={(event) =>
                        updateStep((step) => {
                          const target = step.ctas[index];
                          if (target) {
                            target.targetSceneId = event.currentTarget.value;
                            step.ctaEdited = true;
                          }
                        })}
                    />
                  </div>
                {:else if ctaKind(cta) === 'form'}
                  <div class="field">
                    <label for={`cta-webhook-${index}`}>Webhook ID</label><input
                      id={`cta-webhook-${index}`}
                      class="input mono"
                      placeholder="lead-capture"
                      value={cta.webhookId ?? ''}
                      oninput={(event) =>
                        updateStep((step) => {
                          const target = step.ctas[index];
                          if (target) {
                            target.webhookId = event.currentTarget.value;
                            step.ctaEdited = true;
                          }
                        })}
                    />
                    <small class="field-help"
                      >A host adapter resolves this identifier. Studio never sends submissions by
                      itself.</small
                    >
                  </div>
                  <div class="form-fields">
                    <strong>Fields</strong>
                    {#each cta.fields ?? [] as field, fieldIndex (field.id)}
                      <div class="form-field">
                        <div class="coordinate-grid">
                          <div class="field">
                            <label for={`cta-field-id-${index}-${fieldIndex}`}>Field ID</label
                            ><input
                              id={`cta-field-id-${index}-${fieldIndex}`}
                              class="input mono"
                              value={field.id}
                              oninput={(event) =>
                                updateStep((step) => {
                                  const target = step.ctas[index]?.fields?.[fieldIndex];
                                  if (target) {
                                    target.id = event.currentTarget.value;
                                    step.ctaEdited = true;
                                  }
                                })}
                            />
                          </div>
                          <div class="field">
                            <label for={`cta-field-type-${index}-${fieldIndex}`}>Type</label><select
                              id={`cta-field-type-${index}-${fieldIndex}`}
                              class="select"
                              value={field.type}
                              onchange={(event) =>
                                updateStep((step) => {
                                  const target = step.ctas[index]?.fields?.[fieldIndex];
                                  if (target) {
                                    target.type = event.currentTarget.value as typeof target.type;
                                    if (target.type !== 'checkbox') target.consent = false;
                                    step.ctaEdited = true;
                                  }
                                })}
                              ><option value="email">Email</option><option value="text">Text</option
                              ><option value="checkbox">Checkbox</option></select
                            >
                          </div>
                        </div>
                        <div class="field">
                          <label for={`cta-field-label-${index}-${fieldIndex}`}>Field label</label
                          ><input
                            id={`cta-field-label-${index}-${fieldIndex}`}
                            class="input"
                            value={field.label}
                            oninput={(event) =>
                              updateStep((step) => {
                                const target = step.ctas[index]?.fields?.[fieldIndex];
                                if (target) {
                                  target.label = event.currentTarget.value;
                                  step.ctaEdited = true;
                                }
                              })}
                          />
                        </div>
                        <div class="field-options">
                          <label
                            ><input
                              type="checkbox"
                              checked={field.required}
                              onchange={(event) =>
                                updateStep((step) => {
                                  const target = step.ctas[index]?.fields?.[fieldIndex];
                                  if (target) {
                                    target.required = event.currentTarget.checked;
                                    step.ctaEdited = true;
                                  }
                                })}
                            />Required</label
                          >
                          {#if field.type === 'checkbox'}<label
                              ><input
                                type="checkbox"
                                checked={field.consent}
                                onchange={(event) =>
                                  updateStep((step) => {
                                    const target = step.ctas[index]?.fields?.[fieldIndex];
                                    if (target) {
                                      target.consent = event.currentTarget.checked;
                                      step.ctaEdited = true;
                                    }
                                  })}
                              />Explicit consent</label
                            >{/if}
                          <button
                            type="button"
                            onclick={() =>
                              updateStep((step) => {
                                step.ctas[index]?.fields?.splice(fieldIndex, 1);
                                step.ctaEdited = true;
                              })}><Icon name="trash" size={12} />Remove field</button
                          >
                        </div>
                      </div>
                    {/each}
                    <button
                      class="button"
                      type="button"
                      onclick={() =>
                        updateStep((step) => {
                          step.ctas[index]?.fields?.push({
                            id: `field-${Date.now().toString(36)}`,
                            label: 'New field',
                            type: 'text',
                            required: false,
                            consent: false,
                          });
                          step.ctaEdited = true;
                        })}><Icon name="plus" size={13} />Add field</button
                    >
                  </div>
                {/if}
                <div class="field">
                  <label for={`cta-variant-${index}`}>Button style</label><select
                    id={`cta-variant-${index}`}
                    class="select"
                    value={cta.variant ?? 'primary'}
                    onchange={(event) =>
                      updateStep((step) => {
                        const target = step.ctas[index];
                        if (target) {
                          target.variant = event.currentTarget.value as 'primary' | 'secondary';
                          step.ctaEdited = true;
                        }
                      })}
                    ><option value="primary">Primary</option><option value="secondary"
                      >Secondary</option
                    ></select
                  >
                </div>
                <button
                  class="remove-object"
                  type="button"
                  onclick={() =>
                    updateStep((step) => {
                      step.ctas.splice(index, 1);
                      step.ctaEdited = true;
                    })}><Icon name="trash" size={13} />Remove</button
                >
              </div>
            {/each}
            <button
              class="button"
              type="button"
              onclick={() =>
                updateStep((step) => {
                  step.ctas.push({
                    id: `cta-${Date.now()}`,
                    label: 'Restart walkthrough',
                    kind: 'restart',
                    event: 'restart',
                    fields: [],
                    variant: step.ctas.length === 0 ? 'primary' : 'secondary',
                  });
                  step.ctaEdited = true;
                })}><Icon name="plus" size={14} />Add action</button
            >
          </section>
        {/if}

        <details class="inspector-section inspector-disclosure">
          <summary><span>Appearance</span><small>Theme and frame</small></summary>
          <div class="theme-library">
            <div class="field">
              <label for="saved-theme">Saved theme</label><select
                id="saved-theme"
                class="select"
                value={selectedThemeId}
                disabled={savedThemes.length === 0}
                onchange={(event) => selectSavedTheme(event.currentTarget.value)}
                >{#if savedThemes.length === 0}<option value="">No saved themes yet</option>{/if}
                {#each savedThemes as savedTheme (savedTheme.id)}
                  <option value={savedTheme.id}>{savedTheme.name}</option>
                {/each}</select
              >
            </div>
            <div class="field">
              <label for="theme-name">Theme name</label><input
                id="theme-name"
                class="input"
                maxlength="80"
                value={themeName}
                oninput={(event) => (themeName = event.currentTarget.value)}
              />
            </div>
            <div class="theme-library-actions">
              <button
                class="button"
                type="button"
                disabled={!selectedSavedTheme}
                onclick={applySavedTheme}>Apply</button
              ><button class="button" type="button" onclick={saveCurrentTheme}
                ><Icon name="save" size={13} />Save current</button
              ><button
                class="button danger"
                type="button"
                aria-label="Delete saved theme"
                disabled={!selectedSavedTheme}
                onclick={deleteSavedTheme}>Delete</button
              >
            </div>
            {#if themeLibraryError}<p class="theme-library-message error" role="alert">
                {themeLibraryError}
              </p>{:else if themeLibraryNotice}<p class="theme-library-message" aria-live="polite">
                {themeLibraryNotice}
              </p>{/if}
          </div>
          <div class="theme-row">
            <label for="accent-color">Accent</label><input
              id="accent-color"
              type="color"
              value={scene.theme.accent}
              oninput={(event) =>
                mutate((draft) => (draft.theme.accent = event.currentTarget.value))}
            /><code>{scene.theme.accent}</code>
          </div>
          <div class="theme-row">
            <label for="paper-color">Paper</label><input
              id="paper-color"
              type="color"
              value={scene.theme.paper}
              oninput={(event) =>
                mutate((draft) => (draft.theme.paper = event.currentTarget.value))}
            /><code>{scene.theme.paper}</code>
          </div>
          <div class="theme-row">
            <label for="ink-color">Ink</label><input
              id="ink-color"
              type="color"
              value={scene.theme.ink}
              oninput={(event) => mutate((draft) => (draft.theme.ink = event.currentTarget.value))}
            /><code>{scene.theme.ink}</code>
          </div>
          <div class="range-field">
            <span
              ><label for="theme-radius">Corner radius</label><output>{scene.theme.radius}px</output
              ></span
            ><input
              id="theme-radius"
              type="range"
              min="0"
              max="32"
              step="1"
              value={scene.theme.radius}
              oninput={(event) =>
                mutate((draft) => (draft.theme.radius = Number(event.currentTarget.value)))}
            />
          </div>
          <div class="field">
            <label for="device-frame">Frame</label><select
              id="device-frame"
              class="select"
              value={selectedStep.frame}
              onchange={(event) =>
                updateStep(
                  (step) => (step.frame = event.currentTarget.value as EditorStep['frame']),
                )}
              ><option value="browser">Browser</option><option value="mobile">Mobile device</option
              ><option value="none">None</option></select
            >
          </div>
          <button
            class="button full-width"
            type="button"
            disabled={selectedStep.type !== 'screen'}
            onclick={applyFrameAndCursorToAll}>Apply frame & cursor to all screens</button
          >
          <small class="field-help">Theme colors and radius already apply to the whole Scene.</small
          >
        </details>

        <details class="inspector-section inspector-disclosure">
          <summary
            ><span>Output visibility</span><small
              >{Object.values(selectedStep.outputVisibility).filter(Boolean).length} enabled</small
            ></summary
          >
          {#each ['interactive', 'guide', 'motion', 'social'] as output}
            <label class="output-check"
              ><input
                type="checkbox"
                checked={selectedStep.outputVisibility[output as OutputKind]}
                onchange={(event) =>
                  toggleOutput(output as OutputKind, event.currentTarget.checked)}
              /><span>{output}</span></label
            >
          {/each}
          <button class="button full-width" type="button" onclick={applyOutputsToAll}
            >Apply this visibility to all Steps</button
          >
        </details>
      </div>

      <div class="inspector-actions">
        <button
          class="button"
          type="button"
          disabled={!canSplitSelected}
          title={canSplitSelected
            ? 'Split the instruction into two consecutive screen Steps'
            : 'A screen instruction needs two meaningful clauses before it can be split'}
          onclick={splitSelected}>Split</button
        >
        <button
          class="button"
          type="button"
          disabled={selectedIndex === 0 ||
            selectedStep.type !== 'screen' ||
            scene.steps[selectedIndex - 1]?.type !== 'screen'}
          onclick={mergeWithPrevious}>Merge</button
        >
        <button class="button" type="button" onclick={copySelected}
          ><Icon name="copy" size={14} />Duplicate</button
        >
        <button
          class="button danger"
          type="button"
          disabled={scene.steps.length <= 1}
          onclick={deleteSelected}><Icon name="trash" size={14} />Delete</button
        >
      </div>
    </aside>
  </div>
</section>

<style>
  .editor {
    background: var(--paper-2);
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: max(500px, calc(100dvh - 193px));
    min-height: 0;
    overflow: hidden;
  }
  .editor-toolbar {
    align-items: center;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
    display: grid;
    gap: 14px;
    grid-template-columns: 1fr auto 1fr;
    min-height: 49px;
    padding: 6px 11px;
    position: relative;
    z-index: 30;
  }
  .history-controls,
  .aspect-controls {
    align-items: center;
    display: flex;
    gap: 3px;
  }
  .aspect-controls {
    justify-content: flex-end;
  }
  .toolbar-divider {
    border-left: 1px solid var(--line);
    height: 22px;
    margin: 0 6px;
  }
  .save-state {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--pass);
    display: flex;
    font-size: 0.7rem;
    gap: 5px;
    padding: 5px;
  }
  .save-state.saving {
    color: var(--changed);
  }
  .save-state.error {
    color: var(--broken);
    cursor: pointer;
  }
  .canvas-tools {
    align-items: center;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 8px;
    display: flex;
    padding: 3px;
  }
  .canvas-tools button,
  .canvas-tools summary {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 5px;
    color: var(--muted);
    display: flex;
    font-size: 0.7rem;
    gap: 5px;
    height: 36px;
    padding: 0 9px;
  }
  .canvas-tools button:hover,
  .canvas-tools summary:hover {
    color: var(--ink);
  }
  .canvas-tools button.active,
  .canvas-tools summary.active {
    background: var(--surface);
    box-shadow: var(--shadow-sm);
    color: var(--accent);
  }
  .tool-menu {
    position: relative;
  }
  .tool-menu > summary {
    cursor: pointer;
    list-style: none;
  }
  .tool-menu > summary::-webkit-details-marker {
    display: none;
  }
  .tool-menu-popover {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 8px;
    display: grid;
    gap: 3px;
    left: 0;
    min-width: 172px;
    padding: 5px;
    position: absolute;
    top: calc(100% + 8px);
    z-index: 20;
  }
  .tool-menu-popover button {
    justify-content: flex-start;
    width: 100%;
  }
  .aspect-controls select {
    background: transparent;
    border: 0;
    color: var(--muted);
    font-size: 0.7rem;
    height: 34px;
  }
  .editor-grid {
    display: grid;
    grid-template-columns: 224px minmax(380px, 1fr) 302px;
    min-height: 0;
    overflow: hidden;
  }
  .step-panel,
  .inspector {
    background: var(--surface);
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .step-panel {
    border-right: 1px solid var(--line);
  }
  .inspector {
    border-left: 1px solid var(--line);
  }
  .panel-heading {
    align-items: center;
    border-bottom: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    min-height: 49px;
    padding: 8px 11px;
  }
  .panel-heading > span > strong,
  .panel-heading > span > small {
    display: block;
  }
  .panel-heading strong {
    font-size: 0.75rem;
  }
  .panel-heading small {
    color: var(--muted);
    font-size: 0.7rem;
    margin-top: 1px;
  }
  .step-list {
    display: grid;
    gap: 3px;
    list-style: none;
    margin: 0;
    min-height: 0;
    overflow: auto;
    padding: 8px;
  }
  .step-list li {
    border: 1px solid transparent;
    border-radius: 8px;
    display: grid;
    grid-template-columns: 1fr auto;
    min-width: 0;
    position: relative;
  }
  .step-list li:hover {
    background: var(--paper);
  }
  .step-list li.selected {
    background: var(--accent-soft);
    border-color: #dfb8ac;
  }
  .step-select {
    align-items: center;
    background: transparent;
    border: 0;
    display: grid;
    gap: 7px;
    grid-template-columns: 20px 58px minmax(0, 1fr);
    min-width: 0;
    padding: 6px 2px 6px 6px;
    text-align: left;
  }
  .step-number {
    color: var(--faint);
    font-size: 0.7rem;
  }
  .thumbnail {
    background: #282521;
    border-radius: 5px;
    height: 39px;
    overflow: hidden;
    position: relative;
    width: 58px;
  }
  .thumbnail img {
    height: 100%;
    object-fit: cover;
    width: 100%;
  }
  .special-step {
    align-items: center;
    color: #d3ccc2;
    display: flex;
    height: 100%;
    justify-content: center;
  }
  .mini-hotspot {
    background: var(--accent);
    border: 1px solid white;
    border-radius: 50%;
    height: 7px;
    position: absolute;
    transform: translate(-50%, -50%);
    width: 7px;
  }
  .step-copy {
    min-width: 0;
  }
  .step-copy strong,
  .step-copy small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .step-copy strong {
    font-size: 0.7rem;
    font-weight: 650;
  }
  .step-copy small {
    color: var(--faint);
    font-size: 0.7rem;
    margin-top: 3px;
    text-transform: capitalize;
  }
  .reorder-actions {
    align-content: center;
    display: grid;
    opacity: 0;
    padding-right: 3px;
  }
  li:hover .reorder-actions,
  li:focus-within .reorder-actions {
    opacity: 1;
  }
  .reorder-actions button {
    background: transparent;
    border: 0;
    color: var(--muted);
    height: 24px;
    padding: 0;
    width: 24px;
  }
  .reorder-actions button:disabled {
    opacity: 0.25;
  }
  .add-types {
    border-top: 1px solid var(--line);
    display: grid;
    gap: 3px;
    grid-template-columns: repeat(3, 1fr);
    margin-top: auto;
    padding: 8px;
  }
  .add-types button {
    align-items: center;
    background: transparent;
    border: 1px dashed var(--line);
    border-radius: 6px;
    color: var(--muted);
    display: flex;
    flex-direction: column;
    font-size: 0.7rem;
    gap: 3px;
    justify-content: center;
    min-height: 44px;
    padding: 4px;
  }
  .add-types button:hover {
    background: var(--paper);
    border-color: var(--line-strong);
    color: var(--ink);
  }
  .stage-column {
    display: grid;
    grid-template-rows: 33px minmax(0, 1fr) 37px;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .stage-meta {
    align-items: center;
    color: var(--faint);
    display: flex;
    font-size: 0.7rem;
    gap: 10px;
    justify-content: space-between;
    padding: 0 13px;
  }
  .tool-hint {
    color: var(--accent);
  }
  .stage-scroll {
    align-items: center;
    display: flex;
    justify-content: center;
    min-height: 0;
    overflow: auto;
    padding: clamp(14px, 3vw, 34px);
  }
  .canvas-shell {
    display: flex;
    justify-content: center;
    max-height: 100%;
    max-width: 100%;
    width: min(100%, 1040px);
  }
  .canvas-shell.portrait {
    width: min(45%, 460px);
  }
  .browser-frame {
    background: #24211e;
    border: 1px solid #48433d;
    border-radius: 10px;
    box-shadow: 0 18px 54px rgba(31, 27, 23, 0.18);
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .browser-frame.frameless {
    border: 0;
    border-radius: 0;
  }
  .browser-bar {
    align-items: center;
    display: flex;
    flex: 0 0 24px;
    gap: 5px;
    padding: 0 8px;
  }
  .browser-bar > span {
    background: #767068;
    border-radius: 50%;
    height: 5px;
    width: 5px;
  }
  .browser-bar > span:first-child {
    background: #c35745;
  }
  .browser-bar i {
    background: #36322e;
    border-radius: 4px;
    color: #aaa299;
    font-size: 7px;
    font-style: normal;
    height: 14px;
    left: 50%;
    line-height: 14px;
    padding: 0 25px;
    position: absolute;
    transform: translateX(-50%);
  }
  .canvas {
    background: #292622;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    position: relative;
  }
  .canvas.placing {
    cursor: crosshair;
  }
  .placement-layer {
    background: transparent;
    border: 0;
    cursor: crosshair;
    inset: 0;
    padding: 0;
    position: absolute;
    z-index: 10;
  }
  .canvas-image {
    height: 100%;
    object-fit: contain;
    user-select: none;
    width: 100%;
  }
  .canvas-cursor-path,
  .canvas-arrow-line {
    height: 100%;
    inset: 0;
    overflow: visible;
    pointer-events: none;
    position: absolute;
    width: 100%;
  }
  .canvas-cursor-path {
    z-index: 2;
  }
  .canvas-cursor-path polyline {
    fill: none;
    stroke: color-mix(in srgb, var(--accent) 75%, white);
    stroke-dasharray: 2 1.5;
    stroke-width: 0.45;
  }
  .canvas-cursor-path circle {
    fill: white;
    stroke: var(--accent);
    stroke-width: 0.35;
  }
  .canvas-arrow-line {
    z-index: 3;
  }
  .canvas-arrow-line line {
    stroke-linecap: round;
    stroke-width: 0.8;
  }
  .canvas-object {
    position: absolute;
    z-index: 4;
  }
  .canvas-mask-object {
    min-height: 1%;
    min-width: 1%;
  }
  .object-surface {
    cursor: move;
    font: inherit;
    touch-action: none;
  }
  .object-surface:focus-visible,
  .object-surface.selected {
    outline: 3px solid white;
    outline-offset: 2px;
  }
  .canvas-mask {
    background: #191816;
    border: 1px solid rgba(255, 255, 255, 0.35);
    border-radius: 3px;
    height: 100%;
    padding: 0;
    width: 100%;
  }
  .canvas-mask.blur {
    backdrop-filter: blur(16px);
    background: rgba(25, 24, 22, 0.08);
  }
  .canvas-annotation-object {
    min-height: 1%;
    min-width: 1%;
    transform: translate(-50%, -50%);
  }
  .canvas-annotation {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 7px;
    box-shadow: var(--shadow-md);
    font-size: clamp(7px, 0.8vw, 11px);
    font-weight: 650;
    height: 100%;
    overflow: hidden;
    padding: 7px 9px;
    text-overflow: ellipsis;
    width: 100%;
  }
  .canvas-annotation-object.spotlight .canvas-annotation {
    background: transparent;
    border: 3px solid var(--annotation-color);
    border-radius: 999px;
    box-shadow: 0 0 0 999px rgba(0, 0, 0, 0.22);
  }
  .canvas-arrow-target {
    background: color-mix(in srgb, var(--accent) 26%, transparent);
    border: 1px solid white;
    border-radius: 999px;
    height: 24px;
    padding: 0;
    position: absolute;
    transform: translate(-50%, -50%);
    width: 24px;
    z-index: 5;
  }
  .resize-handle {
    background: white;
    border: 2px solid var(--accent);
    border-radius: 2px;
    bottom: -7px;
    cursor: nwse-resize;
    height: 14px;
    padding: 0;
    position: absolute;
    right: -7px;
    touch-action: none;
    width: 14px;
    z-index: 7;
  }
  .resize-handle:focus-visible {
    outline: 3px solid var(--accent-soft);
    outline-offset: 2px;
  }
  .arrow-resize-handle {
    bottom: auto;
    right: auto;
    transform: translate(-50%, -50%);
  }
  .canvas-hotspot {
    align-items: center;
    background: white;
    border: 2px solid var(--accent);
    border-radius: 999px;
    box-shadow: 0 0 0 7px color-mix(in srgb, var(--accent) 22%, transparent);
    display: flex;
    min-height: 32px;
    min-width: 32px;
    padding: 0;
    position: absolute;
    transform: translate(-50%, -50%);
  }
  .canvas-hotspot i {
    background: var(--accent);
    border-radius: 50%;
    height: 9px;
    margin: 0 10px;
    width: 9px;
  }
  .canvas-hotspot span {
    background: var(--ink);
    border-radius: 6px;
    color: white;
    font-size: 8px;
    font-weight: 650;
    left: 50%;
    padding: 4px 6px;
    position: absolute;
    top: calc(100% + 8px);
    transform: translateX(-50%);
    white-space: nowrap;
  }
  .canvas-cursor {
    color: white;
    filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.45));
    position: absolute;
    transform: translate(-4px, -3px);
    z-index: 6;
  }
  .canvas-cursor.dot {
    background: white;
    border: 3px solid var(--accent);
    border-radius: 50%;
    height: 16px;
    transform: translate(-50%, -50%);
    width: 16px;
  }
  .canvas-cursor.dot :global(svg) {
    display: none;
  }
  .canvas-cursor.pointer {
    color: var(--accent-soft);
  }
  .canvas-cursor.clicking::after {
    border: 2px solid var(--accent);
    border-radius: 50%;
    content: '';
    height: 28px;
    left: -8px;
    position: absolute;
    top: -8px;
    width: 28px;
  }
  .canvas-empty {
    align-items: center;
    color: #bfb8ae;
    display: flex;
    flex-direction: column;
    gap: 5px;
    inset: 0;
    justify-content: center;
    position: absolute;
  }
  .canvas-empty strong {
    font-size: 0.75rem;
  }
  .canvas-empty span {
    font-size: 0.7rem;
  }
  .canvas-empty .button {
    margin-top: 5px;
    min-height: 34px;
  }
  .choice-canvas,
  .end-canvas {
    align-content: center;
    background: var(--ink);
    color: white;
    display: grid;
    height: 100%;
    padding: clamp(20px, 7vw, 72px);
  }
  .choice-canvas h2,
  .end-canvas h2 {
    font-size: clamp(1.3rem, 3vw, 2.8rem);
    letter-spacing: -0.04em;
    margin: 7px 0;
  }
  .choice-canvas p,
  .end-canvas p {
    color: #c5beb5;
    font-size: clamp(0.65rem, 1.2vw, 0.9rem);
    margin: 0 0 18px;
  }
  .choice-canvas > div,
  .end-canvas > div {
    display: flex;
    flex-wrap: wrap;
    gap: 9px;
  }
  .choice-preview,
  .cta-preview {
    background: #2d2a27;
    border: 1px solid #5c5650;
    border-radius: 8px;
    color: white;
    display: block;
    font-size: clamp(0.6rem, 1vw, 0.82rem);
    min-width: 160px;
    padding: 11px 13px;
    text-align: left;
  }
  .choice-preview small {
    color: #aaa39b;
    display: block;
    font-size: 0.7em;
    margin-top: 3px;
  }
  .cta-preview.primary {
    background: var(--accent);
    border-color: var(--accent);
  }
  .narrative-canvas {
    text-align: center;
  }
  .developer-drawer {
    align-items: center;
    background: var(--surface);
    border-top: 1px solid var(--line);
    color: var(--muted);
    display: flex;
    font-size: 0.7rem;
    gap: 18px;
    justify-content: space-between;
    padding: 0 12px;
  }
  .developer-drawer span {
    align-items: center;
    display: flex;
    gap: 5px;
  }
  .developer-drawer strong {
    color: var(--ink);
  }
  .developer-drawer code {
    color: var(--muted);
  }
  .inspector-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .inspector-section {
    border-bottom: 1px solid var(--line);
    display: grid;
    gap: 10px;
    padding: 13px;
  }
  .inspector-section h3 {
    font-size: 0.8rem;
    letter-spacing: 0.02em;
    margin: 0 0 2px;
  }
  .inspector-disclosure {
    display: grid;
    gap: 10px;
    padding: 0;
  }
  .inspector-disclosure-shell {
    padding: 0;
  }
  .inspector-disclosure[open] {
    padding: 0 13px 13px;
  }
  .inspector-disclosure > summary {
    align-items: center;
    cursor: pointer;
    display: grid;
    gap: 3px 10px;
    grid-template-columns: 1fr auto;
    list-style: none;
    min-height: 44px;
    padding: 11px 13px;
  }
  .inspector-disclosure[open] > summary {
    border-bottom: 1px solid var(--line);
    margin: 0 -13px 3px;
  }
  .inspector-disclosure > summary::-webkit-details-marker {
    display: none;
  }
  .inspector-disclosure > summary::after {
    color: var(--muted);
    content: '+';
    font-size: 0.9rem;
    grid-column: 2;
    grid-row: 1 / 3;
  }
  .inspector-disclosure[open] > summary::after {
    content: '−';
  }
  .inspector-disclosure > summary span,
  .inspector-disclosure > summary h3 {
    font-size: 0.78rem;
    font-weight: 680;
    margin: 0;
  }
  .inspector-disclosure > summary small {
    color: var(--muted);
    font-size: 0.7rem;
  }
  .field {
    gap: 5px;
  }
  .field > label {
    font-size: 0.7rem;
  }
  .input,
  .select,
  .textarea {
    font-size: 0.72rem;
    min-height: 38px;
    padding: 7px 8px;
  }
  .textarea {
    min-height: 62px;
  }
  .textarea.small {
    min-height: 52px;
  }
  .field-help {
    color: var(--muted);
    font-size: 0.7rem;
    line-height: 1.4;
  }
  .full-width {
    justify-content: center;
    width: 100%;
  }
  .inline-error {
    color: var(--broken);
    font-size: 0.7rem;
    line-height: 1.4;
    margin: 0;
  }
  .locale-add {
    display: grid;
    gap: 6px;
    grid-template-columns: 1fr auto;
  }
  .coordinate-grid {
    display: grid;
    gap: 8px;
    grid-template-columns: 1fr 1fr;
  }
  .toggle-row {
    align-items: center;
    display: grid;
    gap: 8px;
    grid-template-columns: 1fr auto;
  }
  .toggle-row strong,
  .toggle-row small {
    display: block;
  }
  .toggle-row strong {
    font-size: 0.72rem;
  }
  .toggle-row small {
    color: var(--muted);
    font-size: 0.7rem;
    margin-top: 2px;
  }
  input[type='checkbox'] {
    accent-color: var(--accent);
    height: 15px;
    width: 15px;
  }
  .range-field {
    display: grid;
    gap: 3px;
  }
  .range-field > span {
    display: flex;
    font-size: 0.7rem;
    justify-content: space-between;
  }
  .range-field output {
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  input[type='range'] {
    accent-color: var(--accent);
    width: 100%;
  }
  .section-empty {
    color: var(--muted);
    font-size: 0.7rem;
    line-height: 1.45;
    margin: 0;
  }
  .object-row {
    align-items: center;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 6px;
    display: grid;
    gap: 5px;
    grid-template-columns: 1fr auto;
    padding: 4px 5px;
  }
  .object-row.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .object-row button {
    background: transparent;
    border: 0;
    color: var(--muted);
    padding: 2px;
  }
  .object-row .object-select {
    align-items: center;
    display: grid;
    gap: 7px;
    grid-template-columns: auto 1fr;
    min-width: 0;
    text-align: left;
  }
  .object-select span {
    display: grid;
    min-width: 0;
  }
  .object-select strong {
    color: var(--ink);
    font-size: 0.7rem;
    text-transform: capitalize;
  }
  .object-select small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .object-editor,
  .cursor-path-editor {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 7px;
    display: grid;
    gap: 8px;
    padding: 9px;
  }
  .mask-metadata {
    display: grid;
    gap: 4px;
    margin: 0;
  }
  .mask-metadata > div {
    display: flex;
    font-size: 0.7rem;
    justify-content: space-between;
  }
  .mask-metadata dt {
    color: var(--faint);
  }
  .mask-metadata dd {
    color: var(--ink);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    margin: 0;
  }
  .privacy-note {
    background: color-mix(in srgb, var(--accent) 7%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--line));
    border-radius: 6px;
    color: var(--muted);
    font-size: 0.7rem;
    line-height: 1.45;
    margin: 0;
    padding: 7px 8px;
  }
  .cursor-path-editor > span {
    display: flex;
    font-size: 0.7rem;
    justify-content: space-between;
  }
  .cursor-path-editor > span small {
    color: var(--faint);
  }
  .cursor-keyframe {
    align-items: end;
    display: grid;
    gap: 5px;
    grid-template-columns: 1.2fr 1fr 1fr auto;
  }
  .cursor-keyframe label {
    color: var(--muted);
    display: grid;
    font-size: 0.7rem;
    gap: 2px;
  }
  .cursor-keyframe .input {
    min-width: 0;
    padding-inline: 5px;
  }
  .cursor-keyframe > button {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--broken);
    display: flex;
    height: 38px;
  }
  .color-field {
    align-items: center;
    grid-template-columns: 1fr auto;
  }
  .color-field input {
    background: transparent;
    border: 0;
    height: 30px;
    padding: 0;
    width: 38px;
  }
  .choice-editor {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 7px;
    display: grid;
    gap: 8px;
    padding: 8px;
  }
  .form-fields {
    display: grid;
    gap: 8px;
  }
  .form-fields > strong {
    font-size: 0.7rem;
  }
  .form-field {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 6px;
    display: grid;
    gap: 8px;
    padding: 8px;
  }
  .field-options {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 9px;
  }
  .field-options label {
    align-items: center;
    display: flex;
    font-size: 0.7rem;
    gap: 4px;
  }
  .field-options button {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--broken);
    display: flex;
    font-size: 0.7rem;
    gap: 3px;
    margin-left: auto;
  }
  .remove-object {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--broken);
    display: flex;
    font-size: 0.7rem;
    gap: 4px;
    justify-self: end;
  }
  .theme-row {
    align-items: center;
    display: grid;
    font-size: 0.7rem;
    gap: 8px;
    grid-template-columns: 1fr auto auto;
  }
  .theme-library {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 7px;
    display: grid;
    gap: 8px;
    padding: 9px;
  }
  .theme-library-actions {
    display: grid;
    gap: 5px;
    grid-template-columns: repeat(3, 1fr);
  }
  .theme-library-actions .button {
    font-size: 0.7rem;
    justify-content: center;
    min-height: 34px;
    padding: 5px;
  }
  .theme-library-message {
    color: var(--muted);
    font-size: 0.7rem;
    line-height: 1.4;
    margin: 0;
  }
  .theme-library-message.error {
    color: var(--broken);
  }
  .theme-row input {
    background: transparent;
    border: 0;
    height: 27px;
    padding: 0;
    width: 30px;
  }
  .theme-row code {
    color: var(--muted);
    font-size: 0.7rem;
  }
  .output-check {
    align-items: center;
    display: flex;
    font-size: 0.7rem;
    gap: 8px;
    text-transform: capitalize;
  }
  .inspector-actions {
    border-top: 1px solid var(--line);
    display: grid;
    gap: 6px;
    grid-template-columns: repeat(2, 1fr);
    margin-top: auto;
    padding: 8px;
  }
  .inspector-actions .button {
    flex: 1;
    font-size: 0.7rem;
    min-height: 40px;
    padding: 6px;
  }
  @media (max-width: 1200px) {
    .editor-grid {
      grid-template-columns: 190px minmax(360px, 1fr) 276px;
    }
    .canvas-tools > button span,
    .canvas-tools > .tool-menu > summary span {
      display: none;
    }
    .canvas-tools button {
      padding: 0 8px;
    }
  }
  @media (max-width: 900px) {
    .editor {
      height: auto;
      min-height: auto;
      overflow: visible;
    }
    .editor-toolbar {
      grid-template-columns: 1fr auto;
    }
    .canvas-tools {
      grid-column: 1 / -1;
      grid-row: 2;
      justify-self: center;
    }
    .editor-grid {
      grid-template-columns: 1fr;
      overflow: visible;
    }
    .step-panel {
      border-bottom: 1px solid var(--line);
      border-right: 0;
      max-width: 100vw;
      order: 1;
      overflow: visible;
    }
    .panel-heading {
      min-height: 42px;
    }
    .step-list {
      display: flex;
      overflow-x: auto;
      padding: 7px;
    }
    .step-list li {
      flex: 0 0 188px;
    }
    .add-types {
      display: grid;
      grid-template-columns: repeat(5, minmax(62px, 1fr));
      overflow-x: auto;
    }
    .stage-column {
      min-height: 520px;
      order: 2;
      overflow: hidden;
    }
    .inspector {
      border-left: 0;
      border-top: 1px solid var(--line);
      max-height: none;
      order: 3;
      overflow: visible;
    }
    .inspector-scroll {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      overflow: visible;
    }
    .inspector-section {
      align-content: start;
    }
    .inspector-actions {
      position: sticky;
      bottom: 0;
    }
  }
  @media (pointer: coarse) {
    .canvas-tools button,
    .canvas-tools summary,
    .reorder-actions button,
    .history-controls .icon-button,
    .step-panel .icon-button,
    .inspector .button,
    .inspector input,
    .inspector select {
      min-height: 44px;
      min-width: 44px;
    }
  }
  @media (max-width: 620px) {
    .editor-toolbar {
      padding: 5px 7px;
    }
    .canvas-tools button,
    .canvas-tools summary,
    .reorder-actions button,
    .history-controls .icon-button,
    .step-panel .icon-button,
    .inspector .button,
    .inspector input,
    .inspector select {
      min-height: 44px;
      min-width: 44px;
    }
    .aspect-controls .button {
      font-size: 0;
      padding: 7px;
    }
    .stage-column {
      min-height: 430px;
    }
    .stage-scroll {
      padding: 12px;
    }
    .canvas-shell {
      width: 100%;
    }
    .canvas-shell.portrait {
      width: 56%;
    }
    .developer-drawer span:nth-child(2),
    .developer-drawer code {
      display: none;
    }
    .inspector-scroll {
      grid-template-columns: 1fr;
    }
  }
</style>
