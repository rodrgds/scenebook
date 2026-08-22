# Playwright integration

Playwright is optional for creation and authoritative for verification. It uses public Playwright fixtures, `test.step`, reporters, locators, screenshots, and attachments; traces remain debugging enrichment.

## Rich Scene API

```ts
import { expect, scene } from '@scenebook/playwright';

scene('Invite a teammate', { id: 'invite-member' }, async ({ page, step }) => {
  await page.goto('/settings/members');

  await step(
    'open-invitation-form',
    {
      title: 'Open the invitation form',
      target: page.getByRole('button', { name: 'Invite member' }),
    },
    async () => page.getByRole('button', { name: 'Invite member' }).click(),
  );

  await step(
    'enter-invitee',
    {
      title: 'Enter your teammate email',
      target: page.getByLabel('Email address'),
      masks: [page.getByLabel('Email address')],
    },
    async () => page.getByLabel('Email address').fill('fixture@example.test'),
  );

  await expect(page.getByText('Invitation sent')).toBeVisible();
});
```

`step` is the public UI term; `beat` remains a compatibility alias. Each Step records pre/post states, route without query or fragment, viewport, target semantics and geometry, checks, masks, source location, and attempt identity. Typed fixture values are not copied into Scene narrative.

## Reporter configuration

```ts
import { defineConfig } from '@playwright/test';

const baseURL = process.env.SCENEBOOK_BASE_URL;
if (!baseURL) {
  throw new Error('Run verification through scenebook test/ci so a reviewed base URL is bound.');
}

export default defineConfig({
  use: { baseURL },
  reporter: [['@scenebook/playwright/reporter', { outputDirectory: '.scenebook/runs' }]],
});
```

Run verification through `scenebook test --target <run-target-id>`. The sole enabled Run Target is inferred; multiple enabled targets require an explicit exact ID. The CLI resolves its Environment and fails before spawning Playwright when the target is unknown or disabled, the Environment does not set `allowMutations: true`, a production Environment is blocked by `playwright.forbidProductionMutations`, or the production URL is not HTTPS.

The CLI binds the selected target and canonical Environment URL into the subprocess and reporter. Its generated safety config rejects disagreement with global or per-project Playwright `baseURL`, rejects local `webServer` commands for non-local Environments, and prevents forwarded `--config`, `--project`, or `--reporter` arguments from bypassing policy. It keeps Playwright's line diagnostics alongside mandatory Scenebook evidence. Ad-hoc `--base-url` is intentionally unsupported; change the reviewed Project Environment instead. Running ordinary Playwright directly does not apply this CLI policy boundary.

Retries and repeats retain separate attempt identities inside one logical Scene/Target Run. Each repeat contributes only its final retry to the outcome; any exhausted repeat makes the Run broken, while earlier failed retries remain reviewable evidence. A shard writes only an explicit partial Build fragment and can never masquerade as the final Build.

## Existing tests

`scenebook import playwright <file>` parses literal `test()` and `test.step()` metadata into draft Scene source. It does not execute imported code or rewrite the original test. Add targets, masking, fixtures, and assertions incrementally.

Unmodified Playwright tests still produce honest review evidence. The CLI safety wrapper forces a final screenshot and retains a trace on failure; the reporter content-addresses supported Playwright screenshot, trace ZIP, and configured WebM video attachments without inventing authored Steps or target geometry. A generic final screenshot starts with unknown privacy and blocks publication until exact OCR attestation. Traces and videos remain private debugging attachments: they are never promoted into Baselines or public output merely because the test passed. Rich `scene()`/`step()` fixtures remain the path to pre/post Step states and semantic review.

## Controlled draft recording

`scenebook record <url>` uses the pinned Playwright codegen process only as an onboarding path. It runs with an isolated disposable profile and environment, replaces every navigation target and entered scalar with an explicit fixture before regular-file persistence, and creates a Scene draft that is Captured, not Verified.

