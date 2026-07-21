import type { EditorScene } from './model';

const STORAGE_KEY = 'scenebook:themes:v1';
const STORAGE_VERSION = 1;
const MAX_THEMES = 50;
const MAX_SERIALIZED_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 80;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export type SceneTheme = EditorScene['theme'];

export interface SavedTheme {
  version: 1;
  id: string;
  name: string;
  theme: SceneTheme;
  createdAt: string;
  updatedAt: string;
}

interface ThemeStore {
  version: 1;
  themes: SavedTheme[];
}

export class ThemeLibraryError extends Error {
  readonly code: 'invalid-name' | 'invalid-theme' | 'invalid-store' | 'capacity' | 'storage';

  constructor(message: string, code: ThemeLibraryError['code'], options?: ErrorOptions) {
    super(message, options);
    this.name = 'ThemeLibraryError';
    this.code = code;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cloneTheme(theme: SceneTheme): SceneTheme {
  return { ...theme };
}

function cloneSavedTheme(theme: SavedTheme): SavedTheme {
  return { ...theme, theme: cloneTheme(theme.theme) };
}

function normalizedName(value: string): string {
  const name = value.trim().replace(/\s+/gu, ' ');
  if (!name || name.length > MAX_NAME_LENGTH || CONTROL_CHARACTER.test(name)) {
    throw new ThemeLibraryError(
      `Theme names must contain 1–${MAX_NAME_LENGTH} visible characters.`,
      'invalid-name',
    );
  }
  return name;
}

function normalizedTheme(value: unknown): SceneTheme {
  const theme = objectValue(value);
  if (!theme) {
    throw new ThemeLibraryError('The saved theme is not an object.', 'invalid-theme');
  }
  const { accent, paper, ink, radius, frame } = theme;
  if (
    typeof accent !== 'string' ||
    !HEX_COLOR.test(accent) ||
    typeof paper !== 'string' ||
    !HEX_COLOR.test(paper) ||
    typeof ink !== 'string' ||
    !HEX_COLOR.test(ink) ||
    typeof radius !== 'number' ||
    !Number.isInteger(radius) ||
    radius < 0 ||
    radius > 32 ||
    (frame !== 'light' && frame !== 'dark')
  ) {
    throw new ThemeLibraryError(
      'Themes require three six-digit hex colors, a 0–32px integer radius, and a light or dark frame.',
      'invalid-theme',
    );
  }
  return {
    accent: accent.toLowerCase(),
    paper: paper.toLowerCase(),
    ink: ink.toLowerCase(),
    radius,
    frame,
  };
}

function exactIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseSavedTheme(value: unknown): SavedTheme {
  const saved = objectValue(value);
  if (
    !saved ||
    saved.version !== STORAGE_VERSION ||
    typeof saved.id !== 'string' ||
    !SAFE_ID.test(saved.id) ||
    typeof saved.name !== 'string' ||
    !exactIsoDate(saved.createdAt) ||
    !exactIsoDate(saved.updatedAt)
  ) {
    throw new ThemeLibraryError(
      'The saved theme library contains an invalid entry.',
      'invalid-store',
    );
  }
  let name: string;
  let theme: SceneTheme;
  try {
    name = normalizedName(saved.name);
    theme = normalizedTheme(saved.theme);
  } catch (error) {
    throw new ThemeLibraryError(
      'The saved theme library contains an invalid entry.',
      'invalid-store',
      {
        cause: error,
      },
    );
  }
  if (name !== saved.name || saved.updatedAt < saved.createdAt) {
    throw new ThemeLibraryError(
      'The saved theme library contains an invalid entry.',
      'invalid-store',
    );
  }
  return {
    version: 1,
    id: saved.id,
    name,
    theme,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  };
}

function serializedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function slugForName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 56)
    .replace(/-+$/gu, '');
  return slug || 'theme';
}

