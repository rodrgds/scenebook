# Publishing

The compiler normalizes authored Scene source once and applies the same crop, frame, opaque masks, annotations, cursor, timing, captions, and theme across output families.

## Formats

| Family        | Formats                                                           |
| ------------- | ----------------------------------------------------------------- |
| Interactive   | catalog, standalone HTML, web component, iframe                   |
| Documentation | Markdown, MDX, HTML guide, PDF                                    |
| Motion        | GIF, WebM, MP4                                                    |
| Launch        | README card, Open Graph image, square and landscape social images |
| Public source | privacy-flattened Scene directory and `.scene.zip`                |
| Evidence      | deterministic manifest and per-Scene evidence JSON                |

Select formats in `scenebook.config.ts` or on the command line:

```bash
scenebook export --format pdf --format mp4 --format social-carousel
scenebook export --format remix-source
scenebook export --format all
```

Motion output is deterministic, silent, metadata-free, and intentionally limited to authored cursor movement, click feedback, pan/zoom, caption overlays, Step timing, simple transitions, and branded cards.

## Projects, Collections, and Channels

`project.yaml` is an active publication input. A build with no selector renders Collections in project order, renders each Collection's entries in entry order, and adds an explicit **Ungrouped Scenes** section for valid Scenes that are not referenced by any Collection. Ungrouped Scenes are ordered by Scene ID. Collection entry titles and descriptions override only their catalog card copy; the portable Scene remains unchanged.

All publication commands accept an ID or slug:

```bash
scenebook build --channel public
scenebook export --collection workspace-onboarding --format pdf
scenebook dev --channel public --port 6100
scenebook publish --channel public --candidate <candidate-hash> \
  --destination public/scenebook --actor release-manager --yes
```

`--channel` builds only the Channel's `collectionIds`, in their authored order. `--collection` publishes only that Collection when used by `build`, `export`, or `dev`. Supplying both at build time narrows the Channel candidate to one Collection and fails if the Collection is not in the Channel. Exact IDs take precedence over slugs; slugs are unique within their entity type. Promotion never accepts selection, locale, format, or privacy-override flags because it consumes an already sealed candidate.

A Scene placed more than once is emitted at its first occurrence in Collection and entry order; later placements are omitted. This rule applies within one Collection and across Collections. Every selected entry is still validated before de-duplication, so a missing Scene always aborts the build. Narrowed Channel/Collection builds exclude ungrouped Scenes, and a Channel with no publishable Scenes fails rather than producing an empty catalog.

The deterministic manifest and every per-Scene evidence file record the selection mode, project ID, Channel ID when selected, ordered Collection IDs, resolved groups, duplicate/missing/ungrouped policy, and the selected Channel policy. The compiler receives this as a typed publication plan and has no dependency on project file loading.

## Public distribution settings

`project.yaml` owns the default public-distribution policy. A Channel's `public` object is a partial
override; omitted fields inherit from the Project. The safe default is `noindex,nofollow`, with
attribution and public remix source enabled. Search indexing can be enabled only for
`public-catalog` and `static` Channels.

This example uses the reserved `.invalid` domain deliberately. Replace every URL, ID, and
environment-variable name with reviewed values for the Release being deployed:

```yaml
public:
  baseUrl: https://stories.example.invalid/product/
  customDomain: stories.example.invalid
  seo:
    index: false
    follow: false
    title: Product stories
    description: Reviewed walkthroughs for the product.
  attribution: true
  remix: true
  analytics:
    endpoint: https://control.example.invalid/v1/public/workspaces/acme/projects/product/channels/public/analytics
    tokenEnv: SCENEBOOK_PUBLIC_ANALYTICS_TOKEN
    releaseId: release-2026-07-21
    respectDoNotTrack: true
  cta:
    endpoint: https://forms.example.invalid/v1/public/workspaces/acme/projects/product/channels/public/cta
    tokenEnv: SCENEBOOK_PUBLIC_CTA_TOKEN
    releaseId: release-2026-07-21

channels:
  - id: public
    name: Public stories
    slug: public
    kind: public-catalog
    collectionIds: [onboarding]
    public:
      seo:
        index: true
        follow: true
      attribution: true
      remix: true
```

Set `channel.public.analytics: null` or `channel.public.cta: null` to disable the corresponding
inherited Project service for that Channel. Omission inherits; `null` is the explicit reviewed
opt-out. Analytics and form submission are independently configured, credentialed, and disabled.

`baseUrl` is the exact public root, including a path prefix when the release is mounted below `/`.
It drives canonical, Open Graph, structured-data, README, catalog, and manifest share URLs. It must
be an absolute HTTP(S) URL without credentials, a query string, or a fragment. `customDomain` is a
lowercase DNS hostname; when both fields are present, their hostnames must match. Supplying only a
custom domain implies its HTTPS root. The legacy top-level Channel `customDomain` remains readable
for schema-version-1 projects, but new configuration should use `channel.public.customDomain`.

