# Scenebook interface standard

This file records the product-specific decisions that complement the project-local Impeccable skill.

## Experience

Scenebook should feel like a focused workbench: quiet, precise, trustworthy, and fast. The walkthrough or current decision is the focal point; the interface frame recedes.

Every screen has one primary job and at most one persistent primary action. Safety or provenance notices appear only where they change a decision. Advanced configuration uses progressive disclosure, but remains keyboard reachable and plainly named.

## Visual system

- Chroma-neutral light surfaces with one terracotta action accent.
- Semantic green, amber, red, and blue are reserved for real status meaning.
- System sans-serif for product UI and system monospace for source, commands, IDs, and hashes.
- Fixed product type scale. Page title `2.35rem` desktop / `2rem` mobile, section title `1.25–1.3rem`, body `0.9rem`, metadata no smaller than `0.7rem`.
- Heading tracking never tighter than `-0.04em`.
- Default content width `1280px`; prose remains within roughly 65–75 characters.
- Controls are at least 40px on desktop and 44px on touch layouts.
- Bordered surfaces do not also receive wide decorative shadows. Cards exist only to group related controls or records.
- Avoid uppercase eyebrow labels, decorative gradients, glass effects, side-stripe accents, nested cards, and hero metric-card grids.

## Interaction

- Focus is always visible with a solid accent outline.
- Mobile navigation behaves as a modal drawer: initial focus, focus containment, Escape dismissal, inert background, and focus restoration.
- Motion explains state or spatial change only. Never animate layout properties when a transform or immediate state change is sufficient.
- Loading, empty, error, and success states name what happened and the next useful action.
- Dialogs cannot visually close while a destructive or importing action continues.

## Information hierarchy

- Shell: project context once, search, Import, and New scene.
- Home: workspace state and recent work only.
- Scenes: browse and filter the full library.
- Review and Runs: actionable items first; technical evidence on expansion.
- Editor: content first; interaction, appearance, output, and developer details on demand.
- Release: blockers first, channels second, export handoff last.
- Public viewer: walkthrough first; transcript and downloads collapsed by default.

For new UI, run the Impeccable detector and verify desktop, tablet, mobile, keyboard, reduced-motion, contrast, and overflow behavior before release.
