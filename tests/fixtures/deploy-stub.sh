#!/bin/sh
set -eu

if [ -n "${FAKE_DEPLOY_LOG:-}" ]; then
  printf 'deploy %s\n' "$*" >>"$FAKE_DEPLOY_LOG"
fi
exit "${FAKE_DEPLOY_EXIT:-0}"
