#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
mode=${1:---external-ollama}

if [ ! -f "$project_dir/.env" ]; then
  echo "Missing .env; run ./scripts/configure.sh first." >&2
  exit 1
fi

case "$mode" in
  --external-ollama)
    compose_files="-f $project_dir/compose.yaml"
    ;;
  --remote-ollama)
    compose_files="-f $project_dir/compose.yaml -f $project_dir/compose.remote-ollama.yaml"
    ;;
  --managed-ollama)
    compose_files="-f $project_dir/compose.yaml -f $project_dir/compose.managed-ollama.yaml"
    ;;
  *)
    echo "usage: ./scripts/verify.sh [--external-ollama|--remote-ollama|--managed-ollama]" >&2
    exit 2
    ;;
esac

# Paths are controlled by this script and contain no whitespace in the normal
# clone layout. Splitting compose_files is intentional for POSIX sh.
# shellcheck disable=SC2086
compose() { docker compose --env-file "$project_dir/.env" $compose_files "$@"; }

deadline=$(( $(date +%s) + 180 ))
while :; do
  harness_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' deepseek-harness 2>/dev/null || true)
  gateway_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' deepseek-harness-gateway 2>/dev/null || true)
  if [ "$harness_health" = healthy ] && [ "$gateway_health" = healthy ]; then
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Timed out waiting for Harness health (harness=$harness_health gateway=$gateway_health)." >&2
    compose ps >&2 || true
    exit 1
  fi
  sleep 2
done

inventory=$(compose exec -T harness dsh plugin --profile web list)
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
    echo "Missing captured plugin: $expected" >&2
    exit 1
  }
done

expected_settings=$(sha256sum "$project_dir/config/settings.yaml" | awk '{print $1}')
runtime_settings=$(compose exec -T harness sha256sum /data/dsh/settings.yaml | awk '{print $1}')
if [ "$expected_settings" != "$runtime_settings" ]; then
  echo "Runtime settings differ from config/settings.yaml." >&2
  exit 1
fi

compose exec -T harness node -e \
  "fetch('http://ai-router:11434/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

if [ "$mode" = --managed-ollama ]; then
  compose exec -T ollama ollama show qwen3.8:27b-mtp-q8_0 >/dev/null
  compose exec -T ai-router node -e \
    "fetch('http://127.0.0.1:11434/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
fi

compose ps
echo "Verified DSH 0.1.1-rc.2, canonical runtime settings/plugins, gateway health, and Ollama router reachability."
