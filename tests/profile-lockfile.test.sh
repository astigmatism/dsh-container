#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$test_dir/.." && pwd)
seed_dir=$project_dir/seed/profile
lock=$seed_dir/pnpm-lock.yaml
workspace=$seed_dir/pnpm-workspace.yaml

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "no sha256sum or shasum available" >&2
    exit 2
  fi
}

# Patched-dependency hash recorded in the lockfile, for `name@version`.
lock_patch_hash() {
  awk -v key="  $1:" '
    /^patchedDependencies:/ { in_block = 1; next }
    in_block && /^[^ ]/ { in_block = 0 }
    in_block && $0 == key " " { print $3; found = 1; exit }
    in_block && index($0, key " ") == 1 {
      value = $0
      sub(/^[^:]*: */, "", value)
      print value
      found = 1
      exit
    }
    END { if (!found) exit 3 }
  ' "$lock"
}

# Patch file path recorded in pnpm-workspace.yaml, for `name@version`.
workspace_patch_path() {
  awk -v key="  $1: " '
    /^patchedDependencies:/ { in_block = 1; next }
    in_block && /^[^ ]/ { in_block = 0 }
    in_block && index($0, key) == 1 {
      value = $0
      sub(key, "", value)
      print value
      found = 1
      exit
    }
    END { if (!found) exit 3 }
  ' "$workspace"
}

# The version string the root importer resolves the dependency to.
importer_version() {
  awk -v name="      $1:" '
    /^importers:/ { in_block = 1; next }
    in_block && /^[^ ]/ { in_block = 0 }
    in_block && $0 == name { dep = 1; next }
    dep && /^        specifier:/ { next }
    dep && /^        version:/ {
      print $2
      found = 1
      exit
    }
    dep && /^      [^ ]/ { dep = 0 }
    END { if (!found) exit 3 }
  ' "$lock"
}

fail() {
  echo "seed profile lockfile invariant failed: $1" >&2
  exit 1
}

# 1. Every patched dependency in pnpm-workspace.yaml has a matching lockfile
#    hash, and that hash is the sha256 of the committed patch file. This is
#    the state pnpm --frozen-lockfile enforces at install time; checking it
#    here keeps a hand-edited lockfile from drifting from the patch files.
awk '/^patchedDependencies:/ { in_block = 1; next }
     in_block && /^[^ ]/ { in_block = 0 }
     in_block && /^  [^ ]/ { print $1 }' "$workspace" | while IFS= read -r key; do
  key=${key%:}
  patch_path=$(workspace_patch_path "$key") || fail "no patch path for $key in pnpm-workspace.yaml"
  patch_file=$seed_dir/$patch_path
  [ -f "$patch_file" ] || fail "patch file missing: $patch_path"
  expected=$(sha256_of "$patch_file")
  recorded=$(lock_patch_hash "$key") || fail "no patchedDependencies entry for $key in pnpm-lock.yaml"
  [ "$recorded" = "$expected" ] || fail "$key: lockfile hash $recorded != patch file sha256 $expected"
  resolved=$(importer_version "${key%%@*}") || fail "no importer resolution for ${key%%@*}"
  case "$resolved" in
    *"patch_hash=$expected"*) ;;
    *) fail "${key%%@*}: importer resolves $resolved, expected patch_hash=$expected" ;;
  esac
done

# Ego and its complete dependency graph are locked to the reviewed release.
grep -Fq 'dfde57221443bdade5e0cbee7c773a6839ffe560' "$lock" || fail "missing pinned ego source"
grep -Fq 'dsh-ego-browser:' "$lock" || fail "missing ego importer"
if grep -Fq 'dsh-playwright' "$lock"; then fail "retired browser remains installed"; fi
echo "ok - seed profile patch hashes and pinned ego source are consistent"
