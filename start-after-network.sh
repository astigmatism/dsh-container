#!/bin/sh
set -eu

# Start (or repair) the deepseek-harness deployment after the network is up.
#
# Docker's own unless-stopped start happens at daemon start, before the LAN
# address (HARNESS_BIND_ADDRESS) exists, so the harness cannot publish its
# ports then. In external mode it also joins the shared Ollama network
# (OLLAMA_NETWORK, normally local-ai-ollama_default) that the host's local-ai
# bootstrap destroys and replaces every boot, losing the attachment.
#
# This script waits for the Docker daemon, the LAN address, the local-ai
# bootstrap service, and (in external mode) the shared network; verifies the
# harness port binding and network attachment; when either is missing it
# recreates the harness for the recorded DSH_DEPLOYMENT_MODE, waits up to 240s
# for the harness healthcheck (exiting 1 with a clear message on timeout so a
# broken image fails the unit visibly instead of hanging the boot), then
# recreates the gateway and re-verifies binding, attachment, and gateway
# status. The healthy no-op path exits 0 quickly.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
env_file=$project_dir/.env
unit_name=deepseek-harness-after-network
harness_container=deepseek-harness
gateway_container=deepseek-harness-gateway
health_timeout=240

fail() {
  echo "start-after-network: $*" >&2
  exit 1
}

get_env() {
  [ -f "$env_file" ] || return 0
  awk -F= -v wanted="$1" '$1 == wanted { print substr($0, index($0, "=") + 1); exit }' "$env_file"
}

# docker compose with the file set for the recorded deployment mode, matching
# the mapping in scripts/update-and-restart.sh.
compose() {
  # shellcheck disable=SC2086
  docker compose --env-file "$env_file" $compose_files "$@"
}

wait_for_healthy() {
  container=$1
  timeout_seconds=$2
  deadline=$(( $(date +%s) + timeout_seconds ))
  while :; do
    state=$(docker inspect "$container" \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)
    [ "$state" = healthy ] && return 0
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "start-after-network: $container did not become healthy within ${timeout_seconds}s." >&2
      echo "start-after-network: inspect 'docker logs $container' and repair the deployment, then rerun with 'systemctl --user restart $unit_name'." >&2
      return 1
    fi
    sleep 5
  done
}

# unit_prop <system|user> <unit> <property>
unit_prop() {
  case "$1" in
    system) systemctl show "$2" -p "$3" 2>/dev/null | awk -F= -v wanted="$3" '$1 == wanted { print $2; exit }' ;;
    user) systemctl --user show "$2" -p "$3" 2>/dev/null | awk -F= -v wanted="$3" '$1 == wanted { print $2; exit }' ;;
  esac
}

# A bootstrap unit counts as done when it is active (oneshot with
# RemainAfterExit) or finished successfully as a plain oneshot. A unit that
# never ran, is still starting, or failed is not done.
bootstrap_unit_done() {
  scope=$1
  unit=$2
  load=$(unit_prop "$scope" "$unit" LoadState)
  [ "$load" = loaded ] || return 1
  active=$(unit_prop "$scope" "$unit" ActiveState)
  [ "$active" = active ] && return 0
  result=$(unit_prop "$scope" "$unit" Result)
  invocations=$(unit_prop "$scope" "$unit" NInvocations)
  case "$invocations" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$invocations" -gt 0 ] || return 1
  [ "$result" = success ]
}

harness_running() {
  [ "$(docker inspect "$harness_container" --format '{{.State.Status}}' 2>/dev/null || true)" = running ]
}

ports_bound() {
  ports=$(docker port "$harness_container" 2>/dev/null || true)
  printf '%s\n' "$ports" | grep -Fxq "3443/tcp -> ${bind_address}:${https_port}" \
    && printf '%s\n' "$ports" | grep -Fxq "3081/tcp -> ${bind_address}:${ca_port}"
}

network_attached() {
  docker inspect "$harness_container" \
    --format '{{json .NetworkSettings.Networks}}' 2>/dev/null \
    | grep -Fq "\"$expected_network\":"
}

[ -f "$env_file" ] || fail "missing .env; run ./scripts/configure.sh first"

