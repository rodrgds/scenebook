# `@scenebook/gateway`

Scenebook's first-party publication data plane. It is deployed on a different origin from
`@scenebook/server` and is the only hosted service that interprets publication ZIP members as
HTML, JavaScript, CSS, images, documents, or media.

The gateway resolves a path or active custom hostname to one tenant, Channel, and current immutable
Release in a single database snapshot. It validates the Release-bound inventory, reads objects with
digest and media verification, extracts only exact inventory members into private bounded temporary
files, and never returns object-store keys or URLs. Public entrypoints revalidate; private responses
are `no-store` and recheck the signed Session plus the live User, source Session/token, and exact
User Portal grant, or the live share link and link grant, before every file request. A User grant
may deliberately authorize an external User who is not a Workspace member.

The control-plane Console opens an authenticated private Channel through a short-lived, one-use
handoff. The URL fragment contains only a random handoff credential, never the control-plane
Session. `/login` removes that fragment before a same-origin exchange and sets a scoped `HttpOnly`,
`SameSite` gateway cookie. The control plane stores only the credential digest and binds it to the
source Session, User grant, exact publication audience, and return path; consumption atomically
burns it and rechecks live revocation state.

The gateway receives only the control plane's Ed25519 public verification key. It never receives
the private signing key or personal API-token HMAC key, so gateway configuration and database read
access cannot mint a control-plane Session or private-share token. Incoming JSON is read
incrementally and cancelled as soon as it exceeds the configured byte cap; an oversized
`Content-Length` is rejected before the body is read.

The active public key and at most three rollover public keys are selected strictly by the signed
token's derived `kid`; unknown, missing, duplicate, malformed, or non-EdDSA keys/tokens fail closed.
The gateway also incrementally caps and cancels the internal handoff response, including chunked
responses without `Content-Length`.

Every inventory member is checked against `SCENEBOOK_GATEWAY_MAX_MEMBER_BYTES` before cache
materialization or extraction. An archive containing any oversized member is rejected in full,
including requests for a different, smaller member.

Use the `@scenebook/publication-service` process for deployment. See `deploy/SELF_HOSTING.md` for
the required origin split, SELECT-only PostgreSQL role, read-only object-store policy, edge routing,
temporary-storage bounds, and revocation behavior.

License: `AGPL-3.0-only`.
