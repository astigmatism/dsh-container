#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
HOST_HOME=${HOST_HOME:-${HOME:-}}
export HOST_HOME
mode=
build_flag=--build

usage() {
  cat <<'EOF'
usage: ./scripts/deploy.sh [--external-ollama | --remote-ollama | --managed-ollama] [--no-build]

External mode joins OLLAMA_NETWORK and expects the router alias `ai-router`.
Remote mode maps `ai-router` directly to the Responses-compatible production
router at REMOTE_OLLAMA_HOST; it does not start a local router service.
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

# Boot integration is a deployment invariant. Converge its on-disk unit and
# enablement before Compose can build or change services. The updater performs
# this same preflight itself so it can record the result in maintenance-status.
if [ "${DSH_BOOT_SERVICE_MANAGED_BY_UPDATER:-0}" != 1 ]; then
  if [ ! -x "$script_dir/install-boot-service.sh" ] \
    || ! "$script_dir/install-boot-service.sh" --defer-activation; then
    echo "Required boot-service files could not be converged; services were not changed." >&2
    exit 24
  fi
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

# The upstream browser/RPC layer and the public gateway share only this
# deployment-local launch-token directory. Keep it separate from sessions and
# TLS material, and create it before Compose evaluates the bind mount.
mkdir -p "$project_dir/data/backend-auth"
chmod 0700 "$project_dir/data/backend-auth"

# Paths are controlled by this script and contain no whitespace in the normal
# clone layout. Splitting compose_files and build_flag is intentional.
# shellcheck disable=SC2086
if ! docker compose --env-file "$project_dir/.env" $compose_files up -d $build_flag; then
  echo "Docker Compose failed to build or start the deployment." >&2
  exit 20
fi

"$script_dir/verify.sh" "--$mode-ollama"

# Remove the one-release compatibility location only when it still contains
# the exact 32-byte base64url launch-token shape. Current deployments use the
# isolated backend-auth directory above.
legacy_web_token=$project_dir/data/dsh/web-launch-token
if [ -f "$legacy_web_token" ] \
  && [ "$(wc -c <"$legacy_web_token" | tr -d '[:space:]')" = 43 ] \
  && LC_ALL=C grep -Eq '^[A-Za-z0-9_-]{43}$' "$legacy_web_token"; then
  rm -f "$legacy_web_token"
  echo "Removed the superseded Harness launch-token file from the session directory."
fi

if [ "$mode" = remote ]; then
  legacy_router=deepseek-harness-ollama-router
  if docker inspect "$legacy_router" >/dev/null 2>&1; then
    legacy_project=$(docker inspect "$legacy_router" \
      --format '{{ index .Config.Labels "com.docker.compose.project" }}')
    legacy_service=$(docker inspect "$legacy_router" \
      --format '{{ index .Config.Labels "com.docker.compose.service" }}')
    if [ "$legacy_project" != deepseek-harness ] || [ "$legacy_service" != ai-router ]; then
      echo "Refusing to remove $legacy_router because its Compose identity is not deepseek-harness/ai-router." >&2
      exit 20
    fi
    if ! docker container rm --force "$legacy_router" >/dev/null; then
      echo "Could not stop and remove the obsolete remote-mode router container." >&2
      exit 20
    fi
    echo "Removed obsolete remote-mode router container; its image and persistent data were retained."
    "$script_dir/verify.sh" "--$mode-ollama"
  fi
fi

# Activate the already-converged unit after a successful standalone deploy.
# An unreachable user bus is reported by the installer but remains success
# because the on-disk unit and default.target enablement are complete.
if [ "${DSH_BOOT_SERVICE_MANAGED_BY_UPDATER:-0}" != 1 ] \
  && ! "$script_dir/install-boot-service.sh"; then
  echo "Deployment succeeded, but required boot-service activation/convergence failed." >&2
  exit 24
fi
