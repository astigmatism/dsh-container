#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
mode=external
build_flag=--build

usage() {
  cat <<'EOF'
usage: ./scripts/deploy.sh [--external-ollama | --managed-ollama] [--no-build]

External mode joins OLLAMA_NETWORK and expects the router alias `ai-router`.
Managed mode starts the pinned Ollama image, pulls the captured model set, and
builds the vendored Responses-compatible router.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --external-ollama) mode=external ;;
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

if [ "$mode" = external ]; then
  ollama_network=$(awk -F= '$1 == "OLLAMA_NETWORK" { print substr($0, index($0, "=") + 1); exit }' "$project_dir/.env")
  if ! docker network inspect "${ollama_network:-local-ai-ollama_default}" >/dev/null 2>&1; then
    echo "External Ollama network not found: ${ollama_network:-local-ai-ollama_default}" >&2
    echo "Create it or use --managed-ollama." >&2
    exit 1
  fi
  # shellcheck disable=SC2086
  docker compose --env-file "$project_dir/.env" -f "$project_dir/compose.yaml" up -d $build_flag
else
  # shellcheck disable=SC2086
  docker compose --env-file "$project_dir/.env" \
    -f "$project_dir/compose.yaml" \
    -f "$project_dir/compose.managed-ollama.yaml" \
    up -d $build_flag
fi

"$script_dir/verify.sh" "--$mode-ollama"
