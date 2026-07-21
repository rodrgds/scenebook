#!/usr/bin/env bash

set -euo pipefail

if [[ ! "${SCENEBOOK_ACTION_VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "Scenebook version must be one exact semantic version" >&2
  exit 2
fi

case "${SCENEBOOK_ACTION_UPLOAD:-}" in
  true | false) ;;
  *)
    echo "Scenebook upload input must be exactly 'true' or 'false'" >&2
    exit 2
    ;;
esac

case "${SCENEBOOK_ACTION_POST_CHECKS:-}" in
  true | false) ;;
  *)
    echo "Scenebook post-checks input must be exactly 'true' or 'false'" >&2
    exit 2
    ;;
esac

if [[ ! "${SCENEBOOK_ACTION_ARTIFACT_NAME:-}" =~ ^[A-Za-z0-9._+-]{1,80}$ ]]; then
  echo "Scenebook artifact-name must use 1-80 safe filename characters" >&2
  exit 2
fi

scenebook_args=(ci --config "${SCENEBOOK_ACTION_CONFIG:-scenebook.config.ts}")
if [[ -n "${SCENEBOOK_ACTION_TARGET:-}" ]]; then
  scenebook_args+=(--target "$SCENEBOOK_ACTION_TARGET")
fi

case "${SCENEBOOK_ACTION_OCR_PROVIDER:-}" in
  tesseract)
    if [[ -n "${SCENEBOOK_ACTION_OCR_COMMAND_JSON:-}" || -n "${SCENEBOOK_ACTION_OCR_SCANNER_ID:-}" || -n "${SCENEBOOK_ACTION_OCR_SCANNER_VERSION:-}" ]]; then
      echo "command-json, scanner-id, and scanner-version require provider: command" >&2
      exit 2
    fi
    ;;
  command)
    if [[ -z "${SCENEBOOK_ACTION_OCR_COMMAND_JSON:-}" || -z "${SCENEBOOK_ACTION_OCR_SCANNER_VERSION:-}" ]]; then
      echo "The command OCR provider requires command-json and scanner-version" >&2
      exit 2
    fi
    ;;
  *)
    echo "Scenebook provider input must be 'tesseract' or 'command'" >&2
    exit 2
    ;;
esac

scenebook_args+=(--provider "$SCENEBOOK_ACTION_OCR_PROVIDER")
if [[ "$SCENEBOOK_ACTION_OCR_PROVIDER" == "command" ]]; then
  scenebook_args+=(
    --command-json "$SCENEBOOK_ACTION_OCR_COMMAND_JSON"
    --scanner-version "$SCENEBOOK_ACTION_OCR_SCANNER_VERSION"
  )
  if [[ -n "${SCENEBOOK_ACTION_OCR_SCANNER_ID:-}" ]]; then
    scenebook_args+=(--scanner-id "$SCENEBOOK_ACTION_OCR_SCANNER_ID")
  fi
fi

if [[ "$SCENEBOOK_ACTION_UPLOAD" == "true" ]]; then
  if [[ -z "${SCENEBOOK_ACTION_SERVER_URL:-}" || -z "${SCENEBOOK_ACTION_WORKSPACE_ID:-}" || -z "${SCENEBOOK_ACTION_PROJECT_ID:-}" ]]; then
    echo "Hosted upload requires server-url, workspace-id, and project-id" >&2
    exit 2
  fi

  scenebook_args+=(
    --upload
    --server-url "$SCENEBOOK_ACTION_SERVER_URL"
    --workspace-id "$SCENEBOOK_ACTION_WORKSPACE_ID"
    --project-id "$SCENEBOOK_ACTION_PROJECT_ID"
    --oidc-audience "${SCENEBOOK_ACTION_OIDC_AUDIENCE:-scenebook}"
  )
fi

if [[ -x node_modules/.bin/scenebook ]]; then
  node_modules/.bin/scenebook "${scenebook_args[@]}"
elif [[ -n "${GITHUB_ACTION_PATH:-}" && -x "$GITHUB_ACTION_PATH/node_modules/.bin/scenebook" ]]; then
  "$GITHUB_ACTION_PATH/node_modules/.bin/scenebook" "${scenebook_args[@]}"
else
  bunx --bun "@scenebook/cli@$SCENEBOOK_ACTION_VERSION" "${scenebook_args[@]}"
fi
