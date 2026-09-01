#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
mode=${1:-}
docker_compose_exit=20
configuration_exit=21
provider_exit=22
application_health_exit=23

if [ ! -f "$project_dir/.env" ]; then
  echo "Missing .env; run ./scripts/configure.sh first." >&2
  exit 1
fi

if [ -z "$mode" ]; then
  recorded_mode=$(awk -F= '$1 == "DSH_DEPLOYMENT_MODE" { print substr($0, index($0, "=") + 1); exit }' "$project_dir/.env")
  case "$recorded_mode" in
    external|remote|managed) mode=--$recorded_mode-ollama ;;
    '') mode=--remote-ollama ;;
    *)
      echo "Invalid DSH_DEPLOYMENT_MODE in .env: $recorded_mode" >&2
      exit 2
      ;;
  esac
fi

case "$mode" in
  --external-ollama)
    compose_files="-f $project_dir/compose.yaml -f $project_dir/compose.external-ollama.yaml"
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

get_env() {
  awk -F= -v wanted="$1" '$1 == wanted { print substr($0, index($0, "=") + 1); exit }' "$project_dir/.env"
}

if ! "$script_dir/verify-persisted-settings.sh"; then
  exit "$configuration_exit"
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker Engine is unavailable." >&2
  exit "$docker_compose_exit"
fi

if ! compose config --quiet; then
  echo "Docker Compose configuration validation failed." >&2
  exit "$docker_compose_exit"
fi

deadline=$(( $(date +%s) + 180 ))
while :; do
  harness_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' deepseek-harness 2>/dev/null || true)
  gateway_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' deepseek-harness-gateway 2>/dev/null || true)
  if [ "$harness_health" = healthy ] && [ "$gateway_health" = healthy ]; then
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    if ! docker info >/dev/null 2>&1; then
      echo "Docker Engine became unavailable while waiting for Harness health." >&2
      exit "$docker_compose_exit"
    fi
    echo "Timed out waiting for Harness health (harness=$harness_health gateway=$gateway_health)." >&2
    compose ps >&2 || true
    exit "$application_health_exit"
  fi
  sleep 2
done

if ! inventory=$(compose exec -T harness dsh plugin --profile web list); then
  if ! docker info >/dev/null 2>&1; then
    echo "Docker Engine became unavailable while reading the plugin inventory." >&2
    exit "$docker_compose_exit"
  fi
  echo "Harness did not return its plugin inventory." >&2
  exit "$application_health_exit"
fi
for expected in \
  '@zoytown/dsh-token@0.1.3' \
  'dsh-context@0.37.0' \
  'dsh-favicon-status@0.1.0-rc.5' \
  'dsh-local-speech-input@link:' \
  'dsh-loop-detector@1.0.0' \
  'dsh-plugin-task-notification@0.2.1' \
  'dsh-session-pin@0.6.1' \
  'dsh-ui-appearance@0.1.6'
do
  printf '%s\n' "$inventory" | grep -Fq "$expected" || {
    echo "Missing captured plugin: $expected" >&2
    exit "$configuration_exit"
  }
done

if ! compose exec -T harness node -e \
  "fetch('http://ai-router:11434/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then
  if ! docker info >/dev/null 2>&1; then
    echo "Docker Engine became unavailable during model-provider verification." >&2
    exit "$docker_compose_exit"
  fi
  echo "The configured model provider is unavailable or rejected access." >&2
  exit "$provider_exit"
fi

gateway_tls_ip=$(get_env HARNESS_TLS_IP)
gateway_https_port=$(get_env HARNESS_HTTPS_PORT)
gateway_ca=$project_dir/data/gateway/tls/ca.crt
if [ -z "$gateway_tls_ip" ] || [ -z "$gateway_https_port" ] || [ ! -s "$gateway_ca" ] \
  || ! curl --fail --silent --show-error --cacert "$gateway_ca" \
    "https://$gateway_tls_ip:$gateway_https_port/healthz" >/dev/null; then
  if ! docker info >/dev/null 2>&1; then
    echo "Docker Engine became unavailable during HTTPS gateway verification." >&2
    exit "$docker_compose_exit"
  fi
  echo "The authenticated HTTPS gateway did not pass trusted TLS health verification." >&2
  exit "$application_health_exit"
fi

if [ "$mode" = --managed-ollama ]; then
  if ! compose exec -T ollama ollama show qwen3.8:27b-mtp-q8_0 >/dev/null; then
    if ! docker info >/dev/null 2>&1; then
      echo "Docker Engine became unavailable during managed-model verification." >&2
      exit "$docker_compose_exit"
    fi
    echo "The required managed model is unavailable." >&2
    exit "$provider_exit"
  fi
  if ! compose exec -T ai-router node -e \
    "fetch('http://127.0.0.1:11434/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then
    if ! docker info >/dev/null 2>&1; then
      echo "Docker Engine became unavailable during managed-router verification." >&2
      exit "$docker_compose_exit"
    fi
    echo "The managed model router is unavailable." >&2
    exit "$provider_exit"
  fi
fi

if ! compose ps; then
  echo "Docker Compose could not report the verified deployment." >&2
  exit "$docker_compose_exit"
fi
echo "Verified DSH 0.1.1-rc.2, canonical runtime settings/plugins, authenticated HTTPS gateway, and Ollama router reachability."
