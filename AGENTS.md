# Scenebook agent guide

This file applies to the entire repository. Read it before changing code, documentation, fixtures,
release metadata, or generated evidence.

## Start here

Scenebook is a TypeScript/Bun monorepo for authoring, verifying, compiling, and publishing portable
product walkthroughs called Scenes. The creator path is local-first. Hosted collaboration and
publication are optional layers and must not change the portable Scene contract.

Before substantial work, read the documents relevant to the task:

- `README.md` and `docs/getting-started.md` for the supported workflows.
- `docs/architecture.md` for ownership boundaries and data flow.
- `docs/reference/scene-format.md` for the portable format.
- `docs/privacy.md` and `SECURITY.md` for capture and publication trust boundaries.
- `docs/studio.md` and `DESIGN.md` for creator-facing UI work.
- `docs/playwright.md` for capture, replay, and evidence work.
- `docs/publishing.md` for Channels, Releases, and static output.
- `CONTRIBUTING.md` and `LICENSE.md` before changing public contracts or moving code between paths.

Do not infer behavior from package names alone. Trace the schema, implementation, tests, and
runtime entry point that actually own the behavior.

## Product invariants

Treat these as non-negotiable unless the user explicitly approves a product-contract change:

- A Scene represents one complete outcome. Steps are meaningful human checkpoints; raw Actions are
  debugging and replay evidence.
- Authored source, executable behavior, captured evidence, review, and publication are separate
  truth layers. Do not silently copy authority from one layer to another.
- An authored `verified` capability is not proof of a passing Run. Only attached evidence from a
  controlled complete Run may be displayed as passing.
- Passwords are never recorded. Sensitive pixels are irreversibly masked before persistence.
  Blur is decorative, not privacy protection.
- Never persist or publish cookies, raw network bodies, auth state, hidden values, personal browser
  state, or unreviewed embedded-document pixels.
- Evidence, Baselines, approvals, and Releases are immutable. Approval promotes one complete
  successful Run, never a mosaic assembled from different attempts.
- Publishing is atomic and reversible. A Channel points to one complete immutable Release.
- AI may propose a diff. It must not silently alter narrative, selectors, checks, baselines, Git,
  approvals, or public output.
- The static compiler output and public viewer must work without a cloud dependency.
- Deterministic hashes, canonical JSON, content-addressed assets, and archive boundaries are public
  contracts. Avoid timestamps, host paths, unstable ordering, and other nondeterminism.

When changing a schema field, define which truth layer owns it. Add validation, inferred types,
canonical YAML/JSON round-trip coverage, backward-compatibility handling, and a migration story.

## Repository map

### Applications

- `apps/studio`: SvelteKit local-first authoring UI. IndexedDB is the default; an explicitly
  connected self-hosted workspace stores bounded working history in PostgreSQL and private payloads
  in S3-compatible storage.
- `apps/extension`: WXT browser recorder. Captures are privacy-filtered and always unverified.
- `apps/example`: deterministic UI used by capture and browser tests.
- `apps/cloud`: self-hosted administrative control-plane process.
- `apps/gateway`: independently deployed publication gateway process.

### Core packages

- `packages/schema`: versioned portable source and immutable evidence schemas.
- `packages/core`: deterministic domain utilities and canonicalization.
- `packages/artifact`: atomic artifact IO and content-addressed storage.
- `packages/privacy`: scanning and irreversible redaction primitives.
- `packages/playwright`: fixtures, Scene API, reporter, recorder, and importer.
- `packages/diff`: functional, visual, semantic, geometry, narrative, and privacy comparison.
- `packages/compiler`: deterministic catalog, standalone, guide, document, image, and motion output.
- `packages/viewer`: accessible framework-neutral walkthrough player.
- `packages/policy`: explainable Channel and Release policy evaluation.
- `packages/server`: self-hosted control plane and collaboration service.
- `packages/gateway`: hardened hosted-publication data plane.
- `packages/cli`: local authoring, verification, build, review, and publication commands.
- `packages/adapters`: bounded documentation-framework and GitHub integrations.

`examples/acme-product` is the deterministic end-to-end fixture. `deploy` owns self-hosting and
published static service configuration. `scripts` owns repository verification and release tooling.

## Toolchain and local startup

Use the versions declared by the repository:

- Bun 1.3.3
- Node.js 22 or newer
- Chromium for capture, replay, and browser verification
- FFmpeg on `PATH` or at `SCENEBOOK_FFMPEG_PATH` for GIF/WebM/MP4 output
- Tesseract, or another explicitly configured local OCR command, before public pixel output

Initial setup:

```bash
bun install --frozen-lockfile
bunx playwright install chromium
```

Run the creator Studio:

```bash
bun run dev
```

Vite serves it on `http://127.0.0.1:5173` by default. Local mode needs no database or `.env`; its
data is browser-local. Export a Scene or Project archive before clearing browser storage.

Important distinctions:

- Root `bun run dev` launches Studio.
- `scenebook dev` serves a compiled Scene catalog for a configured consumer Project; it does not
  launch Studio.
