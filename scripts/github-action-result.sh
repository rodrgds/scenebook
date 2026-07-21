#!/usr/bin/env bash

set -euo pipefail

verification_exit_code="${SCENEBOOK_ACTION_VERIFICATION_EXIT_CODE:-255}"
report_exit_code="${SCENEBOOK_ACTION_REPORT_EXIT_CODE:-3}"

if [[ ! "$verification_exit_code" =~ ^[0-9]+$ ]] || ((verification_exit_code < 0 || verification_exit_code > 255)); then
  verification_exit_code=255
fi
if ((verification_exit_code != 0)); then
  exit "$verification_exit_code"
fi
if [[ ! "$report_exit_code" =~ ^[0-9]+$ ]] || ((report_exit_code != 0)); then
  exit 3
fi
if [[ "${SCENEBOOK_ACTION_REPORT_READY:-}" != "true" || "${SCENEBOOK_ACTION_ARTIFACT_OUTCOME:-}" != "success" ]]; then
  exit 3
fi
if [[ "${SCENEBOOK_ACTION_POST_CHECKS:-false}" == "true" && "${SCENEBOOK_ACTION_CHECKS_ALLOWED:-false}" == "true" && "${SCENEBOOK_ACTION_CHECKS_OUTCOME:-}" != "success" ]]; then
  exit 4
fi
