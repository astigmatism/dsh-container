#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$script_dir/.." && pwd)
manifest=
dry_run=0
mode_flag=
action=update
for argument do
  [ "$argument" != --dry-run ] || dry_run=1
done
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest) manifest=$2; shift 2 ;;
    --deployment-dir) manifest=$2/deployment.json; shift 2 ;;
    --dry-run) shift ;;
    --boot) action=boot; shift ;;
    --verify) action=verify; shift ;;
    --external-ollama|--remote-ollama|--managed-ollama)
      mode_flag=$1; shift ;;
    -h|--help) echo "usage: update-and-restart.sh [--manifest FILE | --deployment-dir DIR] [--dry-run]"; exit 0 ;;
    *) echo "Unknown maintenance option" >&2; exit 2 ;;
  esac
done
if [ -z "$manifest" ]; then
  if [ -f "$root/deployment.json" ]; then manifest=$root/deployment.json
  else manifest=$root/data/deployment/deployment.json
  fi
fi
[ -f "$manifest" ] || { echo "No operational manifest. Adopt this deployment with scripts/deploy.sh --adopt --portal-url URL first." >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$manifest")" && pwd)
manifest=$root/deployment.json
[ ! -f "$root/adoption.json" ] || { echo "Adoption is incomplete; rerun the original deploy.sh command to resume safely." >&2; exit 1; }
set --
[ -z "$mode_flag" ] || set -- "$mode_flag"
if [ "$dry_run" -eq 1 ]; then
  exec python3 -B "$root/maintenance/main.py" update --manifest "$manifest" --dry-run "$@"
fi
if [ "${SERVICE_PORTAL_UPDATE_DELEGATED:-0}" = 1 ]; then
  exec python3 -B /opt/dsh-maintenance/main.py launch --manifest "$manifest" --worker-action "$action" "$@"
fi
# The immutable image ID is a bootstrap hint; the worker cross-checks the
# manifest, live engine identity and Compose labels before touching services.
[ -f "$root/runner-image" ] || { echo "Qualified runner is not installed; bootstrap required." >&2; exit 1; }
runner=$(cat "$root/runner-image")
case "$runner" in sha256:*) ;; *) echo "Invalid runner identity" >&2; exit 1 ;; esac
socket_gid=$(ls -ln /var/run/docker.sock | awk '{print $4}')
exec docker run --rm --init --user "$(id -u):$(id -g)" --group-add "$socket_gid" \
  --mount "type=bind,src=$root,dst=$root" \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --entrypoint python3 "$runner" -B /opt/dsh-maintenance/main.py launch --manifest "$manifest" --worker-action "$action" "$@"