- Studio's Publish screen creates a local export and CLI handoff. It does not upload, approve,
  deploy, run FFmpeg/OCR, or invent a destination.
- `bun run example:seed` starts the deterministic example, captures evidence, and regenerates
  committed reference output. Inspect its diff; do not treat it as a read-only command.

### Fast task orientation

Run the read-only context summary once at the start of a substantial task:

```bash
bun run agent:context
```

It reports the current branch, runtime versions, dirty-path counts by owning area, and the likely
verification gates. Use `bun run agent:context -- --paths` only when the exact path list is useful.
This does not replace the final `git status` and diff audit.

## Implementation conventions

- Use strict TypeScript and ESM. Preserve the root compiler guarantees, especially
  `noUncheckedIndexedAccess`, `noImplicitOverride`, and `verbatimModuleSyntax`.
- Use the existing package boundary that owns the behavior. Do not duplicate schema or domain
  logic in an app for convenience.
- Prefer explicit typed state and deterministic pure functions at contract boundaries.
- Keep public error messages actionable without exposing secrets, credentials, internal object
  keys, host paths, or sensitive payloads.
- Preserve same-origin, CSP, archive validation, content-type, and integrity checks. Security
  checks are product behavior, not optional hardening.
- Use synthetic fixture identities and controlled URLs in all tests and generated evidence.
- A privacy-sensitive change requires a negative canary test proving the raw value never reaches
  storage, output, logs, archives, or upload payloads.
- Do not weaken tests merely to accept a new result. Resolve the ownership or contract mismatch.
- Keep documentation and user-facing copy concise, literal, and honest about what the product has
  and has not verified or performed.

### Working-state storage

- Local mode is the default and uses origin-scoped IndexedDB. Never clear an existing browser
  profile to obtain a clean test state; use a disposable origin/port or explicitly import a
  synthetic fixture.
- Connected mode is opt-in. It stores working Projects, Scenes, and bounded revisions in the
  established PostgreSQL control plane, with private content-addressed payloads in S3/MinIO.
  Connecting does not upload or migrate the existing local workspace.
- Hosted saves use optimistic revision compare-and-swap. Personal API tokens are exchanged for
  short sessions and are not persisted in workspace configuration.
- Extend the established PostgreSQL/S3 ownership path for hosted working state. Do not introduce a
  parallel SQLite/Drizzle source of truth without an explicitly approved architecture change.
- Studio asset routes are not generic artifact downloads: uploads must be Studio-scoped and reads
  must be reachable from saved Studio history. Flatten opaque masks before upload and fail closed
  when attached evidence lacks a clear privacy status.
- For a new self-hosted environment, run
  `cd deploy && ./scripts/init-env.sh https://control.example.com https://stories.example.com`; it
  refuses to overwrite an existing `.env`. Then follow `deploy/SELF_HOSTING.md`.

### Licensing boundaries

The repository has path-based licensing. Apache-2.0 covers the public integration surface and root
tooling. `packages/server`, `packages/gateway`, `apps/cloud`, `apps/gateway`, `apps/extension`,
`apps/studio`, and `deploy` are AGPL-3.0-only. Fixture apps are unlicensed. Read `LICENSE.md` before
moving code across these boundaries, and preserve package-local license files for public packages.

## UI and UX work

For any UI audit, design, copy, layout, accessibility, responsive, or interaction change, use the
vendored Impeccable skill at `.agents/skills/impeccable/SKILL.md` and follow `DESIGN.md`.

The product should feel like a quiet, precise workbench:

- Give each screen one primary job and at most one persistent primary action.
- Keep walkthrough content or the current decision visually dominant; let the shell recede.
- Use progressive disclosure for advanced evidence and configuration.
- Keep controls at least 40px on desktop and 44px on touch layouts.
- Maintain visible focus, keyboard reachability, correct dialog/drawer focus containment, Escape
  dismissal, inert backgrounds, and focus restoration.
- Provide honest loading, empty, error, success, retry, and permission states.
- Avoid nested cards, metric-card hero grids, decorative gradients, glass effects, uppercase
  eyebrows, tiny metadata, and decoration that competes with content.
- Motion may explain state or spatial change. Respect reduced motion and avoid layout animation.
- Preserve right-to-left behavior, locale metadata, 200% zoom usability, and long-content wrapping.
- At narrow widths, ensure no horizontal page overflow and no clipped or overlapping actions.

Run all three Impeccable detector scopes over changed UI files:

```bash
bun run check:ui
```

The command derives changed UI files from Git. Pass explicit paths for a broader audit, for example
`bun run check:ui -- apps/studio/src packages/viewer/src packages/compiler/src`.

Browser-check Studio, extension popup/options, generated compiler pages, the embedded viewer,
operator/recovery pages, example surfaces, and published error/status pages when they are affected.
Verify at representative desktop, mobile, and 320px widths with keyboard navigation, reduced motion,
and the console open. A build or DOM snapshot alone is not sufficient UI verification.

