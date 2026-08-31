#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
env_file=${DSH_ENV_FILE:-$project_dir/.env}
canonical_settings=${DSH_CANONICAL_SETTINGS:-$project_dir/config/settings.yaml}
runtime_settings=${DSH_RUNTIME_SETTINGS:-$project_dir/data/dsh/settings.yaml}
expected_mode=644
replace_empty=0
preserve_divergent=0

usage() {
  cat <<'EOF'
usage: ./scripts/initialize-persisted-settings.sh [options]

Options:
  --replace-empty       explicitly replace an existing zero-byte placeholder
  --preserve-divergent  leave non-empty divergent settings unchanged
  -h, --help            show this help

Missing settings are initialized from config/settings.yaml. Matching settings
with incorrect service ownership or mode are atomically normalized. Empty files
require --replace-empty, and non-empty divergent files are never overwritten.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --replace-empty) replace_empty=1 ;;
    --preserve-divergent) preserve_divergent=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

get_env() {
  [ -f "$env_file" ] || return 0
  awk -F= -v wanted="$1" '$1 == wanted { print substr($0, index($0, "=") + 1); exit }' "$env_file"
}

expected_uid=${DSH_SETTINGS_UID:-$(get_env HOST_UID)}
expected_gid=${DSH_SETTINGS_GID:-$(get_env HOST_GID)}
case "$expected_uid" in
  ''|*[!0-9]*) echo "HOST_UID must be a numeric service UID." >&2; exit 1 ;;
esac
case "$expected_gid" in
  ''|*[!0-9]*) echo "HOST_GID must be a numeric service GID." >&2; exit 1 ;;
esac

[ -f "$canonical_settings" ] || {
  echo "Canonical settings are missing or not a regular file: $canonical_settings" >&2
  exit 1
}
[ -s "$canonical_settings" ] || {
  echo "Canonical settings are empty: $canonical_settings" >&2
  exit 1
}

case "$canonical_settings" in
  /*) ;;
  *) echo "Canonical settings path must be absolute: $canonical_settings" >&2; exit 1 ;;
esac
case "$runtime_settings" in
  /*) ;;
  *) echo "Persisted settings path must be absolute: $runtime_settings" >&2; exit 1 ;;
esac

runtime_dir=${runtime_settings%/*}
case "$runtime_settings" in
  ''|/|"$canonical_settings")
    echo "Refusing unsafe persisted-settings path: $runtime_settings" >&2
    exit 1
    ;;
esac
mkdir -p "$runtime_dir"

lock_dir=$runtime_dir/.settings-initialize.lock
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "Another persisted-settings initialization may be active: $lock_dir" >&2
  exit 1
fi

stage=
cleanup() {
  if [ -n "$stage" ]; then
    rm -f "$stage"
  fi
  rmdir "$lock_dir" 2>/dev/null || true
}
finish() {
  status=$?
  trap - EXIT HUP INT TERM
  cleanup
  exit "$status"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

classify_settings() {
  if [ ! -e "$runtime_settings" ] && [ ! -L "$runtime_settings" ]; then
    settings_state=missing
  elif [ ! -f "$runtime_settings" ] || [ -L "$runtime_settings" ]; then
    settings_state=invalid
  elif [ ! -s "$runtime_settings" ]; then
    settings_state=empty
  elif cmp -s "$canonical_settings" "$runtime_settings"; then
    settings_state=matching
  else
    settings_state=divergent
  fi
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

metadata_match() {
  [ "$(file_uid "$1")" = "$expected_uid" ] \
    && [ "$(file_gid "$1")" = "$expected_gid" ] \
    && [ "$(file_mode "$1")" = "$expected_mode" ]
}

classify_settings
initial_state=$settings_state
case "$initial_state" in
  missing) ;;
  empty)
    if [ "$replace_empty" -ne 1 ]; then
      echo "Persisted settings are empty: $runtime_settings" >&2
      echo "Review the canonical configuration, then use --replace-empty explicitly." >&2
      exit 1
    fi
    ;;
  matching)
    if metadata_match "$runtime_settings"; then
      echo "Persisted settings already match canonical content, service ownership, and mode 0644."
      exit 0
    fi
    ;;
  divergent)
    if [ "$preserve_divergent" -eq 1 ]; then
      echo "Keeping non-empty divergent persisted settings unchanged."
      exit 0
    fi
    echo "Persisted settings are non-empty and differ from the canonical configuration." >&2
    echo "They will not be overwritten by this initializer." >&2
    exit 1
    ;;
  invalid)
    echo "Persisted settings are not a regular, non-symlink file: $runtime_settings" >&2
    exit 1
    ;;
esac

umask 077
stage=$(mktemp "$runtime_dir/.settings.yaml.XXXXXX")
cp "$canonical_settings" "$stage"
chmod 0644 "$stage"
if [ "$(file_uid "$stage")" != "$expected_uid" ] \
  || [ "$(file_gid "$stage")" != "$expected_gid" ]; then
  chown "$expected_uid:$expected_gid" "$stage"
fi
cmp -s "$canonical_settings" "$stage" || {
  echo "Staged persisted settings do not match the canonical source." >&2
  exit 1
}
metadata_match "$stage" || {
  echo "Could not stage persisted settings with service ownership and mode 0644." >&2
  exit 1
}

classify_settings
if [ "$settings_state" != "$initial_state" ]; then
  echo "Persisted settings changed during initialization; refusing to replace them." >&2
  exit 1
fi

case "$initial_state" in
  missing)
    if ! ln "$stage" "$runtime_settings" 2>/dev/null; then
      echo "Persisted settings appeared during initialization; refusing to overwrite them." >&2
      exit 1
    fi
    rm -f "$stage"
    stage=
    echo "Initialized missing persisted settings from the canonical configuration."
    ;;
  empty)
    mv "$stage" "$runtime_settings"
    stage=
    echo "Replaced an existing empty persisted-settings placeholder from the canonical configuration."
    ;;
  matching)
    mv "$stage" "$runtime_settings"
    stage=
    echo "Normalized matching persisted settings to service ownership and mode 0644."
    ;;
esac

cmp -s "$canonical_settings" "$runtime_settings" || {
  echo "Persisted settings verification failed after initialization." >&2
  exit 1
}
metadata_match "$runtime_settings" || {
  echo "Persisted settings metadata verification failed after initialization." >&2
  exit 1
}

trap - EXIT HUP INT TERM
cleanup
