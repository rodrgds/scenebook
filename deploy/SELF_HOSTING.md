# Self-hosting Scenebook

This deployment separates PostgreSQL, MinIO, the Node control plane, the connected static Studio,
the first-party publication gateway, and the optional operator-mounted static export. The control
plane performs checksummed migrations under a PostgreSQL advisory lock during startup. Only the
gateway serves active files selected by a hosted Channel pointer, and it runs on a different origin
with SELECT access only to masked publication-specific database views plus read-only finalized-object
storage.

## Prerequisites

- Docker Engine 26 or newer with Compose v2
- OpenSSL for the first-boot secret generator
- A TLS-terminating reverse proxy or load balancer
- Separate public HTTPS origins for the control plane and publication gateway
- An HTTPS Studio origin whose `/v1/*` traffic reaches the bundled same-origin proxy
- A GitHub Actions workflow configured to request an OIDC token with audience `scenebook`

## First boot

1. Generate `.env` with independent secrets and an Ed25519 identity keypair:

   ```sh
   cd deploy
   ./scripts/init-env.sh https://control.example.com https://stories.example.com
   ```

   The script refuses to overwrite an existing `.env`, writes with a restrictive umask, and never
   reuses a database, MinIO, operator, upload-token, identity-token, gateway-session,
   gateway-exchange, Runner-token, analytics, or encryption secret. Review `.env.example` when
   enabling GitHub App, webhook, custom-domain, or non-default limit settings. Store the generated
   file in the deployment secret manager; do not commit it.

2. URL-encode the PostgreSQL password inside `SCENEBOOK_DATABASE_URL`. Keep `SCENEBOOK_GATEWAY_POSTGRES_PASSWORD` URL-safe; Compose creates or rotates a `scenebook_gateway` login whose transactions are read-only. It can select only masked publication/auth/domain views in the `publication_gateway` schema. It cannot select base tables, API-token hashes, analytics, audit, CTA ciphertext, uploads, or future tables by default.
3. Set `SCENEBOOK_PUBLIC_URL` to the final control-plane HTTPS origin and `SCENEBOOK_PUBLICATION_URL` to a distinct gateway HTTPS origin. Set the gateway-only `SCENEBOOK_CONTROL_PLANE_INTERNAL_URL` to the control-plane origin on the private service network. Keep ports loopback-only and publish them only through the reverse proxy. Route the control-plane hostname to `4310`, a Studio hostname to `8080`, and the publication hostname and provisioned custom domains to `4320`. The Studio nginx service proxies its same-origin `/v1/*` requests to the private control plane; do not expose MinIO or PostgreSQL. Never route a publication hostname to `4310`, and block `/v1/internal/*` at every public edge.
4. Start and verify the deployment:

   ```sh
   docker compose --env-file .env up -d --build
   docker compose ps
   curl --fail http://127.0.0.1:4310/readyz
   curl --fail http://127.0.0.1:4310/metrics
   curl --fail http://127.0.0.1:4320/readyz
   ```

Both readiness endpoints check PostgreSQL and the object store. A healthy process with a failing dependency remains not-ready. Studio starts independently, so a temporary control-plane outage does not prevent local editing. The gateway can continue serving already published public and private content while the control plane is unavailable because it validates access and Release state directly against PostgreSQL and immutable storage.

The Studio build emits a build-specific CSP meta policy whose SHA-256 sources authorize only the
generated SvelteKit bootstrap. `bun run --cwd apps/studio build` verifies every inline script against
that policy and rejects `script-src 'unsafe-inline'`. The bundled Studio nginx config deliberately
adds only `frame-ancestors 'self'`, because a second response-header script policy would intersect
with the generated policy and can block the application bootstrap. If a reverse proxy adds CSP,
keep script, style, connection, image, and font directives in the generated policy; add only
deployment-specific framing protection at the edge, then run the production-container smoke test.

On `SIGTERM` or `SIGINT`, the control plane stops its webhook, scheduled-verification, upload-reclamation, and final-evidence-retention claimers,
stops accepting traffic, drains active HTTP requests, and then closes PostgreSQL. It force-closes
remaining connections after 30 seconds; Compose allows 40 seconds before sending `SIGKILL`. Keep
an equivalent grace period when deploying under another orchestrator.

## Final evidence retention and portable exports

The ordinary `scenebook-cloud` object-store policy can create staging objects, promote immutable
objects, read them for verification, and delete staging objects. It cannot delete a final object.
The `scenebook-final-delete` MinIO identity is the inverse: its checked-in policy grants only
`DeleteObject` beneath `workspaces/*/objects/*`; it cannot list, read, stage, or replace bytes. Set
`SCENEBOOK_S3_FINAL_DELETE_ACCESS_KEY_ID` and `SCENEBOOK_S3_FINAL_DELETE_SECRET_ACCESS_KEY` to this
independent identity. Never reuse the cloud or gateway key. With retention disabled, do not provide
a final-delete capability to the process.

The retention worker first applies the configured grace period, then excludes any object referenced
by an immutable Scene asset or State screenshot, an approved Baseline or its source Run, an approved
Run review, any immutable Release or Release evidence ledger, or a Release artifact upload. It also
excludes identities present in an active upload. Scene creation takes the same Workspace advisory
lock and active-lifecycle guard as retention. Eligible identities are claimed in PostgreSQL, then every reference and concurrency guard
is rechecked immediately before the lifecycle becomes `deleting`. Only then is the exact
content/media-bound object key sent to the delete-only client. Completion writes the tombstone,
required retention event, and tenant audit in one PostgreSQL transaction;
an ambiguous delete attempt remains fail-closed in `deleting` and is reclaimed idempotently after
its bounded claim lease expires. A failure before erasure restores the active lifecycle. Expired
`claimed` and `deleting` rows are part of the ordinary bounded scan, so a process or audit failure
cannot strand an object outside reconciliation. Scheduled-pass rejections are contained and measured; shutdown aborts and
awaits the active pass before PostgreSQL closes. Staged-upload garbage collection is separate and
unchanged.

Use `POST /v1/admin/workspaces/:workspaceId/retention/run?dryRun=true` for a bounded, audited
preview. Omitting the query remains a dry run; pass `dryRun=false` only for an explicit operator
deletion pass. Tune standard and diagnostic grace periods independently. Diagnostic retention must
remain shorter, and no grace value can override an immutable protection reference. The repository
claim itself requires the route Workspace ID: an Owner preview or deletion pass cannot enumerate,
audit, claim, or erase another tenant's identities. Run-review approval takes the same Workspace
advisory lock and rejects approval unless every referenced object remains active.