`seo.title` and `seo.description` override catalog metadata. Scene pages retain their authored
title and description. Robots directives follow the resolved `index` and `follow` values; generated
iframe wrappers remain `noindex,nofollow`. Open Graph and Twitter image tags are emitted when an
Open Graph image was selected, and absolute URLs are emitted only when a public base is known.

### Public analytics

Analytics is absent by default, which leaves generated players with `analytics: null` and makes no
analytics requests. When configured:

- `endpoint` must be HTTPS, except for explicit loopback development, and must use the exact
  `/v1/public/workspaces/:workspaceId/projects/:projectId/channels/:channelId/analytics` path;
- `tokenEnv` names a build-time environment variable containing the public-scoped Channel token;
  a missing value fails the build, and the token is never placed in the manifest or evidence;
- `releaseId` must identify the Channel's current immutable Release; stale-Release events are
  rejected by the public endpoint;
- `respectDoNotTrack` defaults to `true` and suppresses requests for Do Not Track or Global Privacy
  Control clients.

The public analytics token is embedded only in generated interactive pages and must never be an admin token
or treated as a secret. Requests use `credentials: omit` and `no-referrer`, and contain only
`view`, `start`, `step`, `complete`, or `cta` lifecycle events plus Scene/Step identity, source,
index, total, and progress. The player never includes CTA form fields, anonymous IDs, session IDs,
or other authored values in analytics. It sets no analytics cookies and writes no browser storage;
each request receives a fresh event ID.

Administrators can read privacy-safe funnel results from
`GET /v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/analytics/funnel`.
The admin-authenticated endpoint defaults to the current Release and the last 30 days; `releaseId`,
`from`, and `to` select a specific Release and an at-most-90-day interval. It returns accepted-event
counts, completion/dropoff/CTA rates, and per-Scene/per-Step CTA placements. It never returns event
properties, event IDs, or hashed session/anonymous identifiers, and responses are `private,
no-store`.

### Public form submission

Form delivery is absent by default and separate from analytics. Without a reviewed `public.cta`
runtime, standalone and catalog players do not render form controls; they expose an accessible
unavailable status and make no submission request. The Web Component remains a host-integration
surface and emits its typed form event to the embedding application.

When `public.cta` is configured:

- `endpoint` must be HTTPS, except for explicit loopback development, and must use the exact
  `/v1/public/workspaces/:workspaceId/projects/:projectId/channels/:channelId/cta` path;
- `tokenEnv` names a dedicated build-time environment variable containing a public-scoped CTA
  credential. A missing value fails the build, and the token is excluded from manifest and evidence
  files;
- `releaseId` binds every submission to the reviewed immutable Release. Every canonical
  `steps[].ctas` submission also carries its stable authored `ctaId`; the server selects that exact
  form and rejects stale Releases or any Scene, Step, CTA, webhook, field ID, type, required value,
  or consent value that does not match the released authored form contract. A deprecated
  single-`step.cta` publication may omit `ctaId`, in which case the server derives its deterministic
  compatibility ID.

The player submits only the Release, Scene, Step, stable CTA ID, authored webhook, and typed form
fields. It uses `credentials: omit`, `no-referrer`, and CORS; shows accessible pending, accepted,
and retryable error states; and retains one idempotency key across retries of the same rendered
form. The server applies structured privacy policy, encrypts accepted fields and CTA identity at
rest, persists the selected CTA identity for delivery/audit, and queues only its allowed configured
webhook. CTA fields are never copied into analytics events. The CTA token is a public, narrowly
validated credential—not a secret or admin token—and its environment variable remains independent
from public analytics.

### Share links

Each Scene entry in `manifest.json` has a credential-free `share` object. A property is present only
when its output was compiled:

| Property       | Artifact                                   |
| -------------- | ------------------------------------------ |
| `page`         | catalog Scene page                         |
| `standalone`   | self-contained player HTML                 |
| `embed`        | iframe wrapper                             |
| `webComponent` | custom-element JavaScript module           |
| `readme`       | README card                                |
| `ogImage`      | 1200x630 Open Graph image                  |
| `socialImages` | square and landscape social images         |
| `remixSource`  | privacy-flattened `scene.yaml`             |
| `remixArchive` | Studio-ready, integrity-bound `.scene.zip` |

Links are absolute when `baseUrl` or `customDomain` is configured and otherwise remain paths within
the release directory. Generated catalog and Scene pages expose the applicable page, embed, media,
and remix links from the same privacy-gated build.

## Privacy gate

