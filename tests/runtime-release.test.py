#!/usr/bin/env python3
"""Exercise release selection without changing a running Compose deployment."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent
DOCKERFILE = (ROOT / "Dockerfile").read_text()
PINS = dict(re.findall(r"^ARG (DSH_VERSION|DSH_UPSTREAM_COMMIT|NODE_IMAGE)=(.+)$", DOCKERFILE, re.M))
LOCK = json.loads((ROOT / "config/dsh-runtime.package-lock.json").read_text())
ENV = {key: value for key, value in os.environ.items()
       if key not in ("DSH_VERSION", "DSH_UPSTREAM_COMMIT", "HARNESS_IMAGE",
                      "HARNESS_AUTH_USERNAME", "HARNESS_AUTH_PASSWORD",
                      "COMPOSE_FILE", "COMPOSE_ENV_FILES")}


def run(command, **kwargs):
    return subprocess.run(command, capture_output=True, text=True, timeout=60, **kwargs)


class RuntimeReleaseTests(unittest.TestCase):
    def test_source_pins_match_the_reviewed_dependency_graph(self):
        self.assertRegex(PINS["DSH_UPSTREAM_COMMIT"], r"^[0-9a-f]{40}$")
        self.assertEqual(LOCK["name"], "@deepseek-ai/dsh")
        for path, entry in LOCK["packages"].items():
            if path == "" or re.search(r"(?:^|/)node_modules/@deepseek-ai/dsh(?:-[^/]+)?$", path):
                self.assertEqual(entry["version"], PINS["DSH_VERSION"], path)
        self.assertEqual(LOCK["version"], PINS["DSH_VERSION"])
        profile = json.loads((ROOT / "seed/profile/package.json").read_text())
        for name, version in profile["dependencies"].items():
            if name.startswith("@deepseek-ai/dsh-"):
                self.assertEqual(version, PINS["DSH_VERSION"], name)

    def test_compose_ignores_legacy_pins_and_preserves_deployment_settings(self):
        # No build/up calls: Compose renders all supported modes against fresh,
        # Unix legacy, Windows CRLF legacy, and exported-shell configurations.
        with tempfile.TemporaryDirectory() as temporary:
            env_file = Path(temporary) / "test.env"
            for kind in ("fresh", "current", "legacy-lf", "legacy-crlf", "shell"):
                values = ["HARNESS_IMAGE=local/custom-harness:retained",
                          "HARNESS_AUTH_USERNAME=release-fixture-user",
                          "HARNESS_AUTH_PASSWORD=release-fixture-password",
                          "HARNESS_HTTPS_PORT=43443", "HOST_UID=12345"]
                if kind.startswith("legacy"):
                    values += ["DSH_VERSION=0.1.1-rc.2", "DSH_UPSTREAM_COMMIT=stale-commit"]
                elif kind == "current":
                    values += [f"DSH_VERSION={PINS['DSH_VERSION']}",
                               f"DSH_UPSTREAM_COMMIT={PINS['DSH_UPSTREAM_COMMIT']}"]
                newline = "\r\n" if kind == "legacy-crlf" else "\n"
                original = (newline.join(values) + newline).encode()
                env_file.write_bytes(original)
                env = dict(ENV)
                if kind == "shell":
                    env.update(DSH_VERSION="0.1.1-rc.2", DSH_UPSTREAM_COMMIT="stale-shell-commit")
                for mode in ("", "remote", "external", "managed"):
                    with self.subTest(configuration=kind, mode=mode or "default"):
                        command = ["docker", "compose", "--env-file", str(env_file),
                                   "-f", str(ROOT / "compose.yaml")]
                        if mode:
                            command += ["-f", str(ROOT / f"compose.{mode}-ollama.yaml")]
                        result = run(command + ["config", "--format", "json"], env=env)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        harness = json.loads(result.stdout)["services"]["harness"]
                        self.assertNotIn("DSH_VERSION", harness["build"]["args"])
                        self.assertNotIn("DSH_UPSTREAM_COMMIT", harness["build"]["args"])
                        self.assertEqual(harness["image"], "local/custom-harness:retained")
                        self.assertEqual(harness["environment"]["HOST_EXEC_IMAGE"], harness["image"])
                        self.assertEqual(harness["labels"]["io.service-portal.update.image"], harness["image"])
                        self.assertTrue(harness["user"].startswith("12345:"))
                        self.assertTrue(any(str(port["published"]) == "43443" for port in harness["ports"]))
                        self.assertEqual(env_file.read_bytes(), original)

    def test_installer_keeps_version_checks_and_reports_the_mismatch(self):
        # Run the actual installer on Linux, offline. A stub npm stops matching
        # locks at the first network operation; invalid locks must never reach it.
        script = r"""
