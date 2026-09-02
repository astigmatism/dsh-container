#!/bin/sh
set -eu

container=${HARNESS_CONTAINER:-deepseek-harness}
require_private=0

case "${1:-}" in
  '') ;;
  --require-private-targets) require_private=1 ;;
  -h|--help)
    echo "usage: ./scripts/verify-browser-readiness.sh [--require-private-targets]"
    exit 0
    ;;
  *)
    echo "usage: ./scripts/verify-browser-readiness.sh [--require-private-targets]" >&2
    exit 2
    ;;
esac

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required for browser readiness verification." >&2
  exit 1
}

[ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" = true ] || {
  echo "Harness container is not running: $container" >&2
  exit 1
}

inventory=$(docker exec "$container" dsh plugin --profile web list)
printf '%s\n' "$inventory" | grep -Fq 'dsh-playwright@0.1.0' || {
  echo "The pinned dsh-playwright@0.1.0 plugin is not installed." >&2
  exit 1
}

docker exec "$container" test -x /usr/bin/chromium || {
  echo "Chromium is not executable at /usr/bin/chromium." >&2
  exit 1
}

docker exec "$container" sh -eu -c '
  browser_tmp=$(mktemp -d /tmp/dsh-browser-readiness.XXXXXX)
  trap '\''rm -rf -- "$browser_tmp"'\'' EXIT HUP INT TERM
  HOME="$browser_tmp" /usr/bin/chromium \
    --headless \
    --no-sandbox \
    --disable-gpu \
    --user-data-dir="$browser_tmp/profile" \
    --dump-dom "data:text/html,<title>DSH browser ready</title>" \
    2>/dev/null | grep -Fq "<title>DSH browser ready</title>"
' || {
  echo "Chromium could not complete a headless render." >&2
  exit 1
}

docker exec "$container" node --input-type=module -e '
  const response = await fetch("http://ai-router:11434/v1/models");
  if (!response.ok) throw new Error(`model discovery returned HTTP ${response.status}`);
  const body = await response.json();
  const model = body?.data?.find((entry) => entry?.id === "local-active");
  const metadata = model?.x_ollama_router;
  if (!metadata?.complete || metadata?.warnings?.length) {
    throw new Error(`local-active discovery is incomplete: ${JSON.stringify(metadata?.warnings ?? [])}`);
  }
  for (const modality of ["text", "image"]) {
    if (!metadata.input_modalities?.includes(modality)) throw new Error(`missing ${modality} input modality`);
  }
  for (const capability of ["vision", "tools"]) {
    if (!metadata.capabilities?.includes(capability)) throw new Error(`missing ${capability} capability`);
  }
' || {
  echo "The active model route is not advertising complete vision and tool support." >&2
  exit 1
}

if [ "$require_private" -eq 1 ]; then
  docker exec "$container" sh -eu -c \
    'test "${DSH_BROWSER_ALLOW_PRIVATE_HOSTS:-false}" = true' || {
      echo "Private browser targets are required but DSH_BROWSER_ALLOW_PRIVATE_HOSTS is not true." >&2
      exit 1
    }
fi

echo "Browser readiness checks passed. Run the model acceptance prompt from docs/visual-validation-playbook.md to verify screenshot reasoning."
