#!/bin/sh
set -eu

# Live Docker test for delegated (Service Portal / maintenance runner)
# gateway TLS verification.
#
# The bug this test pins down: scripts/verify.sh verified
# https://127.0.0.1:HARNESS_HTTPS_PORT/healthz from the caller's network
# namespace. On the Docker host that is the published gateway port, but a
# Service Portal update runs in a detached, ordinary bridge-network
# maintenance container whose 127.0.0.1 is the runner itself, so the check
# failed with curl exit 7 and the updater exited 23 even though the
# deployment was healthy. Mocked command-order tests cannot catch that, so
# this test builds the real topology:
#
#   * a "gateway" container on an isolated network hosting the TLS listener
#     (the role of deepseek-harness-gateway), its port published to the host
#     like the real deployment;
#   * a "maintenance runner" container created exactly like the Service
#     Portal contract (default bridge network, repository + Docker socket
#     mounted, SERVICE_PORTAL_UPDATE_DELEGATED=1 and DSH_UPDATE_DELEGATED=1,
#     no host networking);
# and exercises scripts/verify-gateway-tls.sh (the check verify.sh runs)
# from inside that runner:
#
#   * proves the runner cannot reach the gateway through 127.0.0.1 while the
#     host can (the bug's precondition is genuinely present);
#   * proves delegated verification from the runner passes with full
#     certificate-chain and IP verification (and that either delegated flag
#     alone is sufficient);
#   * proves an invalid CA, a certificate without the IP:127.0.0.1 SAN, and
#     an unavailable gateway listener each still fail with exit 23
#     (fail-closed; also defeats any "fix" that skips or relaxes TLS);
#   * proves an unavailable Docker engine is classified as exit 20;
#   * proves host-mode input validation still fails closed.

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_root=$(CDPATH= cd -- "$test_dir/.." && pwd)

# Same pinned images check.sh uses for its Node checks, plus the Docker CLI
# image the repository Dockerfile pins.
node_image=node@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
docker_cli_image=docker@sha256:d14410ab6f87a2b6c14b7150de787cd7b8bb012a8e900966d6d893e9f7fc49b6

