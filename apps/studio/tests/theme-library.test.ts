import { describe, expect, it } from 'vitest';

import { ThemeLibrary, ThemeLibraryError } from '../src/lib/theme-library';

const theme = {
  accent: '#B83B24',
  paper: '#FBF7EF',
  ink: '#191816',
  radius: 14,
  frame: 'dark' as const,
};

describe('saved theme library', () => {
  it('stores normalized, cloned themes and updates a case-insensitive name in place', () => {
    let now = '2026-07-20T10:00:00.000Z';
    const library = new ThemeLibrary(
      () => localStorage,
      () => now,
    );
    const saved = library.save('  Product   launch  ', theme);

    expect(saved).toMatchObject({
      id: 'product-launch',
      name: 'Product launch',
      theme: { accent: '#b83b24', paper: '#fbf7ef' },
      createdAt: now,
    });
    saved.theme.accent = '#000000';
    expect(library.list()[0]!.theme.accent).toBe('#b83b24');

    now = '2026-07-20T11:00:00.000Z';
    const updated = library.save('product launch', { ...theme, radius: 20 });
    expect(updated.id).toBe('product-launch');
    expect(updated.createdAt).toBe('2026-07-20T10:00:00.000Z');
    expect(updated.updatedAt).toBe(now);
    expect(library.list()).toHaveLength(1);
    expect(library.list()[0]!.theme.radius).toBe(20);
  });

  it('assigns deterministic collision suffixes and deletes exact entries', () => {
    const library = new ThemeLibrary(
      () => localStorage,
      () => '2026-07-20T10:00:00.000Z',
    );
    expect(library.save('Launch!', theme).id).toBe('launch');
    expect(library.save('Launch?', theme).id).toBe('launch-2');
    expect(library.delete('launch')).toBe(true);
    expect(library.delete('launch')).toBe(false);
    expect(library.list().map((entry) => entry.id)).toEqual(['launch-2']);
  });

  it('rejects invalid names and unsafe theme values before persistence', () => {
    const library = new ThemeLibrary(() => localStorage);
    expect(() => library.save('   ', theme)).toThrow(ThemeLibraryError);
    expect(() => library.save('Bad\u0000name', theme)).toThrow(/visible characters/u);
    expect(() => library.save('Bad color', { ...theme, accent: 'red' })).toThrow(
      /six-digit hex colors/u,
    );
    expect(() => library.save('Bad radius', { ...theme, radius: 32.5 })).toThrow(/0–32px/u);
    expect(localStorage.length).toBe(0);
  });

  it('fails closed for corrupt, duplicate, oversized, and unsupported stores', () => {
    const library = new ThemeLibrary(() => localStorage);
    localStorage.setItem('scenebook:themes:v1', '{bad json');
    expect(() => library.list()).toThrow(/corrupt/u);

    localStorage.setItem('scenebook:themes:v1', JSON.stringify({ version: 2, themes: [] }));
    expect(() => library.list()).toThrow(/unsupported/u);

    const entry = {
      version: 1,
      id: 'same',
      name: 'Same',
      theme: { ...theme, accent: '#b83b24', paper: '#fbf7ef' },
      createdAt: '2026-07-20T10:00:00.000Z',
      updatedAt: '2026-07-20T10:00:00.000Z',
    };
    localStorage.setItem(
      'scenebook:themes:v1',
      JSON.stringify({ version: 1, themes: [entry, entry] }),
    );
    expect(() => library.list()).toThrow(/duplicate/u);

    localStorage.setItem('scenebook:themes:v1', ' '.repeat(64 * 1024 + 1));
    expect(() => library.list()).toThrow(/safe storage limit/u);
  });

  it('reports unavailable and quota-failing storage without losing the original cause', () => {
    const unavailable = new ThemeLibrary(() => null);
    expect(unavailable.list()).toEqual([]);
    expect(() => unavailable.save('Launch', theme)).toThrow(/require browser storage/u);
    const blocked = new ThemeLibrary(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
    expect(() => blocked.list()).toThrow(/unavailable in this browser/u);

    const quotaError = new DOMException('Quota exceeded', 'QuotaExceededError');
    const failing = new ThemeLibrary(
      () =>
        ({
          length: 0,
          clear: () => undefined,
          getItem: () => null,
          key: () => null,
          removeItem: () => undefined,
          setItem: () => {
            throw quotaError;
          },
        }) as Storage,
    );
    expect(() => failing.save('Launch', theme)).toThrow(/could not persist/u);
  });
});
