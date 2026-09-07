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
  'dsh-playwright@0.1.0' \
  'dsh-session-pin@0.6.1' \
  'dsh-ui-appearance@0.1.6'
do
  printf '%s\n' "$inventory" | grep -Fq "$expected" || {
    echo "Missing captured plugin: $expected" >&2
    exit "$configuration_exit"
  }
done

# Import the patched dsh-playwright loader entry from the live runtime
# profile. The image build's boot smoke check proves the seed at build time;
# this proves the re-synced runtime profile still resolves the plugin's
# third-party dependencies (playwright-core, pngjs, ws) at deployment time.
if ! compose exec -T harness node -e \
  "import('file:///data/dsh/profiles/web/node_modules/dsh-playwright/lib/index.js').catch((e) => { console.error(e.message); process.exit(1); })"; then
  if ! docker info >/dev/null 2>&1; then
    echo "Docker Engine became unavailable during plugin import verification." >&2
    exit "$docker_compose_exit"
  fi
  echo "The deployed plugin tree failed to import dsh-playwright." >&2
  exit "$configuration_exit"
fi

# Import the deployed loop detector itself (not a source-side helper) and
# require the corrected generated implementation markers. This detects both a
# stale runtime profile and a patch that was present in source but not applied
# by pnpm to the installed package.
if ! compose exec -T harness node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const path = "/data/dsh/profiles/web/node_modules/dsh-loop-detector/lib/index.js";
  const plugin = await import(`file://${path}`);
  if (plugin.name !== "loop-detector" || typeof plugin.apply !== "function") {
    throw new Error("deployed loop detector exports are invalid");
  }
  const source = await readFile(path, "utf8");
  for (const marker of ["hasSemanticSignal", "primitivePeriod", "if (!hasSemanticSignal(segment)) continue"]) {
    if (!source.includes(marker)) throw new Error(`deployed loop detector is missing ${marker}`);
  }
  console.log("Verified corrected deployed dsh-loop-detector import and source markers.");
'; then
  echo "The deployed loop detector is stale or failed its runtime import probe." >&2
  exit "$configuration_exit"
fi

# Exercise the exact installed adapter and pi-ai package, including dynamic
# context/output budgeting and reasoning/tool continuation, rather than
# relying only on checked-in patch markers.
if ! compose exec -T harness node /opt/dsh-build/verify-dsh-inference-contract.mjs; then
  echo "The deployed Harness inference adapter does not satisfy the local router contract." >&2
  exit "$configuration_exit"
fi

# The browser module is generated from the pinned DSH package during the image
# build. Compile the exact deployed files and require the cancellation and
# native-file capability markers.
if ! compose exec -T harness node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const path = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js";
  const source = await readFile(path, "utf8");
  Function(source);
  for (const marker of [
    "dsh-cancellation-presentation-v1",
    "turn-cancellation",
    "Stopped by user",
    "The session or transport lifecycle ended before this turn completed.",
    "hasInterruptionEvidence(blocks)",
    "dsh-native-file-opening-v1",
    "openFile: availableOpenFile",
    "owner.openFile === void 0 ? void 0",
    "guardedWorkspaceFileOpener(connection.hostDescription",
  ]) {
    if (!source.includes(marker)) throw new Error(`deployed conversation browser module is missing ${marker}`);
  }
  const deliverablesPath = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-deliverables/lib/client.js";
  const deliverables = await readFile(deliverablesPath, "utf8");
  Function(deliverables);
  for (const marker of [
    "dsh-native-file-opening-v1",
    "shown.map((path) => canOpenPath ?",
    "hidden > 0 && isLoopback && canOpenPath",
  ]) {
    if (!deliverables.includes(marker)) throw new Error(`deployed deliverables browser module is missing ${marker}`);
  }
  console.log("Verified visible cancellation provenance and fail-closed native file actions in the deployed browser modules.");
