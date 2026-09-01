#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$test_dir/.." && pwd)
temporary_root=$(mktemp -d)
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM

render() {
  name=$1
  shift
  docker compose --env-file "$project_dir/.env.example" \
    -f "$project_dir/compose.yaml" "$@" config --format json \
    >"$temporary_root/$name.json"
}

render default
render remote -f "$project_dir/compose.remote-ollama.yaml"
render external -f "$project_dir/compose.external-ollama.yaml"
render managed -f "$project_dir/compose.managed-ollama.yaml"

python3 - "$temporary_root" <<'PY'
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])


def load(name):
    return json.loads((root / f"{name}.json").read_text(encoding="utf-8"))


def extra_hosts(config):
    return config["services"]["harness"].get("extra_hosts", [])


default = load("default")
remote = load("remote")
external = load("external")
managed = load("managed")

for name, config in (("default", default), ("remote", remote)):
    network = config["networks"]["ollama_net"]
    if network.get("external", False):
        raise SystemExit(f"{name}: portable remote network unexpectedly external")
    if network["name"] != "deepseek-harness_default":
        raise SystemExit(f"{name}: unexpected private network name: {network['name']}")
    if not any(entry.replace("=", ":", 1) == "ai-router:192.168.1.21" for entry in extra_hosts(config)):
        raise SystemExit(f"{name}: ai-router does not map to REMOTE_OLLAMA_HOST")

for name, config in (("default", default), ("remote", remote), ("external", external), ("managed", managed)):
    environment = config["services"]["gateway"]["environment"]
    if environment.get("HARNESS_AUTH_USERNAME") != "astigmatism":
        raise SystemExit(f"{name}: source-managed gateway username changed")
    if environment.get("HARNESS_AUTH_PASSWORD") != "ICar12..":
        raise SystemExit(f"{name}: source-managed gateway password changed")

external_network = external["networks"]["ollama_net"]
if not external_network.get("external", False):
    raise SystemExit("external: shared Ollama network is not external")
if external_network["name"] != "local-ai-ollama_default":
    raise SystemExit(f"external: unexpected network name: {external_network['name']}")
if extra_hosts(external):
    raise SystemExit(f"external: remote ai-router mapping survived reset: {extra_hosts(external)!r}")

managed_network = managed["networks"]["ollama_net"]
if managed_network.get("external", False):
    raise SystemExit("managed: network unexpectedly external")
if managed_network["name"] != "dsh-container_ollama":
    raise SystemExit(f"managed: unexpected network name: {managed_network['name']}")
if extra_hosts(managed):
    raise SystemExit(f"managed: remote ai-router mapping survived reset: {extra_hosts(managed)!r}")
aliases = managed["services"]["ai-router"]["networks"]["ollama_net"].get("aliases", [])
if "ai-router" not in aliases:
    raise SystemExit("managed: bundled router is missing its ai-router alias")
PY

echo "ok - default/remote, external, and managed Compose network topologies are isolated"