The adjacent `recording-review.json` binds the persisted source hash and reports generic Step boundaries, locator brittleness, missing outcome assertions, fixed/dynamic waits, and file impact without copying source snippets or application values. Its project-relative `recording-review.patch` contains zero-context insertion hunks and an exact precondition/result contract; it is never applied automatically. Those suggestions help curate ordinary readable Playwright, but maintained checks and approved Run evidence remain the source of verification truth.

## Baselines and CI

```bash
scenebook test --target admin-desktop-local
scenebook review .scenebook/runs/<run>.json
scenebook privacy scan --run .scenebook/runs/<run>.json --provider tesseract
scenebook baseline accept .scenebook/runs/<run>.json --actor maintainer --yes
scenebook ci --target admin-desktop-local
```

Exact Run privacy scanning OCRs private copies of the content-addressed screenshots, scans structured evidence, then atomically rebinds the Run, Review, Build summary/hash, and GitHub check payload. Until that attestation succeeds, screenshot privacy remains unknown and the Run is blocked. Baseline acceptance requires a functionally passed Run, its selected complete attempt, all expected Step states, and clear privacy; it validates and copies immutable screenshot assets, writes a content-addressed Baseline bound to the canonical Run hash, advances the active pointer, and stores visual approval separately. Cleaning `.scenebook/runs` therefore does not destroy accepted review truth.

For Playwright sharding, retain every shard directory and finalize only the exact complete set:

```bash
scenebook ci --target admin-desktop-preview -- --shard=1/2
scenebook ci --target admin-desktop-preview -- --shard=2/2
scenebook ci merge-shards
```

`ci merge-shards` rejects missing or duplicate indices, mixed repository provenance, and duplicate Scene/Target ownership. Only its complete `.scenebook/runs/build.json` is eligible for control-plane ingestion.

By default, the GitHub Action runs `scenebook ci` and exact Run screenshot OCR inside the repository checkout, then always retains a downloadable, script-free visual-review artifact, even when verification fails. It requests no OIDC or Checks token and requires only `contents: read`.

The artifact generator does not trust the reporter directory as ordinary upload input. It accepts only a Build created after the current Action invocation and bound to the exact `GITHUB_SHA`, reads that Build and its content-bound Runs through bounded, no-follow file descriptors, rejects traversal and symlinks, verifies canonical Run hashes, verifies screenshot SHA-256 and byte length, and accepts only bounded PNG/JPEG streams with matching decoded dimensions. Screenshot bytes are copied only when the Run, its selected attempt, and the individual State all have complete clear privacy attestations from a non-placeholder scanner. Unknown, warning, blocked, quarantined, malformed, stale, oversized, or mismatched screenshots are withheld; their paths and bytes never enter the artifact. A failure before the reporter starts still produces a metadata-only report containing the original verification exit code.

The final Action step returns the original `scenebook ci` exit code after report generation and artifact retention. Report, artifact, or explicitly requested Checks failures also fail a verification that was otherwise successful. The Action outputs `verification-exit-code`, the authenticated `artifact-url`, and GitHub's `artifact-digest`; the URL expires with the 14-day artifact retention period. Artifact retention uses the full verified commit for official `actions/upload-artifact` v7.0.1; self-hosted runners must meet that Action's current runner requirement, and GitHub Enterprise Server does not currently support its v4+ artifact backend.

The reusable Action installs pinned Node.js 24.18.0 and Bun 1.3.3 runtimes, prefers a repository-local
`node_modules/.bin/scenebook`, and otherwise runs the exactly pinned CLI version with Bun.
It remains local-only by default:

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@<pinned-commit>
  - name: Install the local OCR gate
    run: sudo apt-get update && sudo apt-get install --yes tesseract-ocr
  - uses: your-org/scenebook@<pinned-commit>
    with:
      version: 0.1.0
      target: admin-desktop-preview
```

GitHub Check Runs are separate and opt-in. Grant `checks: write`, pass the workflow's short-lived token explicitly, and keep `contents: read`:

```yaml
permissions:
  contents: read
  checks: write

