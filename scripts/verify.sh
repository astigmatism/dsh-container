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

expected_dsh_version=$(get_env DSH_VERSION)
[ -n "$expected_dsh_version" ] || expected_dsh_version=0.1.5-alpha.1
expected_upstream_commit=$(get_env DSH_UPSTREAM_COMMIT)
[ -n "$expected_upstream_commit" ] || expected_upstream_commit=5dda764ed3aa172535a7967b06ff95d9cbfe536a
deployed_dsh_version=$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' deepseek-harness 2>/dev/null || true)
deployed_upstream_commit=$(docker inspect --format '{{ index .Config.Labels "io.astigmatism.deepseek-harness.upstream.commit" }}' deepseek-harness 2>/dev/null || true)
if [ "$deployed_dsh_version" != "$expected_dsh_version" ] \
  || [ "$deployed_upstream_commit" != "$expected_upstream_commit" ]; then
  echo "The deployed Harness image provenance does not match .env." >&2
  exit "$configuration_exit"
fi
if ! compose exec -T harness node -e \
  'const expected = process.argv[1]; const actual = require("/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json").version; if (actual !== expected) { console.error(`expected ${expected}, found ${actual}`); process.exit(1); }' \
  "$expected_dsh_version"; then
  echo "The deployed Harness package version does not match its image provenance." >&2
  exit "$configuration_exit"
fi
echo "Verified DeepSeek Harness $expected_dsh_version from upstream commit $expected_upstream_commit."

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
  'dsh-context@0.47.0' \
  'dsh-favicon-status@0.1.0-rc.5' \
  'dsh-local-speech-input@link:' \
  'dsh-loop-detector@1.0.0' \
  'dsh-plugin-task-notification@0.2.1' \
  'dsh-playwright@0.1.0' \
  'dsh-session-pin@0.7.7' \
  'dsh-ui-appearance@0.1.8'
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
  for (const marker of [
    "hasSemanticSignal",
    "primitivePeriod",
    "if (!hasSemanticSignal(segment)) continue",
    "DUPLICATE_READ_SUPPRESSED",
    "implementation-checkpoint",
    "reasoning_prefix_cycle",
    "Compaction preserved the progress guard state",
  ]) {
    if (!source.includes(marker)) throw new Error(`deployed loop detector is missing ${marker}`);
  }
  console.log("Verified corrected deployed dsh-loop-detector import and source markers.");
'; then
  echo "The deployed loop detector is stale or failed its runtime import probe." >&2
  exit "$configuration_exit"
fi

if ! compose exec -T harness node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const path = "/data/dsh/profiles/web/node_modules/dsh-playwright/lib/index.js";
  const source = await readFile(path, "utf8");
  if (!source.includes("dsh-playwright-webserver-scope-v1")) {
    throw new Error("deployed dsh-playwright is missing scoped webServer compatibility");
  }
  console.log("Verified dsh-playwright scoped webServer compatibility.");
'; then
  echo "The deployed Browser Use plugin is incompatible with the current web server scope." >&2
  exit "$configuration_exit"
fi

# Exercise the exact installed adapter and pi-ai package, including dynamic
# context/output budgeting and reasoning/tool continuation, rather than
# relying only on checked-in patch markers.
if ! compose exec -T harness node /opt/dsh-build/verify-dsh-inference-contract.mjs; then
  echo "The deployed Harness inference adapter does not satisfy the local router contract." >&2
  exit "$configuration_exit"
fi

# The discovery plugin upgrades persisted settings in place when the second
# profile is absent and restores each profile's static capacity after backend
# swaps. Wait briefly for its immediate synchronization before validating the
# user-visible model-selection contract.
profile_deadline=$(( $(date +%s) + 30 ))
while ! profile_output=$(compose exec -T harness node /opt/dsh-build/verify-local-model-profiles.mjs 2>&1); do
  if [ "$(date +%s)" -ge "$profile_deadline" ]; then
    printf '%s\n' "$profile_output" >&2
    echo "The deployed Harness did not expose both local model profiles." >&2
    exit "$configuration_exit"
  fi
  sleep 1
