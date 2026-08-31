#!/bin/sh
set -eu

seed_home=/opt/dsh-seed
runtime_home=${DSH_HOME:-/data/dsh}
canonical_settings=${DSH_CANONICAL_SETTINGS:-/opt/dsh-defaults/settings.yaml}
profile_sync=${DSH_RUNTIME_PROFILE_SYNC:-/usr/local/bin/dsh-sync-runtime-profile}
settings_initializer=${DSH_SETTINGS_INITIALIZER:-/usr/local/bin/dsh-initialize-persisted-settings}

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
