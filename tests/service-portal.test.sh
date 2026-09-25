#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$test_dir/.." && pwd)
temporary_root=$(mktemp -d)
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM
# This suite only renders Compose metadata; it never starts services.
export HARNESS_AUTH_USERNAME=compose-fixture-user
export HARNESS_AUTH_PASSWORD=compose-fixture-password

grep -Fq 'COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx' "$project_dir/Dockerfile" \
  || { echo "Harness image does not include the Buildx plugin required by delegated updates." >&2; exit 1; }

(cd "$project_dir" && python3 -B -m maintenance.qualification)

speech_output=$temporary_root/speech.json
docker compose --env-file "$project_dir/speech/.env.example" \
  -f "$project_dir/speech/compose.yaml" config --format json >"$speech_output"
python3 - "$speech_output" <<'PY'
import json
from pathlib import Path
import sys

config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
prefix = "io.service-portal.update."
for name, service in config["services"].items():
    labels = service.get("labels", {})
    if any(key.startswith(prefix) for key in labels):
        raise SystemExit(f"speech project service {name} must remain unadvertised")
PY

echo "ok - Service Portal labels resolve once per root mode with a safe executable updater"
