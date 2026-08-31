#!/bin/sh
set -eu

seed_home=${DSH_SEED_HOME:-/opt/dsh-seed}
runtime_home=${DSH_HOME:-/data/dsh}

case "$runtime_home" in
  ""|/|"$seed_home"|"$seed_home"/*)
    echo "Refusing unsafe DSH runtime path: $runtime_home" >&2
    exit 1
    ;;
esac

[ -d "$seed_home/profiles/web" ] || {
  echo "Canonical web profile is missing: $seed_home/profiles/web" >&2
  exit 1
}
[ -d "$seed_home/.dsh-plugins" ] || {
  echo "Canonical local plugins are missing: $seed_home/.dsh-plugins" >&2
  exit 1
}

mkdir -p "$runtime_home/profiles"
profile_stage="$runtime_home/profiles/.web.canonical.$$"
plugins_stage="$runtime_home/.dsh-plugins.canonical.$$"

cleanup() {
  rm -rf -- "$profile_stage" "$plugins_stage"
}
trap cleanup EXIT HUP INT TERM

cp -R "$seed_home/profiles/web" "$profile_stage"
cp -R "$seed_home/.dsh-plugins" "$plugins_stage"

rm -rf -- "$runtime_home/profiles/web" "$runtime_home/.dsh-plugins"
mv "$profile_stage" "$runtime_home/profiles/web"
mv "$plugins_stage" "$runtime_home/.dsh-plugins"
cp "$seed_home/plugin-inventory.txt" "$runtime_home/plugin-inventory.txt"

trap - EXIT HUP INT TERM
