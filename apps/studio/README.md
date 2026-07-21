# Scenebook Studio

Studio is the browser-local authoring surface. Scene source, compact media payloads, Project
configuration, and the latest 100 successful Scene revisions live in IndexedDB. Import and export
are the portability boundary; Studio does not silently upload, execute product automation, approve
Reviews, publish a Channel, or collect viewer analytics.

## Project surfaces

- **Changes** compares the two newest retained local revision summaries and shows attached Run
  metadata. It does not claim a pixel diff or replay.
- **Collections** edits ordered canonical Project Collections, validates the complete Project schema,
  and saves only after an explicit author action.
- **Publish** reports source, Collection, Channel, policy, and authoring preflight state. It exports a
  portable Project ZIP and links to each Scene's full 15-format output configuration; privacy scans,
  approvals, compilation, and promotion remain CLI or Console gates.
- **Runs** shows imported Scene-bound evidence and copyable commands for configured Run Targets.
  Commands execute only when the user runs them in their repository or CI.
- **Insights** computes local source, evidence, curation, visual, translation, and freshness coverage.
  It never presents inferred views, completion, CTA, form, or conversion numbers.
- **Settings** safely edits Project identity, locales, public defaults, and portable Studio privacy
  handoff defaults. Advanced execution configuration and secrets stay in reviewed files. YAML and
  Project ZIP downloads provide recovery and handoff.

## Verification

Run the Studio gates from the repository root:

```sh
bun run --filter @scenebook/studio check
bun run --filter @scenebook/studio test
bun run --filter @scenebook/studio build
```

Manual browser QA should use a clean profile and then an imported Project archive:

1. At desktop and 390px widths, visit `/changes`, `/collections`, `/publish`, `/runs`, `/insights`,
   and `/settings`; confirm the matching navigation item is active and no page overflows.
2. Create a Collection, add/reorder/remove entries, edit metadata, save, reload, and confirm the
   exact order survives. Confirm the final entry cannot be removed and an invalid slug cannot save.
3. Edit Project metadata/privacy defaults, save, reload, download `project.yaml`, and round-trip it
   through Import. Confirm no secret input or managed-run button exists.
4. Import Scene evidence with passed/changed/broken status. Confirm Changes, Runs, and Insights show
   only the imported commit/environment/time and label synthetic samples or missing evidence.
5. Add a static Channel from Publish. Confirm strict passing policy is saved, blockers are derived
   from selected local Scenes, and the screen labels CLI/Console checks as a handoff—not completed.
6. Export a Project ZIP and re-import it in a fresh profile. Confirm Project identity, Collections,
   Channels, privacy metadata, Scenes, and embedded screenshots survive.
7. Keep DevTools open throughout; there should be no console error, network upload, analytics beacon,
   or unexpected request beyond same-origin Studio assets.
