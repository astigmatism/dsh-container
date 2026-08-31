#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
build=0

case "${1:-}" in
  '') ;;
  --build) build=1 ;;
  -h|--help)
    echo "usage: ./scripts/check.sh [--build]"
    exit 0
    ;;
  *)
    echo "usage: ./scripts/check.sh [--build]" >&2
    exit 2
    ;;
esac

sh -n "$project_dir/entrypoint.sh" "$project_dir"/scripts/*.sh

python3 - "$project_dir" <<'PY'
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
for relative in (
    "config/active-model.json",
    "config/plugins.lock.json",
    "seed/profile/package.json",
    "seed/profile/pnpm-lock.yaml",
    "ollama-router/package.json",
):
    path = root / relative
    if path.suffix == ".json":
        json.loads(path.read_text(encoding="utf-8"))
for relative in ("scripts/change-password.py", "scripts/import-openwebui-stt.py"):
    source = (root / relative).read_text(encoding="utf-8")
    compile(source, relative, "exec")
PY

docker compose --env-file "$project_dir/.env.example" \
  -f "$project_dir/compose.yaml" config --quiet
docker compose --env-file "$project_dir/.env.example" \
  -f "$project_dir/compose.yaml" \
  -f "$project_dir/compose.remote-ollama.yaml" \
  config --quiet
docker compose --env-file "$project_dir/.env.example" \
  -f "$project_dir/compose.yaml" \
  -f "$project_dir/compose.managed-ollama.yaml" \
  config --quiet

node_image=node@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
docker run --rm --network none --read-only --tmpfs /tmp \
  --volume "$project_dir:/src:ro" --workdir /src --entrypoint /bin/sh \
  "$node_image" -eu -c '
    node --check gateway/server.mjs
    node --check plugin/dsh-local-speech/client.js
    node --check seed/plugins/dsh-web-search-free.js
    node --check ollama-router/src/server.js
    node --test ollama-router/test/*.test.js
  '

if [ "$build" -eq 1 ]; then
  harness_image=local/dsh-container-check:harness
  gateway_image=local/dsh-container-check:gateway
  router_image=local/dsh-container-check:router

  docker build --target harness --tag "$harness_image" "$project_dir"
  docker build --target gateway --tag "$gateway_image" "$project_dir"
  docker build --tag "$router_image" "$project_dir/ollama-router"

  inventory=$(docker run --rm --entrypoint dsh \
    --env DSH_HOME=/opt/dsh-seed "$harness_image" plugin --profile web list)
  for expected in \
    '@zoytown/dsh-token@0.1.3' \
    'dsh-context@0.37.0' \
    'dsh-local-speech-input@link:' \
    'dsh-loop-detector@1.0.0' \
    'dsh-plugin-task-notification@0.2.1' \
    'dsh-session-pin@0.6.1' \
    'dsh-ui-appearance@0.1.6'
  do
    printf '%s\n' "$inventory" | grep -Fq "$expected" || {
      echo "Built image is missing: $expected" >&2
      exit 1
    }
  done
fi

if [ "$build" -eq 1 ]; then
  echo "Repository checks passed with image builds."
else
  echo "Repository checks passed."
fi
