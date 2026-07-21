# `@scenebook/cli`

Scenebook compiles local Scene sources into sanitized publication derivatives and verifies product journeys with Playwright.

## Install

```sh
npm install --save-dev @scenebook/cli
```

The package is ESM-only and requires Node.js 22 or newer. It includes the `scenebook` executable, declarations, and the corresponding TypeScript source.

`scenebook docs install --adapter <framework>` wires the generated catalog into Fumadocs, Docusaurus, VitePress, Starlight, Nextra, Mintlify, or GitHub Pages. Use `--base-path`, `--destination`, and `--dry-run` to preview an exact project-contained plan. The installer rejects link traversal and conflicting files instead of silently rewriting a documentation application.

GIF, WebM, and MP4 output requires an operator-installed FFmpeg. Put `ffmpeg` on `PATH` or set `SCENEBOOK_FFMPEG_PATH` to an absolute executable path. Reproducible CI should also set `SCENEBOOK_FFMPEG_EXPECTED_SHA256` to the reviewed binary digest. The compiler records and re-verifies the path-free toolchain binding; `scenebook doctor` validates the selected executable, and the CLI never downloads an encoder.

## Publication privacy

Publication fails closed until OCR assessments exist for the exact post-crop, post-mask derivative hashes that the compiler will ship. Raw captures stay inside the Scene source and are never copied into public output.

Use the local Tesseract provider:

```sh
scenebook privacy scan --provider tesseract
scenebook build --channel public --build .scenebook/runs/build.json
```

If Tesseract is unavailable, use a local command without invoking a shell. The command is a JSON argument array; `{input}` is replaced with the sanitized derivative path and `{hash}` with its SHA-256:

```sh
scenebook privacy scan \
  --provider command \
  --command-json '["my-ocr","--input","{input}"]' \
  --scanner-id my-ocr \
  --scanner-version 2.4.1
```

Assessments are written atomically to `.scenebook/privacy/<derivative-sha256>.json` with OCR engine and Scenebook scanner provenance. A missing engine, non-zero provider exit, stale hash, malformed response, or detected blocking data fails explicitly; none is treated as clear. Sensitive publication masks (`email`, `token`, `payment`, authentication, and personal data) must be irreversible `opaque` masks. `--allow-unscanned-privacy` is an explicit local override recorded in build evidence, not a production scanning workflow.

By default `privacy scan` stages the same configured output-format set as a normal build, including exact launch rasters and every unique motion/PDF presentation frame. If `--format` narrows the scan, a later build with additional formats remains fail-closed until their additional hashes are assessed.

Run screenshot evidence has a separate exact attestation path:

```sh
scenebook privacy scan --run .scenebook/runs/runs/<run-id>.json --provider tesseract
```

The provider receives a private copy whose hash is rechecked after OCR. The CLI scans structured evidence, persists only redacted findings, recomputes the Baseline diff and Review, and atomically rebinds all affected Run and Build hashes/summaries. `scenebook ci` performs this attestation automatically unless an explicit local-only `--allow-unscanned-privacy` override is used.

`scenebook baseline accept` validates every selected screenshot's path, media signature, byte length, and SHA-256, rejects symlinks and path escape, and copies deduplicated content-addressed assets under the baseline root. It writes an immutable Baseline object, advances an active pointer, and records visual approval as a separate exact-hash attestation. Use `scenebook baseline migrate --actor <id> --yes` to bind legacy descriptors to their exact retained Runs.

For sharded CI, run Playwright with `-- --shard=<current>/<total>` and retain each `.scenebook/runs/shards/<current>-of-<total>` directory. `scenebook ci merge-shards` creates the only final Build and rejects incomplete, duplicate, mixed-provenance, or overlapping shard sets.

## Publication selection

`build`, `export`, and `dev` accept `--channel <id-or-slug>` and `--collection <id-or-slug>`. A Channel selects its ordered Collections; a Collection selects its ordered entries; both flags narrow the Channel to that Collection and require membership. Without selectors, the catalog follows all project Collections and adds an explicit ungrouped section.

