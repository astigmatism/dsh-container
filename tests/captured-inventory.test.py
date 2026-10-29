#!/usr/bin/env python3
"""One captured plugin inventory, read by both gates that prove it.

scripts/check.sh proves the built image carries the captured plugins and
scripts/verify.sh proves a deployment still carries them. They each kept their
own copy of the list, so raising a plugin left the operator verifier demanding
the pre-upgrade versions and failing against every current deployment. The two
lists now have to match each other and `config/plugins.lock.json`.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GATE = re.compile(r"^ *for expected in \\\n(.*?)^ *do$", re.MULTILINE | re.DOTALL)
ENTRY = re.compile(r"'([^']+)'")
# Bundled from the repository, so an inventory names these by their link target.
LINKED = {"dsh-follow-up-suggestions", "dsh-local-speech-input"}


def gate(path):
    source = (ROOT / path).read_text(encoding="utf-8")
    blocks = GATE.findall(source)
    if len(blocks) != 1:
        raise AssertionError(f"{path}: expected one captured inventory gate, found {len(blocks)}")
    entries = ENTRY.findall(blocks[0])
    if not entries:
        raise AssertionError(f"{path}: captured inventory gate is empty")
    if len(entries) != len(set(entries)):
        raise AssertionError(f"{path}: captured inventory repeats a plugin")
    return {entry.rpartition("@")[0]: entry.rpartition("@")[2] for entry in entries}


def main():
    built = gate("scripts/check.sh")
    deployed = gate("scripts/verify.sh")
    if sorted(built) != sorted(deployed):
        only_built = sorted(set(built) - set(deployed))
        only_deployed = sorted(set(deployed) - set(built))
        raise AssertionError(
            "the built-image gate and the deployment verifier expect different plugins: "
            f"built only {only_built}, deployed only {only_deployed}")
    mismatched = sorted(name for name in built if built[name] != deployed[name])
    if mismatched:
        raise AssertionError(
            "the built-image gate and the deployment verifier expect different versions: "
            + ", ".join(f"{name} {built[name]} != {deployed[name]}" for name in mismatched))

    captured = json.loads((ROOT / "config/plugins.lock.json").read_text(encoding="utf-8"))["plugins"]
    if set(built) != set(captured):
        raise AssertionError(
            "the captured inventory gates and config/plugins.lock.json cover different plugins: "
            f"{sorted(set(built) ^ set(captured))}")
    for name, recorded in captured.items():
        expected = "link:" if name in LINKED else recorded.split(" ")[0]
        if built[name] != expected:
            raise AssertionError(f"{name}: inventory expects {built[name]!r}, captured {expected!r}")
    print(f"ok - both inventory gates demand the same {len(built)} captured plugins")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as failure:
        print(f"FAIL: {failure}", file=sys.stderr)
        raise SystemExit(1)
