#!/bin/sh
set -eu

# Verify the authenticated HTTPS gateway's /healthz endpoint against the
# trusted local CA, fail-closed.
#
# Host mode (default): the caller runs on the Docker host (or otherwise in a
# network namespace that can reach the published port), so the check curls
# https://HARNESS_TLS_IP:HARNESS_HTTPS_PORT/healthz directly, exactly as
# verify.sh always did.
#
# Delegated mode: when the caller is a Service Portal maintenance runner or a
# Harness-delegated maintenance container (SERVICE_PORTAL_UPDATE_DELEGATED=1
# or DSH_UPDATE_DELEGATED=1), the caller sits in an ordinary isolated
# container whose 127.0.0.1 is the runner itself, not the host. The
# trusted-TLS probe is therefore executed inside the gateway container, which
# shares the Harness network namespace where the gateway listener is bound.
# The probe receives the host-side CA over stdin and keeps full
# certificate-chain and IP verification: the gateway certificate always
# carries the IP:127.0.0.1 SAN. The host bind address and published port are
# irrelevant in delegated mode; the probe targets the listener in the
# gateway's own network namespace. Verification is never skipped and never
# relaxed in delegated mode.
#
# Exit codes: 0 verified, 20 Docker Engine unavailable, 23 gateway TLS
# verification failed (or its inputs are missing).

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)

container=deepseek-harness-gateway
ca_file=$project_dir/data/gateway/tls/ca.crt
tls_ip=
https_port=

usage() {
  cat <<'EOF'
usage: verify-gateway-tls.sh [--container NAME] [--ca FILE] [--ip IP] [--port PORT]

Verifies https://<ip>:<port>/healthz with full certificate-chain and
hostname/IP verification against the local gateway CA. Defaults:
container deepseek-harness-gateway, CA <project>/data/gateway/tls/ca.crt,
ip/port from .env (HARNESS_TLS_IP, HARNESS_HTTPS_PORT). When
SERVICE_PORTAL_UPDATE_DELEGATED=1 or DSH_UPDATE_DELEGATED=1 is set, the probe
runs inside the gateway container's network namespace instead of the caller's
and the host ip/port settings are not used.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --container) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; container=$2; shift 2 ;;
    --ca) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; ca_file=$2; shift 2 ;;
    --ip) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; tls_ip=$2; shift 2 ;;
    --port) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; https_port=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

get_env() {
  [ -f "$project_dir/.env" ] || return 0
  awk -F= -v wanted="$1" '$1 == wanted { print substr($0, index($0, "=") + 1); exit }' "$project_dir/.env"
}

delegated=0
if [ "${SERVICE_PORTAL_UPDATE_DELEGATED:-0}" = 1 ] || [ "${DSH_UPDATE_DELEGATED:-0}" = 1 ]; then
  delegated=1
fi

if [ ! -s "$ca_file" ]; then
  echo "Gateway CA is missing or empty ($ca_file); refusing to skip trusted-TLS verification." >&2
  exit 23
fi

if [ "$delegated" -eq 1 ]; then
  if ! docker info >/dev/null 2>&1; then
    echo "Docker Engine became unavailable during HTTPS gateway verification." >&2
    exit 20
  fi

  # The probe runs inside the gateway container, where 127.0.0.1 is the
  # shared Harness/gateway network namespace and the gateway listener is
  # bound. It trusts exactly the CA bytes the runner supplies on stdin,
  # verifies the full chain and the IP:127.0.0.1 SAN, and requires HTTP 200.
  # The port comes from the gateway container's own HARNESS_HTTPS_PORT.
  probe=$(cat <<'EOF'
import https from 'node:https'

const port = Number.parseInt(process.env.HARNESS_HTTPS_PORT || '3443', 10)
if (!Number.isSafeInteger(port) || port <= 0) {
  process.stderr.write('Gateway HTTPS port is not configured.\n')
  process.exit(1)
}
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const ca = Buffer.concat(chunks)
if (ca.length === 0) {
  process.stderr.write('No gateway CA was supplied to the probe.\n')
  process.exit(1)
}
const request = https.get(
  { host: '127.0.0.1', port, path: '/healthz', ca },
  response => {
    response.resume()
    response.on('end', () => {
      if (response.statusCode !== 200) {
        process.stderr.write(`Gateway health endpoint returned HTTP ${response.statusCode}.\n`)
        process.exit(1)
      }
      process.exit(0)
    })
  },
)
request.setTimeout(10000, () => request.destroy(new Error('gateway health probe timed out')))
request.on('error', error => {
  process.stderr.write(`Gateway trusted-TLS probe failed: ${error.message}\n`)
  process.exit(1)
})
EOF
  )

  if ! docker exec -i "$container" node --input-type=module -e "$probe" <"$ca_file"; then
    echo "The authenticated HTTPS gateway did not pass trusted TLS health verification from the gateway network namespace." >&2
    exit 23
  fi
  exit 0
fi

[ -n "$tls_ip" ] || tls_ip=$(get_env HARNESS_TLS_IP)
[ -n "$https_port" ] || https_port=$(get_env HARNESS_HTTPS_PORT)

if [ -z "$tls_ip" ] || [ -z "$https_port" ]; then
  echo "Gateway TLS identity is incomplete (ip=$tls_ip port=$https_port); refusing to skip trusted-TLS verification." >&2
  exit 23
fi

if ! curl --fail --silent --show-error --cacert "$ca_file" \
  "https://$tls_ip:$https_port/healthz" >/dev/null; then
  if ! docker info >/dev/null 2>&1; then
    echo "Docker Engine became unavailable during HTTPS gateway verification." >&2
    exit 20
  fi
  echo "The authenticated HTTPS gateway did not pass trusted TLS health verification." >&2
  exit 23
fi

exit 0
