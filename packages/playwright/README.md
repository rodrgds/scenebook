# `@scenebook/playwright`

Playwright fixtures, Scene capture APIs, reporter integration, and existing-test import for Scenebook.

## Install

```sh
npm install --save-dev @scenebook/playwright @playwright/test
```

The fixture API is exported from `@scenebook/playwright`. Reporter and importer entry points are available from `@scenebook/playwright/reporter` and `@scenebook/playwright/importer`. The package is ESM-only and requires Node.js 22 or newer.

Compiled JavaScript, declarations, and the corresponding TypeScript source are included.

## Evidence lifecycle

The reporter aggregates retries and repeats into one Run per Scene/Target, fingerprints decoded screenshot pixels, compares the final attempt with the approved Baseline, and writes exact Run, Review, Build, and GitHub check artifacts. A Run without exact screenshot privacy attestation is blocked; a clear first run is changed until a Baseline is approved; only matching evidence is passed.

Ordinary unmodified tests are supported without fabricated Scene structure. The CLI wrapper forces a final screenshot and retains failure traces, while the reporter persists supported screenshot, trace ZIP, and configured WebM video attachments as content-addressed private evidence. Generic screenshots remain privacy-unknown until scanned, and traces/videos are debugging attachments rather than public or Baseline truth.

Playwright shards write partial fragments under `.scenebook/runs/shards/<current>-of-<total>/build.json`. Finalize an exact set with `scenebook ci merge-shards`; missing, duplicate, provenance-mismatched, or overlapping shards fail closed.

## License

Apache-2.0. See `LICENSE` in this package for the complete terms.
