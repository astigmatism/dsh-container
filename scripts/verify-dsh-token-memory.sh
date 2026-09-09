#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
mode=${1:-}
require_fixture=0
if [ "$mode" = --require-incident-fixture ]; then
  require_fixture=1
  mode=
fi

[ -f "$project_dir/.env" ] || {
  echo "Missing .env; run ./scripts/configure.sh first." >&2
  exit 1
}

get_env() {
  awk -F= -v wanted="$1" '$1 == wanted { print substr($0, index($0, "=") + 1); exit }' "$project_dir/.env"
}

if [ -z "$mode" ]; then
  case "$(get_env DSH_DEPLOYMENT_MODE)" in
    external) mode=--external-ollama ;;
    remote) mode=--remote-ollama ;;
    managed) mode=--managed-ollama ;;
    *) echo "DSH_DEPLOYMENT_MODE must select external, remote, or managed." >&2; exit 2 ;;
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
    echo "usage: ./scripts/verify-dsh-token-memory.sh [--external-ollama|--remote-ollama|--managed-ollama|--require-incident-fixture]" >&2
    exit 2
    ;;
esac

# Paths are repository-controlled and do not contain whitespace in supported
# deployments. Splitting compose_files is intentional for POSIX sh.
# shellcheck disable=SC2086
compose() { docker compose --env-file "$project_dir/.env" $compose_files "$@"; }

[ "$(get_env DSH_TOKEN_ENABLED)" = false ] || {
  echo "Memory qualification requires DSH_TOKEN_ENABLED=false." >&2
  exit 1
}

container_id=$(compose ps -q harness)
[ -n "$container_id" ] || { echo "Harness container is not running." >&2; exit 1; }
health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
[ "$health" = healthy ] || { echo "Harness is not healthy: $health" >&2; exit 1; }

fixture=$(compose exec -T harness sh -eu -c '
  count=$(find /data/dsh/sessions -type f -name "*.zstd" | wc -l | tr -d " ")
  bytes=$(find /data/dsh/sessions -type f -name "*.zstd" -exec stat -c %s {} \; | awk "{ total += \$1 } END { print total + 0 }")
  printf "%s %s\n" "$count" "$bytes"
')
fixture_count=${fixture%% *}
fixture_bytes=${fixture#* }
if [ "$require_fixture" -eq 1 ] && [ "$fixture_count" -ne 52 ]; then
  echo "Incident regression requires 52 compressed session artifacts; found $fixture_count." >&2
  exit 1
fi

if ! compose exec -T harness dsh --profile web --dump-config \
  | compose exec -T harness node /opt/dsh-build/verify-dsh-token-policy.mjs \
      --effective-config disabled >/dev/null; then
  echo "The deployed token plugin is not disabled." >&2
  exit 1
fi

index_signature() {
  compose exec -T harness sh -c '
    if [ -f /data/dsh/storages/dsh_token_index.json ]; then
      cksum /data/dsh/storages/dsh_token_index.json
    else
      echo missing
    fi
  '
}

node_rss_kib() {
  compose exec -T harness sh -eu -c '
    pid=$(pgrep -o node)
    awk "/^VmRSS:/ { print \$2 }" "/proc/$pid/status"
  '
}

initial_id=$container_id
initial_restarts=$(docker inspect --format '{{.RestartCount}}' "$container_id")
initial_started=$(docker inspect --format '{{.State.StartedAt}}' "$container_id")
index_before=$(index_signature)
interval_seconds=${DSH_TOKEN_REFRESH_INTERVAL_SECONDS:-35}
max_rss_kib=${DSH_TOKEN_MAX_RSS_KIB:-1048576}
max_growth_kib=${DSH_TOKEN_MAX_GROWTH_KIB:-131072}

sample0=$(node_rss_kib)
echo "token-memory sample=0 rss_kib=$sample0"
sample1=
sample2=
sample3=
for sample_number in 1 2 3; do
  sleep "$interval_seconds"
  sample_value=$(node_rss_kib)
  case "$sample_number" in
    1) sample1=$sample_value ;;
    2) sample2=$sample_value ;;
    3) sample3=$sample_value ;;
  esac
  echo "token-memory sample=$sample_number rss_kib=$sample_value"
done

final_id=$(compose ps -q harness)
final_restarts=$(docker inspect --format '{{.RestartCount}}' "$final_id")
final_started=$(docker inspect --format '{{.State.StartedAt}}' "$final_id")
oom_killed=$(docker inspect --format '{{.State.OOMKilled}}' "$final_id")
index_after=$(index_signature)

[ "$final_id" = "$initial_id" ] || { echo "Harness container was recreated during memory qualification." >&2; exit 1; }
[ "$final_restarts" = "$initial_restarts" ] || { echo "Harness restart count changed during memory qualification." >&2; exit 1; }
[ "$final_started" = "$initial_started" ] || { echo "Harness start time changed during memory qualification." >&2; exit 1; }
[ "$oom_killed" = false ] || { echo "Harness reports an OOM kill." >&2; exit 1; }
[ "$index_after" = "$index_before" ] || { echo "Disabled dsh-token unexpectedly modified its durable index." >&2; exit 1; }

for rss in "$sample0" "$sample1" "$sample2" "$sample3"; do
  [ "$rss" -le "$max_rss_kib" ] || {
    echo "Harness Node RSS exceeded the $max_rss_kib KiB safety ceiling: $rss KiB." >&2
    exit 1
  }
done
growth=$((sample3 - sample0))
[ "$growth" -le "$max_growth_kib" ] || {
  echo "Harness Node RSS grew by $growth KiB; limit is $max_growth_kib KiB." >&2
  exit 1
}
if [ "$sample0" -lt "$sample1" ] \
  && [ "$sample1" -lt "$sample2" ] \
  && [ "$sample2" -lt "$sample3" ]; then
  echo "Harness Node RSS increased at every refresh boundary: $sample0 $sample1 $sample2 $sample3." >&2
  exit 1
fi

echo "Verified disabled dsh-token across $fixture_count artifacts ($fixture_bytes compressed bytes): RSS $sample0,$sample1,$sample2,$sample3 KiB; restarts=$final_restarts; OOMKilled=$oom_killed; index unchanged."
