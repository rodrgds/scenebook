#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEPLOY_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TARGET="$DEPLOY_DIR/.env"

usage() {
  printf '%s\n' 'usage: ./scripts/init-env.sh https://control.example.com https://stories.example.com'
}

if [ "$#" -ne 2 ]; then
  usage >&2
  exit 2
fi

CONTROL_URL=$1
PUBLICATION_URL=$2
if ! printf '%s\n' "$CONTROL_URL" | grep -Eq '^https://[^/?#]+$'; then
  printf '%s\n' 'The control-plane URL must be an exact HTTPS origin without a path.' >&2
  exit 2
fi
if ! printf '%s\n' "$PUBLICATION_URL" | grep -Eq '^https://[^/?#]+$'; then
  printf '%s\n' 'The publication URL must be an exact HTTPS origin without a path.' >&2
  exit 2
fi
if [ "$CONTROL_URL" = "$PUBLICATION_URL" ]; then
  printf '%s\n' 'Control-plane and publication origins must be different.' >&2
  exit 2
fi
if [ -e "$TARGET" ]; then
  printf '%s\n' "$TARGET already exists; it was not changed." >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || {
  printf '%s\n' 'openssl is required to generate deployment secrets.' >&2
  exit 1
}

secret() {
  openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'
}

key32() {
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
}

KEY_DIR=$(mktemp -d "${TMPDIR:-/tmp}/scenebook-keys.XXXXXX")
cleanup() {
  rm -f "$KEY_DIR/identity.pem"
  rmdir "$KEY_DIR" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
openssl genpkey -algorithm Ed25519 -out "$KEY_DIR/identity.pem" 2>/dev/null
IDENTITY_PRIVATE=$(openssl pkey -in "$KEY_DIR/identity.pem" -outform DER | base64 | tr -d '\n')
IDENTITY_PUBLIC=$(openssl pkey -in "$KEY_DIR/identity.pem" -pubout -outform DER | base64 | tr -d '\n')

POSTGRES_PASSWORD=$(secret)
GATEWAY_POSTGRES_PASSWORD=$(secret)
MINIO_ROOT_PASSWORD=$(secret)
S3_SECRET=$(secret)
GATEWAY_S3_SECRET=$(secret)
FINAL_DELETE_S3_SECRET=$(secret)
ADMIN_TOKEN=$(secret)
UPLOAD_SECRET=$(secret)
IDENTITY_TOKEN_SECRET=$(secret)
GATEWAY_SESSION_SECRET=$(secret)
GATEWAY_EXCHANGE_SECRET=$(secret)
RUNNER_SECRET=$(secret)
ANALYTICS_SECRET=$(secret)
CTA_KEY=$(key32)

umask 077
set -C
{
  printf 'SCENEBOOK_POSTGRES_PASSWORD=%s\n' "$POSTGRES_PASSWORD"
  printf 'SCENEBOOK_DATABASE_URL=postgresql://scenebook:%s@postgres:5432/scenebook\n' "$POSTGRES_PASSWORD"
  printf 'SCENEBOOK_GATEWAY_POSTGRES_PASSWORD=%s\n' "$GATEWAY_POSTGRES_PASSWORD"
  printf 'SCENEBOOK_MINIO_ROOT_USER=scenebook-minio\n'
  printf 'SCENEBOOK_MINIO_ROOT_PASSWORD=%s\n' "$MINIO_ROOT_PASSWORD"
  printf 'SCENEBOOK_S3_ACCESS_KEY_ID=scenebook-cloud\n'
  printf 'SCENEBOOK_S3_SECRET_ACCESS_KEY=%s\n' "$S3_SECRET"
  printf 'SCENEBOOK_GATEWAY_S3_ACCESS_KEY_ID=scenebook-gateway\n'
  printf 'SCENEBOOK_GATEWAY_S3_SECRET_ACCESS_KEY=%s\n' "$GATEWAY_S3_SECRET"
  printf 'SCENEBOOK_S3_FINAL_DELETE_ACCESS_KEY_ID=scenebook-final-delete\n'
  printf 'SCENEBOOK_S3_FINAL_DELETE_SECRET_ACCESS_KEY=%s\n' "$FINAL_DELETE_S3_SECRET"
  printf 'SCENEBOOK_PUBLIC_URL=%s\n' "$CONTROL_URL"
  printf 'SCENEBOOK_PUBLICATION_URL=%s\n' "$PUBLICATION_URL"
  printf 'SCENEBOOK_ADMIN_TOKEN=%s\n' "$ADMIN_TOKEN"
  printf 'SCENEBOOK_UPLOAD_TOKEN_SECRET=%s\n' "$UPLOAD_SECRET"
  printf 'SCENEBOOK_IDENTITY_TOKEN_SECRET=%s\n' "$IDENTITY_TOKEN_SECRET"
  printf 'SCENEBOOK_IDENTITY_SIGNING_PRIVATE_KEY=%s\n' "$IDENTITY_PRIVATE"
  printf 'SCENEBOOK_IDENTITY_VERIFICATION_PUBLIC_KEY=%s\n' "$IDENTITY_PUBLIC"
  printf 'SCENEBOOK_IDENTITY_PREVIOUS_VERIFICATION_PUBLIC_KEYS_JSON=[]\n'
  printf 'SCENEBOOK_GATEWAY_SESSION_SECRET=%s\n' "$GATEWAY_SESSION_SECRET"
  printf 'SCENEBOOK_GATEWAY_EXCHANGE_SECRET=%s\n' "$GATEWAY_EXCHANGE_SECRET"
  printf 'SCENEBOOK_RUNNER_TOKEN_SECRET=%s\n' "$RUNNER_SECRET"
  printf 'SCENEBOOK_ANALYTICS_HASH_SECRET=%s\n' "$ANALYTICS_SECRET"
  printf 'SCENEBOOK_CTA_ENCRYPTION_KEY=%s\n' "$CTA_KEY"
  printf 'SCENEBOOK_GITHUB_OIDC_AUDIENCE=scenebook\n'
  printf 'SCENEBOOK_GITHUB_APP_ID=\n'
  printf 'SCENEBOOK_GITHUB_APP_PRIVATE_KEY=\n'
  printf 'SCENEBOOK_WEBHOOKS_JSON=[]\n'
  printf 'SCENEBOOK_EVIDENCE_RETENTION_ENABLED=true\n'
} >"$TARGET"

printf '%s\n' "Created $TARGET with restrictive permissions. Store its secrets in your deployment secret manager."
