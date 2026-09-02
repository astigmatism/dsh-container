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
SYSTEMDRIVE="$temporary_root/windows-drive" render windows

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
windows = load("windows")

harness = default["services"]["harness"]
healthcheck = " ".join(harness["healthcheck"]["test"])
if "127.0.0.1:3080" not in healthcheck:
    raise SystemExit("harness readiness does not check the actual backend")
depends_on = default["services"]["gateway"]["depends_on"]
if depends_on.get("harness", {}).get("condition") != "service_healthy":
    raise SystemExit("gateway can start before the harness backend is ready")

workspace = next(
    volume for volume in windows["services"]["harness"]["volumes"]
    if volume.get("target") == "/host"
)
if Path(workspace["source"]).resolve() != (root / "windows-drive").resolve():
    raise SystemExit(f"native Windows system drive is not the workspace source: {workspace!r}")

unix_workspace = next(
    volume for volume in default["services"]["harness"]["volumes"]
    if volume.get("target") == "/host"
)
if Path(unix_workspace["source"]).resolve() != Path("/").resolve():
    raise SystemExit(f"Unix root is not the default workspace source: {unix_workspace!r}")
if harness["working_dir"] != "/host" or harness["environment"].get("HOME") != "/host":
    raise SystemExit("Harness does not default its workspace picker to /host")

for name, config in (("default", default), ("remote", remote)):
    network = config["networks"]["ollama_net"]
    if network.get("external", False):
        raise SystemExit(f"{name}: portable remote network unexpectedly external")
    if network["name"] != "deepseek-harness_default":
        raise SystemExit(f"{name}: unexpected private network name: {network['name']}")

if not any(entry.replace("=", ":", 1) == "ai-router:192.168.1.21" for entry in extra_hosts(default)):
    raise SystemExit("default: ai-router does not map to REMOTE_OLLAMA_HOST")

if extra_hosts(remote):
    raise SystemExit(f"remote: direct ai-router host mapping survived local-adapter overlay: {extra_hosts(remote)!r}")
remote_router = remote["services"].get("ai-router", {})
if remote_router.get("environment", {}).get("OLLAMA_UPSTREAM_URL") != "http://192.168.1.21:11434":
    raise SystemExit("remote: local router does not forward to REMOTE_OLLAMA_HOST")
remote_aliases = remote_router.get("networks", {}).get("ollama_net", {}).get("aliases", [])
if "ai-router" not in remote_aliases:
    raise SystemExit("remote: local router is missing its ai-router alias")
if remote["services"]["harness"].get("depends_on", {}).get("ai-router", {}).get("condition") != "service_healthy":
    raise SystemExit("remote: harness can start before the local Responses adapter is healthy")

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
