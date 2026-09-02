#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
canonical_settings=$project_dir/config/settings.yaml
runtime_settings=$project_dir/data/dsh/settings.yaml
env_file=$project_dir/.env

get_env() {
  [ -f "$env_file" ] || return 0
  awk -F= -v wanted="$1" '$1 == wanted { print substr($0, index($0, "=") + 1); exit }' "$env_file"
}

file_uid() {
  case "$(uname -s)" in
    Darwin) stat -f '%u' "$1" ;;
    *) stat -c '%u' "$1" ;;
  esac
}

file_gid() {
  case "$(uname -s)" in
    Darwin) stat -f '%g' "$1" ;;
    *) stat -c '%g' "$1" ;;
  esac
}

file_mode() {
  case "$(uname -s)" in
    Darwin) stat -f '%Lp' "$1" ;;
    *) stat -c '%a' "$1" ;;
  esac
}

if [ ! -f "$canonical_settings" ]; then
  echo "Canonical settings are missing: config/settings.yaml" >&2
  exit 1
fi

if [ ! -e "$runtime_settings" ]; then
  echo "Persisted settings are missing: data/dsh/settings.yaml" >&2
  echo "Maintenance will not create or replace persisted settings." >&2
  exit 1
fi

if [ ! -f "$runtime_settings" ] || [ -L "$runtime_settings" ]; then
  echo "Persisted settings are not a regular file: data/dsh/settings.yaml" >&2
  exit 1
fi

if [ ! -s "$runtime_settings" ]; then
  echo "Persisted settings are empty: data/dsh/settings.yaml" >&2
  echo "Maintenance will not create or replace persisted settings." >&2
  exit 1
fi

expected_uid=$(get_env HOST_UID)
expected_gid=$(get_env HOST_GID)
case "$expected_uid" in
  ''|*[!0-9]*) echo "HOST_UID must identify the numeric service owner in .env." >&2; exit 1 ;;
esac
case "$expected_gid" in
  ''|*[!0-9]*) echo "HOST_GID must identify the numeric service group in .env." >&2; exit 1 ;;
esac

actual_uid=$(file_uid "$runtime_settings")
actual_gid=$(file_gid "$runtime_settings")
actual_mode=$(file_mode "$runtime_settings")
if [ "$actual_uid" != "$expected_uid" ] || [ "$actual_gid" != "$expected_gid" ]; then
  echo "Persisted settings ownership is $actual_uid:$actual_gid; expected service ownership $expected_uid:$expected_gid." >&2
  exit 1
fi
case "$actual_mode" in
  600|640|644) ;;
  *)
    echo "Persisted settings mode is $actual_mode; expected a service-writable, non-executable mode (0600, 0640, or 0644)." >&2
    exit 1
    ;;
esac

if cmp -s "$canonical_settings" "$runtime_settings"; then
  echo "Persisted settings match the canonical defaults with service ownership and secure mode $actual_mode."
else
  echo "Persisted settings differ from the canonical defaults; preserving the non-empty runtime configuration with secure mode $actual_mode."
fi
