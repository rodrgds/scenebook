# Studio

Studio is the creator-facing, local-first editor. Its default tabs are Edit, Preview, Health, Versions, and Publish; execution details stay under Health.

## Local data and recovery

Scenes and projects are stored in the browser's IndexedDB. Unsaved edits also enter a small local recovery journal. Studio does not upload either store. Export a portable Scene or project archive before clearing site data or moving browsers.

Every save is compare-and-swapped against the revision the editor loaded. If another tab saves first, Studio rejects the stale write, preserves it in crash recovery, and asks the author to reload; immutable revision-history keys are never overwritten.

Imports validate the versioned schema, archive paths, entry counts, expanded size, media type, and content hashes. Conflicts can be renamed, replaced, or skipped explicitly. Referenced narrative, theme, locale, and replay sidecars are required in ZIP imports, retained byte-for-byte in JSON-portable browser storage, and restored on ZIP re-export; extension replay drafts receive the same treatment. Re-export also preserves checks, automation metadata, and assets that Studio does not edit.

Studio projects editable values from imported theme and locale sidecars, then writes authored theme
overrides, translations, and all end-card actions into the canonical Scene schema. Inline edits take
precedence over retained sidecars at compile time. Stable CTA IDs, multiple primary/secondary
actions, and imported choice/CTA translation bindings survive re-export without depending on
Studio-private metadata; the private mirror remains only for older Studio readers.

If imported source references an HTTP image, export first fetches it without cookies, authorization,
or a referrer, streams it through the 25 MB media/integrity gate, and bundles it by content hash.
Both YAML and ZIP export fail with the affected Step when CORS, availability, size, or content
validation prevents a genuinely self-contained artifact.

An authored `verified` capability is a source contract, not a passing Run. Studio displays source capability separately and only shows a passing result when actual Run evidence is attached.

## Publishing handoff

Publish is a local handoff, not a hosted control surface. Studio exports canonical Scene YAML or a
self-contained `.scene.zip` in the browser and shows the exact CLI workflow for the selected
Project/Channel. It does not run FFmpeg, OCR, or the repository compiler in the browser, and it does
not upload, promote, deploy, or invent an external destination.

After placing the exported Scene in the configured `scenes/` path, run the production pipeline from
the Project repository:

```bash
bunx --bun @scenebook/cli@0.1.0 privacy scan --provider tesseract
bunx --bun @scenebook/cli@0.1.0 dev --channel <channel> --port 6100
bunx --bun @scenebook/cli@0.1.0 build --channel <channel>
bunx --bun @scenebook/cli@0.1.0 publish --channel <channel> \
  --destination public/scenebook
```

The compiler, not Studio, produces the catalog, standalone HTML, Web Component, iframe, Markdown,
MDX, HTML guide, PDF, MP4, WebM, GIF, README card, Open Graph image, social carousel, public remix
source, manifest, and evidence. Its output visibility still comes from each Step's authored
interactive, guide, motion, and social recipe.

Deploy the complete finalized directory to an independent static origin or CDN. The administrative
control plane must never serve the generated active pages or scripts. Optional GitHub OIDC upload
can ingest the deterministic archive and evidence with a short-lived token, but it does not deploy
the static site. See [Publishing](./publishing.md) for public URLs, SEO, analytics, share links,
remix safety, and promotion boundaries.

## Editing model

The thumbnail rail owns Step order. The canvas owns crop, focal point, hotspot, annotations, cursor, and masks. The inspector owns narrative, timing, frame, branches, CTAs, accessibility text, and output visibility.

- Drag to reorder; duplicate, split, merge, or delete from the Step menu.
- Use undo/redo before and after structural edits.
- Add an intro, separator, screen, choice, or end Step.
- Use opaque masks for secrets, authentication, payments, or personal data. Blur is available only
  for manual, custom-classified presentation regions; public derivatives rasterize it, while the
  live editor preview remains reversible and must never be treated as privacy protection.
- Save validated color, radius, and frame presets from Appearance to reuse a theme across Scenes.
  Presets remain in this browser, are bounded to 50 entries, and never contain Scene media.
- Keep executable Scenes linear. A choice links to another linear Scene and cycles are rejected.
- Preview interactive, guide, motion, social, and common aspect-ratio projections before export.

## Source ownership

Studio edits authored presentation. It does not silently change a Playwright action, selector, check, baseline, or public Release. Importing a verified Scene retains its portable source so a caption or theme edit does not discard the execution contract.

Use Versions for local revision history and explicit recovery. Use Health for capability state, freshness, privacy, and proposed changes. A Captured Scene remains labeled Captured until a controlled complete Run is approved.