Workspace Owners can download `GET /v1/admin/workspaces/:workspaceId/export`. The response is a
streamed, private, no-store ZIP with content-addressed `manifest.json`, complete bounded metadata,
and a hashed `restoration.json` object map. Hosted Studio Project documents, Scene heads, bounded
version history, and payload references are included with the administrative metadata. The exporter
walks every object referenced by hosted Studio drafts, Scene assets and State screenshots, Run
attachments/traces/states, Baselines, Release outputs, and
all three Release publication objects (`archive`, `inventory`, and `compilerManifest`). Referenced
objects are omitted only under an explicit immutable-record privacy status; the restoration plan
records the exact missing references and marks the snapshot non-restorable. A missing, deleted,
length-conflicting, or corrupt required object rejects
the export instead of producing a dangling record graph. ZIP production advances only when the
client pulls, holds a bounded output queue, and cancels the active object iterator when the client
disconnects. Secrets, credential hashes, encrypted CTA bodies, raw analytics subjects, object-store
keys, and DNS/provisioner credentials are never members. Non-secret GitHub installation bindings are
included beside their repository bindings; App keys and installation tokens are not. Record count,
asset count, asset payload bytes, serialized metadata bytes, and the exact pass-through ZIP size all
have configurable hard fail-closed limits; increase them deliberately instead of accepting a partial
export. The byte controls are `SCENEBOOK_WORKSPACE_EXPORT_MAX_ASSET_BYTES`,
`SCENEBOOK_WORKSPACE_EXPORT_MAX_METADATA_BYTES`, and `SCENEBOOK_WORKSPACE_EXPORT_MAX_TOTAL_BYTES`.
The metadata default is 64 MiB because preparation retains bounded object graphs plus canonical JSON
and byte buffers before headers are sent; keep it comfortably below the process's available heap.

Every registry image in Compose and every Dockerfile base uses a readable version tag plus an
immutable multi-platform manifest digest. The checked-in pins support both `linux/amd64` and
`linux/arm64`; Docker selects the matching child manifest without allowing a mutable tag to change
the build. Refresh a pin deliberately: review the upstream release notes, run
`docker buildx imagetools inspect <repository>:<tag>`, confirm the reported top-level digest and both
platform manifests, update every occurrence to `<tag>@sha256:<digest>`, then run
`./scripts/verify-image-pins.sh`, `docker compose config --quiet`, and the complete image builds and
smoke tests. Never copy a platform child digest into these multi-platform references, and never
invent or retain a digest when the registry cannot be queried.

`SCENEBOOK_MINIO_ROOT_*` credentials are used only by the one-shot bucket/policy provisioner and backup tooling. The long-running cloud process receives the separate `SCENEBOOK_S3_*` identity. Its policy permits direct writes and deletion only beneath the staging prefix; finalized objects are readable, but can be written only by a metadata-replacing server-side copy from staging and cannot be deleted with the application identity. The gateway receives a separate `SCENEBOOK_GATEWAY_S3_*` identity that can only list the bucket and read finalized `workspaces/*/objects/*` keys: it cannot read staging, upload, copy, overwrite, or delete. Generate all three identities independently. Do not give either service MinIO root credentials.

## GitHub OIDC trust

An administrator first creates a Workspace and Project, then binds an exact `owner/repository` plus an anchored workflow-ref pattern. GitHub Actions sends its OIDC token to `POST /v1/oidc/exchange`. The service validates GitHub's issuer, audience, signature, token age, repository, workflow ref, and one-time token ID. It returns a token valid for at most 15 minutes and bound to one Workspace, Project, repository, commit, ref, workflow, and the sole `artifact:write` permission.

Use a narrow pattern such as:

```text
acme/product/.github/workflows/publish.yml@refs/heads/main
```

Do not use `*` for a production repository unless every workflow and ref in that repository is equally trusted.

### GitHub App source changes and Checks

GitHub OIDC remains the credential for CI evidence ingestion, and the customer-owned Action remains the
executor. The optional GitHub App separately owns source changes and commit Check Runs. Configure
`SCENEBOOK_GITHUB_APP_ID` and the GitHub-issued
unencrypted PEM key in `SCENEBOOK_GITHUB_APP_PRIVATE_KEY`; leave both blank to disable the integration.
The key is read only from runtime configuration, is never written to PostgreSQL or API output, and is
used to mint short-lived installation tokens held only in process memory. Grant the App Metadata read,
Checks read/write, Contents read/write, Pull requests read/write, and Issues read/write only if review
issues are enabled. Install it only on repositories that Scenebook is expected to edit and report on.

For github.com, keep `SCENEBOOK_GITHUB_APP_API_URL=https://api.github.com`. A GitHub Enterprise API
origin is rejected unless its exact credential-free HTTPS origin also appears in the comma-separated
operator setting `SCENEBOOK_GITHUB_APP_ALLOWED_API_ORIGINS`. Workspace requests cannot supply or
override an API URL, token, branch name, redirect target, or App credential. HTTP redirects are disabled,
responses and timeouts are bounded, and returned pull-request/issue links must remain on the configured
GitHub host.

An Owner first selects an existing repository-binding ID and explicitly binds an installation:

```text
POST   /v1/admin/workspaces/:workspaceId/projects/:projectId/github/installations
GET    /v1/admin/workspaces/:workspaceId/projects/:projectId/github/installations
DELETE /v1/admin/workspaces/:workspaceId/projects/:projectId/github/installations/:bindingId
```

The POST body is `{ "repositoryBindingId": "...", "installationId": "..." }`. The server exchanges an
App JWT for an installation token and verifies that the installation resolves the exact bound
`owner/repository` before persisting only non-secret installation/repository IDs and the discovered
default branch. Mutation requires live Owner membership plus `workspace:admin`; revocation uses
`{ "expectedVersion": 1 }` compare-and-swap. Every later operation rechecks both the human credential and
the live installation/repository relationship, so User, membership, token, Session, App-installation,
and local binding revocation fail closed.

Source reads and changes use:

```text
POST /v1/admin/workspaces/:workspaceId/projects/:projectId/github/source/read
POST /v1/admin/workspaces/:workspaceId/projects/:projectId/github/changes
GET  /v1/admin/workspaces/:workspaceId/projects/:projectId/github/changes/:changeId
```

A read supplies `installationBindingId`, a full 40-character `commitSha`, and a safe repository-relative
Scene path. Below a `scenes` directory, the only accepted authored files are `scene.yaml`, `scene.yml`,
`scene.json`, `narrative.mdx`, `theme.yaml`, `theme.yml`, `locales/<locale>.yaml`,
`locales/<locale>.yml`, and `automation/replay.ts`. Assets and every other path are always rejected. The
server proves the exact commit, verifies the returned Git blob SHA against the bytes, enforces UTF-8 and
a 512 KiB limit, returns the blob SHA needed for compare-and-swap, and marks the response `no-store`.

