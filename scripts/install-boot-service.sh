#!/bin/sh
set -eu

# Install the deepseek-harness-after-network user systemd unit for this
# checkout. The installer is idempotent and content-driven: identical files
# cause no writes and no daemon-reload; drifted files are replaced and the
# change is logged. When the user systemd bus is reachable the unit is
# reloaded and started (or restarted if it was already active). When the bus
# is not reachable (for example from a maintenance container that has no host
# user session) the files are still installed, the exact commands the
# operator must run on the host are printed, and the script exits 0: an
# install problem must never fail a deployment.
#
# The last line of the output is a machine-readable summary of the form
# boot_service=<installed|updated|unchanged|started|warning:<reason>>.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
unit_name=deepseek-harness-after-network.service
template=$project_dir/deploy/$unit_name
dry_run=0

usage() {
  cat <<'EOF'
usage: ./scripts/install-boot-service.sh [--dry-run]

Render deploy/deepseek-harness-after-network.service for this checkout and
install it under ~/.config/systemd/user/ with a default.target.wants symlink.
With a reachable user systemd bus the unit is daemon-reloaded and started
(or restarted if already active). Without one, the files are installed and
the commands to run on the host are printed. Identical installs are a no-op
(no writes, no reload).
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[ -f "$template" ] || { echo "Missing unit template: $template" >&2; exit 1; }

# The rendered paths go into a unit file; refuse substitution-unsafe paths
# instead of producing a broken unit. The normal clone layout has none of
# these characters.
case "$project_dir" in
  *\&*|*\|*|*\\*)
    echo "Refusing to render: the project path is unsafe for the template substitution: $project_dir" >&2
    exit 1
    ;;
esac

rendered=$(sed "s|@PROJECT_DIR@|$project_dir|g" "$template")

# Installation home: the deploying user's $HOME on the host. In the delegated
# maintenance container the host home is mounted at its real path and named
# by DSH_BOOT_SERVICE_HOME; the container's own HOME is ephemeral.
install_home=$HOME
if [ "${DSH_UPDATE_DELEGATED:-0}" = 1 ]; then
  if [ -z "${DSH_BOOT_SERVICE_HOME:-}" ] || [ ! -d "${DSH_BOOT_SERVICE_HOME:-}" ]; then
    echo "Warning: delegated maintenance has no host home mount (DSH_BOOT_SERVICE_HOME); the unit files were not installed." >&2
    echo "boot_service=warning:host-home-unavailable"
    exit 0
  fi
  install_home=$DSH_BOOT_SERVICE_HOME
fi

user_unit_dir=$install_home/.config/systemd/user
unit_path=$user_unit_dir/$unit_name
wants_dir=$user_unit_dir/default.target.wants
wants_link=$wants_dir/$unit_name
wants_target=../$unit_name

bus_reachable() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user show -p LoadState >/dev/null 2>&1
}

unit_active() {
  state=$(systemctl --user is-active "$unit_name" 2>/dev/null || true)
  case "$state" in
    active|activating) return 0 ;;
    *) return 1 ;;
  esac
}

unit_loaded() {
  load=$(systemctl --user show "$unit_name" -p LoadState 2>/dev/null \
    | awk -F= '$1 == "LoadState" { print $2; exit }')
  [ "$load" = loaded ]
}

file_state() {
  if [ ! -e "$unit_path" ]; then
    printf 'install\n'
    return 0
  fi
  if [ "$(cat "$unit_path" 2>/dev/null)" = "$rendered" ]; then
    printf 'unchanged\n'
  else
    printf 'update\n'
  fi
}

link_state() {
  if [ -L "$wants_link" ]; then
    if [ "$(readlink "$wants_link")" = "$wants_target" ]; then
      printf 'unchanged\n'
    else
      printf 'update\n'
    fi
  elif [ -e "$wants_link" ]; then
    printf 'update\n'
  else
    printf 'install\n'
  fi
}

manual_commands() {
  cat <<EOF
On the host, run these commands as the deploying user:
systemctl --user daemon-reload
systemctl --user start $unit_name
systemctl --user status $unit_name
EOF
}

existing_state=$(file_state)
wants_state=$(link_state)

was_active=0
if bus_reachable && unit_active; then
  was_active=1
fi

if [ "$dry_run" -eq 1 ]; then
  echo "dry-run: plan for $unit_name (install home: $install_home)"
  echo "dry-run: unit file ($existing_state) at $unit_path:"
  printf '%s\n' "$rendered"
  echo "dry-run: wants link ($wants_state): $wants_link -> $wants_target"
  if bus_reachable; then
    if [ "$existing_state" != unchanged ] || [ "$wants_state" != unchanged ]; then
      echo "dry-run: systemctl --user daemon-reload"
    fi
    if [ "$was_active" -eq 1 ]; then
      echo "dry-run: systemctl --user restart $unit_name"
    else
      echo "dry-run: systemctl --user start $unit_name"
    fi
  else
    echo "dry-run: user systemd bus unreachable; would install the files and print the manual activation commands"
  fi
  echo "boot_service=dry-run"
  exit 0
fi

changed=0
if [ "$existing_state" != unchanged ]; then
  changed=1
  mkdir -p "$user_unit_dir"
  temporary=$(mktemp "$user_unit_dir/.${unit_name}.XXXXXX")
  printf '%s\n' "$rendered" >"$temporary"
  chmod 0644 "$temporary"
  mv "$temporary" "$unit_path"
  echo "Unit file $existing_state: $unit_path"
fi
if [ "$wants_state" != unchanged ]; then
  changed=1
  mkdir -p "$wants_dir"
  if [ -L "$wants_link" ] || [ -e "$wants_link" ]; then
    rm -f "$wants_link"
  fi
  ln -s "$wants_target" "$wants_link"
  echo "Wants link $wants_state: $wants_link -> $wants_target"
fi

if [ "$changed" -eq 0 ]; then
  result=unchanged
elif [ "$existing_state" = install ] && [ "$wants_state" = install ]; then
  result=installed
else
  result=updated
fi

if ! bus_reachable; then
  echo "Warning: the user systemd bus is unreachable from this context (for example a maintenance container without the host user session)." >&2
  manual_commands >&2
  echo "boot_service=warning:bus-unreachable"
  exit 0
fi

needs_reload=0
if [ "$changed" -eq 1 ]; then
  needs_reload=1
elif ! unit_loaded; then
  # The files were installed while the bus was unreachable; load them now.
  needs_reload=1
fi
if [ "$needs_reload" -eq 1 ]; then
  echo "Reloading the user systemd manager..."
  systemctl --user daemon-reload
fi

if [ "$was_active" -eq 1 ]; then
  systemctl --user restart "$unit_name"
  echo "Boot service $result; restarted $unit_name."
else
  if [ "$changed" -eq 0 ]; then
    result=started
  fi
  systemctl --user start "$unit_name"
  echo "Boot service $result; started $unit_name."
fi

echo "boot_service=$result"
