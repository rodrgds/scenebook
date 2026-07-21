# Portable Scene format

The public schema lives in `@scenebook/schema`. `scene.yaml` is the presentation-first authored source; it is not an execution script or mutable run report.

## Minimal shape

```yaml
schemaVersion: 1
id: invite-member
slug: invite-member
title: Invite a teammate
status: draft
capability: captured
criticality: normal
audience: [workspace-admin]
tags: [team-management]
defaultLocale: en
locales: []
translations: {}
steps:
  - id: open-invitation-form
    kind: browser
    title: Open the invitation form
    instruction: Choose Invite member.
    states:
      before:
        id: members-before-invite
        route: /settings/members
        screenshot:
          sha256: <64 lowercase hex characters>
          path: assets/<sha256>.png
          mediaType: image/png
          byteLength: 48231
          role: screenshot
          width: 1440
          height: 900
        viewport:
          width: 1440
          height: 900
          deviceScaleFactor: 1
          isMobile: false
        scroll: { x: 0, y: 0 }
    actions: []
    checks: []
    masks: []
    choices: []
    ctas: []
automation: { level: none }
assets: []
metadata: {}
```

## Stable identities

Scene, Step, State, Check, mask, annotation, choice, Collection entry, Run, attempt, baseline, Channel, and Release IDs are durable bindings. Reordering a Step changes only its array position. Renaming narrative does not change identity.

## Step kinds

- `browser`: captured pre/post browser States, optional target, Actions, and Checks
- `intro`, `separator`, `explanation`: authored presentation without fake browser activity
- `choice`: bounded links to other linear Scenes; loops and arbitrary logic are invalid
- `end`: final narrative and optional safe CTA/form

Executable Scenes remain linear. A presentation branch links to another independently executable and independently verified Scene.

## CTAs and localization

`steps[].ctas` is the canonical action list. Every entry has a stable `id`, a `primary` or
`secondary` variant, and one of the bounded CTA kinds. Forms declare typed fields and an optional
logical `webhookId`; portable source never contains a credential or arbitrary submission URL. For
schema-version-1 compatibility, readers still accept `steps[].cta` as a single primary action when
`ctas` is empty.

Inline authored translations use `translations.<locale>` and can override Scene text, Step text,
choice labels, CTA labels, and form-field labels by stable ID. `locales[]` can still point to YAML
sidecars. When both exist, the compiler deep-merges the locale sidecar first and applies matching
inline values last. This lets Studio export a self-describing YAML file or ZIP without relying on
private editor metadata.

```yaml
translations:
  pt-PT:
    title: Convidar colega
    steps:
      finished:
        title: Convite enviado
        ctas:
          read-guide:
            label: Ler o guia
steps:
  - id: finished
    kind: end
    title: Invitation sent
    ctas:
      - id: read-guide
        variant: primary
        kind: read-docs
        label: Read the guide
        url: https://docs.example.test/invitations
      - id: restart
        variant: secondary
        kind: restart
        label: Start again
```

## Sensitive values

Actions never contain literal sensitive values. They use fixture references or `redacted`. Automatic masks must be opaque and describe their classification and scope. Asset filenames begin with the exact SHA-256 digest of their bytes.

## Compatibility

Readers validate `schemaVersion` before interpretation. Migrations are explicit pure transformations, retain stable IDs, report every change, and never overwrite source without a requested write operation. Unknown future versions fail with a supported-version diagnostic.
