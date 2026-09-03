#!/bin/sh
set -eu

# Boot the canonical web profile in a throwaway DSH_HOME and require a stable
# HTTP 200. Booting imports the full plugin tree (every bundle's loader entry,
# including dsh-playwright's server-side entry), so this catches broken
# dependency graphs - e.g. a pnpm patched-dependency snapshot in the seed
# lockfile that drops playwright-core/pngjs/ws - that `dsh --dump-config` and
# `dsh plugin list` pass without noticing.
#
# The broken server can answer the first probe before the failed plugin-tree
# import kills the process a moment later, so the check requires several
# consecutive 200s and fails fast when the process dies.

seed_home=${DSH_SEED_HOME:-/opt/dsh-seed}
canonical_settings=${DSH_CANONICAL_SETTINGS:-/opt/dsh-defaults/settings.yaml}
local_speech_source=${DSH_LOCAL_SPEECH_SOURCE:-/opt/dsh-local-speech}
port=${DSH_PLUGIN_BOOT_PORT:-3999}
stable=5
timeout_seconds=90

[ -d "$seed_home/profiles/web" ] || {
  echo "Canonical web profile is missing: $seed_home/profiles/web" >&2
  exit 1
}
[ -d "$local_speech_source" ] || {
  echo "Local speech plugin source is missing: $local_speech_source" >&2
  exit 1
}

parent=$(mktemp -d "${TMPDIR:-/tmp}/dsh-plugin-boot.XXXXXX")
home=$parent/runtime
cleanup() {
  rm -rf -- "$parent"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$home"
# The profile's link dependency is relative (../../../dsh-local-speech), so
# the throwaway runtime needs the same sibling geometry the image gives
# /data/dsh (a sibling symlink next to the runtime home).
ln -s "$local_speech_source" "$parent/dsh-local-speech"

DSH_SEED_HOME=$seed_home DSH_HOME=$home \
  /usr/local/bin/dsh-sync-runtime-profile

DSH_CANONICAL_SETTINGS=$canonical_settings \
DSH_RUNTIME_SETTINGS=$home/settings.yaml \
DSH_SETTINGS_UID=$(id -u) \
DSH_SETTINGS_GID=$(id -g) \
  /usr/local/bin/dsh-initialize-persisted-settings --replace-empty

# Neutral CWD: the repo's .env is rejected by the launcher for
# environment-authority variables, and no other CWD layer is wanted here.
cd "$parent"

(
  DSH_HOME=$home DSH_TELEMETRY_DISABLED=1 \
    exec dsh web --no-open --port "$port"
) >/dev/null 2>&1 &
boot_pid=$!

probe() {
  node -e "fetch('http://127.0.0.1:${port}/').then(r => { process.exit(r.ok ? 0 : 1); }).catch(() => process.exit(1))" 2>/dev/null
}

ok=0
elapsed=0
while [ "$elapsed" -lt "$timeout_seconds" ]; do
  if probe; then
    ok=$((ok + 1))
  else
    ok=0
  fi
  [ "$ok" -ge "$stable" ] && break
  if ! kill -0 "$boot_pid" 2>/dev/null; then
    break
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

kill "$boot_pid" 2>/dev/null || true
wait "$boot_pid" 2>/dev/null || true

if [ "$ok" -lt "$stable" ]; then
  echo "Plugin boot check failed: dsh web never served $stable consecutive HTTP 200 responses from $seed_home/profiles/web (after ${elapsed}s)." >&2
  echo "The plugin tree likely failed to import; check the seed lockfile's patched-dependency snapshots." >&2
  exit 1
fi

echo "Plugin boot check passed: web profile booted and served a stable HTTP 200."
