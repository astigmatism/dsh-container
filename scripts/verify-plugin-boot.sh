#!/bin/sh
set -eu

# Boot the canonical web profile in a throwaway DSH_HOME and require a stable
# authenticated HTTP 200. Booting imports the full plugin tree (every bundle's loader entry,
# including dsh-playwright's server-side entry), so this catches broken
# dependency graphs - e.g. a pnpm patched-dependency snapshot in the seed
# lockfile that drops playwright-core/pngjs/ws - that `dsh --dump-config` and
# `dsh plugin list` pass without noticing.
#
# The current Harness release prints a one-time login URL. The probe consumes
# it into a throwaway cookie jar without printing the token. A broken server
# can answer the first probe before the failed plugin-tree
# import kills the process a moment later, so the check requires several
# consecutive 200s and fails fast when the process dies.

seed_home=${DSH_SEED_HOME:-/opt/dsh-seed}
canonical_settings=${DSH_CANONICAL_SETTINGS:-/opt/dsh-defaults/settings.yaml}
local_speech_source=${DSH_LOCAL_SPEECH_SOURCE:-/opt/dsh-local-speech}
port=${DSH_PLUGIN_BOOT_PORT:-3999}
stable=5
timeout_seconds=90

[ -d "$seed_home/profiles/web" ] || {
  echo "Canonical web profile is missing: $seed_home/profiles/web" >&2
  exit 1
}
[ -d "$local_speech_source" ] || {
  echo "Local speech plugin source is missing: $local_speech_source" >&2
  exit 1
}

parent=$(mktemp -d "${TMPDIR:-/tmp}/dsh-plugin-boot.XXXXXX")
home=$parent/runtime
boot_log=$parent/dsh-web.log
cookie_jar=$parent/cookies.txt
cleanup() {
  rm -rf -- "$parent"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$home"
# The profile's link dependency is relative (../../../dsh-local-speech), so
# the throwaway runtime needs the same sibling geometry the image gives
# /data/dsh (a sibling symlink next to the runtime home).
ln -s "$local_speech_source" "$parent/dsh-local-speech"

DSH_SEED_HOME=$seed_home DSH_HOME=$home \
  /usr/local/bin/dsh-sync-runtime-profile

DSH_CANONICAL_SETTINGS=$canonical_settings \
DSH_RUNTIME_SETTINGS=$home/settings.yaml \
DSH_SETTINGS_UID=$(id -u) \
DSH_SETTINGS_GID=$(id -g) \
  /usr/local/bin/dsh-initialize-persisted-settings --replace-empty

# Neutral CWD: the repo's .env is rejected by the launcher for
# environment-authority variables, and no other CWD layer is wanted here.
cd "$parent"

(
  unset DISPLAY WAYLAND_DISPLAY
  DSH_HOME=$home DSH_TELEMETRY_DISABLED=1 \
    exec dsh web --no-open --port "$port"
) >"$boot_log" 2>&1 &
boot_pid=$!

authenticate() {
  token=$(sed -n 's/.*[?]token=\([^ ]*\).*/\1/p' "$boot_log" | tail -n 1)
  [ -n "$token" ] || return 1
  curl --fail --silent --show-error \
    --cookie-jar "$cookie_jar" \
    --output /dev/null \
    "http://127.0.0.1:${port}/?token=${token}"
  token=
}

probe() {
  [ -s "$cookie_jar" ] || authenticate || return 1
  curl --fail --silent --show-error \
    --cookie "$cookie_jar" \
    --output /dev/null \
    "http://127.0.0.1:${port}/"
}

probe_browser_client() {
  token=$(sed -n 's/.*[?]token=\([^ ]*\).*/\1/p' "$boot_log" | tail -n 1)
  [ -n "$token" ] || return 1
  DSH_BOOT_TOKEN=$token DSH_BOOT_PORT=$port DSH_PROFILE_ROOT=$home/profiles/web \
    node <<'NODE'
const { chromium } = require(`${process.env.DSH_PROFILE_ROOT}/node_modules/playwright-core`);

(async () => {
  const token = process.env.DSH_BOOT_TOKEN;
  const errors = [];
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  const response = await page.goto(
    `http://127.0.0.1:${process.env.DSH_BOOT_PORT}/?token=${token}`,
    { waitUntil: "networkidle", timeout: 30000 },
  );
  await page.waitForTimeout(2000);
  const state = await page.evaluate(() => ({
    bodyChars: (document.body?.innerText ?? "").trim().length,
    composerInputs: document.querySelectorAll("[data-composer-input]").length,
    dictationButtons: document.querySelectorAll("[data-local-speech-button]").length,
    moduleLoader: typeof window.__ModuleLoader__,
  }));
  await browser.close();
  if (!response?.ok()) throw new Error(`final page status ${response?.status()}`);
  if (state.bodyChars < 20) throw new Error(`client body too small: ${state.bodyChars}`);
  if (state.moduleLoader !== "object") throw new Error(`module loader unavailable: ${state.moduleLoader}`);
  if (state.composerInputs < 1) throw new Error("Harness composer input was not rendered");
  if (state.dictationButtons < 1) throw new Error("local dictation control was not mounted");
  if (errors.length > 0) throw new Error(errors.join("\n"));
})().catch((error) => {
  const detail = String(error?.stack ?? error).split(process.env.DSH_BOOT_TOKEN).join("<redacted>");
  console.error(detail);
  process.exit(1);
});
NODE
  token=
}

print_boot_log() {
  tail -n 200 "$boot_log" | sed 's/[?]token=[^ ]*/?token=<redacted>/g' >&2
}

ok=0
elapsed=0
while [ "$elapsed" -lt "$timeout_seconds" ]; do
  if probe; then
    ok=$((ok + 1))
  else
    ok=0
  fi
  [ "$ok" -ge "$stable" ] && break
  if ! kill -0 "$boot_pid" 2>/dev/null; then
    break
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

browser_ok=0
if [ "$ok" -ge "$stable" ] && probe_browser_client; then
  browser_ok=1
fi

stream_ok=0
if [ "$ok" -ge "$stable" ] \
  && DSH_WEB_PORT=$port node /opt/dsh-build/verify-dsh-playwright-stream.mjs; then
  stream_ok=1
fi

kill "$boot_pid" 2>/dev/null || true
wait "$boot_pid" 2>/dev/null || true

if [ "$ok" -lt "$stable" ]; then
  echo "Plugin boot check failed: dsh web never served $stable consecutive HTTP 200 responses from $seed_home/profiles/web (after ${elapsed}s)." >&2
  echo "The plugin tree likely failed to import; check the seed lockfile's patched-dependency snapshots." >&2
  echo "Last Harness startup output:" >&2
  print_boot_log || true
  exit 1
fi

if [ "$browser_ok" -ne 1 ]; then
  echo "Plugin boot check failed: Chromium could not load the composed Harness client without errors." >&2
  echo "Last Harness startup output:" >&2
  print_boot_log || true
  exit 1
fi

if [ "$stream_ok" -ne 1 ]; then
  echo "Plugin boot check failed: the Browser Use WebSocket route was not mounted." >&2
  echo "Last Harness startup output:" >&2
  print_boot_log || true
  exit 1
fi

echo "Plugin boot check passed: the authenticated web profile, composed browser client, and Browser Use stream route loaded cleanly."
