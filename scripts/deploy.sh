#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
mode=
build_flag=--build

usage() {
  cat <<'EOF'
usage: ./scripts/deploy.sh [--external-ollama | --remote-ollama | --managed-ollama] [--no-build]

External mode joins OLLAMA_NETWORK and expects the router alias `ai-router`.
Remote mode runs the vendored adapter as `ai-router` on a private Docker
network and forwards native Ollama calls to REMOTE_OLLAMA_HOST.
Managed mode starts the pinned Ollama image, pulls the captured model set, and
builds the vendored Responses-compatible router.
With no mode flag, an existing recorded mode is reused; a new deployment uses
remote mode as the portable default.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --external-ollama) mode=external ;;
    --remote-ollama) mode=remote ;;
    --managed-ollama) mode=managed ;;
    --no-build) build_flag= ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ ! -f "$project_dir/.env" ]; then
  "$script_dir/configure.sh"
fi

if [ -z "$mode" ]; then
  recorded_mode=$(awk -F= '$1 == "DSH_DEPLOYMENT_MODE" { print substr($0, index($0, "=") + 1); exit }' "$project_dir/.env")
  case "$recorded_mode" in
    external|remote|managed) mode=$recorded_mode ;;
    '') mode=remote ;;
    *)
      echo "Invalid DSH_DEPLOYMENT_MODE in .env: $recorded_mode" >&2
      exit 2
      ;;
  esac
fi

# Record the selected topology before any Compose mutation. A
# failed first deployment therefore remains safely resumable, while an
# existing conflicting or duplicated mode is never overwritten.
if ! "$script_dir/record-deployment-mode.py" "$mode"; then
  echo "Could not record the requested deployment mode before deployment." >&2
  exit 21
fi

case "$mode" in
  external)
    ollama_network=$(awk -F= '$1 == "OLLAMA_NETWORK" { print substr($0, index($0, "=") + 1); exit }' "$project_dir/.env")
    if ! docker network inspect "${ollama_network:-local-ai-ollama_default}" >/dev/null 2>&1; then
      echo "External Ollama network not found: ${ollama_network:-local-ai-ollama_default}" >&2
      echo "Create it or use --remote-ollama/--managed-ollama." >&2
      exit 1
    fi
    compose_files="-f $project_dir/compose.yaml -f $project_dir/compose.external-ollama.yaml"
    ;;
  remote)
    compose_files="-f $project_dir/compose.yaml -f $project_dir/compose.remote-ollama.yaml"
    ;;
  managed)
    compose_files="-f $project_dir/compose.yaml -f $project_dir/compose.managed-ollama.yaml"
    ;;
esac

# Paths are controlled by this script and contain no whitespace in the normal
# clone layout. Splitting compose_files and build_flag is intentional.
# shellcheck disable=SC2086
if ! docker compose --env-file "$project_dir/.env" $compose_files up -d $build_flag; then
  echo "Docker Compose failed to build or start the deployment." >&2
  exit 20
fi

"$script_dir/verify.sh" "--$mode-ollama"

# Post-deployment, best effort: install or refresh the after-network boot
# service on the host. A problem here is logged but never fails an otherwise
# successful deployment.
if ! "$script_dir/install-boot-service.sh"; then
  echo "Warning: the boot service installer reported a problem; the deployment is unaffected." >&2
fi
