#!/bin/sh
set -eu

# Boot the canonical web profile in a throwaway DSH_HOME and require a stable
# authenticated HTTP 200. Booting imports the full plugin tree (every bundle's loader entry,
# including dsh-ego-browser's server-side entry), so this catches broken
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
whisper_source=${DSH_SPEECH_WHISPER_SOURCE:-/opt/dsh-speech-whisper}
port=${DSH_PLUGIN_BOOT_PORT:-3999}
speech_port=${DSH_SPEECH_FIXTURE_PORT:-3979}
stable=5
# Cold ARM builds can spend over 90 seconds importing the complete plugin graph.
timeout_seconds=180

[ -d "$seed_home/profiles/web" ] || {
  echo "Canonical web profile is missing: $seed_home/profiles/web" >&2
  exit 1
}
[ -d "$local_speech_source" ] || {
  echo "Local speech plugin source is missing: $local_speech_source" >&2
  exit 1
}
[ -d "$whisper_source" ] || {
  echo "Whisper speech provider source is missing: $whisper_source" >&2
  exit 1
}

parent=$(mktemp -d "${TMPDIR:-/tmp}/dsh-plugin-boot.XXXXXX")
home=$parent/runtime
boot_log=$parent/dsh-web.log
cookie_jar=$parent/cookies.txt
cleanup() {
  if [ -n "${boot_pid:-}" ]; then
    kill "$boot_pid" 2>/dev/null || true
    wait "$boot_pid" 2>/dev/null || true
  fi
  if [ -n "${speech_pid:-}" ]; then
    kill "$speech_pid" 2>/dev/null || true
    wait "$speech_pid" 2>/dev/null || true
  fi
  rm -rf -- "$parent"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$home"
# The profile's link dependency is relative (../../../dsh-local-speech), so
# the throwaway runtime needs the same sibling geometry the image gives
# /data/dsh (a sibling symlink next to the runtime home).
ln -s "$local_speech_source" "$parent/dsh-local-speech"
ln -s "$whisper_source" "$parent/dsh-speech-whisper"

# Dictation is qualified against a synthetic OpenAI-compatible speech service,
# so the recognizer leg (Harness to transcription endpoint) is exercised too and
# the profile boots with a *ready* default provider, exactly as a deployment
# with a voice host does. The round-trip verifier steers and reads it over HTTP.
mkdir -p "$parent/speech"
printf 'synthetic-speech-key' >"$parent/speech/stt_api_key"
chmod 600 "$parent/speech/stt_api_key"
STT_MODEL=synthetic-whisper node /opt/dsh-build/qualification-speech-service.mjs \
  --port "$speech_port" --key-file "$parent/speech/stt_api_key" --state-dir "$parent/speech" \
  >"$parent/speech.log" 2>&1 &
speech_pid=$!
speech_attempts=0
until curl --silent --fail --output /dev/null "http://127.0.0.1:$speech_port/__state"; do
  speech_attempts=$((speech_attempts + 1))
  if [ "$speech_attempts" -ge 50 ]; then
    echo "Synthetic speech service did not become ready:" >&2
    tail -n 20 "$parent/speech.log" >&2
    exit 1
  fi
  sleep 0.2
done

DSH_SEED_HOME=$seed_home DSH_HOME=$home \
  /usr/local/bin/dsh-sync-runtime-profile

DSH_CANONICAL_SETTINGS=$canonical_settings \
DSH_RUNTIME_SETTINGS=$home/settings.yaml \
DSH_SETTINGS_UID=$(id -u) \
DSH_SETTINGS_GID=$(id -g) \
  /usr/local/bin/dsh-initialize-persisted-settings --replace-empty

node /opt/dsh-build/migrate-profile-settings.mjs "$home"
# The tool-driving bridge is appended only to this disposable profile.
# Cordis replaces a row's complete config object. Keep the container launch
# settings when shortening the idle timeout for qualification.
cat >>"$home/profiles/web/cordis.patch.yml" <<'YAML'
- insert:
    - id: ego-qualification
      name: /opt/dsh-build/qualification-ego-host.mjs
- id: ego-browser
  config:
    chromePath: /usr/bin/chromium
    chromeArgs: --no-sandbox --disable-dev-shm-usage
    captureBackend: cdp
    isolateSpaces: false
    idleTimeoutMin: 1
    cdpFps: 15
    cdpMaxWidth: 1440
YAML
# Neutral CWD: the repo's .env is rejected by the launcher for
# environment-authority variables, and no other CWD layer is wanted here.
cd "$parent"

start_harness() {
  : >"$boot_log"
  rm -f "$cookie_jar"
(
  unset DISPLAY WAYLAND_DISPLAY
  # The disposable browser fixture verifies local pages and private subresources.
  DSH_HOME=$home DSH_TELEMETRY_DISABLED=1 DSH_BROWSER_ALLOW_PRIVATE_HOSTS=true \
  STT_BASE_URL=http://127.0.0.1:$speech_port/v1 STT_MODEL=synthetic-whisper \
  STT_API_KEY_FILE=$parent/speech/stt_api_key \
    exec dsh web --no-open --port "$port"
) >"$boot_log" 2>&1 &
boot_pid=$!

}
start_harness

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
  DSH_BOOT_TOKEN=$token DSH_VERIFY_URL=http://127.0.0.1:$port DSH_PROFILE_ROOT=$home/profiles/web \
    node /opt/dsh-build/verify-sidebar-client.mjs || return 1
  DSH_BOOT_TOKEN=$token DSH_VERIFY_URL=http://127.0.0.1:$port DSH_PROFILE_ROOT=$home/profiles/web \
    node /opt/dsh-build/verify-file-previews.mjs || return 1
  DSH_BOOT_TOKEN=$token DSH_VERIFY_URL=http://127.0.0.1:$port DSH_PROFILE_ROOT=$home/profiles/web \
  DSH_SPEECH_FIXTURE_URL=http://127.0.0.1:$speech_port \
    node /opt/dsh-build/verify-dictation-roundtrip.mjs || return 1
  if [ "${DSH_VERIFY_RESIDENT_CATALOG:-false}" = true ]; then
    DSH_BOOT_TOKEN=$token DSH_VERIFY_URL=http://127.0.0.1:$port DSH_PROFILE_ROOT=$home/profiles/web \
      node /opt/dsh-build/verify-resident-onboarding.mjs || return 1
  fi
  DSH_BOOT_TOKEN=$token DSH_VERIFY_URL=http://127.0.0.1:$port \
    node /opt/dsh-build/verify-dsh-playwright-stream.mjs || return 1
  echo "Legacy maintenance browser entry point qualified the authenticated ego routes."
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


kill "$boot_pid" 2>/dev/null || true
wait "$boot_pid" 2>/dev/null || true
boot_pid=

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


# Reopen exactly the same profile, then repeat from a copied persisted home.
# Each previous process must release Chromium before the next one starts.
for phase in restart recreate; do
  if [ "$phase" = recreate ]; then
    cp -a "$home" "$parent/recreated"
    home=$parent/recreated
  fi
  DSH_SEED_HOME=$seed_home DSH_HOME=$home /usr/local/bin/dsh-sync-runtime-profile
  start_harness
  ready=0
  for attempt in $(seq 1 180); do
    if probe; then ready=1; break; fi
    kill -0 "$boot_pid" 2>/dev/null || break
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then print_boot_log; exit 1; fi
  token=$(sed -n 's/.*[?]token=\([^ ]*\).*/\1/p' "$boot_log" | tail -n 1)
  if ! DSH_BOOT_TOKEN=$token DSH_VERIFY_URL=http://127.0.0.1:$port DSH_PROFILE_ROOT=$home/profiles/web \
    node /opt/dsh-build/verify-ego-persistence.mjs; then
    kill "$boot_pid" 2>/dev/null || true
    wait "$boot_pid" 2>/dev/null || true
    print_boot_log; exit 1
  fi
  if [ "$phase" = recreate ]; then
    if ! DSH_PROFILE_ROOT=$home/profiles/web node /opt/dsh-build/verify-ego-idle.mjs; then
      kill "$boot_pid" 2>/dev/null || true
      wait "$boot_pid" 2>/dev/null || true
      print_boot_log; exit 1
    fi
    DSH_BOOT_TOKEN=$token DSH_VERIFY_URL=http://127.0.0.1:$port DSH_PROFILE_ROOT=$home/profiles/web \
      node /opt/dsh-build/verify-ego-persistence.mjs
  fi
  token=
  kill "$boot_pid" 2>/dev/null || true
  wait "$boot_pid" 2>/dev/null || true
  boot_pid=
done

echo "Plugin boot check passed: the authenticated web profile, composed browser client, and ego browser routes loaded cleanly."