For browser QA, wait for `domcontentloaded` and then assert the specific visible state; this runtime
does not support `networkidle`. Let image-heavy views settle before taking a bounded DOM snapshot.
Do not trust a page-wide media query when testing an embedded viewer: measure the actual host and
stage dimensions.

### Preview and presentation changes

The preview system has several renderers that must agree:

- `apps/studio/src/lib/components/ScenePreview.svelte` owns the Studio preview modes and controls.
- `apps/studio/src/lib/components/PresentationPreview.svelte` owns motion/presentation frames.
- `packages/viewer/src/scenebook-player.ts` owns the framework-neutral embedded player.
- `packages/compiler/src/presentation.ts` owns compiled presentation output.

Trace Scene data, evidence, assets, normalized geometry, copy, and controls through every affected
renderer before editing. Embedded responsiveness must follow the component's container, not only the
outer page viewport. Test screenshot steps plus image-free choice/end steps, missing or broken
assets, long translated copy, overlay collisions, mobile controls, and reduced motion. A preview fix
is incomplete if Studio looks correct while the viewer or compiler output still diverges.

## Testing and verification

Use targeted tests while iterating, then widen verification in proportion to the change.

Common targeted commands:

```bash
bun run --cwd <workspace> check
bun run --cwd <workspace> test
bun run --cwd apps/extension test:e2e
bun run example:test
```

Baseline repository gates:

```bash
bun run format:check
bun run check
bun run test
bun run build
git diff --check
```

Before a broad handoff or release-sensitive delivery, run:

```bash
bun run release:verify
```

This validates formatting, types, tests, builds, CSP, package contents, clean consumer installs,
runtime imports, CLI behavior, and source rebuildability. Run the real backend integration gate for
changes to migrations, storage, uploads, approvals, provenance, promotion, server/gateway auth, or
publication policy. It requires explicitly configured disposable PostgreSQL and policy-restricted
MinIO services; use the exact environment contract in `CONTRIBUTING.md`.

Use these recurring verification paths instead of rediscovering them:

- Studio-only UI: targeted Studio check/tests, `bun run check:ui`, and real browser QA.
- Viewer/compiler/portable output: targeted package tests, a Changeset when public behavior changes,
  baseline gates, and `bun run release:verify`.
- Hosted persistence, migrations, object access, auth, or publication: targeted tests,
  `bun run test:integration:backend` with disposable services, and `bun run release:verify`.
- ACME fixture/replay: `bun run example:test`. Run `bun run example:seed` only when regeneration is
  intended, then inspect every generated evidence diff.

For frontend work, also verify:

- No page, console, request, or subresource errors.
- No horizontal overflow at desktop, common mobile widths, or 320px.
- Keyboard order, focus trap/restoration, Escape behavior, and touch target size.
- Loading, empty, error, retry, offline/permission, and duplicate-submit behavior.
- Large collections and evidence sets do not create unbounded DOM, image, or request storms.
- LTR and RTL output, contrast-derived themes, reduced motion, and autoplay opt-in semantics.

## Release and Git discipline

- Treat pre-existing modified or untracked files as user-owned. Inspect first and never reset,
  overwrite, stage, or publish unrelated work.
- Keep changes focused. Add or update tests with the implementation.
- Add a Changeset for changes affecting public packages:

  ```bash
  bun changeset
  bun run changeset status
  ```

- `bun run release:version` consumes Changesets and rewrites versions, changelogs, manifests, and
  the lockfile. Test it only in a disposable worktree unless versioning is the explicit task.
- Do not run `bun run release:publish`, merge the automated version PR, create a release, or deploy
  without explicit user authorization.
- Never commit real credentials, customer screenshots, production URLs, personal authentication
  state, private Scene archives, or generated evidence containing non-synthetic personal/payment
  data.
- Before committing, inspect `git status`, `git diff`, staged scope, and `git diff --check`.
- After pushing, wait for the exact commit's CI, Scenebook journeys, backend integration, and any
  triggered package-version workflow. A successful push is not proof of a successful delivery.

## Recurring request language

- “Whole app”, “all screens”, or “everything” means inventory the applicable routes and generated
  surfaces first, then report a route-by-route desktop/mobile/320px QA matrix; do not sample only the
  easiest screen.
- “Deep dive”, “fix”, or “make it good” means trace the shared owning layer, implement the systemic
  fix, and verify it. Stop at an audit only when the user asked for review or planning.
- “Production-ready” or “take no shortcuts” includes failure states, privacy/security canaries,
  migrations and compatibility where relevant, docs, a Changeset for public packages, and the broad
  release gate. Do not ship placeholder live capabilities.
- Commit, push, publish, release, and deploy are separate explicit authorities. Without those words,
  leave the completed work uncommitted and report what remains.

## Definition of done

A change is complete only when the requested behavior is implemented across every affected surface,
truth-layer and privacy invariants still hold, relevant targeted and broad gates pass, browser-visible
behavior is verified when applicable, documentation and Changesets are accurate, temporary services
and artifacts are cleaned up, and the final handoff states exactly what was changed, tested, and left
unperformed.
