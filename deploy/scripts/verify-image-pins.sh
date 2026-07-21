#!/bin/sh
set -eu

DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$DEPLOY_DIR/.."

REFERENCES=$(
  {
    awk '$1 == "image:" { print $2 }' deploy/compose.yaml
    awk '$1 == "FROM" { print $2 }' deploy/Dockerfile.cloud deploy/Dockerfile.gateway deploy/Dockerfile.static deploy/Dockerfile.studio
    awk '$1 == "image:" { print $2 } $1 ~ /^[a-z0-9][a-z0-9._\/-]*:[A-Za-z0-9._-]+(@sha256:[0-9a-f]+)?$/ { print $1 }' .github/workflows/*.yml
  } | LC_ALL=C sort -u
)

for reference in $REFERENCES; do
  tag=${reference%@*}
  expected=${reference##*@}
  if ! printf '%s\n' "$expected" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
    echo "Unpinned or malformed image reference: $reference" >&2
    exit 1
  fi

  inspection=$(docker buildx imagetools inspect "$tag")
  actual=$(printf '%s\n' "$inspection" | awk '$1 == "Digest:" { print $2; exit }')
  if [ "$actual" != "$expected" ]; then
    echo "Image tag moved or pin is stale: $tag expected $expected, registry reports $actual" >&2
    exit 1
  fi
  if ! printf '%s\n' "$inspection" | grep -Eq 'Platform:[[:space:]]+linux/amd64$'; then
    echo "Pinned image no longer publishes linux/amd64: $tag" >&2
    exit 1
  fi
  if ! printf '%s\n' "$inspection" | grep -Eq 'Platform:[[:space:]]+linux/arm64(/v8)?$'; then
    echo "Pinned image no longer publishes linux/arm64: $tag" >&2
    exit 1
  fi
  echo "Verified $tag@$expected for linux/amd64 and linux/arm64"
done
