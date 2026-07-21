# `@scenebook/adapters`

Safe adapters for turning Scenebook output into documentation-framework and GitHub payloads.

## Install

```sh
npm install @scenebook/adapters
```

The package exports the main adapter API from `@scenebook/adapters` and GitHub-specific helpers from `@scenebook/adapters/github`. ESM JavaScript, declarations, and the corresponding TypeScript source are included in the package.

The CLI wires the framework generators into real projects:

```sh
scenebook docs install --adapter vitepress --base-path /docs --destination website --dry-run
scenebook docs install --adapter vitepress --base-path /docs --destination website
```

Supported adapters are Fumadocs, Docusaurus, VitePress, Starlight, Nextra, Mintlify, and GitHub Pages. Installation is project-contained, rejects symbolic-link path components, previews without writes under `--dry-run`, treats exact files as idempotently unchanged, and never overwrites a conflicting source or workflow file.

## License

Apache-2.0. See `LICENSE` in this package for the complete terms.