The compiler never copies a raw source screenshot into public output. It first creates post-crop, post-publication-mask derivatives, binds OCR assessments to exact SHA-256 hashes, scans authored/semantic strings, and fails closed for unknown or blocking privacy status. Sensitive classifications cannot use reversible blur.

`--allow-unscanned-privacy` is an attributed local override. A build manifest that used it has `privacy.status: "overridden"`; hosted policy can reject it.

## Public remix source

`remix-source` creates `remix/<slug>.scene/` and `remix/<slug>.scene.zip`. A catalog build adds this
format automatically when the resolved public policy has `remix: true`; explicitly requesting it
while remix is disabled fails the build.

This is public source, not the private authored Scene. Every visual is rendered from the
post-publication-mask derivative and flattened into a passive, content-addressed PNG. Private
routes, selectors, actions, checks, automation, source locations, and raw captures are removed.
Public titles, narrative, choices, CTAs, and safe practice targets remain useful. `INTEGRITY.json`
records the hash and size of every included file, and the deterministic ZIP can be imported into
Studio with the same archive and content-hash checks as any portable Scene.

## Determinism and atomicity

Set `SOURCE_DATE_EPOCH` to bind generated timestamps. Identical source, renderer versions, locale, assets, and epoch produce identical manifests and media. Content-addressed filenames make caches safe and let consumers verify bytes.

Every publication is written to staging. The compiler validates format output and privacy before replacing a development output. A Channel build additionally seals its exact tree, deterministic ZIP, sorted inventory, compiler manifest, and canonical Build/Run/Review evidence under `.scenebook/publication/candidates/objects/<candidate-hash>/`. Later source or mutable evidence edits cannot alter that candidate.

Local Releases and publication events are immutable, while each Channel has one atomically replaced active pointer. Promotion stages and verifies every candidate byte before changing the destination and commits the Channel pointer only after the directory swap succeeds. A pointer failure restores the previous directory. Rollback creates a new immutable event and atomically restores a prior Release's verified candidate bytes; it never edits Release history.

## Immutable local promotion workflow

Build and publish are deliberately separate operations:

```bash
scenebook test --target primary
scenebook privacy scan --run .scenebook/runs/runs/<run-id>.json --provider tesseract
scenebook baseline accept .scenebook/runs/runs/<run-id>.json \
  --actor visual-reviewer --yes

scenebook build --channel public --build .scenebook/runs/build.json
scenebook approve editorial --channel public --candidate <candidate-hash> \
  --scene onboarding --actor editor --yes
scenebook approve release --channel public --candidate <candidate-hash> \
  --actor release-manager --yes
scenebook publish --channel public --candidate <candidate-hash> \
  --destination public/scenebook --actor publisher --yes
```

`baseline accept` stores a content-addressed Baseline object, advances a small active pointer, preserves the compatibility descriptor used by the Playwright reporter, and records visual approval as a separate exact-hash attestation. Existing fixed-path Baselines can be upgraded without guessing their source evidence:

```bash
scenebook baseline migrate --actor visual-reviewer --yes
```

Migration requires the exact source Run to remain available. Approval attestations are append-only. A later `--decision rejected --reason ...` from the same actor supersedes that actor's prior decision for the same subject; it does not rewrite history. Privacy overrides are separately typed and require an auditable reason, but they never satisfy visual approval or publication privacy.

Promotion recomputes Channel readiness from the candidate and active evidence. It requires exact Build and Run hashes, fresh source revisions, complete required targets, clear privacy at every Run/attempt/State and Baseline State, active visual/editorial approvals when policy requires them, computed locale coverage, and a separate Release approval. Non-critical carry-forward succeeds only when the candidate Scene revision, locale revisions, and every owned output byte equal the prior Release; otherwise it fails closed. Exclusion also fails closed when the sealed tree still contains the Scene, requiring a narrowed candidate instead of silently publishing excluded bytes.

Rollback defaults to the active Release's predecessor, or accepts an exact Release ID/hash:

```bash
scenebook rollback --channel public --actor release-manager --yes
scenebook rollback --channel public --release <release-hash> \
  --actor release-manager --yes
```

## Deploying the static release

`scenebook publish --channel <channel> --candidate <hash> --destination <directory> --actor <id> --yes` promotes the complete, already sealed static release directory. Ship
that entire directory—with `manifest.json`, pages, scripts, styles, media, remix archives, and
evidence—to an independent static origin or CDN. Do not copy only `index.html`, and do not serve
active HTML, JavaScript, CSS, or SVG from the administrative control-plane origin. Canonical and
share URLs are correct only when `public.baseUrl` matches the deployed root.

Scenebook's filesystem publication is atomic, but uploading that directory to an external CDN is a
separate operator action unless a deployment adapter owns both. Verify the public `manifest.json`
and referenced hashes before and after promotion; retain the previous static directory as the
rollback target.

