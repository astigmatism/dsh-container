#!/bin/sh
set -eu

seed_home=/opt/dsh-seed
runtime_home=${DSH_HOME:-/data/dsh}

mkdir -p "$runtime_home"

# The repository is authoritative for software-managed profile state. Re-sync
# it at every start so a normal image rebuild applies plugin additions,
# removals, upgrades, lockfile changes, and local plugin updates uniformly.
/usr/local/bin/dsh-sync-runtime-profile

if [ ! -f "$runtime_home/settings.yaml" ]; then
  cp /opt/dsh-defaults/settings.yaml "$runtime_home/settings.yaml"
fi

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
