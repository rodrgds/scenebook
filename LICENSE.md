# Licensing

Scenebook uses a source-boundary split license. Unless a more specific license
file or package manifest says otherwise, project-authored files in this
repository are licensed under the **Apache License 2.0**, including the root
development and release tooling, documentation, repository configuration, and
the GitHub Action in `action.yml`.

The following project-authored paths are instead licensed under the **GNU
Affero General Public License v3.0 only**:

- `packages/server` and `packages/gateway`
- `apps/cloud`, `apps/gateway`, `apps/extension`, and `apps/studio`
- `deploy`, including its service images, runtime configuration, and
  operational scripts

The Apache-licensed integration surface includes `packages/schema`,
`packages/core`, `packages/artifact`, `packages/privacy`, `packages/diff`,
`packages/playwright`, `packages/compiler`, `packages/viewer`, `packages/cli`,
`packages/adapters`, and `packages/policy`.

Private fixture packages under `apps/example` and `examples/acme-product` are
marked `UNLICENSED`. They are included for local development and demonstration
but are not granted redistribution rights by either Scenebook license.

The standard license texts are stored at [`LICENSE-APACHE`](./LICENSE-APACHE)
and [`LICENSE-AGPL`](./LICENSE-AGPL). Every npm publication candidate declares
its applicable SPDX identifier and ships an exact package-local `LICENSE` copy.
The AGPL server package also ships its corresponding TypeScript source, SQL
migrations, and self-contained build configuration.

Third-party files keep their upstream terms and notices rather than receiving
the Scenebook default. In particular, `.agents/skills/impeccable` is a vendored
Apache-2.0 work with its own [`LICENSE`](./.agents/skills/impeccable/LICENSE) and
[`NOTICE.md`](./.agents/skills/impeccable/NOTICE.md), including its transitive
platform-design attribution.

This file records the repository's intended license boundaries; it is not legal
advice and does not represent that counsel has reviewed the project. Dependency
licenses and other third-party obligations still apply. Commercial licensing,
contributor agreements, and trademark rights require separate express grants.
