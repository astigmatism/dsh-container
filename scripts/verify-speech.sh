#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
env_file=$project_dir/.env

[ -f "$env_file" ] || { echo "Missing .env; run ./scripts/configure.sh first." >&2; exit 1; }

get_env() {
  awk -F= -v wanted="$1" '$1 == wanted { print substr($0, index($0, "=") + 1); exit }' "$env_file"
}

stt_base=$(get_env STT_BASE_URL)
tts_base=$(get_env TTS_BASE_URL)
stt_model=$(get_env STT_MODEL)
tts_model=$(get_env TTS_MODEL)
tts_voice=$(get_env TTS_VOICE)
stt_key_file=$project_dir/secrets/stt_api_key
tts_key_file=$project_dir/secrets/tts_api_key

[ -n "$stt_base" ] || { echo "STT_BASE_URL is empty." >&2; exit 1; }
[ -n "$tts_base" ] || { echo "TTS_BASE_URL is empty." >&2; exit 1; }
[ -s "$stt_key_file" ] || { echo "Missing nonempty secrets/stt_api_key." >&2; exit 1; }
[ -s "$tts_key_file" ] || { echo "Missing nonempty secrets/tts_api_key." >&2; exit 1; }

temporary=$(mktemp -d "${TMPDIR:-/tmp}/dsh-speech-check.XXXXXX")
case "$temporary" in
  "${TMPDIR:-/tmp}"/dsh-speech-check.*) ;;
  *) echo "Unexpected temporary path: $temporary" >&2; exit 1 ;;
esac
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

phrase='DSH speech round trip test.'
request_file=$temporary/tts-request.json
audio_file=$temporary/roundtrip.mp3
transcript_file=$temporary/transcript.json

python3 - "$request_file" "$phrase" "${tts_model:-tts-1}" "${tts_voice:-af_heart}" <<'PY'
import json
from pathlib import Path
import sys

Path(sys.argv[1]).write_text(json.dumps({
    "input": sys.argv[2],
    "model": sys.argv[3],
    "voice": sys.argv[4],
    "response_format": "mp3",
}), encoding="utf-8")
PY

curl --fail --silent --show-error "${stt_base%/v1}/health" >/dev/null
curl --fail --silent --show-error "${tts_base%/v1}/healthz" >/dev/null

tts_key=$(tr -d '\r\n' <"$tts_key_file")
curl --fail --silent --show-error --config - \
  --header 'Content-Type: application/json' \
  --data-binary "@$request_file" \
  --output "$audio_file" \
  "$tts_base/audio/speech" <<EOF
header = "Authorization: Bearer $tts_key"
EOF
unset tts_key
[ -s "$audio_file" ] || { echo "TTS returned an empty audio file." >&2; exit 1; }

stt_key=$(tr -d '\r\n' <"$stt_key_file")
curl --fail --silent --show-error --config - \
  --form "file=@$audio_file;type=audio/mpeg" \
  --form "model=${stt_model:-large-v3-turbo}" \
  --output "$transcript_file" \
  "$stt_base/audio/transcriptions" <<EOF
header = "Authorization: Bearer $stt_key"
EOF
unset stt_key

python3 - "$transcript_file" "$phrase" <<'PY'
import json
from pathlib import Path
import sys

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
actual = payload.get("text")
expected = sys.argv[2]
if actual != expected:
    raise SystemExit(f"Round-trip mismatch: expected {expected!r}, received {actual!r}")
PY

audio_bytes=$(wc -c <"$audio_file" | tr -d ' ')
echo "Speech verified: STT health, TTS health, ${audio_bytes}-byte synthesis, and exact transcription round trip."
