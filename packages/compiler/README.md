# `@scenebook/compiler`

Deterministic multi-format compilation and publication adapters for portable Scenebook Scenes.

## Install

```sh
npm install @scenebook/compiler
```

The main API is exported from `@scenebook/compiler`; format-specific types and helpers are available from `@scenebook/compiler/formats`. The package is ESM-only and requires Node.js 22 or newer. Image rendering uses Sharp.

GIF, WebM, and MP4 exports require an operator-provided FFmpeg executable. Put `ffmpeg` on `PATH` or set `SCENEBOOK_FFMPEG_PATH` to an absolute executable path. Scenebook does not bundle or download FFmpeg. For reproducible CI, pin a reviewed FFmpeg build, provide its immutable path through `SCENEBOOK_FFMPEG_PATH`, and set `SCENEBOOK_FFMPEG_EXPECTED_SHA256` to the reviewed executable digest. The compiler hashes the executable and normalized `ffmpeg -version` output before rendering, records the path-free binding in `manifest.json` and `formats.json`, and verifies it again before atomic promotion. Motion formats are therefore explicitly toolchain-bound; built-in formats remain self-contained.

Compiled JavaScript, declarations, and the corresponding TypeScript source are included.

Standalone HTML and generated Web Components bundle the exact `@scenebook/viewer` implementation,
so keyboard guards, transcript/deep links, reduced-motion behavior, branches, multiple CTAs, form
submission, and composed host events stay aligned with the canonical player. Generated Web
Components auto-mount an empty `<scenebook-player>`; use `data-scene="<scene-id>"` when more than one
generated Scene module shares a document, or call the exported `mountScenebookPlayer(element)`
helper explicitly.

## License

Apache-2.0. See `LICENSE` in this package for the complete terms.
