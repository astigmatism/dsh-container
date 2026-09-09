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
grep -Fq "HOME: process.env.DSH_BROWSER_HOME || '/tmp'" \
  "$project_dir/scripts/verify-dictation-client.mjs" \
  || fail "dictation client verifier does not give Chromium a writable home"
grep -Fq 'scripts/verify-dictation-backend.mjs /opt/dsh-gateway/' "$project_dir/Dockerfile" \
  || fail "gateway image does not contain the dictation backend verifier"
grep -Fq 'dictationButtons: document.querySelectorAll("[data-local-speech-button]").length' \
  "$project_dir/scripts/verify-plugin-boot.sh" \
  || fail "image qualification no longer checks the rendered dictation control"
grep -Fq "input.matches('[data-composer-input][role=\"textbox\"]')" \
  "$project_dir/plugin/dsh-local-speech/client.js" \
  || fail "speech plugin no longer supports the current Harness composer"

echo "ok - dictation is mandatory at image build and post-deployment runtime validation"