mode=$(get_env DSH_DEPLOYMENT_MODE)
case "$mode" in
  external|remote|managed) ;;
  *) fail "DSH_DEPLOYMENT_MODE in .env must be external, remote, or managed (got '$mode')" ;;
esac

bind_address=$(get_env HARNESS_BIND_ADDRESS)
[ -n "$bind_address" ] || bind_address=127.0.0.1
https_port=$(get_env HARNESS_HTTPS_PORT)
[ -n "$https_port" ] || https_port=3443
ca_port=$(get_env HARNESS_CA_PORT)
[ -n "$ca_port" ] || ca_port=3081

case "$mode" in
  external)
    expected_network=$(get_env OLLAMA_NETWORK)
    [ -n "$expected_network" ] || expected_network=local-ai-ollama_default
    # shellcheck disable=SC2086
    compose_files="-f $project_dir/compose.yaml -f $project_dir/compose.external-ollama.yaml"
    ;;
  remote)
    expected_network=$(get_env DSH_NETWORK)
    [ -n "$expected_network" ] || expected_network=deepseek-harness_default
    # shellcheck disable=SC2086
    compose_files="-f $project_dir/compose.yaml -f $project_dir/compose.remote-ollama.yaml"
    ;;
  managed)
    expected_network=$(get_env MANAGED_OLLAMA_NETWORK)
    [ -n "$expected_network" ] || expected_network=dsh-container_ollama
    # shellcheck disable=SC2086
    compose_files="-f $project_dir/compose.yaml -f $project_dir/compose.managed-ollama.yaml"
    ;;
esac

echo "Boot check for $harness_container in $mode mode (bind $bind_address:$https_port/$ca_port, network $expected_network)."

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v ip >/dev/null 2>&1 || fail "ip (iproute2) is required"
if ! docker compose version >/dev/null 2>&1; then
  fail "the Docker Compose plugin is required"
fi

echo "Waiting for the Docker daemon..."
while ! docker info >/dev/null 2>&1; do
  sleep 5
done

have_address() {
  ip -o addr show 2>/dev/null | awk '{ print $4 }' | grep -Fq "${bind_address}/"
}
echo "Waiting for the LAN address $bind_address..."
while ! have_address; do
  sleep 5
done

if [ "$mode" = external ]; then
  echo "Waiting for the local-ai bootstrap to finish..."
  while :; do
    if bootstrap_unit_done system local-ai-apply-default.service \
      || bootstrap_unit_done user local-ai-apply-default-after-network.service; then
      break
    fi
    system_load=$(unit_prop system local-ai-apply-default.service LoadState)
    user_load=$(unit_prop user local-ai-apply-default-after-network.service LoadState)
    if [ "$system_load" != loaded ] && [ "$user_load" != loaded ]; then
      # Neither bootstrap unit exists on this host; the shared network check
      # below is the gate.
      break
    fi
    sleep 5
  done

  echo "Waiting for the shared Ollama network $expected_network..."
  while ! docker network inspect "$expected_network" >/dev/null 2>&1; do
    sleep 5
  done
fi

need_recreate=0
if ! harness_running; then
  echo "The harness container is not running; a recreate is required."
  need_recreate=1
elif ! ports_bound; then
  echo "The harness is not bound to ${bind_address}:${https_port} and ${bind_address}:${ca_port}; a recreate is required."
  need_recreate=1
elif ! network_attached; then
  echo "The harness is not attached to $expected_network; a recreate is required."
  need_recreate=1
fi

if [ "$need_recreate" -eq 0 ]; then
  echo "Harness binding and network attachment are already correct; nothing to do."
  exit 0
fi

echo "Recreating the harness container for the $mode topology..."
compose up -d --force-recreate --no-deps harness
wait_for_healthy "$harness_container" "$health_timeout"

echo "Recreating the gateway on the harness network namespace..."
compose up -d --force-recreate --no-deps gateway
wait_for_healthy "$gateway_container" "$health_timeout"

if ! harness_running || ! ports_bound || ! network_attached; then
  fail "re-verification after recreation failed: the harness binding or network attachment is still missing"
fi

echo "Boot check complete: harness bound to $bind_address, attached to $expected_network, gateway healthy."
