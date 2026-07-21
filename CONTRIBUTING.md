# Contributing

Scenebook’s public contracts are deliberately conservative. Start with an issue for schema, privacy, artifact, baseline, or Release changes; compatible renderer and UI work can usually begin directly.

```bash
bun install
bun run example:seed
bun run check
bun run test
bun run build
```

Keep changes focused and add a Changeset for published packages. New schema fields need validation, inferred TypeScript types, canonical YAML/JSON round-trip tests, a migration story, and a note on which truth layer owns the value.

Privacy-sensitive changes need a negative test proving the raw canary value never reaches storage, output, logs, or upload payloads. Visual/editor changes should be checked at desktop and mobile widths, by keyboard, with reduced motion, and at 200% zoom.

Do not submit generated evidence containing real credentials, customer data, production URLs, personal auth state, or non-synthetic email/payment details.

## Real backend integration gate

The default test suite does not start infrastructure. Before changing migrations, upload storage, approvals, provenance lookup, or promotion policy, run the explicit backend gate against disposable PostgreSQL and policy-restricted MinIO services:

```bash
SCENEBOOK_BACKEND_INTEGRATION=1 \
SCENEBOOK_TEST_POSTGRES_ADMIN_URL=postgresql://scenebook:password@127.0.0.1:5432/postgres \
SCENEBOOK_TEST_MINIO_ENDPOINT=http://127.0.0.1:9000 \
SCENEBOOK_TEST_MINIO_ACCESS_KEY_ID=scenebook-integration-app \
SCENEBOOK_TEST_MINIO_SECRET_ACCESS_KEY=backend-integration-app-password \
SCENEBOOK_TEST_MINIO_BUCKET=scenebook \
bun run test:integration:backend
```

The PostgreSQL role must be allowed to create and drop databases. The test creates a uniquely named database, applies every migration, exercises the real reporter-to-release workflow, and drops that database afterward. The MinIO credentials must use `deploy/minio-policy.json`: staged-object writes and immutable-object reads/copies are allowed, while direct writes to final object keys are denied. Missing opt-in or service variables fail the target; they never turn it into a skipped test.