'; then
  echo "The deployed browser modules are missing cancellation or native-file capability behavior." >&2
  exit "$configuration_exit"
fi

if ! compose exec -T harness node -e \
  "fetch('http://ai-router:11434/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then
  if ! docker info >/dev/null 2>&1; then
    echo "Docker Engine became unavailable during model-provider verification." >&2
    exit "$docker_compose_exit"
  fi
  echo "The configured model provider is unavailable or rejected access." >&2
  exit "$provider_exit"
fi

if [ "$mode" = --remote-ollama ]; then
  remote_host=$(get_env REMOTE_OLLAMA_HOST)
  [ -n "$remote_host" ] || remote_host=192.168.1.21
  resolved_hosts=$(compose exec -T harness getent hosts ai-router 2>/dev/null \
    | awk '{ print $1 }' | sort -u)
  if [ "$resolved_hosts" != "$remote_host" ]; then
    echo "Remote mode resolved ai-router to '$resolved_hosts' instead of REMOTE_OLLAMA_HOST '$remote_host'." >&2
    exit "$provider_exit"
  fi
  if ! compose exec -T harness node --input-type=module -e '
    const response = await fetch("http://ai-router:11434/v1/models");
    if (!response.ok) throw new Error(`model discovery returned HTTP ${response.status}`);
    const body = await response.json();
    const model = body?.data?.find((entry) => entry?.id === "local-active");
    const metadata = model?.x_ollama_router;
    if (metadata?.schema_version !== 2 || !metadata?.complete || metadata?.warnings?.length) {
      throw new Error(`local-active discovery is not complete schema-v2: ${JSON.stringify(metadata)}`);
    }
    for (const [field, expected] of Object.entries({
      context_window: 131072,
      active_request_limit: 2,
      max_output_tokens: 32768,
    })) {
      if (metadata[field] !== expected) {
        throw new Error(field + " is " + metadata[field] + "; expected " + expected);
      }
    }
    for (const modality of ["text", "image"]) {
      if (!metadata.input_modalities?.includes(modality)) throw new Error(`missing ${modality} input modality`);
    }
    for (const capability of ["vision", "tools"]) {
      if (!metadata.capabilities?.includes(capability)) throw new Error(`missing ${capability} capability`);
    }
    const reasoning = metadata.reasoning;
    if (
      reasoning?.supported !== true ||
      reasoning.default !== "medium" ||
      reasoning.absolute_max_output_tokens !== 32768 ||
      reasoning.efforts?.off !== "none" ||
      reasoning.efforts?.low !== "low" ||
      reasoning.efforts?.medium !== "medium" ||
      reasoning.efforts?.xhigh !== "xhigh" ||
      reasoning.aliases?.minimal !== "low" ||
      reasoning.aliases?.high !== "xhigh" ||
      reasoning.aliases?.max !== "xhigh"
    ) {
      throw new Error("local-active reasoning contract is incompatible: " + JSON.stringify(reasoning));
    }
  '; then
    echo "The direct remote router did not advertise the qualified local-active request contract." >&2
    exit "$provider_exit"
  fi
fi

# Trusted TLS gateway verification. verify-gateway-tls.sh probes
# https://HARNESS_TLS_IP:HARNESS_HTTPS_PORT/healthz from the caller's network
# namespace on the host. When invoked from an isolated maintenance runner
# (SERVICE_PORTAL_UPDATE_DELEGATED=1 or DSH_UPDATE_DELEGATED=1), 127.0.0.1 in
# the caller is the runner itself, so it instead runs the same trusted probe
# with full certificate-chain and IP verification inside the gateway
# container's network namespace. It exits 20 (Docker unavailable) or 23
# (verification failed); set -e propagates that classification here.
"$script_dir/verify-gateway-tls.sh"

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
echo "Verified DSH 0.1.1-rc.2, persisted runtime settings, canonical plugins, authenticated HTTPS gateway, and Ollama router reachability."
