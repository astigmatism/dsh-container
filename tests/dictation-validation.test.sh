#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$test_dir/.." && pwd)

fail() {
  echo "not ok - $*" >&2
  exit 1
}

for path in \
  scripts/verify-dictation-client.mjs \
  scripts/verify-dictation-backend.mjs
do
  [ -f "$project_dir/$path" ] || fail "missing $path"
done

grep -Fq 'node /opt/dsh-build/verify-dictation-client.mjs' "$project_dir/scripts/verify.sh" \
  || fail "post-deployment verification does not render-check the dictation client"
grep -Fq 'node /opt/dsh-gateway/verify-dictation-backend.mjs' "$project_dir/scripts/verify.sh" \
  || fail "post-deployment verification does not check the dictation backend"
grep -Fq 'COPY scripts/verify-dictation-client.mjs /opt/dsh-build/verify-dictation-client.mjs' "$project_dir/Dockerfile" \
  || fail "Harness image does not contain the dictation client verifier"
grep -Fq 'await launchVerificationBrowser(chromium)' \
  "$project_dir/scripts/verify-dictation-client.mjs" \
  || fail "dictation client verifier does not use an isolated writable browser home"
grep -Fq 'HOME: home, XDG_CONFIG_HOME:' "$project_dir/scripts/verification-browser.mjs" \
  || fail "shared browser launcher does not isolate Chromium state"
grep -Fq 'scripts/verify-dictation-backend.mjs /opt/dsh-gateway/' "$project_dir/Dockerfile" \
  || fail "gateway image does not contain the dictation backend verifier"
grep -Fq 'node /opt/dsh-build/verify-sidebar-client.mjs || return 1' \
  "$project_dir/scripts/verify-plugin-boot.sh" \
  || fail "image qualification no longer requires the shared browser verifier"
grep -Fq "page.locator('[data-local-speech-button]').first().waitFor()" \
  "$project_dir/scripts/verify-sidebar-client.mjs" \
  || fail "image qualification no longer checks the rendered dictation control"
grep -Fq "input.matches('[data-composer-input][role=\"textbox\"]')" \
  "$project_dir/plugin/dsh-local-speech/client.js" \
  || fail "speech plugin no longer supports the current Harness composer"

echo "ok - dictation controls and configured speech policy are verified at deployment"