A change requires an `Idempotency-Key`, that exact base commit/blob pair, a title, and 1–50 explicit
`locator`, `narrative`, or `presentation` replacements appropriate to the selected file. Every
before-anchor must occur exactly once inside one parsed scalar whose AST path is authorized for that
operation. The server proves that no other node or document shape changed. Scene manifests, themes, and
locales use duplicate-key rejection and schema validation; MDX is compiled with the production MDX
parser before and after a plain-editorial-text edit; replay edits are confined to static locator string
literals and the resulting TypeScript must parse. Callers cannot submit a generic diff, full
replacement file, arbitrary branch, commit message, or asset change.
Optional evidence binding is accepted only as exact ID/hash pairs for a stored Run, Build, or Review.
The server holds a renewable exact lease while creating the deterministic `scenebook/<change-id>` branch
at the requested base commit, committing with GitHub's blob compare-and-swap, and opening or recovering
one pull request. PostgreSQL determines lease eligibility and deadlines from its own clock. The worker
renews before every remote mutation and its watchdog accounts for request latency plus the returned
deadline; it aborts in-flight GitHub work if ownership or timing safety is lost. A stale worker therefore
cannot resurrect an expired lease or complete or fail a newer worker's record. Configure the
30–900 second lease window with `SCENEBOOK_GITHUB_CHANGE_LEASE_SECONDS`; the default is 120 seconds.
`createReviewIssue: true` creates or recovers an issue containing the exact change and evidence bindings.
Lost responses, retries, and concurrent copies converge on the same branch/PR/issue; reusing an
idempotency key for different input conflicts. Source values and repository paths are not copied into
audit metadata: audit records contain content hashes, Git object IDs, local evidence bindings, and a
keyed path hash.

After immutable Build evidence exists, Scenebook revalidates that the App installation still owns the
exact repository and creates or reconciles a `Scenebook` Check Run at the Build's exact commit. Its
deterministic external identity includes the Build ID, artifact hash, and immutable Review identity;
different Builds at one SHA and multiple Reviews of one Build cannot overwrite each other. Changed
Builds wait for an exact Review before creating a Check. An open Review is in progress; approval succeeds,
while rejection or requested changes fail. Passed, failed, blocked, and cancelled Builds without review
complete directly. Reconciliation scans up to 2,000 Check Runs, chooses the lowest matching ID if legacy
duplicates exist, and is serialized across replicas with a PostgreSQL advisory lock. The lock and all
GitHub I/O share a 60-second maximum end-to-end deadline, after which the request aborts and the lock is
released. Terminal Checks are idempotent only for the same conclusion; regressions or rewrites fail
closed. This status plane does not execute workflows or broaden the Action's permissions.

The reusable Action is local-only unless `upload: 'true'` is set. A local verification job keeps the narrow default permission:

```yaml
permissions:
  contents: read
```

An upload job must explicitly opt in and let GitHub mint an OIDC assertion:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@<pinned-commit>
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

The composite Action cannot grant job permissions itself. The server URL and Workspace/Project IDs are identifiers, not secrets; never place `SCENEBOOK_ADMIN_TOKEN`, MinIO credentials, or another long-lived upload credential in the CI job. The Action checks the configured Project and the active GitHub repository, workflow, ref, and commit before requesting OIDC. The server independently verifies and binds the same provenance on exchange and every evidence write.

## Artifact upload protocol

The Action starts this protocol only after the selected Playwright replay and Build have passed without changes, every structured and screenshot OCR privacy assessment is clear, no privacy override was used, and repository provenance matches. Failure happens before any OIDC or upload network request.

1. Package the complete deterministic compiler output as one `application/zip`. Build a canonical inventory JSON containing every relative path, canonical media type, SHA-256, and byte length.
2. Exchange GitHub OIDC for a short-lived upload token.
3. Begin an upload with a unique `Idempotency-Key` and the complete expected object list.
4. Upload each object to its declared SHA-256 route with the exact media type and byte length.
5. Finalize with a versioned manifest describing exactly the same objects, the complete publication inventory, and the exact repository/ref/commit provenance.

Every object is incrementally SHA-256- and media-verified while it streams directly into a temporary object; binary uploads use constant-size validation buffers, and safe text/JSON types have a separate 8 MiB hard ceiling. The server never assembles a second full artifact-sized request buffer. It atomically installs the verified temporary object at its deterministic staging key and verifies it again before immutable promotion. Final keys include both the SHA-256 digest and an encoded canonical media type: a digest identifies bytes, while the media type identifies how those bytes may be interpreted. This preserves older Release reads if identical bytes are later declared under another allowed media type. Promotion is an atomic create: concurrent writers either install the same verified object once or verify the winner, and a conflicting existing object is never overwritten. The upload API accepts only JSON, PDF, ZIP, PNG, JPEG, WebP, GIF, AVIF, plain text, Markdown, MP4, and WebM. It rejects active SVG, HTML, JavaScript, and CSS objects, including active bytes mislabeled as `text/plain`, and rechecks S3 content type, digest metadata, byte length, and media structure when reading an object.

HTML, JavaScript, CSS, and SVG may exist only as members of the deterministic publication ZIP and retain their real media types in its canonical inventory. The control plane stores and verifies that ZIP as immutable release evidence; it never expands or serves those members from the control-plane origin. The separate gateway resolves the current Channel and Release atomically, revalidates the bound inventory, streams and verifies the complete archive into a private bounded extraction, and only then serves the exact requested inventory member. It never emits MinIO keys, endpoints, or presigned URLs.

### Upload resource controls and recovery

Upload admission is applied before reading a body. The defaults permit at most 250 MiB per object, 512 objects and 2 GiB per upload, 32 active uploads/8 GiB of declared active bytes per tenant, and 2,048 active uploads/256 GiB globally. PostgreSQL advisory locks serialize those active-session reservations across cloud replicas. Per-process stream admission additionally permits four objects/512 MiB per tenant and 64 objects/8 GiB globally; when running multiple cloud replicas, divide those process limits by the replica count or enforce the desired fleet ceiling at the load balancer. Tenant exhaustion returns `429`; global exhaustion returns `503` so clients can retry with backoff.

Configure these ceilings with `SCENEBOOK_MAX_OBJECT_BYTES`, `SCENEBOOK_MAX_UPLOAD_OBJECTS`, `SCENEBOOK_MAX_UPLOAD_BYTES`, the `SCENEBOOK_MAX_ACTIVE_*` variables, and the `SCENEBOOK_MAX_CONCURRENT_*` variables in `.env.example`. Keep the tenant value at or below its corresponding global value. The declared limits are admission controls, not a replacement for reverse-proxy body/time limits, MinIO quotas, or host memory limits.

