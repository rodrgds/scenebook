import type {
  LoadedScene,
  NormalizedScene,
  PublicationPlan,
  PublicationPrivacyProjection,
} from './types.js';

/**
 * The exact normalized text-bearing model used by publication renderers, plus authored text
 * sidecars that remain part of the portable source. Raw capture bytes are deliberately absent.
 */
export function publicationPrivacyProjection(
  loaded: LoadedScene,
  normalized: NormalizedScene,
  catalog: PublicationPlan,
): PublicationPrivacyProjection {
  const localeNames = new Set([
    ...Object.keys(loaded.locales),
    ...Object.keys(loaded.scene.translations),
  ]);
  const locales = Object.fromEntries(
    [...localeNames].sort().map((locale) => [
      locale,
      {
        ...(loaded.locales[locale] !== undefined ? { sidecar: loaded.locales[locale] } : {}),
        ...(loaded.scene.translations[locale] !== undefined
          ? { inline: loaded.scene.translations[locale] }
          : {}),
      },
    ]),
  );
  return {
    format: 'scenebook-publication-text',
    version: 1,
    catalog,
    normalized,
    ...(loaded.narrative ? { narrative: loaded.narrative } : {}),
    locales,
  };
}