mkdir /opt/dsh-build/bin
printf '#!/bin/sh\necho reached-npm >&2\nexit 42\n' >/opt/dsh-build/bin/npm
chmod +x /opt/dsh-build/bin/npm
export PATH="/opt/dsh-build/bin:$PATH"
node - "$1" <<'NODE'
const fs = require('node:fs');
const lock = JSON.parse(fs.readFileSync('/src/config/dsh-runtime.package-lock.json', 'utf8'));
if (process.argv[2] === 'root') lock.packages[''].version = 'wrong-root';
if (process.argv[2] === 'mixed') lock.packages['node_modules/@deepseek-ai/dsh-base'].version = 'wrong-internal';
fs.writeFileSync('/opt/dsh-build/dsh-runtime.package-lock.json', JSON.stringify(lock));
const source = fs.readFileSync('/src/scripts/install-dsh-runtime.sh', 'utf8');
fs.writeFileSync('/opt/dsh-build/install-dsh-runtime.sh', source.replace(/\r?\n/g, '\r\n'));
NODE
sed -i 's/\r$//' /opt/dsh-build/install-dsh-runtime.sh
sh /opt/dsh-build/install-dsh-runtime.sh "$2"
"""
        for kind, version, status, diagnostic in (
            ("matching", PINS["DSH_VERSION"], 42, "reached-npm"),
            ("mismatch", "0.1.1-rc.2", 1, "Requested DSH_VERSION=\"0.1.1-rc.2\""),
            ("root", PINS["DSH_VERSION"], 1, "Runtime lock root package"),
            ("mixed", PINS["DSH_VERSION"], 1, "Mixed Harness generation"),
        ):
            with self.subTest(kind=kind):
                name = f"dsh-runtime-release-{os.getpid()}-{kind}"
                try:
                    result = run(["docker", "run", "--rm", "--name", name, "-i", "--network", "none",
                                  "--read-only", "--tmpfs", "/tmp", "--tmpfs", "/opt/dsh-build:exec,size=16m",
                                  "--volume", f"{ROOT}:/src:ro", "--entrypoint", "/bin/sh",
                                  PINS["NODE_IMAGE"], "-eu", "-s", "--", kind, version], input=script)
                finally:
                    # Docker may outlive its client if a subprocess times out.
                    run(["docker", "rm", "--force", name])
                output = result.stdout + result.stderr
                self.assertEqual(result.returncode, status, output)
                self.assertIn(diagnostic, output)
                if kind != "matching":
                    self.assertNotIn("reached-npm", output)
                if kind == "mismatch":
                    self.assertIn(f"@deepseek-ai/dsh@{PINS['DSH_VERSION']}", output)

    def test_deployment_verification_uses_source_and_rejects_wrong_images(self):
        # Stubs stop verification at plugin inventory, after real provenance and
        # installed-package checks. No command can reach the host Docker daemon.
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Path(temporary)
            (fixture / "scripts").mkdir()
            (fixture / "bin").mkdir()
            (fixture / "Dockerfile").write_text(DOCKERFILE)
            (fixture / ".env").write_text(
                "DSH_VERSION=0.1.1-rc.2\nDSH_UPSTREAM_COMMIT=obsolete\nDSH_DEPLOYMENT_MODE=remote\n")
            (fixture / "scripts/verify.sh").write_bytes((ROOT / "scripts/verify.sh").read_bytes())
            settings = fixture / "scripts/verify-persisted-settings.sh"
            settings.write_text("#!/bin/sh\nexit 0\n")
            settings.chmod(0o755)
            docker = fixture / "bin/docker"
            docker.write_text("""#!/bin/sh
case "$*" in
  info|*" config --quiet") exit 0 ;;
  inspect*org.opencontainers.image.version*) echo "$FAKE_VERSION" ;;
  inspect*io.astigmatism.deepseek-harness.upstream.commit*) echo "$FAKE_COMMIT" ;;
  inspect*) echo healthy ;;
  *'require("/data/dsh/profiles/web/package.json").dependencies'*) echo reached-inventory >&2; exit 1 ;;
  *" exec -T harness node -e "*)
    for expected do :; done
    [ "$expected" = "$FAKE_PACKAGE_VERSION" ] ;;
  *) echo "Unexpected verification command" >&2; exit 99 ;;
esac
""")
            docker.chmod(0o755)
            for kind, overrides, expected_status in (
                ("matching", {}, 23),
                ("version", {"FAKE_VERSION": "0.1.1-rc.2"}, 21),
                ("commit", {"FAKE_COMMIT": "wrong-commit"}, 21),
                ("package", {"FAKE_PACKAGE_VERSION": "0.1.1-rc.2"}, 21),
            ):
                with self.subTest(kind=kind):
                    env = dict(ENV, PATH=f"{fixture / 'bin'}:{os.environ['PATH']}",
                               DSH_VERSION="old-shell-version", DSH_UPSTREAM_COMMIT="old-shell-commit",
                               FAKE_VERSION=PINS["DSH_VERSION"], FAKE_COMMIT=PINS["DSH_UPSTREAM_COMMIT"],
                               FAKE_PACKAGE_VERSION=PINS["DSH_VERSION"])
                    env.update(overrides)
                    result = run(["sh", str(fixture / "scripts/verify.sh")], env=env)
                    output = result.stdout + result.stderr
                    self.assertEqual(result.returncode, expected_status, output)
                    if kind == "matching":
                        self.assertIn(f"Verified DeepSeek Harness {PINS['DSH_VERSION']}", output)
                        self.assertIn("reached-inventory", output)
                    else:
                        self.assertNotIn("reached-inventory", output)


if __name__ == "__main__":
    unittest.main()
