#!/bin/sh
set -eu

DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$DEPLOY_DIR"

docker compose run --rm --no-deps cloud node packages/server/dist/migrate.js
