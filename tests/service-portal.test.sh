#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$test_dir/.." && pwd)
temporary_root=$(mktemp -d)
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM

check_project() {
  mode=$1
  shift
  output=$temporary_root/$mode.json
  docker compose --env-file "$project_dir/.env.example" "$@" config --format json >"$output"
  python3 - "$project_dir" "$mode" "$output" <<'PY'
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys

root = Path(sys.argv[1])
mode = sys.argv[2]
config = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
services = config["services"]
prefix = "io.service-portal.update."
advertisers = [
    name for name, service in services.items()
    if service.get("labels", {}).get(prefix + "enabled") == "true"
]
if advertisers != ["harness"]:
    raise SystemExit(f"{mode}: expected only harness to advertise updates; got {advertisers}")

labels = services["harness"]["labels"]
expected = {
    prefix + "enabled": "true",
    prefix + "script": "scripts/update-and-restart.sh",
    prefix + "image": "local/deepseek-harness:0.1.1-rc.2-portable",
    prefix + "user": "1000:1000",
}
actual = {key: value for key, value in labels.items() if key.startswith(prefix)}
if actual != expected:
    raise SystemExit(f"{mode}: unexpected Service Portal labels: {actual!r}")

relative_script = PurePosixPath(labels[prefix + "script"])
if relative_script.is_absolute() or ".." in relative_script.parts:
    raise SystemExit(f"{mode}: updater path is not a safe project-relative path")
script = root.joinpath(*relative_script.parts)
metadata = script.lstat()
if not stat.S_ISREG(metadata.st_mode) or not os.access(script, os.X_OK):
    raise SystemExit(f"{mode}: updater is not a regular executable file")

for name, service in services.items():
    if name == "harness":
        continue
    conflicting = [key for key in service.get("labels", {}) if key.startswith(prefix)]
    if conflicting:
        raise SystemExit(f"{mode}: {name} has conflicting update labels: {conflicting}")
PY
}

check_project external -f "$project_dir/compose.yaml"
check_project remote \
  -f "$project_dir/compose.yaml" \
  -f "$project_dir/compose.remote-ollama.yaml"
check_project managed \
  -f "$project_dir/compose.yaml" \
  -f "$project_dir/compose.managed-ollama.yaml"

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