function uniqueId(name: string, themes: readonly SavedTheme[]): string {
  const used = new Set(themes.map((theme) => theme.id));
  const base = slugForName(name);
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix <= MAX_THEMES + 1; suffix += 1) {
    const candidate = `${base.slice(0, 63 - String(suffix).length)}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new ThemeLibraryError('The saved theme library has no available identifiers.', 'capacity');
}

export class ThemeLibrary {
  readonly #storage: () => Storage | null;
  readonly #now: () => string;

  constructor(
    storage: () => Storage | null = () =>
      typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#storage = storage;
    this.#now = now;
  }

  #getStorage(): Storage | null {
    try {
      return this.#storage();
    } catch (error) {
      throw new ThemeLibraryError('Saved themes are unavailable in this browser.', 'storage', {
        cause: error,
      });
    }
  }

  list(): SavedTheme[] {
    const storage = this.#getStorage();
    if (!storage) return [];
    let source: string | null;
    try {
      source = storage.getItem(STORAGE_KEY);
    } catch (error) {
      throw new ThemeLibraryError('Saved themes are unavailable in this browser.', 'storage', {
        cause: error,
      });
    }
    if (source === null) return [];
    if (serializedBytes(source) > MAX_SERIALIZED_BYTES) {
      throw new ThemeLibraryError(
        'The saved theme library exceeds its safe storage limit.',
        'invalid-store',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch (error) {
      throw new ThemeLibraryError('The saved theme library is corrupt.', 'invalid-store', {
        cause: error,
      });
    }
    const store = objectValue(parsed);
    if (store?.version !== STORAGE_VERSION || !Array.isArray(store.themes)) {
      throw new ThemeLibraryError(
        'The saved theme library uses an unsupported format.',
        'invalid-store',
      );
    }
    if (store.themes.length > MAX_THEMES) {
      throw new ThemeLibraryError(
        'The saved theme library exceeds its safe entry limit.',
        'invalid-store',
      );
    }
    const themes = store.themes.map(parseSavedTheme);
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const theme of themes) {
      const foldedName = theme.name.toLocaleLowerCase('en-US');
      if (ids.has(theme.id) || names.has(foldedName)) {
        throw new ThemeLibraryError(
          'The saved theme library contains duplicate entries.',
          'invalid-store',
        );
      }
      ids.add(theme.id);
      names.add(foldedName);
    }
    return themes
      .map(cloneSavedTheme)
      .sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
  }

  save(nameValue: string, themeValue: SceneTheme): SavedTheme {
    const name = normalizedName(nameValue);
    const theme = normalizedTheme(themeValue);
    const themes = this.list();
    const existingIndex = themes.findIndex(
      (candidate) => candidate.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'),
    );
    if (existingIndex === -1 && themes.length >= MAX_THEMES) {
      throw new ThemeLibraryError(`You can save up to ${MAX_THEMES} themes.`, 'capacity');
    }
    const now = this.#now();
    if (!exactIsoDate(now)) {
      throw new ThemeLibraryError('The browser returned an invalid timestamp.', 'storage');
    }
    const existing = existingIndex >= 0 ? themes[existingIndex] : undefined;
    const updatedAt = existing && now < existing.createdAt ? existing.createdAt : now;
    const saved: SavedTheme = {
      version: 1,
      id: existing?.id ?? uniqueId(name, themes),
      name,
      theme,
      createdAt: existing?.createdAt ?? now,
      updatedAt,
    };
    if (existingIndex >= 0) themes[existingIndex] = saved;
    else themes.push(saved);
    this.#write(themes);
    return cloneSavedTheme(saved);
  }

  delete(id: string): boolean {
    if (!SAFE_ID.test(id)) return false;
    const themes = this.list();
    const next = themes.filter((theme) => theme.id !== id);
    if (next.length === themes.length) return false;
    this.#write(next);
    return true;
  }

  #write(themes: readonly SavedTheme[]): void {
    const storage = this.#getStorage();
    if (!storage) {
      throw new ThemeLibraryError('Saved themes require browser storage.', 'storage');
    }
    const store: ThemeStore = { version: 1, themes: themes.map(cloneSavedTheme) };
    const serialized = JSON.stringify(store);
    if (serializedBytes(serialized) > MAX_SERIALIZED_BYTES) {
      throw new ThemeLibraryError(
        'The saved theme library exceeds its safe storage limit.',
        'capacity',
      );
    }
    try {
      storage.setItem(STORAGE_KEY, serialized);
    } catch (error) {
      throw new ThemeLibraryError(
        'The browser could not persist the saved theme library.',
        'storage',
        {
          cause: error,
        },
      );
    }
  }
}

export const studioThemeLibrary = new ThemeLibrary();