An idempotency key is scoped to its Workspace. Retrying the same begin request returns the original upload even when a concurrent copy committed while the request waited for capacity locks; reusing the key for different input returns a conflict. The Action also derives stable keys for the exact Scene revision, Run, and Build envelopes. Object routes are content-addressed and safe to repeat. A failed or disconnected stream removes its temporary object. If a process stops after committing the deterministic staged object but before recording it, expiry collection probes and removes that crash-window object.

Uploads expire with their short-lived upload credential. A bounded collector runs on startup and every `SCENEBOOK_UPLOAD_GC_INTERVAL_MS`, claims at most `SCENEBOOK_UPLOAD_GC_BATCH_SIZE` expired uploads with PostgreSQL `FOR UPDATE SKIP LOCKED`, and leases each claim for `SCENEBOOK_UPLOAD_GC_CLAIM_TTL_SECONDS`. A failed worker leaves the claim retryable after its lease. The collector deletes only staging-prefix objects without a finalized key; finalized uploads are excluded from claims and the application object-store identity cannot delete finalized content.

## Evidence and Release promotion API

Administrative routes accept a signed human Session or scoped personal API token. Authorization is the intersection of the credential's Workspace/Project/Channel binding and scopes with the User's live Workspace role. Membership, User disabled state, token/Session expiry, and revocation are rechecked in PostgreSQL on every request. Review comments, decisions, approvals, and audit events use the authenticated User ID; `X-Scenebook-Actor` and caller-authored actor fields are ignored.

`SCENEBOOK_ADMIN_TOKEN` remains an explicit bootstrap and emergency-operator credential whose actor is `admin`. Keep it only in the control-plane secret store and operator shell: never expose it to Studio, a published viewer, a private-portal browser, or CI. CI uses only GitHub OIDC and the short-lived `artifact:write` credential described below.

### Human identity bootstrap and RBAC

This deployment does not invent an OAuth or email provider. Bootstrap a User with the operator token, assign a Workspace membership, then mint a personal API token whose plaintext is returned exactly once:

```text
POST /v1/operator/users
GET/DELETE /v1/operator/users/:userId
PUT  /v1/operator/workspaces/:workspaceId/memberships
POST /v1/operator/workspaces/:workspaceId/users/:userId/api-tokens
```

The last request specifies a name, unique `scopes`, optional `projectId`/`channelId`, and `expiresAt`. Supported scopes are `workspace:read`, `workspace:admin`, `project:read`, `project:write`, `review:read`, `review:write`, `channel:read`, `channel:write`, `release:write`, `schedule:read`, `schedule:write`, `runner:admin`, `analytics:read`, and `audit:read`. Roles cap those scopes: Owners can use all; Editors can create/edit/publish, coordinate schedules, and read analytics but cannot manage membership, Runner credentials, or audit; Reviewers and Viewers can inspect schedules but cannot mutate them. Only Owners can administer Runner credentials. Project- or Channel-bound credentials fail closed outside that exact scope.

For a first local deployment, the following creates one synthetic Workspace, Project, Owner, and
30-day Project-bound Studio token. Run it from `deploy` after the readiness checks, replace the
example identity, and copy only the final response's `credential` value into Studio:

```sh
CONTROL=http://127.0.0.1:4310
ADMIN_TOKEN=$(sed -n 's/^SCENEBOOK_ADMIN_TOKEN=//p' .env)
EXPIRY=$(docker compose exec -T cloud node -e \
  "console.log(new Date(Date.now() + 30 * 86400000).toISOString())")

curl --fail-with-body -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d \
  '{"id":"workspace_acme","slug":"acme","name":"Acme"}' \
  "$CONTROL/v1/admin/workspaces"
curl --fail-with-body -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d \
  '{"id":"project_demo","slug":"demo","name":"Demo"}' \
  "$CONTROL/v1/admin/workspaces/workspace_acme/projects"
curl --fail-with-body -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d \
  '{"id":"user_admin","email":"owner@example.invalid","displayName":"Workspace owner"}' \
  "$CONTROL/v1/operator/users"
curl --fail-with-body -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d \
  '{"userId":"user_admin","role":"owner"}' \
  "$CONTROL/v1/operator/workspaces/workspace_acme/memberships"
curl --fail-with-body -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d \
  "{\"name\":\"Hosted Studio\",\"scopes\":[\"workspace:read\",\"project:read\",\"project:write\"],\"projectId\":\"project_demo\",\"expiresAt\":\"$EXPIRY\"}" \
  "$CONTROL/v1/operator/workspaces/workspace_acme/users/user_admin/api-tokens"
```

The example uses deterministic IDs so rerunning a creation request returns a conflict instead of
silently creating duplicates. The personal token is not stored in `.env`; save it in the User's
password manager and revoke it from the operator API if it is exposed.

Exchange a personal API token for a shorter signed Session with `POST /v1/auth/sessions` and `{}`. Inspect the current identity at `GET /v1/auth/me`; revoke the current Session with `DELETE /v1/auth/sessions/current`. Session authorization is copied from the source token, cannot outlive it, and does not broaden its scope. The source token is rechecked on every Session request, so revoking a compromised personal token immediately invalidates every Session derived from it. A User may list, create, or revoke their own non-escalating tokens at `GET/POST/DELETE /v1/admin/workspaces/:workspaceId/api-tokens...`; an Owner lists and manages memberships under the corresponding `/v1/admin/.../memberships` routes. Operator routes can list the same records, disable a User globally, and recover a tenant when no Owner remains. List responses never include stored credential hashes.

### Connect the hosted Studio

Open the Studio origin on port `8080`, then open **Project settings → Workspace storage**. Paste an
Owner or Editor personal API token with `workspace:read`, `project:read`, and `project:write`. Studio
exchanges it for a shorter Session, clears the token input, and lets the User choose an accessible
Project. The Session exists only in that browser tab; reconnect after closing the tab. The operator
token must never be pasted into Studio.

Local and hosted workspaces remain separate. Connecting does not upload the browser's existing local
library; import a reviewed portable Scene or project archive after connecting when a migration is
intended. Disconnecting restores the previous local Project selection without deleting either side.

Hosted Scene working documents, Project configuration, and the last 100 saved revisions live in
PostgreSQL. Embedded media is removed from JSON, irreversibly masked where opaque masks are authored,
stream-verified, and finalized as private content-addressed objects in MinIO before the database save
commits. A stale save or delete conflicts instead of overwriting another collaborator. These records
are still drafts: they do not create passing evidence, approvals, or Releases.

Configure maximum lifetimes with `SCENEBOOK_SESSION_TTL_SECONDS`, `SCENEBOOK_API_TOKEN_MAX_TTL_SECONDS`, and `SCENEBOOK_SHARE_LINK_MAX_TTL_SECONDS`. Generate the Ed25519 pair as base64-encoded DER:

