# Scenebook

**Interactive product demos that don’t go stale.**

Scenebook is a local-first, open-source studio for product stories. Capture a real browser workflow, shape it into a polished walkthrough, guide, video, or docs embed, and connect Playwright when the journey needs continuous verification.

The portable Scene is yours: ordinary YAML, MDX, Playwright, and content-addressed media that can live beside the product in Git. Local capture, editing, review, and static publishing do not require a Scenebook account or service.

## What is included

- Privacy-first Chrome MV3 recorder with portable `.scene.zip` export, plus isolated Playwright codegen with pre-persistence fixture replacement, deterministic diagnostics, and an unapplied exact Step patch
- Creator-focused Studio with catalog, visual Step editor, preview, health, version, and publishing views; browser-local by default with an explicit self-hosted workspace mode
- Accessible, responsive `<scenebook-player>` web component with keyboard navigation, transcript, branching, CTAs, and host events
- Versioned Zod + JSON/YAML Scene, Project, Run, Review, Baseline, Channel, and Release schemas
- Content-addressed immutable asset storage, safe path handling, canonical serialization, and atomic release writes
- Playwright fixture, Step capture API, reporter, existing-test importer, local CI, and optional OIDC-bound hosted evidence upload (not static hosting)
- Functional, visual, semantic, geometry, narrative, and privacy change classification
- GitHub App source builds and failed-run visual-review artifacts with fail-closed screenshot privacy, leased workers, immutable build/review identity, and App-owned exact-SHA Check Runs
- Static catalog, standalone player, iframe/web-component, Markdown, MDX, HTML, PDF, GIF, WebM, MP4, README, OG, social, privacy-flattened remix source, evidence, and CI renderers
- CLI workflows for initialization, authoring, importing, verification, review, baselines, publishing, migration, and diagnostics
- Optional self-hosted control plane for workspaces, RBAC and PATs, private portals, evidence, baselines, approvals, immutable releases and rollback, schedules, private runners, GitHub App builds, custom domains, analytics, audit, retention, and bounded workspace export
- Separate least-privilege publication gateway with revocable audience grants, one-time login handoff, bounded archive extraction, and Ed25519 identity-key rollover
- A deterministic reference product and verified Scene under [`examples/acme-product`](./examples/acme-product)

Scenebook deliberately does not clone application HTML, retain passwords or raw network bodies, silently repair selectors, mutate baselines, or require an LLM for core behavior.

## Develop locally

Requirements: Bun 1.3+, Node.js 22+, and a current Chromium installation. GIF, WebM, and MP4 exports additionally require a system FFmpeg executable. Put a reviewed FFmpeg build on `PATH` or set `SCENEBOOK_FFMPEG_PATH` to its absolute path; reproducible CI should pin `SCENEBOOK_FFMPEG_EXPECTED_SHA256` as well. Scenebook never downloads an encoder, and motion manifests bind the exact binary and version output without exposing its host path.

```bash
bun install
bun run example:seed
bun run build
bun run test
bun run dev
```

The Studio is served locally and the reference product lives in [`apps/example`](./apps/example). `example:seed` starts that deterministic product, captures real browser evidence, irreversibly masks the example email field, and regenerates the content-addressed reference Scene.

The packaged command is `scenebook`:

```bash
scenebook init
scenebook dev
scenebook import playwright
scenebook build
scenebook export --format pdf --format mp4
scenebook test --target <run-target-id>
scenebook review
scenebook build --channel <channel> --build .scenebook/runs/build.json
scenebook approve release --channel <channel> --actor <id> --yes
scenebook publish --channel <channel> --destination <directory> --actor <id> --yes
```

`bun run dev` at this repository root launches the creator Studio. `scenebook dev` is intentionally the lightweight compiler catalog server for a configured project; it does not claim to launch the Studio.

Run `scenebook help <command>` for flags, non-interactive behavior, and exit-code semantics.

Production output is a complete static directory for any independent origin or CDN. Self-hosters
can also run the first-party publication gateway, which serves the exact immutable archive selected
by the current Channel on a distinct origin. The administrative control plane may ingest and verify
that archive through explicit GitHub OIDC, but it never serves generated active pages. Public
projects default to `noindex,nofollow` and no analytics; see [Publishing](./docs/publishing.md) before
enabling canonical URLs, indexing, public lifecycle analytics, or remix downloads.

