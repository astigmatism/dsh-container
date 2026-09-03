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

# 2. The patched dsh-playwright snapshot must retain its full dependency
#    graph. Commit e89828d committed an empty patched snapshot, so pnpm
#    installed the patched plugin without playwright-core/pngjs/ws and the
#    container crashed on boot with "Cannot find package 'playwright-core'".
#    The snapshot pnpm actually writes carries the package's dependencies.
playwright_hash=$(lock_patch_hash 'dsh-playwright@0.1.0') || fail "no patched dsh-playwright entry in lockfile"
if awk '/^snapshots:/ { in_block = 1; next }
        in_block && /^[^ ]/ { in_block = 0 }
        in_block && /^  dsh-playwright@0.1.0\(patch_hash=[0-9a-f]+\): \{\}$/ { found = 1 }
        END { exit found ? 0 : 1 }' "$lock"; then
  fail "patched dsh-playwright snapshot is empty (dependency graph lost)"
fi
awk -v wanted="  dsh-playwright@0.1.0(patch_hash=$playwright_hash):" '
  $0 == wanted { in_snap = 1; next }
  in_snap && /^[^ ]/ { in_snap = 0 }
  in_snap && /^  [^ ]/ { in_snap = 0 }
  in_snap && $0 ~ /^      playwright-core: / { print "DEP_PLAYWRIGHT" }
  in_snap && $0 ~ /^      pngjs: / { print "DEP_PNGJS" }
  in_snap && $0 ~ /^      ws: / { print "DEP_WS" }
' "$lock" > "$lock.snapcheck.$$"
trap 'rm -f "$lock.snapcheck.$$"' EXIT
for marker in DEP_PLAYWRIGHT DEP_PNGJS DEP_WS; do
  grep -q "^$marker$" "$lock.snapcheck.$$" || fail "patched dsh-playwright snapshot is missing $marker"
done

echo "ok - seed profile patched-dependency lock state is consistent with the patch files"