```sh
openssl genpkey -algorithm Ed25519 -out identity-signing.pem
openssl pkey -in identity-signing.pem -outform DER | base64 | tr -d '\n'
openssl pkey -in identity-signing.pem -pubout -outform DER | base64 | tr -d '\n'
```

Put the first encoded value in `SCENEBOOK_IDENTITY_SIGNING_PRIVATE_KEY` and the second in `SCENEBOOK_IDENTITY_VERIFICATION_PUBLIC_KEY`; securely remove or archive the PEM according to the deployment's key-custody policy. `SCENEBOOK_IDENTITY_PREVIOUS_VERIFICATION_PUBLIC_KEYS_JSON` is a JSON array of at most three SPKI public keys. Verification derives the `kid` from each key, rejects duplicate IDs, selects only the exact token `kid`, and still pins EdDSA, issuer, audience, and token type.

Rotate without invalidating live Sessions or private-share URLs:

1. Generate the new pair. Add its public key to the rollover JSON array on both control plane and gateway while the old pair remains active, then deploy both verifiers.
2. Switch the active private/public pair to the new pair on the control plane and gateway. Move the old public key into the rollover array and remove the now-active new key from that array, then deploy again.
3. Retain the old public key for at least the greater of the configured Session and private-share maximum lifetimes, plus the five-second verification clock tolerance. Remove it only after that window.

The gateway receives only active and rollover public keys. Rotating `SCENEBOOK_IDENTITY_TOKEN_SECRET` separately invalidates personal API tokens without changing signed Sessions or shares.

## Scheduled verification and customer-owned Runners

Scenebook coordinates scheduled verification but does not run Playwright in the control plane. A
Schedule stores only a bound `owner/repository`, canonical Git branch/tag ref, opaque Environment
ID, and explicit Run Target IDs. It cannot contain a URL, shell command, browser arguments,
credentials, or network policy. The external Runner resolves the Environment ID in its own trusted
configuration and executes the repository's ordinary Scenebook/Playwright workflow.

Discover a Project's repository-binding IDs and manage Schedules through:

```text
GET   /v1/admin/workspaces/:workspaceId/projects/:projectId/repositories
POST  /v1/admin/workspaces/:workspaceId/projects/:projectId/schedules
GET   /v1/admin/workspaces/:workspaceId/projects/:projectId/schedules[/:scheduleId]
PATCH /v1/admin/workspaces/:workspaceId/projects/:projectId/schedules/:scheduleId
POST  .../:scheduleId/pause
POST  .../:scheduleId/resume
POST  .../:scheduleId/trigger
GET   /v1/admin/workspaces/:workspaceId/projects/:projectId/verification-jobs
GET   /v1/admin/workspaces/:workspaceId/projects/:projectId/verification-jobs/:jobId
POST  /v1/admin/workspaces/:workspaceId/projects/:projectId/verification-jobs/:jobId/cancel
```

Creation uses an interval of 300 seconds to one year, a freshness target at least as long as that
interval, a bounded maximum runtime, and one to ten lease attempts. PATCH requires the current
integer `expectedVersion`. Pausing prevents new due Jobs without discarding history; manual
triggering remains available for an explicit diagnostic run and requires an `Idempotency-Key`.
Resume can run immediately or set a future `nextDueAt`. Schedule responses derive `fresh`,
`due-soon`, `stale`, or `never-verified` from immutable successful Build completion rather than a
caller-authored health flag.

The PostgreSQL scheduler locks due rows with `FOR UPDATE SKIP LOCKED`, inserts each occurrence under
a deterministic `(schedule, dueAt)` identity, and advances the next occurrence in the same
transaction. A process crash therefore cannot advance a Schedule without preserving its Job.
Expired leases return to the queue until `maxAttempts`; exhaustion becomes an immutable failed Job.
Tune only coordination load with `SCENEBOOK_SCHEDULER_INTERVAL_MS` and
`SCENEBOOK_SCHEDULER_BATCH_SIZE`. These settings never enable managed browser execution.

Owners create, list, rotate, and revoke least-privilege Runner credentials at:

```text
POST   /v1/admin/workspaces/:workspaceId/projects/:projectId/runners
GET    /v1/admin/workspaces/:workspaceId/projects/:projectId/runners
POST   /v1/admin/workspaces/:workspaceId/projects/:projectId/runners/:runnerId/rotate-token
DELETE /v1/admin/workspaces/:workspaceId/projects/:projectId/runners/:runnerId
```

The plaintext `sbk_runner` credential is returned once; list responses omit its HMAC hash. Each
Runner is authorized for an explicit non-empty Schedule set and cannot call human, administrative,
upload, or public APIs. Runner data-plane calls are limited to:

```text
POST /v1/runner/jobs/claim
POST /v1/runner/jobs/:jobId/heartbeat
POST /v1/runner/jobs/:jobId/complete
```

A claim returns a random lease ID, a hard execution deadline, and an immutable execution contract
with a server-assigned expected Build ID. Heartbeats cannot extend beyond the Schedule's maximum
runtime. Completion succeeds only while that exact Runner/lease is live. A verified completion must
reference the assigned terminal, complete Build whose repository/ref, trigger, Project, and Run
Target set match the Job; callers cannot declare “passed” directly. Record the Run and Build
evidence first through the existing GitHub OIDC flow (including on a customer-owned GitHub Runner)
or an explicitly provisioned Project evidence identity, then complete the Job. The coordination
credential itself can never upload or author evidence.

Generate `SCENEBOOK_RUNNER_TOKEN_SECRET` independently from every other secret. Rotating it
invalidates every outstanding Runner credential; then rotate each active Runner through its admin
route. `SCENEBOOK_RUNNER_LEASE_SECONDS` controls the renewable lease slice, not the hard runtime.
Runner creation/rotation/revocation, claims, terminal outcomes, automatic enqueue, lease recovery,
and exhaustion append tenant audit events. Alert on stale critical Schedules and the scheduler
metrics described under Operations.

### Private portal grants and share links

Only a Channel whose kind is `private-portal` accepts grants. Channel writers create/revoke a User or anonymous-link grant under:

```text
POST   /v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/portal/grants
DELETE /v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/portal/grants/:grantId
POST   /v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/portal/share-links
DELETE /v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/portal/share-links/:linkId
```

User grants may be `view` or `review`; link grants are always `view`. Review access additionally requires a per-user credential with `review:write`, which preserves authenticated attribution. `GET .../portal/grants` and `GET .../portal/grants/:grantId/share-links` provide bounded management lists without credential hashes. Share-link creation returns a URL whose credential stays in the browser fragment. The included minimal `/portal/private` shell removes that fragment, exchanges it through `POST /v1/portal/share/resolve`, and renders the current private Release. The resolver rechecks the JWT signature, constant-time token hash, link and grant expiry/revocation, exact tenant/Project/Channel, private Channel kind, and current Release on every request. Revocation therefore takes effect without waiting for the signed token to expire.