Exact IDs win over slugs. Missing Scene entries fail closed. If a Scene appears repeatedly, its first Collection/entry occurrence owns its catalog placement. The resolved selection, ordered IDs, grouping policy, and Channel policy are written to `manifest.json` and every Scene's `evidence.json`.

`build --channel` additionally requires a finalized exact Build (default `.scenebook/runs/build.json`) and seals a self-contained candidate: compiled tree, deterministic archive/inventory, and canonical Build/Run/Review copies. `approve editorial` and `approve release` create immutable attestations for its printed hash. `publish --channel --candidate --destination --actor --yes` verifies and promotes only those bytes; it never invokes the compiler. `rollback --channel --actor --yes` restores the predecessor through a new immutable publication event and atomic Channel pointer.

## Output safety

Build and promotion destinations are replaced atomically and therefore must be dedicated output directories. `build`, `export`, `dev`, and `publish` reject protected configuration, evidence, Baseline, cache, candidate, or pointer storage. Use a sibling such as `scenebook-dist`; never point `--output` or `--destination` at `.` or `.scenebook`.

## Controlled recorder review

`scenebook record <url> --output scenes/name.scene/automation/replay.ts` runs Playwright codegen in an isolated profile and strips navigation targets and every entered scalar into explicit `SCENEBOOK_URL_*` and `SCENEBOOK_INPUT_*` fixtures before source reaches a regular file. Recorder output is project-contained; parent-directory symlinks, artifact symlinks, non-regular targets, private-looking filenames, and loose files outside a portable `*.scene` directory fail before capture.

Every successful recording also writes `automation/recording-review.json` and `automation/recording-review.patch`. The deterministic JSON binds the exact persisted replay hash and byte length, fixture contract, suggested Step ranges, locator-quality findings, missing assertions, fixed/dynamic wait hazards, and create/replace/unchanged file impact. Findings carry coordinates and controlled method names only—never URLs, entered values, source snippets, locator text, or secrets.

The patch uses project-relative, zero-context insertion hunks to propose generic `test.step()` boundaries without reproducing surrounding source. Its precondition hash, proposed result hash, exact UTF-8 byte-offset edits, byte length, and patch hash are recorded in the JSON. It is review material, not executable truth: the CLI marks it unapplied and never mutates the replay from a suggestion. Re-record after any replay change; the stored precondition intentionally makes the old proposal stale.

## Playwright target safety

`scenebook test` and `scenebook ci` execute exactly one enabled Project Run Target. They infer it only when there is one enabled target; otherwise use `--target <id>`. Before starting Playwright, the CLI rejects unknown or disabled targets, Environments with `allowMutations: false`, and production Environments while `playwright.forbidProductionMutations` is enabled. Production execution additionally requires HTTPS.

`scenebook init` can create a source-linked first Scene from an interactively selected Playwright file. Use `--yes` only when exactly one file is detected, or `--import <path> [--test <literal-title-or-id>]` for an explicit non-interactive choice; it refuses to guess among multiple files. Init still does not invent an Environment URL or mutation policy. Add an Environment, Product Variant, Capture Profile, and Run Target to the generated inline Project (or a referenced Project sidecar) before verification. `scenebook doctor` reports whether any target is runnable; ordinary authoring and publication commands do not require a Run Target.

The selected Project, Run Target, Environment, Product Variant, Capture Profile, and canonical Environment `baseUrl` are bound into the child process. A generated safety config checks global and per-project Playwright `baseURL` values, prevents remote targets from starting a local `webServer`, and then forces the selected URL. The CLI runs a line reporter for actionable failures alongside the mandatory Scenebook evidence reporter. Ad-hoc `--base-url`, `--config`, `--project`, and `--reporter` overrides are rejected; configure those declaratively instead.

## License

Apache-2.0. See `LICENSE` in this package for the complete terms.
