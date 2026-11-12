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
  scripts/verify-dictation-backend.mjs \
  scripts/reconcile-voice-bundles.mjs \
  plugin/dsh-speech-whisper/index.js \
  plugin/dsh-speech-whisper/provider.js \
  plugin/dsh-speech-whisper/cordis.patch.yml
do
  [ -f "$project_dir/$path" ] || fail "missing $path"
done

# The microphone is the one feature this deployment promises to keep working, so
# every layer of it is pinned by a gate that runs on a real deployment.
grep -Fq 'node /opt/dsh-build/verify-dictation-client.mjs' "$project_dir/scripts/verify.sh" \
  || fail "post-deployment verification does not render-check the voice input control"
grep -Fq 'node /opt/dsh-gateway/verify-dictation-backend.mjs' "$project_dir/scripts/verify.sh" \
  || fail "post-deployment verification does not check the dictation backend"
grep -Fq 'COPY scripts/verify-dictation-client.mjs /opt/dsh-build/verify-dictation-client.mjs' "$project_dir/Dockerfile" \
  || fail "Harness image does not contain the dictation client verifier"
grep -Fq 'await launchVerificationBrowser(chromium' \
  "$project_dir/scripts/verify-dictation-client.mjs" \
  || fail "dictation client verifier does not use an isolated writable browser home"
grep -Fq 'HOME: home, XDG_CONFIG_HOME:' "$project_dir/scripts/verification-browser.mjs" \
  || fail "shared browser launcher does not isolate Chromium state"
grep -Fq 'scripts/verify-dictation-backend.mjs /opt/dsh-gateway/' "$project_dir/Dockerfile" \
  || fail "gateway image does not contain the dictation backend verifier"
grep -Fq 'node /opt/dsh-build/verify-sidebar-client.mjs || return 1' \
  "$project_dir/scripts/verify-plugin-boot.sh" \
  || fail "image qualification no longer requires the shared browser verifier"

# A microphone the user cannot see working is not this feature: the verifier has
# to record, watch the waveform measure the fake device, and settle.
grep -Fq "aria-label=\"\${LABEL.start}\"" "$project_dir/scripts/verify-dictation-client.mjs" \
  || fail "the verifier does not drive the official microphone control"
grep -Fq 'data-voice-activity="recording"' "$project_dir/scripts/verify-dictation-client.mjs" \
  || fail "the verifier does not open the recording row"
grep -Fq 'the waveform is not measuring the microphone' "$project_dir/scripts/verify-dictation-client.mjs" \
  || fail "the verifier does not prove the waveform is live"
grep -Fq 'use-fake-device-for-media-stream' "$project_dir/scripts/verify-dictation-client.mjs" \
  || fail "the verifier records without a fake microphone device"
grep -Fq 'the retired microphone is still mounted' "$project_dir/scripts/verify-sidebar-client.mjs" \
  || fail "image qualification no longer rejects the retired microphone control"

# The composer renders its activity slot only inside an open Session, so the
# deployment verifier opens one instead of trusting whatever a person left open.
grep -Fq 'verificationSessionRow' "$project_dir/scripts/verify-dictation-client.mjs" \
  || fail "the deployment verifier does not open a Session before driving the microphone"

# Image qualification boots the profile against a synthetic speech service, so
# the recognizer leg and all three outcomes a user can meet are exercised
# without a voice host: transcript, service failure, and dead microphone.
grep -Fq 'STT_BASE_URL=http://127.0.0.1:$speech_port/v1' "$project_dir/scripts/verify-plugin-boot.sh" \
  || fail "image qualification does not boot Harness with a speech service to recognize through"
grep -Fq 'COPY scripts/qualification-speech-service.mjs /opt/dsh-build/qualification-speech-service.mjs' "$project_dir/Dockerfile" \
  || fail "the qualification speech service is not in the image"
grep -Fq 'aria-label="Start recording"' "$project_dir/scripts/verify-dictation-roundtrip.mjs" \
  || fail "the round trip no longer drives the voice input control"
grep -Fq 'aria-label="Stop and transcribe"' "$project_dir/scripts/verify-dictation-roundtrip.mjs" \
  || fail "the round trip no longer stops the recording through the capture row"
grep -Fq 'button[aria-label="Record again"]' "$project_dir/scripts/verify-dictation-roundtrip.mjs" \
  || fail "the round trip does not require a retry affordance after a failure"
grep -Fq 'the capture waveform did not measure the synthetic microphone' \
  "$project_dir/scripts/verify-dictation-roundtrip.mjs" \
  || fail "the round trip does not require a live waveform"

# The recognizer itself is this repository's own code, so its transport is
# unit-tested without a browser, a network, or the voice host.
grep -Fq 'tests/dsh-speech-whisper.test.mjs' "$project_dir/scripts/check.sh" \
  || fail "the Whisper provider transport has no test in the check suite"
grep -Fq 'tests/voice-bundle-activation.test.mjs' "$project_dir/scripts/check.sh" \
  || fail "the voice bundle substitution has no test in the check suite"

# Activation: the retired plugin must be replaced, not merely supplemented, on an
# existing deployment whose bundle selection survives every profile sync.
grep -Fq 'reconcile-voice-bundles.mjs' "$project_dir/entrypoint.sh" \
  || fail "startup does not reconcile the voice input bundles"
grep -Fq 'COPY scripts/reconcile-voice-bundles.mjs /opt/dsh-build/reconcile-voice-bundles.mjs' "$project_dir/Dockerfile" \
  || fail "Harness image does not contain the voice bundle reconciler"
grep -Fq 'ln -s "$whisper_source" "$parent/dsh-speech-whisper"' "$project_dir/scripts/verify-plugin-boot.sh" \
  || fail "image qualification does not stage the Whisper provider for its throwaway profile"
grep -Fq '"@deepseek-ai/dsh-experimental-voice-input-bundle"' "$project_dir/seed/profile/package.json" \
  || fail "the canonical profile does not select the official voice input bundle"
grep -Fq '"dsh-speech-whisper"' "$project_dir/seed/profile/package.json" \
  || fail "the canonical profile does not select the Whisper provider"
grep -Fq 'defaultProvider: whisper-lan' "$project_dir/seed/profile/managed/cordis.patch.yml" \
  || fail "the profile does not select Whisper as the default recognizer"
grep -Fq 'STT_API_KEY_FILE: /run/secrets/stt_api_key' "$project_dir/compose.yaml" \
  || fail "the dictation key is not mounted where the recognizer reads it"

echo "ok - voice input controls, the live waveform, the recognizer transport, and the configured policy are verified at deployment"