The reusable GitHub Action remains local-only unless `upload: 'true'` is set. With that explicit
opt-in, GitHub OIDC can upload a deterministic publication archive and verification evidence to the
control plane using a short-lived `artifact:write` token. Upload alone does not publish it: an exact
Release must pass policy and atomically advance its Channel pointer. The control plane streams members
only to verify the typed manifest, inventory, deterministic ZIP metadata, and Release binding; it
never retains expanded output or serves active members, and never needs a long-lived admin credential
in CI. Self-hosters may then let the separate first-party publication gateway serve the current
immutable Release, or deploy the compiler's static directory through an external CDN.

For authenticated private portals, the control plane creates a short-lived, one-use handoff bound
to the live User grant, source Session, first-party publication origin, and exact return path. Only
its random credential appears in the URL fragment; the publication gateway removes it before a
same-origin exchange and issues its own `HttpOnly` cookie. The control-plane Session is never sent
to the publication origin, and live revocation is rechecked on every member request.

### Content Security Policy

The bundled static nginx file cannot safely hard-code service or embedding origins because those
are reviewed per deployment. Add a `Content-Security-Policy` **HTTP response header** at the static
origin after replacing the reserved `.invalid` origins below. `connect-src` must list only the
origins of configured analytics and CTA endpoints; omit either origin when that service is
disabled. `frame-ancestors` must list only applications allowed to embed generated players:

```nginx
add_header Content-Security-Policy "default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://analytics.example.invalid https://forms.example.invalid; frame-src 'self'; frame-ancestors https://docs.example.invalid; form-action 'none'; worker-src 'none'; manifest-src 'none'; upgrade-insecure-requests" always;
```

Current deterministic pages contain their runtime and theme CSS inline, so the two explicit
`'unsafe-inline'` allowances are required until a deployment owns per-file script/style hashes.
They do not permit external active content. Do not set `X-Frame-Options` on an origin intended for
cross-origin embedding; use the exact `frame-ancestors` allowlist instead. `frame-ancestors` is not
effective in a `<meta>` tag, which is why this policy belongs in the CDN or web-server response.
The first-party publication gateway computes per-document inline hashes and does not use this static
nginx fallback policy.
Test the final header on catalog, standalone, iframe, media, analytics, CTA success/error, and every
approved embedding origin before promotion.

## Embedding

The framework-neutral player supports keyboard navigation, transcript, deep links, reduced motion, bounded cross-Scene choices, CTAs, and composed host events:

- `scenebook:ready`
- `scenebook:stepchange`
- `scenebook:branch`
- `scenebook:cta`
- `scenebook:complete`

The generated Web Component dispatches these events from `<scenebook-player>` with
`bubbles: true` and `composed: true`. `ready`, `stepchange`, and `complete` carry the current
Scene snapshot (`sceneId`, `stepId`, zero-based `index`, `total`, progress, and navigation
state). `stepchange` also includes its navigation `source`. `branch` is cancelable and includes
the selected choice; preventing it stops the generated link navigation. `cta` includes the CTA
metadata. Web Component form CTAs additionally include the stable authored `ctaId`, authored
`webhookId`, retry-safe `submissionId`, and a `fields` object whose text/email values are strings
and checkbox values are booleans; the host decides whether and where to send that payload.
Standalone and catalog players instead use only the separately reviewed `public.cta` runtime
described above.

Standalone HTML dispatches the same lifecycle from its `<main>` element, so listeners on
`document` or `window` can observe it. When that document is embedded, it sends only those five
allowlisted event types to the same-origin iframe wrapper. The wrapper validates both the child
window and origin, re-emits local DOM events, and can relay observational messages to its own
parent using the exact referrer origin—never a wildcard. The iframe bridge accepts no incoming
controls. CTA messages crossing either bridge contain only the Scene/Step navigation snapshot,
stable CTA ID, CTA kind/label, and outcome status; submitted fields, authored webhook IDs,
submission IDs, and nested field definitions never leave through `postMessage`. Branch cancellation is only synchronous in standalone/Web Component DOM events;
an outer host cannot cancel navigation after receiving a `postMessage`. Form submission never
derives a destination or credential from the page URL: it is explicitly configured for the public
CTA service, handled by a Web Component host, or unavailable.

Each generated Scene module registers the canonical viewer idempotently and exports
`mountScenebookPlayer(element)`. A single empty `<scenebook-player>` is mounted automatically. If a
page loads multiple generated Scene modules, set `data-scene="<scene-id>"` on each player (or call
the mount helper from the chosen module) so an already-registered custom element cannot select the
wrong Scene.

Use the generated iframe for the smallest trust boundary. Use the web component when the host needs events or theme integration. Generated adapters are available for Docusaurus, VitePress, Astro, Next.js, Mintlify, and generic MDX projects.
