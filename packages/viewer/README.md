# `@scenebook/viewer`

Accessible, framework-neutral `<scenebook-player>` web component for interactive product stories.

## Install

```sh
npm install @scenebook/viewer
```

Import `registerScenebookPlayer` from `@scenebook/viewer`, call it in a browser, then render a `scenebook-player` element with a compiled Scene payload. Registration is explicit and idempotent. The package is ESM-only and requires Node.js 22 or newer.

The player includes guarded keyboard navigation, transcript jumps, reflected Step IDs for deep
links, reduced-motion handling, bounded branches, multiple CTAs, and bubbling/composed lifecycle
events. Set `ctaSubmitter` to an async function to handle form CTAs; submissions include a stable
authored CTA ID, a retry ID scoped to that Step/CTA pair, and typed field values. Set
`formsDisabled` when a publication has no reviewed submission destination. Text and email fields
are never interpreted as player keyboard shortcuts.

Compiled JavaScript, declarations, styles embedded by the component, and the corresponding TypeScript source are included.

## License

Apache-2.0. See `LICENSE` in this package for the complete terms.