For an authenticated User grant, the Console calls `POST .../portal/login-handoffs` with its signed
control-plane Session and then navigates to the returned first-party publication `/login` URL. API
tokens cannot mint handoffs directly. The fragment contains a random 256-bit, short-lived,
single-use credential—not the Session—and `/login` clears it before a strict same-origin bootstrap
POST. The gateway consumes it over the private service network using
`SCENEBOOK_GATEWAY_EXCHANGE_SECRET`, then sets an `HttpOnly`, `SameSite` publication cookie. The
stored digest is bound to the source Session, exact User grant, publication origin, and exact return
path. Consumption and its append-only audit event commit in one database transaction: an audit
failure does not burn the credential, while a completed consumption rejects every replay. Both
consumption and every subsequent member request recheck the live User, source Session/token, grant,
Channel, and current Release. User Portal grants may
deliberately authorize an external User without Workspace membership. Configure the handoff lifetime
with `SCENEBOOK_PUBLICATION_LOGIN_TTL_SECONDS` (60 seconds by default).

Authenticated portal clients use `GET /v1/portal/workspaces/:workspaceId/projects/:projectId/channels/:channelId` and the nested Release-review GET/comment/decision routes. The `/portal/private` reference shell covers view-only signed links and strips the credential fragment before resolving it. The operator-facing `/console` is a separate first-party application for signed-in Workspace Users; it includes Scene/evidence inventory, Baseline/current screenshot comparison, reviewer assignment, region comments with attributed resolve/reopen actions, Channel/Release history and rollback, private-share creation, recurring-verification schedules, durable Jobs, external Runner credentials, custom-domain lifecycle management, aggregate analytics, memberships, scoped personal tokens, and audit history.

### First-party Console and bounded list APIs

Open `/console` on the same HTTPS origin as the control plane. Paste a personal API token, not the operator token. The browser sends that credential only to `POST /v1/auth/sessions`, clears the field immediately, and keeps the returned short-lived Session in `sessionStorage`. Its nonce-bound, dependency-free application is served with `default-src 'none'`, same-origin connections, blob-only evidence images, no framing, no third-party scripts, no inline-script exception, and `Cache-Control: no-store`. Signing out revokes the Session server-side; live membership, User, source-token, and Session revocation are still checked on every API request.

The Console consumes bounded, tenant-filtered `GET` collections under the existing administrative namespace:

```text
/v1/admin/workspaces/:workspaceId/projects
/v1/admin/workspaces/:workspaceId/projects/:projectId/scenes
/v1/admin/workspaces/:workspaceId/projects/:projectId/reviews
/v1/admin/workspaces/:workspaceId/projects/:projectId/reviewers
/v1/admin/workspaces/:workspaceId/projects/:projectId/evidence/{runs,builds,baselines,approvals}
/v1/admin/workspaces/:workspaceId/projects/:projectId/channels
/v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/releases
/v1/admin/workspaces/:workspaceId/projects/:projectId/{repositories,schedules,verification-jobs,runners}
```

Each accepts only a single integer `limit` within its documented hard maximum and applies the same live human-authorization scope as the corresponding item route. Scene lists return the newest immutable revision per Scene, never an arbitrary historical row. Evidence screenshots use `GET .../assets/:sha256?mediaType=image/png` (or `image/jpeg`); the server resolves only finalized objects belonging to that exact Workspace and Project, revalidates their digest and byte length through the immutable object store, and returns them with private immutable caching. The Console fetches pixels with its Authorization header and displays them through short-lived blob URLs. It never exposes a globally addressable object-store URL.

Review assignment and comment-resolution mutations are optimistic and attributed to the authenticated User:

```text
PUT /v1/admin/workspaces/:workspaceId/projects/:projectId/reviews/:reviewId/assignees
PUT /v1/admin/workspaces/:workspaceId/projects/:projectId/reviews/:reviewId/comments/:commentId/resolution
```

An assignee must be an enabled User with a current Owner, Editor, or Reviewer membership in the same Workspace. The assignment request carries the complete last-observed `expectedAssignedTo` set; resolve and reopen requests carry the last-observed `expectedResolvedAt`. Stale writes conflict instead of overwriting another reviewer. CI and GitHub OIDC credentials cannot assign reviewers, resolve comments, or forge attribution.

The OIDC exchange token is a deliberately smaller exception. Its sole `artifact:write` permission can call only the exact `POST` routes for Scene revisions, Runs, and Builds in its bound Workspace and Project. Each request must byte-for-byte match a canonical JSON request envelope in the same finalized upload and carry that upload ID. Every Run screenshot reference must also resolve to the exact digest, media type, and byte length of a finalized object in that upload; a JSON envelope cannot smuggle an unuploaded or mutable screenshot reference into later review. The server rechecks repository, workflow, ref, commit, clean-tree provenance, passed execution/build state, and clear privacy state before recording the GitHub Actions actor. The token cannot read administrative data or create Baselines, approvals, Releases, Channels, or other evidence. Those decisions remain behind the administrator/reviewer boundary.

Record and promote evidence in this order:

1. Persist the exact Scene revision with `POST /v1/admin/workspaces/:workspaceId/projects/:projectId/scenes/revisions`.
2. Record the completed Run at `.../evidence/runs`. Its project, repository binding, source revision, expected Steps, selected attempt, status, and privacy state are checked. The server computes its artifact hash.
3. Record the terminal Build at `.../evidence/builds`. Every required Run reference must resolve to the stored Run ID and exact artifact hash, status, target, Scene, and repository revision.
4. Record the complete Baseline at `.../evidence/baselines`. Its selected attempt, State bytes/hashes, Checks hash, source revision, and Run artifact hash must match the stored passed Run.
5. Record visual/editorial approvals at `.../evidence/approvals`, referring to the Baseline ID. Submit the entire baseline-free Release candidate to the same route for the release approval; the server binds that approval to the candidate's canonical SHA-256.
6. Promote at `.../channels/:channelId/releases` with `{ release, evidence }`. `evidence` contains the stored release approval ID and, per Scene, Run/Baseline/visual/editorial approval IDs. The Release candidate does not accept `readiness`, `approvals`, `baselineId`, `carriedForward`, status, sequence, or publication timestamps; the server derives them.

Promotion reconstructs criticality, execution/change status, localization completeness, approval state, candidate revision, and prior Release revision from stored evidence. It also requires the finalized manifest's repository and commit to equal the verified Build. The resulting Release stores an immutable evidence ledger containing every Run, Build, Baseline, approval, upload, manifest, and candidate hash used for the decision. Evidence records and that ledger are append-only at the database layer.