fail() {
  echo "not ok - $*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is required for the delegated gateway test"
docker info >/dev/null 2>&1 || fail "Docker Engine is unavailable"
command -v openssl >/dev/null 2>&1 || fail "openssl is required to generate the test PKI"
command -v python3 >/dev/null 2>&1 || fail "python3 is required to pick a free port"

helper=$source_root/scripts/verify-gateway-tls.sh
[ -x "$helper" ] || fail "scripts/verify-gateway-tls.sh is missing or not executable"

# verify.sh must route gateway TLS verification through the helper and must
# not contain a direct curl command for the gateway itself. Ignore comments so
# documentation can still name the endpoint being verified.
grep -Fq 'verify-gateway-tls.sh' "$source_root/scripts/verify.sh" \
  || fail "verify.sh no longer routes gateway TLS verification through verify-gateway-tls.sh"
if awk '
  /^[[:space:]]*#/ { next }
  /(^|[[:space:]])curl([[:space:]]|$)/ { found = 1 }
  END { exit found ? 0 : 1 }
' "$source_root/scripts/verify.sh"; then
  fail "verify.sh still probes the gateway itself instead of using verify-gateway-tls.sh"
fi

temporary_root=$(mktemp -d)
certdir=$temporary_root/certs
mkdir "$certdir"
suffix=$$
runner_image=dsh-delegated-verify-runner:local
names=
add_name() { names="$names $1"; }

cleanup() {
  for name in $names; do
    docker rm -f "$name" >/dev/null 2>&1 || true
  done
  docker rmi "$runner_image" >/dev/null 2>&1 || true
  rm -rf "$temporary_root"
}
trap cleanup EXIT HUP INT TERM

expect_status() {
  expected=$1
  description=$2
  shift 2
  output=$(mktemp)
  set +e
  "$@" >"$output" 2>&1
  actual=$?
  set -e
  if [ "$actual" -ne "$expected" ]; then
    sed 's/^/    /' "$output" >&2
    rm -f "$output"
    fail "$description: expected exit $expected, got $actual"
  fi
  rm -f "$output"
}

# --- Test PKI ---------------------------------------------------------------

openssl req -x509 -newkey rsa:2048 -keyout "$certdir/ca.key" -out "$certdir/ca.crt" \
  -days 1 -nodes -subj '/CN=Delegated Gateway Test CA' 2>/dev/null \
  || fail "could not create the test CA"

make_leaf() { # $1 = base name, $2 = subjectAltName value
  openssl req -newkey rsa:2048 -keyout "$certdir/$1.key" -out "$certdir/$1.csr" \
    -nodes -subj '/CN=deepseek-harness.local' 2>/dev/null || return 1
  {
    printf 'basicConstraints=critical,CA:FALSE\n'
    printf 'keyUsage=critical,digitalSignature,keyEncipherment\n'
    printf 'extendedKeyUsage=serverAuth\n'
    printf 'subjectAltName=%s\n' "$2"
  } >"$certdir/$1.ext"
  openssl x509 -req -in "$certdir/$1.csr" -CA "$certdir/ca.crt" -CAkey "$certdir/ca.key" \
    -CAcreateserial -days 1 -extfile "$certdir/$1.ext" -out "$certdir/$1.crt" 2>/dev/null
}

make_leaf server 'IP:127.0.0.1,DNS:deepseek-harness.local,DNS:localhost' \
  || fail "could not create the IP SAN leaf certificate"
make_leaf noip 'DNS:deepseek-harness.local,DNS:localhost' \
  || fail "could not create the DNS-only leaf certificate"
openssl req -x509 -newkey rsa:2048 -keyout "$certdir/wrong-ca.key" -out "$certdir/wrong-ca.crt" \
  -days 1 -nodes -subj '/CN=Wrong Test CA' 2>/dev/null \
  || fail "could not create the invalid test CA"

cp "$source_root/tests/fixtures/delegated-gateway/tls-server.mjs" "$certdir/" \
  || fail "could not stage the test TLS server fixture"

ports=$(python3 - <<'PY'
import socket

free = []
for candidate in range(43443, 43843):
    probe = socket.socket()
    try:
        probe.bind(('127.0.0.1', candidate))
    except OSError:
        probe.close()
        continue
    probe.close()
    free.append(candidate)
    if len(free) == 2:
        break
if len(free) < 2:
    raise SystemExit("no free test ports found")
print(free[0], free[1])
PY
) || fail "could not pick free test ports"
gateway_port=${ports%% *}
dead_port=${ports##* }

# --- Test gateways ------------------------------------------------------------

start_gateway() { # $1 = name, $2 = cert, $3 = key, $4 = publish (0|1)
  name=$1
  cert=$2
  key=$3
  publish=${4:-0}
  # One string, split on expansion: the port is numeric and the path is ours.
  publish_args=
  if [ "$publish" = 1 ]; then
    publish_args="--publish 127.0.0.1:$gateway_port:$gateway_port"
  fi
  # shellcheck disable=SC2086
  docker run --detach --rm --init --name "$name" \
    --env "HARNESS_HTTPS_PORT=$gateway_port" \
    --env "GATEWAY_TEST_CERT=/certs/$cert" \
    --env "GATEWAY_TEST_KEY=/certs/$key" \
    $publish_args \
    --volume "$certdir:/certs:ro" \
    --entrypoint /bin/sh \
    "$node_image" -c "node /certs/tls-server.mjs" >/dev/null \
    || fail "could not start test gateway $name"
  add_name "$name"
}

wait_ready() {
  name=$1
  tries=0
  # Readiness only: accept any TLS so the loop can distinguish "listener not
  # up yet" from "listener up". The trusted verification itself is performed
  # strictly by verify-gateway-tls.sh below.
  while [ "$tries" -lt 150 ]; do
    if docker exec "$name" node -e \
      "require('node:https').get({ host: '127.0.0.1', port: process.env.HARNESS_HTTPS_PORT || '3443', path: '/healthz', rejectUnauthorized: false }, response => { response.resume(); response.on('end', () => process.exit(response.statusCode === 200 ? 0 : 1)) }).on('error', () => process.exit(1))" \
      >/dev/null 2>&1; then
      return 0
    fi
    tries=$((tries + 1))
    sleep 0.2
  done
  docker logs "$name" >&2 || true
  return 1
}

gw_ok=dsh-delegated-gw-ok-$suffix
gw_noip=dsh-delegated-gw-noip-$suffix
gw_dead=dsh-delegated-gw-dead-$suffix

start_gateway "$gw_ok" server.crt server.key 1
wait_ready "$gw_ok" || fail "test gateway with the IP SAN certificate never became ready"

start_gateway "$gw_noip" noip.crt noip.key 0
wait_ready "$gw_noip" || fail "test gateway with the DNS-only certificate never became ready"

# A container that shares the runner's fate: up, but no listener bound.
docker run --detach --rm --init --name "$gw_dead" \
  --env "HARNESS_HTTPS_PORT=$gateway_port" \
  --entrypoint /bin/sh \
  "$node_image" -c "exec sleep infinity" >/dev/null \
  || fail "could not start the listener-less test gateway"
add_name "$gw_dead"

# --- Maintenance runner -------------------------------------------------------

# The runner image is the pinned Node image plus the pinned Docker CLI, so it
# can run the helper the same way the production harness image does.
runner_build_dir=$temporary_root/runner
mkdir "$runner_build_dir"
cat >"$runner_build_dir/Dockerfile" <<EOF
FROM $node_image
COPY --from=$docker_cli_image /usr/local/bin/docker /usr/local/bin/docker
EOF
docker build --quiet -t "$runner_image" "$runner_build_dir" >/dev/null \
  || fail "could not build the maintenance runner image"

socket_group_id() {
  # Docker Desktop exposes /var/run/docker.sock as a host-side symlink whose
  # group can differ from the socket mounted into a Linux container. Resolve
  # the effective group in the runner's namespace instead of inspecting the
  # host path.
  docker run --rm --network none \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --entrypoint stat "$node_image" -c '%g' /var/run/docker.sock
}

runner_name=dsh-delegated-runner-$suffix
# Created exactly like the Service Portal contract: default bridge network,
# repository + Docker socket mounted, both delegated markers set, and no host
# networking.
docker run --detach --rm --init \
  --name "$runner_name" \
  --pull=never \
  --user "$(id -u):$(id -g)" \
  --group-add "$(socket_group_id)" \
  --env DSH_UPDATE_DELEGATED=1 \
  --env SERVICE_PORTAL_UPDATE_DELEGATED=1 \
  --env HOME=/tmp \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume "$source_root:$source_root" \
  --volume "$certdir:/tmp/dsh-test-certs:ro" \
  --workdir "$source_root" \
  --entrypoint /bin/sh \
  "$runner_image" -c "exec sleep infinity" >/dev/null \
  || fail "could not start the maintenance runner"
add_name "$runner_name"

tries=0
while [ "$tries" -lt 100 ]; do
  if docker exec "$runner_name" true 2>/dev/null; then
    break
  fi
  tries=$((tries + 1))
  sleep 0.2
done
docker exec "$runner_name" true >/dev/null 2>&1 \
  || fail "the maintenance runner never became ready"

runner_helper=$source_root/scripts/verify-gateway-tls.sh
runner_ca=/tmp/dsh-test-certs/ca.crt
runner_wrong_ca=/tmp/dsh-test-certs/wrong-ca.crt

# --- The bug's precondition: the runner cannot see the host loopback ---------

expect_status 1 "the maintenance runner must NOT reach the gateway through its own 127.0.0.1" \
  docker exec "$runner_name" node -e \
    "fetch('https://127.0.0.1:$gateway_port/healthz', { rejectUnauthorized: false }).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1)).catch(() => process.exit(1))"

# --- Host mode (unchanged behavior) -------------------------------------------

expect_status 0 "host-mode trusted TLS verification from the host" \
  sh "$helper" --container "$gw_ok" --ca "$certdir/ca.crt" --ip 127.0.0.1 --port "$gateway_port"

expect_status 23 "host-mode verification fails closed when the gateway is unreachable" \
  sh "$helper" --ca "$certdir/ca.crt" --ip 127.0.0.1 --port "$dead_port"

# --- Delegated mode from the maintenance runner --------------------------------

expect_status 0 "delegated trusted TLS verification from the maintenance runner" \
  docker exec "$runner_name" sh "$runner_helper" --container "$gw_ok" --ca "$runner_ca"

expect_status 0 "delegation triggered by SERVICE_PORTAL_UPDATE_DELEGATED alone" \
  docker exec -e DSH_UPDATE_DELEGATED=0 "$runner_name" sh "$runner_helper" --container "$gw_ok" --ca "$runner_ca"

expect_status 0 "delegation triggered by DSH_UPDATE_DELEGATED alone" \
  docker exec -e SERVICE_PORTAL_UPDATE_DELEGATED=0 "$runner_name" sh "$runner_helper" --container "$gw_ok" --ca "$runner_ca"

# Without the delegated markers the helper behaves as before, which is exactly
# the pre-fix failure inside the runner. If this ever passes, the test
# environment no longer reproduces the bug.
expect_status 23 "non-delegated verification from the runner fails (pre-fix behavior preserved)" \
  docker exec -e DSH_UPDATE_DELEGATED=0 -e SERVICE_PORTAL_UPDATE_DELEGATED=0 "$runner_name" \
  sh "$runner_helper" --container "$gw_ok" --ca "$runner_ca" --ip 127.0.0.1 --port "$gateway_port"

# --- Delegated negatives: every failure mode still exits 23 ---------------------

expect_status 23 "delegated verification fails closed with an invalid CA" \
  docker exec "$runner_name" sh "$runner_helper" --container "$gw_ok" --ca "$runner_wrong_ca"

expect_status 23 "delegated verification fails closed when the certificate lacks the IP:127.0.0.1 SAN" \
  docker exec "$runner_name" sh "$runner_helper" --container "$gw_noip" --ca "$runner_ca"

expect_status 23 "delegated verification fails closed when the gateway listener is unavailable" \
  docker exec "$runner_name" sh "$runner_helper" --container "$gw_dead" --ca "$runner_ca"

expect_status 20 "an unavailable Docker engine classifies as exit 20" \
  docker exec -e DOCKER_HOST=unix:///nonexistent-dsh-test.sock "$runner_name" \
  sh "$runner_helper" --container "$gw_ok" --ca "$runner_ca"

expect_status 20 "host-mode verification preserves Docker-unavailable exit 20" \
  docker exec -e DSH_UPDATE_DELEGATED=0 -e SERVICE_PORTAL_UPDATE_DELEGATED=0 \
  -e DOCKER_HOST=unix:///nonexistent-dsh-test.sock "$runner_name" \
  sh "$runner_helper" --ca "$runner_ca" --ip 127.0.0.1 --port "$gateway_port"

# --- Host-mode input validation still fails closed ------------------------------

# A bare project tree (no .env, no data/) exercises the helper's own
# fail-closed input checks without touching the real checkout.
fake_project=$temporary_root/fake-project
mkdir -p "$fake_project/scripts"
cp "$helper" "$fake_project/scripts/verify-gateway-tls.sh"
fake_helper=$fake_project/scripts/verify-gateway-tls.sh

expect_status 23 "missing HARNESS_TLS_IP (no .env) fails closed in host mode" \
  sh "$fake_helper" --ca "$certdir/ca.crt" --port "$dead_port"

expect_status 23 "missing HARNESS_HTTPS_PORT (no .env) fails closed in host mode" \
  sh "$fake_helper" --ca "$certdir/ca.crt" --ip 127.0.0.1

expect_status 23 "missing CA file fails closed in host mode" \
  sh "$fake_helper" --ip 127.0.0.1 --port "$dead_port"

echo "ok - delegated gateway TLS verification works from an isolated maintenance runner and fails closed"
