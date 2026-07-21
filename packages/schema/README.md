# `@scenebook/schema`

Versioned Zod schemas and portable contracts for Scenebook Scene, Project, Run, Build, Review, Baseline, Channel, Release, immutable local publication candidate, separate approval attestation, publication event, and active-pointer documents.

## Install

```sh
npm install @scenebook/schema
```

The package is ESM-only and requires Node.js 22 or newer. Compiled JavaScript, declarations, and the corresponding TypeScript source are included.

Scene schema version 1 accepts the legacy single `step.cta` field and the canonical
`step.ctas` array. A non-empty `ctas` array takes precedence and gives every action a stable ID and
primary/secondary variant. Portable inline locale overrides live in `scene.translations`; locale
sidecars remain supported and inline values override matching sidecar fields. These authored fields
are public schema, not Studio-private metadata.

## License

Apache-2.0. See `LICENSE` in this package for the complete terms.