Validation and unknown/mismatched evidence return `422`; blocked Channel policy, dirty builds, stale privacy state, and compare-and-swap/idempotency conflicts return `409`; temporarily unavailable immutable objects return `503`. Invented IDs, actor fields, stale-commit uploads, self-authored pass/readiness claims, and approvals bound to another candidate or Baseline are rejected before the Channel pointer changes. Release promotion is transactional in PostgreSQL and uses compare-and-swap against the Channel's current Release.

## Webhooks and CTA data

Webhooks are preconfigured through `SCENEBOOK_WEBHOOKS_JSON`; an administrator must then allow specific webhook IDs on each Channel. A public CTA submission must identify an exact Step in the current immutable Scene revision, that Step must contain an authored form CTA, and the submitted webhook must match both the form and the Channel allowlist. Unknown fields, missing required values, invalid email/text types, and ungranted required consent are rejected before encryption or delivery. Callers can never supply a URL, preventing one tenant or publication from targeting another tenant's integration. HTTPS is mandatory by default. DNS is resolved before dispatch, every resolved address must be public, the selected address is pinned for the request, redirects are not followed, and responses are aborted once they exceed 64 KiB. Each body is signed with `X-Scenebook-Timestamp` and `X-Scenebook-Signature: sha256=...`.

CTA bodies are encrypted with AES-256-GCM before database storage. Logs redact tokens, secrets, payload-like keys, and email addresses. Delivery retries use exponential backoff, recover stale locks after a worker crash, and become terminal after eight attempts.

Analytics and CTA submissions must target the Channel's current Release. The service verifies Release ID and Scene membership; analytics verifies Step membership when supplied, while CTA submission always requires the exact authored Step and form contract. Stale Release traffic is rejected rather than silently attributed to the new publication.

Funnel reporting is an administrative read, not a capability of the embedded Channel token. Query `GET /v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/analytics/funnel` with the admin bearer token. The optional `releaseId`, `from`, and `to` query parameters are strictly validated and limited to a 90-day interval. Results contain only aggregate accepted-event and privacy-safe unique-subject counts plus completion, dropoff, Step reach, and CTA conversion rates; raw event IDs, properties, and subject hashes never leave the repository layer. Responses use `Cache-Control: private, no-store`.

Example configuration value:

```json
[
  {
    "id": "crm",
    "url": "https://hooks.example.com/scenebook",
    "secret": "replace-with-32-or-more-random-characters",
    "timeoutMs": 10000
  }
]
```

Rotate a webhook secret by accepting both old and new signatures at the receiver, updating `.env`, restarting `cloud`, and then removing the old receiver secret. Rotating `SCENEBOOK_CTA_ENCRYPTION_KEY` requires a data migration because existing envelopes use the current key.

## Managed custom domains

Custom domains are disabled unless all of `SCENEBOOK_CUSTOM_DOMAIN_ROUTING_TARGET`,
`SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_URL`, and
`SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_SECRET` are configured. The secret must be independent from
every control-plane, upload, identity, runner, analytics, and webhook secret. Production requires an
HTTPS provisioner URL. `SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_TIMEOUT_MS` defaults to 10 seconds.
The provisioner hostname is resolved on every call, every address must be public, and the selected
address is pinned into the request so a later DNS answer cannot redirect the operation into a
private network. Redirects and responses larger than 64 KiB are rejected.

Only `public-catalog` and `private-portal` Channels accept a custom domain. A Channel can have one
live domain claim, and a canonical hostname can belong to only one live claim across all tenants.
Unverified pending claims do not reserve a hostname globally; the first exact DNS proof promoted to
`ready-to-provision` wins the database uniqueness race. This prevents one tenant from squatting
another tenant's hostname without controlling its DNS.
Create and inspect claims under:

```text
POST /v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/custom-domains
GET  /v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/custom-domains
GET  /v1/admin/workspaces/:workspaceId/projects/:projectId/channels/:channelId/custom-domains/:domainId
POST .../:domainId/challenge
POST .../:domainId/verify-dns
POST .../:domainId/activate
POST .../:domainId/refresh
POST .../:domainId/disable
POST .../:domainId/remove
```

Every mutation after creation requires the last observed integer `expectedVersion`, so two
operators cannot silently overwrite each other. Creation returns a TXT challenge at
`_scenebook-challenge.<hostname>` plus the configured CNAME routing target. Hostnames are normalized
to lower-case IDNA ASCII and reject URL syntax, credentials, ports, wildcards, IP literals,
single-label names, private-use suffixes, invalid labels, and the control-plane or routing-target
hostname. Rotate a challenge whenever ownership proof may have leaked; a rotated claim cannot be
activated again until the exact new TXT value is observed. Once provisioning has begun, disable
the ingress before rotating its ownership challenge so an active route is never confused with an
unverified replacement proof.

The lifecycle is deliberately split:

```text
pending-dns -> ready-to-provision -> provisioning -> active
active/failed -> disabling -> disabled
any nonremoved claim -> removing -> removed
```

DNS verification proves only control of the TXT record. It never claims that a certificate exists
or that a CDN/ingress route is live. Activation also requires a current immutable Channel Release,
then a configured provisioner must explicitly report both `certificate: "ready"` and
`routing: "ready"`. Disable completes only after `routing: "disabled"`. Removal completes—and the
database uniqueness claims are released—only after both `certificate: "removed"` and
`routing: "removed"`. Pending, failed, mismatched, unauthenticated, or unavailable provider results
remain non-active and append an audit event.

The provider endpoint receives an HMAC-authenticated JSON request containing `schemaVersion: 1`,
`action: "reconcile"`, a stable `operationKey`, the desired state (`active`, `disabled`, or
`removed`), and the exact Workspace/Project/Channel/domain identity. It must make reconciliation
idempotent by `operationKey`. The strict response is:

```json
{
  "operationKey": "domain-operation-...",
  "operationId": "provider-operation-...",
  "hostname": "stories.example.com",
  "desiredState": "active",
  "certificate": "pending",
  "routing": "pending"
}
```

`certificate` is one of `not-requested`, `pending`, `ready`, `failed`, or `removed`; `routing` is one
of `not-requested`, `pending`, `ready`, `disabled`, `failed`, or `removed`. An optional bounded
`failureCode` may use lower-case letters, digits, dots, underscores, colons, and dashes. Requests
carry `X-Scenebook-Timestamp`, `Idempotency-Key`, and
`X-Scenebook-Signature: sha256=<HMAC(timestamp + "." + body)>`. The response body must be signed
with the same secret and request timestamp. Scenebook rejects another hostname, operation key,
desired state, impossible state combination, or invalid signature.