The self-host deployment uses PostgreSQL for tenant metadata, hosted Studio drafts, optimistic
revision history, evidence, and Release pointers. Media is immutable and content-addressed in an
S3-compatible store; the bundled Compose stack provisions MinIO with separate write, read-only
gateway, and delete-only retention identities. SQLite is intentionally not the hosted default: the
control plane needs concurrent multi-user compare-and-swap writes, advisory locks, append-only
evidence guards, and a separate least-privilege gateway process. Local Studio use still needs none
of these services.

## The three truth layers

1. **Authored Scene source** owns order, captions, crops, hotspots, redaction, themes, localization, branch links, and output presentation.
2. **Optional Playwright contract** owns controlled authentication, fixtures, actions, assertions, setup, and cleanup.
3. **Immutable Run and Release artifacts** own exact evidence, privacy results, review decisions, commit provenance, and published checksums.

A creator can publish a **Captured** Scene immediately. A **Monitored** Scene checks routes, targets, and likely drift. A **Verified** Scene has maintained Playwright checks and an approved complete-run baseline. The UI never labels an extension-only capture as verified.

## Repository map

```text
apps/
  studio/       local creator workbench
  extension/    no-account Chromium recorder
  example/      deterministic fixture product
  cloud/        hosted control-plane entrypoint
  gateway/      isolated publication data-plane entrypoint
packages/
  adapters/     safe documentation and GitHub payload adapters
  schema/       portable source and immutable artifact contracts
  core/         canonical IDs, paths, Scene graph, and release rules
  artifact/     content-addressed storage and atomic persistence
  privacy/      text/semantic privacy gate and irreversible redaction
  diff/         multi-dimensional change classification
  playwright/   fixture, reporter, capture, and importer
  compiler/     deterministic multi-format publishing
  viewer/       framework-neutral public player
  cli/          end-to-end command surface
  policy/       explainable Channel and Release policy evaluation
  server/       AGPL self-hosted control-plane components
  gateway/      least-privilege immutable publication gateway
```

Start with [Getting started](./docs/getting-started.md), then read [Studio](./docs/studio.md), [Playwright integration](./docs/playwright.md), [Publishing](./docs/publishing.md), [Architecture](./docs/architecture.md), [Privacy and threat model](./docs/privacy.md), and the [portable Scene format](./docs/reference/scene-format.md).

Self-hosters should follow the recovery-aware [deployment runbook](./deploy/SELF_HOSTING.md).

## Licensing

The Apache-2.0 integration surface covers the schema, protocol, Playwright adapter, viewer, and renderer SDK. Studio and hosted-capable collaboration/publication services are licensed under AGPL-3.0-only; commercial licensing requires a separate agreement. See [LICENSE.md](./LICENSE.md) for the exact source boundaries and third-party notices. This split is a product decision, not legal advice, and does not represent that counsel has reviewed the project.

## Package releases

Public packages are versioned with Changesets and packed only with the repository-pinned Bun 1.3.3. The local release gate verifies every tarball's full license, README, TypeScript source, export metadata, rewritten workspace dependencies, and dependency order; it then clean-installs all tarballs together with both npm and Bun, imports every public entry point, exercises `scenebook --help`, and rebuilds the packed AGPL server from source.

```sh
bun changeset
bun run release:verify
```

Before the first public release, the repository owner must add real `repository`, `homepage`, and `bugs` fields to the root `package.json`, then run `bun run release:metadata:write`. Placeholders, non-HTTPS URLs, and fabricated repository coordinates are rejected. The protected `npm-production` GitHub environment is the only publication path; it requires the exact manual confirmation `PUBLISH`, GitHub OIDC trusted publishing, provenance, and an owner-reviewed Changesets version commit. Long-lived npm tokens are rejected.

## Security

Please report vulnerabilities through a private GitHub Security Advisory rather than a public issue. See [SECURITY.md](./SECURITY.md) for the trust boundaries and disclosure process.
