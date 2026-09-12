#!/bin/sh
set -eu

seed_home=/opt/dsh-seed
runtime_home=${DSH_HOME:-/data/dsh}
canonical_settings=${DSH_CANONICAL_SETTINGS:-/opt/dsh-defaults/settings.yaml}
profile_sync=${DSH_RUNTIME_PROFILE_SYNC:-/usr/local/bin/dsh-sync-runtime-profile}
settings_initializer=${DSH_SETTINGS_INITIALIZER:-/usr/local/bin/dsh-initialize-persisted-settings}
web_token_file=${DSH_WEB_LAUNCH_TOKEN_FILE:-$runtime_home/web-launch-token}

mkdir -p "$runtime_home"

# The repository is authoritative for software-managed profile state. Re-sync
# it at every start so a normal image rebuild applies plugin additions,
# removals, upgrades, lockfile changes, and local plugin updates uniformly.
"$profile_sync"

DSH_CANONICAL_SETTINGS=$canonical_settings \
DSH_RUNTIME_SETTINGS=$runtime_home/settings.yaml \
DSH_SETTINGS_UID=$(id -u) \
DSH_SETTINGS_GID=$(id -g) \
  "$settings_initializer" --replace-empty --preserve-divergent

# Reconcile known router capabilities before any lazy agent/settings scope can
# read the persisted file. Invalid/unavailable discovery never changes settings;
# keep the application available and let provider verification report the cause.
router_migrator=${DSH_ROUTER_SETTINGS_MIGRATOR:-/opt/dsh-build/migrate-resident-models.mjs}
if [ -f "$router_migrator" ]; then
  if ! node "$router_migrator" --startup "$runtime_home/settings.yaml"; then
    echo "Router settings synchronization deferred; persisted settings were preserved." >&2
  fi
fi

# Upstream protects every browser and RPC request with a process launch token.
# Generate it at container start, publish it only through the mode-0600 shared
# file consumed by the colocated gateway, and inject the same value into DSH.
web_token_directory=$(dirname -- "$web_token_file")
mkdir -p "$web_token_directory"
token_temporary=$(mktemp "$web_token_directory/.launch-token.XXXXXX")
trap 'rm -f "$token_temporary"' EXIT HUP INT TERM
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' >"$token_temporary"
chmod 0600 "$token_temporary"
mv "$token_temporary" "$web_token_file"
trap - EXIT HUP INT TERM
DSH_WEB_LAUNCH_TOKEN=$(cat "$web_token_file")
export DSH_WEB_LAUNCH_TOKEN

set -- dsh web --no-open
old_ifs=$IFS
IFS=,
for authority in ${HARNESS_TRUSTED_HOSTS:-}; do
  authority=$(printf '%s' "$authority" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  if [ -n "$authority" ]; then
    set -- "$@" --trusted-host "$authority"
  fi
done
IFS=$old_ifs

exec "$@"
