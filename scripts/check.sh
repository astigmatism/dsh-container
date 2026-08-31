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

sh -n "$project_dir/entrypoint.sh" "$project_dir"/scripts/*.sh "$project_dir"/tests/*.sh

"$project_dir/tests/update-and-restart.test.sh"
"$project_dir/tests/persisted-settings.test.sh"

python3 - "$project_dir" <<'PY'
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
for relative in (
    "config/active-model.json",
    "config/plugins.lock.json",
    "config/speech.lock.json",
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
docker compose --env-file "$project_dir/speech/.env.example" \
  -f "$project_dir/speech/compose.yaml" config --quiet

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

  docker run --rm --tmpfs /data/dsh --entrypoint /bin/sh "$harness_image" -eu -c '
    mkdir -p /data/dsh/profiles/web /data/dsh/.dsh-plugins /data/dsh/sessions
    touch /data/dsh/profiles/web/divergent-package /data/dsh/.dsh-plugins/divergent-plugin
    printf preserved >/data/dsh/sessions/preserved-state
    /usr/local/bin/dsh-sync-runtime-profile
    test ! -e /data/dsh/profiles/web/divergent-package
    test ! -e /data/dsh/.dsh-plugins/divergent-plugin
    test "$(cat /data/dsh/sessions/preserved-state)" = preserved
    cmp /opt/dsh-seed/profiles/web/package.json /data/dsh/profiles/web/package.json
    cmp /opt/dsh-seed/.dsh-plugins/dsh-web-search-free.js /data/dsh/.dsh-plugins/dsh-web-search-free.js
  '

  docker run --rm --tmpfs /data/dsh --entrypoint /bin/sh "$harness_image" -eu -c '
    DSH_CANONICAL_SETTINGS=/opt/dsh-defaults/settings.yaml \
    DSH_RUNTIME_SETTINGS=/data/dsh/settings.yaml \
    DSH_SETTINGS_UID=$(id -u) \
    DSH_SETTINGS_GID=$(id -g) \
      /usr/local/bin/dsh-initialize-persisted-settings
    cmp /opt/dsh-defaults/settings.yaml /data/dsh/settings.yaml
    test "$(stat -c %u /data/dsh/settings.yaml)" = "$(id -u)"
    test "$(stat -c %g /data/dsh/settings.yaml)" = "$(id -g)"
    test "$(stat -c %a /data/dsh/settings.yaml)" = 644
  '

  docker run --rm --user 0:0 --tmpfs /data/dsh --entrypoint /bin/sh "$harness_image" -eu -c '
    service_uid=$(id -u node)
    service_gid=$(id -g node)
    chown "$service_uid:$service_gid" /data/dsh
    : >/data/dsh/settings.yaml
    chown 0:0 /data/dsh/settings.yaml
    chmod 0644 /data/dsh/settings.yaml
    runuser -u node -- env \
      DSH_CANONICAL_SETTINGS=/opt/dsh-defaults/settings.yaml \
      DSH_RUNTIME_SETTINGS=/data/dsh/settings.yaml \
      DSH_SETTINGS_UID="$service_uid" \
      DSH_SETTINGS_GID="$service_gid" \
      /usr/local/bin/dsh-initialize-persisted-settings --replace-empty
    cmp /opt/dsh-defaults/settings.yaml /data/dsh/settings.yaml
    test "$(stat -c %u /data/dsh/settings.yaml)" = "$service_uid"
    test "$(stat -c %g /data/dsh/settings.yaml)" = "$service_gid"
    test "$(stat -c %a /data/dsh/settings.yaml)" = 644
  '
fi

if [ "$build" -eq 1 ]; then
  echo "Repository checks passed with image builds."
else
  echo "Repository checks passed."
fi
