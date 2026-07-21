# Getting started

Scenebook can start from a browser recording, existing screenshots, or an existing Playwright test. All three paths produce the same portable Scene directory.

## Requirements

- Bun 1.3.3
- Node.js 22 or newer
- Chromium for capture and verification
- FFmpeg on `PATH`, or at the absolute `SCENEBOOK_FFMPEG_PATH`, for GIF/WebM/MP4 output
- Tesseract, or another configured local OCR command, before public pixel output

Scenebook never downloads an encoder. In reproducible CI, pin a reviewed FFmpeg build and set
`SCENEBOOK_FFMPEG_EXPECTED_SHA256` to its 64-character digest. Motion manifests record the exact
path-free binary and version-output hashes and compilation aborts if the toolchain changes before
promotion.

Install and verify the repository:

```bash
bun install --frozen-lockfile
bunx playwright install chromium
bun run check
bun run test
bun run build
```

## Create a project

From an application repository:

```bash
bunx @scenebook/cli init
bunx @scenebook/cli doctor
```

`init` detects a Playwright config, creates `scenebook.config.ts`, and creates the `scenes/` source directory. In an interactive terminal it offers the detected test files so you can create a source-linked first Scene immediately. For automation, `init --yes` imports the sole detected file, while `init --import tests/example.spec.ts [--test "literal title"]` makes the choice explicit; multiple files are never guessed. Keep the generated sources in version control. `init` intentionally leaves verification targets empty because it cannot safely guess which deployment Playwright may mutate. This does not block importing, recording, editing, building, or publishing Scenes.

Before `scenebook test` or `scenebook ci`, edit the inline `project` in `scenebook.config.ts` (or the Project YAML referenced by `project`) and add all four reviewed records:

- an Environment whose `baseUrl` is the exact controlled application URL and whose `allowMutations` decision is explicit;
- a Product Variant describing the fixture role/plan under test;
- a Capture Profile with the browser and viewport contract;
- an enabled Run Target referencing those three IDs.

[`examples/acme-product/project.yaml`](../examples/acme-product/project.yaml) is the complete reviewed shape. Copy its structure, not its example URL or fixture identity. Keep `playwright.forbidProductionMutations: true` unless production mutation is an intentional, separately reviewed policy decision. Then run:

```bash
bunx @scenebook/cli doctor
bunx @scenebook/cli test --target <run-target-id>
```

`doctor` lists runnable and policy-blocked targets. A sole enabled target may omit `--target`; multiple enabled targets always require it.

Choose one creation path:

```bash
# Import literal tests and test.step() blocks without rewriting the suite
bunx @scenebook/cli import playwright tests/invite-member.spec.ts

# Record a Playwright codegen draft (then curate semantic Steps)
bunx @scenebook/cli record http://127.0.0.1:3000

# Or install the unpacked browser extension and export a .scene.zip
bun --cwd apps/extension run build
```

The extension uses the active signed-in tab and labels its output Captured. `scenebook record` wraps Playwright codegen and creates a portable draft; it does not invent Step semantics, fixtures, checks, or verification. Curate that source with the rich Scene API and synthetic fixtures before it can become Verified.

To place the compiled catalog in an existing documentation site, install one of the bounded first-party adapters without overwriting framework files:

```bash
bunx @scenebook/cli docs install --adapter vitepress --base-path /docs --destination website --dry-run
bunx @scenebook/cli docs install --adapter vitepress --base-path /docs --destination website
```

The same command supports `fumadocs`, `docusaurus`, `starlight`, `nextra`, `mintlify`, and `github-pages`. A conflicting existing file aborts the complete preflight so you can merge it deliberately.

The controlled recorder writes three private files under the Scene’s `automation/` directory:

- `replay.ts` contains only sanitized URL and input fixture references.
- `recording-review.json` binds the persisted replay SHA-256 and reports suggested semantic Step boundaries, brittle locator patterns, missing outcome checks, timing/dynamic-flow hazards, and the exact files changed by the command.
- `recording-review.patch` is a project-relative, zero-context Git patch that proposes `test.step()` wrappers. It contains no source context, URL, entered value, locator text, or secret, and Scenebook never applies it automatically.

Review findings use source coordinates and controlled method names rather than copying application text. The JSON includes the patch precondition/result hashes and byte offsets, so a changed replay invalidates the proposal instead of silently applying stale advice. Recorder output must remain inside the current project, and existing symlink parents or artifact targets are rejected.

