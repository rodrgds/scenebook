# Privacy and threat model

Screenshots are high-risk product data. Scenebook therefore treats privacy as a capture constraint, not a warning added after export.

## Defaults

- Runs, editing, diffing, and builds stay local unless the user explicitly selects a hosted action.
- Password values are never read or serialized.
- Recorder events omit typed values; fixture references replace values in executable Actions.
- `input[type=password]`, token/credential fields, payment fields, common personal-data fields, and `[data-scenebook-redact]` are masked with opaque pixels before screenshot bytes enter persistence.
- `iframe`, `object`, and `embed` surfaces are opaque privacy boundaries and are masked in full; the recorder never persists unaudited embedded-document pixels.
- Full DOM, cookies, request/response bodies, auth state, and hidden values are absent from the artifact.
- Semantic evidence is limited to selected visible text, accessible role/name, target geometry, and configured checks.
- Browser-extension captures remain Captured/unverified until controlled replay succeeds and a complete baseline is approved.

## Publication gate

The gate scans authored strings, semantic evidence, captions, routes, and OCR text when an OCR provider is configured. Findings carry category, confidence, severity, exact provenance, and a deterministic fingerprint. High-confidence secret, private-key, authentication, or payment findings block and quarantine publication.

An override is explicit, local to one finding/revision/destination, attributed, and recorded in release evidence. It never changes the underlying scanner result.

## Irreversible and decorative masking

Automatic and policy-sensitive masks are opaque. They cannot be downgraded to blur because blur is reversible in principle and can leave recognizable data. Authors may use blur as a purely presentational annotation only for content that has already passed policy.

## Storage isolation

- Asset hashes never imply global deduplication; bytes are deduplicated only inside one workspace.
- Object keys include tenant/workspace and release staging scope.
- Signed URLs are short-lived and authorization is rechecked for private portals.
- Staged or quarantined assets never enter public/CDN namespaces.
- Trace retention is short and separate from approved screenshot retention.

## Recorder limitations

Opaque DOM overlays protect recognized and author-selected elements before `captureVisibleTab`. Embedded documents are masked in full because their live contents and pointer events cannot be audited reliably from the top document. The recorder still cannot detect sensitive pixels drawn into first-party canvas/video surfaces or every arbitrary text pattern. The extension labels captures unverified and the publication OCR/privacy gate remains mandatory for public output under the default policy.

The controlled Playwright recorder persists only after AST-level URL/input replacement and a structured privacy postflight. Its adjacent review report and proposed patch are derived from those exact persisted bytes, contain no source snippets, and expose only fixture names, controlled Playwright method names, source coordinates, hashes, counts, and generic recommendations. A replay mismatch, literal URL, blocking privacy finding, path escape, symlink, or non-regular artifact target stops review generation.

## Security testing

The release gate should include canary secrets across passwords, JWT/API tokens, private keys, payment numbers, email/phone/address fields, screenshots, semantic evidence, logs, archives, and upload bodies. A canary search must find no raw value after capture. ZIP imports reject traversal, symlink escape, oversized entries, active content, mismatched media, and hash tampering.
