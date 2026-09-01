# Managed speech stack

This directory reconstructs the NVIDIA voice stack captured on the separate
`192.168.1.22` voice host. The main Harness deployment does not need to start
these services when it can reach that host; its gateway uses the tracked
`STT_BASE_URL` and `TTS_BASE_URL` values instead.

The stack provides:

- faster-whisper `large-v3-turbo` at `/v1/audio/transcriptions`;
- Kokoro as the default TTS backend;
- Chatterbox multilingual TTS for `chatterbox:`, `clone:`, or `cb:` voices;
- an OpenAI-compatible router at `/v1/audio/speech`.

The exact captured endpoints, revisions, model identifiers, tuning, secret
relationships, and successful reference test are recorded in
`../config/speech.lock.json`. Model blobs are intentionally not committed.

## Deploy on an NVIDIA Linux host

Install Docker Engine, Compose v2, and the NVIDIA Container Toolkit. Then:

```sh
cp speech/.env.example speech/.env
# Review VOICE_BIND_ADDRESS, both GPU UUIDs, and the model/audio paths.
./scripts/configure.sh
docker compose --env-file speech/.env -f speech/compose.yaml up -d --build
./scripts/verify-speech.sh
```

The home-network STT token is tracked in `secrets/stt_api_key`; put the distinct
deployment-local TTS router key in `secrets/tts_api_key`. The Compose stack
reads those files as Docker secrets, and neither value belongs in `speech/.env`.

The first start downloads approximately 1.6 GB of Whisper weights and about
3.2 GB for Chatterbox. Kokoro's weights are bundled in its pinned image. The
source deployment used one RTX 3060 Ti for Whisper/Kokoro and a second RTX
3060 Ti for Chatterbox, so the captured UUIDs must be reviewed on other hosts.

The captured Whisper registry tag was mutable and its former image digest is
no longer downloadable. This Compose file therefore builds the exact recorded
`hwdsl2/docker-whisper` Git revision. Chatterbox application source is vendored
at its recorded revision, with its Git-installed TTS dependency and CUDA base
now pinned in `docker/Dockerfile.gpu`.