The packaged recorder’s **Open in Studio** handoff downloads the portable archive and opens
Studio’s real import dialog. Its default is the self-hosted Compose address,
`http://127.0.0.1:8080/`. Open **Studio connection** in the recorder popup to select another
loopback development port or an HTTPS-hosted Studio. URLs containing credentials, query strings,
fragments, or non-loopback plain HTTP are rejected; the archive is never uploaded implicitly.

## Edit locally

Start Studio from this repository with `bun run dev`, or build and serve the catalog with:

```bash
bunx @scenebook/cli dev --port 6100 --allow-unscanned-privacy
```

These are distinct surfaces: the repository command launches the creator Studio, while `scenebook dev` watches Scene sources and serves only the compiled static catalog.

The privacy override is only for local authoring. It is recorded in generated evidence and must not be used for a public release.

## Configure public distribution

Projects default to `noindex,nofollow`, attribution enabled, public remix source enabled, and no
analytics. Keep those defaults until a real static destination and Release exist:

```yaml
public:
  seo:
    index: false
    follow: false
  attribution: true
  remix: true
```

A Channel can partially override those settings under its own `public` key. Add a reviewed
`baseUrl`/`customDomain` only when it matches the final publication origin; add analytics only when
the exact HTTPS public Channel endpoint, current `releaseId`, and public-scoped build-time
`tokenEnv` are available. See [Publishing](./publishing.md#public-distribution-settings) for the
complete typed shape. The reference Project keeps the non-indexing defaults intentionally and does
not advertise a placeholder hosted destination.

## Scan and publish

Publication fails closed when pixel privacy has not been assessed:

```bash
bunx @scenebook/cli privacy scan --provider tesseract
bunx @scenebook/cli build --channel public
bunx @scenebook/cli publish --channel public --destination public/scenebook
```

`publish` renders in a sibling staging directory, validates the complete result, and changes the destination atomically. A failed build leaves the previous publication intact.

Deploy the entire `public/scenebook` directory to an independent static origin or CDN. This
filesystem publication does not upload to a provider, and the administrative control plane never
serves its active HTML, JavaScript, CSS, or SVG. Verify the deployed `manifest.json` and its
referenced hashes before promoting a hosted Channel. Catalog builds also include privacy-flattened,
integrity-bound remix ZIPs when the resolved public policy has `remix: true`.

Projects with Collections publish grouped catalogs by default. Use `--channel <id-or-slug>` on `build`, `export`, `dev`, or `publish` to publish only that Channel's ordered Collections, or `--collection <id-or-slug>` to select one Collection. Both flags together select that Collection within the Channel.

## Verify in GitHub Actions

The reusable Action installs Node.js 24.18.0 and Bun 1.3.3 itself, prefers a repository-local Scenebook binary, and otherwise runs the exact `version` input with Bun. It runs local verification by default and needs only `contents: read`. Set its `target` input when the Project has multiple enabled Run Targets. It always retains a privacy-filtered, static visual-review artifact after the run—including failed runs—but never copies screenshot pixels without clear Run, selected-attempt, and State privacy attestations. This GitHub artifact is distinct from hosted evidence upload; no evidence reaches a Scenebook server unless the Action input `upload: 'true'` is present.

Real GitHub Check Runs are also explicit: set `post-checks: 'true'`, pass `github-token: ${{ github.token }}`, and grant the job `checks: write`. Fork pull requests and `pull_request_target` are skipped before token use. The final Action result retains the original verification exit code after report and upload steps complete.

Hosted evidence upload additionally requires the calling job to grant `id-token: write` and provide the HTTPS server URL plus Workspace and Project IDs. Those values are identifiers, not secrets; do not add an admin token or long-lived upload credential. GitHub OIDC gives the job a short-lived token bound to its exact repository, workflow, ref, and commit. The upload starts only after replay, Build, provenance, and local OCR privacy gates pass. It uploads a deterministic archive and evidence for control-plane review; it does not deploy the static release. The control plane streams archive members only for integrity verification, never retains expanded active content, and never serves it. See [Playwright integration](./playwright.md#baselines-and-ci) for complete local and hosted workflow examples.

Hosted mode attests the checkout's exact Git `HEAD` against signed `GITHUB_SHA` before replay and
again before upload, so a changed checkout or mismatched pull-request merge commit fails locally.

See [Studio](./studio.md), [Playwright](./playwright.md), [Publishing](./publishing.md), and [Privacy](./privacy.md) for the production workflows.