steps:
  - uses: actions/checkout@<pinned-commit>
  - name: Install the local OCR gate
    run: sudo apt-get update && sudo apt-get install --yes tesseract-ocr
  - uses: your-org/scenebook@<pinned-commit>
    with:
      version: 0.1.0
      target: admin-desktop-preview
      post-checks: 'true'
      github-token: ${{ github.token }}
```

Scenebook posts only the bounded `github-checks.json` created for the exact full `GITHUB_SHA` and active `GITHUB_REPOSITORY`, and only when the freshly generated artifact proves an integrity-clean current Build. It links the Check to the retained artifact, strips raw annotation details, forces the conclusion to fail closed if it disagrees with the exact Build status, and sends it to GitHub's HTTPS Checks endpoint. Fork pull requests and every `pull_request_target` event are deliberately skipped before the token is validated or used. Do not substitute a personal access token, expose secrets to fork workflows, or use `pull_request_target` to execute pull-request code. The workflow author remains responsible for granting `checks: write`; the Action cannot broaden its own permissions.

Hosted evidence upload is a separate, explicit mode. The calling job, not the composite Action, must grant GitHub's OIDC permission:

```yaml
permissions:
  contents: read
  id-token: write
  # Add only when post-checks is true:
  # checks: write

steps:
  - uses: actions/checkout@<pinned-commit>
  - name: Install the local OCR gate
    run: sudo apt-get update && sudo apt-get install --yes tesseract-ocr
  - uses: your-org/scenebook@<pinned-commit>
    with:
      version: 0.1.0
      target: admin-desktop-preview
      upload: 'true'
      server-url: https://scenebook.example.com
      workspace-id: workspace-acme
      project-id: product-docs
      oidc-audience: scenebook
```

The server URL and Workspace/Project IDs are identifiers, not credentials. Never pass an admin token or long-lived upload secret to the job. The control plane verifies GitHub's signed OIDC assertion and binds the short-lived, sole-`artifact:write` token to the exact repository, workflow, ref, and commit. That token can submit only finalized request envelopes for Scene revisions, Runs, Reviews, and the Build; it cannot read administrative data or create Baselines, approvals, or Releases.

`upload: 'true'` is fail-closed. Before requesting OIDC or sending bytes, the CLI requires every selected replay to pass functionally, permits either unchanged evidence or an explicit reviewable change, requires all structured and screenshot OCR privacy checks to be clear, rejects broken/blocked/pending evidence and local privacy overrides, and checks the configured Project and GitHub provenance. Changed evidence is uploaded with its deterministic open Review but still produces a non-green CI result until approved. There is no silent upload from `scenebook ci` or from setting server-related inputs alone.

The CLI also attests `git rev-parse --verify HEAD` before verification and again immediately before
upload. Both values must exactly equal signed `GITHUB_SHA`, including GitHub's detached pull-request
merge commit; a checkout change during the job fails before evidence can leave the runner.

The finalized upload contains the evidence request envelopes and screenshots plus the complete compiled publication as one deterministic `application/zip`. Its canonical inventory JSON records every archive path, canonical media type, SHA-256, and byte length, and the raw compiler `manifest.json` is also uploaded as a small immutable JSON object. Before approval or promotion, the server parses both bounded schemas, streams every ZIP member without retaining expanded output, verifies exact hashes, lengths, paths, regular-file modes, deterministic metadata, and the inventory tree hash, then binds the Release's exact Scene revisions and output entrypoints to that truth. HTML, JavaScript, CSS, and SVG are never accepted as individual upload objects or relabeled as plain text, and archive content is never served from the control-plane origin. Deploying the compiler's real static output to an independent publication origin remains a separate operation. Upload and evidence keys are deterministic, so an identical job retry returns the same immutable result while reuse with different bytes conflicts.

Use synthetic accounts, deterministic fixtures, explicit setup/cleanup, and preview environments. Do not verify through a personal browser profile or enable production mutation casually.