done
printf '%s\n' "$profile_output"

# Exercise the installed compaction policy and shared context classifier with
# bounded in-memory fixtures, then resolve the live Web composition from its
# bundle layers and require the route-specific automatic policy to be active.
if ! compose exec -T harness node /opt/dsh-build/verify-dsh-context-compaction.mjs; then
  echo "The deployed Harness context-overflow recovery contract is incomplete." >&2
  exit "$configuration_exit"
fi
if ! compose exec -T harness env DSH_PROFILE_ROOT=/data/dsh/profiles/web \
  node /opt/dsh-build/verify-dsh-semantic-progress.mjs; then
  echo "The deployed Harness semantic progress guard is incomplete." >&2
  exit "$configuration_exit"
fi
if ! compose exec -T harness dsh --profile web --dump-config \
  | compose exec -T harness node /opt/dsh-build/verify-dsh-context-compaction.mjs --effective-config; then
  echo "The effective Web composition does not mount the required compaction policy." >&2
  exit "$configuration_exit"
fi

# The browser module is generated from the pinned DSH package during the image
# build. Compile the exact deployed files and require the cancellation and
# in-app workspace-file behavior markers.
if ! compose exec -T harness node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const path = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js";
  const source = await readFile(path, "utf8");
  Function(source);
  for (const marker of [
    "dsh-cancellation-presentation-v1",
    "event.data.reason.kind === \"error\" || event.data.reason.kind === \"aborted\"",
    "failure.cancellation === void 0 ? {} : { cancellation: failure.cancellation }",
    "Stopped by user",
    "The session or transport lifecycle ended before this turn completed.",
    "hasInterruptionEvidence(blocks)",
    "dsh-native-file-opening-v1",
    "const FILE_ADDRESS_PREFIX = \"dsh-resource://file/\";",
    "const url = fileAddressFor(sessionId, cwd, path);",
    "ctx.sidebarRight.openResource(url)",
  ]) {
    if (!source.includes(marker)) throw new Error(`deployed conversation browser module is missing ${marker}`);
  }
  const deliverablesPath = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-deliverables/lib/client.js";
  const deliverables = await readFile(deliverablesPath, "utf8");
  Function(deliverables);
  for (const marker of [
    "dsh-native-file-opening-v1",
    "function ProducedFiles({ matched: paths, openFile, t })",
    "producedFileMentions(paths, owner.openFile",
  ]) {
    if (!deliverables.includes(marker)) throw new Error(`deployed deliverables browser module is missing ${marker}`);
  }
  console.log("Verified visible cancellation provenance and in-app workspace resource opening in the deployed browser modules.");
'; then
  echo "The deployed browser modules are missing cancellation or workspace-resource behavior." >&2
  exit "$configuration_exit"
fi

if ! compose exec -T harness node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const path = "/data/dsh/profiles/web/node_modules/@zoytown/dsh-token/lib/index.js";
  const source = await readFile(path, "utf8");
  if (!source.includes("dsh-token-session-format-v3-compat-v1")) {
    throw new Error("deployed dsh-token is missing format v3 compatibility");
  }
  console.log("Verified dsh-token format v3 session compatibility.");
'; then
  echo "The deployed token plugin is incompatible with the current session format." >&2
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
    const backendProfile = `${metadata.context_window}:${metadata.active_request_limit}`;
    if (!new Set(["131072:2", "262144:1"]).has(backendProfile)) {
      throw new Error(
        `backend capacity is ${backendProfile}; expected 128K/2 or 256K/1`,
      );
    }
    if (metadata.max_output_tokens !== 32768) {
      throw new Error("max_output_tokens is " + metadata.max_output_tokens + "; expected 32768");
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
echo "Verified DSH 0.1.5-alpha.1, persisted runtime settings, canonical plugins, authenticated HTTPS gateway, and Ollama router reachability."