This adapter is a control-plane/ingress contract, not a built-in certificate authority or CDN.
Deployers implement certificate and edge routing, but route active custom hostnames to the included
gateway. The gateway accepts only a globally unique `active` domain whose DNS proof, certificate,
and routing observation are ready, then binds it to that exact tenant, Channel, and current Release
in one database snapshot. Leaving the adapter disabled is fail-closed; DNS proof alone never serves.

## Publication gateway and static exports

Default hosted links use `/s/<workspace-slug>/<project-slug>/<channel-slug>/...` on `SCENEBOOK_PUBLICATION_URL`. An active custom hostname maps `/...` to one exact Channel. Stable current URLs use `public, max-age=0, must-revalidate` plus content ETags; every private response uses `private, no-store`. HTML receives per-document script/style hashes, a bounded connection policy, no MIME sniffing, no referrer, and restrictive frame policy. Byte ranges are supported for documents and media.

Share and authenticated-User handoff credentials exist only in the URL fragment. `/share` and `/login` remove the fragment from browser history before exchanging it in a same-origin JSON request for an HttpOnly, SameSite signed Session cookie. User handoffs are available only on the configured first-party publication origin; active custom domains continue to use the resulting Channel-scoped gateway authorization rather than receiving a control-plane Session. Every private member request rechecks the cookie and live share link/grant or User/source Session/token/grant records, so revocation takes effect on the next request. The gateway never logs request bodies; configure the edge not to log fragments (which are not sent in HTTP requests) or sensitive headers/cookies.

Publication ZIPs are never unpacked by path. The gateway compares each member to the sorted Release inventory, rejects traversal and unknown members, hashes all uncompressed bytes, and writes members to new `0600` temporary regular files named only by index and digest. Before either cache materialization or one-member extraction, it rejects the entire archive if any inventory member exceeds `SCENEBOOK_GATEWAY_MAX_MEMBER_BYTES`; requesting a different small member cannot bypass that bound. A bounded process-local LRU lets one verified extraction serve all screenshots and media in that immutable archive; authorization and the current pointer are still rechecked before every cache lookup. Archives too large for the cache, but whose individual members remain within the member bound, fall back to a one-member verified extraction. No bytes are sent until verification completes. `SCENEBOOK_GATEWAY_MAX_CACHE_BYTES`, `SCENEBOOK_GATEWAY_MAX_MEMBER_BYTES`, `SCENEBOOK_GATEWAY_MAX_RESPONSES`, and the gateway `/tmp` tmpfs jointly bound disk and concurrency. Increase them deliberately for larger video outputs and keep cache plus concurrent fallback capacity below temporary-storage capacity.

The `static` service remains an optional, operator-mounted export origin for teams that want compiler output deployed through another CDN. It does not follow PostgreSQL Channel pointers and is not the hosted gateway. The built-in CLI's filesystem publication remains atomic for those local/static destinations.

## Migrations

Automatic migrations are safe to run from multiple replicas because they take an advisory lock and record a SHA-256 checksum. A migration already applied with different bytes fails startup. To migrate explicitly:

```sh
./scripts/migrate.sh
```

Take a backup before upgrading. Never edit an applied SQL migration; add a new numbered migration.

## Backup and restore

The backup script requires a new destination beneath an existing parent. It briefly stops `cloud`
only when that service was already running, mirrors an exact logical snapshot of the `scenebook`
bucket, dumps PostgreSQL, writes per-file checksums, and restores the prior cloud running state. The
snapshot includes hosted Studio drafts, Project settings, version history, and their object payloads
alongside evidence and Releases. The read-only gateway can keep serving the last stable pointer
during backup:

```sh
./scripts/backup.sh /srv/backups/scenebook/$(date -u +%Y%m%dT%H%M%SZ)
```

The script starts with `umask 077` and accepts only an unambiguous leaf beneath an existing,
symlink-free physical parent. Dot segments, repeated or trailing separators, symlink parents,
symlink destinations, and non-directory destinations are rejected before anything is created or
chmodded; create the intended parent separately first. The script then forces and verifies mode
`0700` on the destination and verifies the completed tree contains only `0700` directories and
`0600` files. Treat a permission-validation failure as a failed backup even when data files exist;
inspect and remove that incomplete destination before retrying. Preserve these modes when copying
the directory, in addition to encrypting the off-host copy. Restore applies the same unambiguous,
symlink-free source-path rules and rejects any symbolic link inside the backup tree before stopping
services or restoring data.

Copy the resulting directory to encrypted off-host storage. Test restoration regularly on an isolated host:

```sh
./scripts/restore.sh /srv/backups/scenebook/20260720T120000Z --confirm-destructive-restore
```

Restore is destructive for database and bucket state. It verifies every backup checksum, records which traffic-facing services were running, stops them, restores PostgreSQL in one transaction, and mirrors the object snapshot with removal of stale bucket objects. Only the services that were previously running are restarted after full success; a failed restore leaves them stopped. Afterward, verify `/readyz`, inspect migration checksums, open a known public Release, and perform a non-production CTA delivery.

## Operations

- Scrape `/metrics`; alert on readiness failures, elevated 5xx counts, webhook exhaustion, `scenebook_upload_admission_rejections_total`, `scenebook_upload_gc_failures_total`, scheduler iteration failures, exhausted Runner leases, and a sustained nonzero `scenebook_upload_active_bytes`. Scheduled workload and recovery are exposed through `scenebook_verification_jobs_enqueued_total`, `scenebook_verification_job_leases_recovered_total`, and `scenebook_verification_scheduler_last_duration_ms`. Capacity planning can use `scenebook_upload_staged_bytes_total`; collection throughput is exposed through `scenebook_upload_gc_claimed_total`, `scenebook_upload_gc_deleted_objects_total`, and `scenebook_upload_gc_deleted_bytes_total`.
- Keep PostgreSQL and MinIO on private networks. Restrict the MinIO console separately or do not publish it.
- Terminate TLS and apply request limits at the edge as well as in the application.
- Ensure the edge overwrites `X-Real-IP` and `X-Forwarded-For`; the application enforces both a per-client aggregate request budget and narrower per-operation budgets. Route IDs never enter limiter keys, every non-route shares one bounded `unmatched` scope, and the limiter fails closed at its bounded in-memory client capacity. Tune `SCENEBOOK_RATE_WINDOW_MS`, `SCENEBOOK_RATE_REQUESTS`, and `SCENEBOOK_RATE_AGGREGATE_REQUESTS` together with edge limits.
- Preserve the append-only audit table. Database triggers reject updates and deletes for audit events, Scene revisions, verification Runs/Builds/Baselines, approval evidence, review comments/decisions, and analytics events; Release content, manifest hashes, and promotion evidence are immutable.
- Upgrade pinned container versions deliberately after reading their release notes and completing a backup/restore drill.
