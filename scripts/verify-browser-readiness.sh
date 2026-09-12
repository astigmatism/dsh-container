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

docker exec "$container" node /opt/dsh-build/verify-dsh-playwright-stream.mjs || {
  echo "The Browser Use panel stream route is not mounted." >&2
  exit 1
}

docker exec "$container" node /opt/dsh-build/verify-router-contract.mjs --browser || {
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

echo "Browser and panel-stream readiness checks passed. Run the model acceptance prompt from docs/visual-validation-playbook.md to verify screenshot reasoning."
