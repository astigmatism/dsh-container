#!/bin/sh
set -eu

# No-Docker tests for the after-network boot service:
#   - the unit template carries the required directives and placeholders
#   - install-boot-service.sh --dry-run renders a valid unit and is stable
#     across a second run
#   - a real install without a user bus is idempotent and drift-repairing
#   - start-after-network.sh reads .env beside itself and covers both its
#     healthy no-op and missing-port repair paths with mocked host commands
#   - the tracked scripts are LF-only
# The user bus is forced unreachable with a PATH that has no systemctl.

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_root=$(CDPATH= cd -- "$test_dir/.." && pwd)
installer=$source_root/scripts/install-boot-service.sh
template=$source_root/deploy/deepseek-harness-after-network.service
boot_script=$source_root/start-after-network.sh
unit_name=deepseek-harness-after-network.service
temporary_root=$(mktemp -d)
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM

fail() {
  echo "not ok - $*" >&2
  exit 1
}

[ -x "$installer" ] || fail "install-boot-service.sh is missing or not executable"
[ -x "$boot_script" ] || fail "start-after-network.sh is missing or not executable"
[ -f "$template" ] || fail "unit template is missing"

# 1. The tracked boot-service files are LF-only (repo policy).
cr=$(printf '\r')
for tracked_file in "$boot_script" "$installer" "$template"; do
  if grep -q "$cr" "$tracked_file"; then
    fail "$tracked_file contains CRLF line endings"
  fi
done

# 2. The template keeps the host unit's exact shape and renders two absolute
#    paths from @PROJECT_DIR@.
for directive in \
  'Type=oneshot' \
  'RemainAfterExit=yes' \
  'Restart=on-failure' \
  'RestartPreventExitStatus=78' \
  'RestartSec=10' \
  'TimeoutStartSec=infinity' \
  'WantedBy=default.target' \
  'WorkingDirectory=@PROJECT_DIR@' \
  'ExecStart=@PROJECT_DIR@/start-after-network.sh'
do
  grep -Fq "$directive" "$template" \
    || fail "template is missing: $directive"
done
# The token may be mentioned in template comments, but every occurrence must
# sit in one of the two path lines; anything else would not render to a path.
stray_placeholder=$(grep -F '@PROJECT_DIR@' "$template" \
  | grep -Fvx 'WorkingDirectory=@PROJECT_DIR@' \
  | grep -Fvx 'ExecStart=@PROJECT_DIR@/start-after-network.sh' || true)
[ -z "$stray_placeholder" ] \
  || fail "template has @PROJECT_DIR@ outside the two path lines: $stray_placeholder"

# 3. Deterministic bus-unreachable context: a PATH without systemctl.
no_bus_bin=$temporary_root/no-bus-bin
mkdir "$no_bus_bin"
for utility in sh sed awk grep cat dirname mkdir mktemp chmod mv rm ln readlink; do
  utility_path=$(command -v "$utility" 2>/dev/null) \
    || fail "required test utility is missing: $utility"
  ln -s "$utility_path" "$no_bus_bin/$utility"
done

# 4. --dry-run renders the real unit for this checkout, changes nothing, and
#    is stable across a second run.
dry_home=$temporary_root/dry-home
dry_log_1=$temporary_root/dry-run-1.log
dry_log_2=$temporary_root/dry-run-2.log
HOME="$dry_home" PATH="$no_bus_bin" sh "$installer" --dry-run >"$dry_log_1" 2>&1 \
  || fail "dry-run install failed"
HOME="$dry_home" PATH="$no_bus_bin" sh "$installer" --dry-run >"$dry_log_2" 2>&1 \
  || fail "second dry-run install failed"
[ "$(cksum <"$dry_log_1")" = "$(cksum <"$dry_log_2")" ] \
  || fail "dry-run output is not stable across a second run"
[ ! -e "$dry_home/.config" ] || fail "dry-run wrote files"
grep -Fxq "WorkingDirectory=$source_root" "$dry_log_1" \
  || fail "dry-run did not render WorkingDirectory for this checkout"
grep -Fxq "ExecStart=$source_root/start-after-network.sh" "$dry_log_1" \
  || fail "dry-run did not render ExecStart for this checkout"
for directive in \
  'Type=oneshot' \
  'RemainAfterExit=yes' \
  'Restart=on-failure' \
  'RestartPreventExitStatus=78' \
  'RestartSec=10' \
  'TimeoutStartSec=infinity' \
  'WantedBy=default.target'
do
  grep -Fxq "$directive" "$dry_log_1" \
    || fail "dry-run unit is missing: $directive"
done
if grep -Fq '@PROJECT_DIR@' "$dry_log_1"; then
  fail "dry-run unit still contains an unrendered placeholder"
fi
grep -Fqx 'boot_service=dry-run' "$dry_log_1" \
  || fail "dry-run did not report its result"

# 5. A real install without a bus writes the rendered unit and the
#    default.target.wants symlink, prints the exact host commands, and exits 0.
install_home=$temporary_root/install-home
install_log=$temporary_root/install.log
expected_unit=$temporary_root/expected-unit
sed "s|@PROJECT_DIR@|$source_root|g" "$template" >"$expected_unit"
HOME="$install_home" PATH="$no_bus_bin" sh "$installer" >"$install_log" 2>&1 \
  || fail "install without a user bus failed"
unit_file=$install_home/.config/systemd/user/$unit_name
wants_link=$install_home/.config/systemd/user/default.target.wants/$unit_name
[ -f "$unit_file" ] || fail "unit file was not installed"
cmp -s "$expected_unit" "$unit_file" \
  || fail "installed unit does not match the rendered template"
[ -L "$wants_link" ] || fail "default.target.wants symlink was not created"
[ "$(readlink "$wants_link")" = "../$unit_name" ] \
  || fail "wants symlink points at the wrong target"
grep -Fxq 'systemctl --user daemon-reload' "$install_log" \
  || fail "bus-unreachable install did not print the daemon-reload command"
grep -Fxq "systemctl --user start $unit_name" "$install_log" \
  || fail "bus-unreachable install did not print the start command"
grep -Fqx 'boot_service=warning:bus-unreachable' "$install_log" \
  || fail "bus-unreachable install did not report a warning result"

# 6. A second install is a content-driven no-op: no writes, no reload, exit 0.
unit_before=$(cksum "$unit_file")
noop_log=$temporary_root/noop.log
HOME="$install_home" PATH="$no_bus_bin" sh "$installer" >"$noop_log" 2>&1 \
  || fail "second install failed"
[ "$unit_before" = "$(cksum "$unit_file")" ] \
  || fail "second install modified the unit file"
if grep -Eq 'Unit file (install|update)' "$noop_log"; then
  fail "second install reported a unit file change"
fi
if grep -Eq 'Wants link (install|update)' "$noop_log"; then
  fail "second install reported a wants link change"
fi
# The manual-commands block always names the daemon-reload command when the
# bus is unreachable, so the reload marker is the discriminator: it is only
# printed when the installer actually reloads the manager.
if grep -Fxq 'Reloading the user systemd manager...' "$noop_log"; then
  fail "second install reloaded with unchanged files"
fi
grep -Fqx 'boot_service=warning:bus-unreachable' "$noop_log" \
  || fail "second install did not report a warning result"

# 7. Drift is repaired: a modified unit file is restored to the rendered
#    content on the next run.
echo "drifted" >>"$unit_file"
drift_log=$temporary_root/drift.log
HOME="$install_home" PATH="$no_bus_bin" sh "$installer" >"$drift_log" 2>&1 \
  || fail "drift-repair install failed"
cmp -s "$expected_unit" "$unit_file" \
  || fail "drifted unit file was not restored to the rendered template"
grep -Fq 'Unit file update' "$drift_log" \
  || fail "drift was not logged as a unit file update"
grep -Fqx 'boot_service=warning:bus-unreachable' "$drift_log" \
  || fail "drift-repair install did not report a warning result"

# 8. Execute the real recovery script from an isolated repository root. The
#    fixture's parent intentionally has no .env: deriving project_dir as ..
#    would fail before reaching any mocked host command.
runtime_project=$temporary_root/runtime-project
runtime_bin=$temporary_root/runtime-bin
runtime_state=$temporary_root/runtime-state
mkdir "$runtime_project" "$runtime_bin" "$runtime_state"
cp "$boot_script" "$runtime_project/start-after-network.sh"
chmod +x "$runtime_project/start-after-network.sh"
touch "$runtime_project/compose.yaml" "$runtime_project/compose.external-ollama.yaml"
cat >"$runtime_project/.env" <<'EOF'
DSH_DEPLOYMENT_MODE=external
HARNESS_BIND_ADDRESS=192.0.2.21
HARNESS_HTTPS_PORT=3443
HARNESS_CA_PORT=3081
OLLAMA_NETWORK=test-ollama
EOF

cat >"$runtime_bin/ip" <<'EOF'
#!/bin/sh
echo '2: eth0 inet 192.0.2.21/24 brd 192.0.2.255 scope global eth0'
EOF
cat >"$runtime_bin/systemctl" <<'EOF'
#!/bin/sh
case "$*" in
  *'--user show local-ai-apply-default-after-network.service -p LoadState') echo 'LoadState=loaded' ;;
  *'--user show local-ai-apply-default-after-network.service -p ActiveState') echo 'ActiveState=inactive' ;;
  *'--user show local-ai-apply-default-after-network.service -p Result') echo 'Result=success' ;;
  *'--user show local-ai-apply-default-after-network.service -p NInvocations') echo 'NInvocations=0' ;;
  *'--user show local-ai-apply-default-after-network.service -p UnitFileState') echo 'UnitFileState=disabled' ;;
  *'-p LoadState') echo 'LoadState=not-found' ;;
  *'-p ActiveState') echo 'ActiveState=inactive' ;;
  *'-p Result') echo 'Result=success' ;;
  *'-p NInvocations') echo 'NInvocations=0' ;;
esac
EOF
cat >"$runtime_bin/sleep" <<'EOF'
#!/bin/sh
echo "unexpected retry wait: sleep $*" >&2
exit 99
EOF
cat >"$runtime_bin/docker" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$MOCK_DOCKER_LOG"
case "${1:-}" in
  compose)
    if [ "${2:-}" = version ]; then
      exit 0
    fi
    case "$*" in
      *' up -d --force-recreate --no-deps harness')
        touch "$MOCK_RUNTIME_STATE/harness-recreated"
        ;;
    esac
    ;;
  info) ;;
  network) ;;
  port)
    if [ "$MOCK_SCENARIO" = healthy ] \
      || [ -f "$MOCK_RUNTIME_STATE/harness-recreated" ]; then
      echo '3443/tcp -> 192.0.2.21:3443'
      echo '3081/tcp -> 192.0.2.21:3081'
    fi
    ;;
  inspect)
    case "$*" in
      *'{{if .State.Health}}'*) echo healthy ;;
      *'{{.State.Status}}'*) echo running ;;
      *'{{json .NetworkSettings.Networks}}'*) echo '{"test-ollama":{}}' ;;
    esac
    ;;
esac
EOF
chmod +x "$runtime_bin/ip" "$runtime_bin/systemctl" "$runtime_bin/sleep" "$runtime_bin/docker"

run_boot_script() {
  scenario=$1
  output=$2
  docker_log=$3
  rm -f "$runtime_state/harness-recreated" "$docker_log"
  MOCK_SCENARIO=$scenario \
    MOCK_RUNTIME_STATE=$runtime_state \
    MOCK_DOCKER_LOG=$docker_log \
    PATH="$runtime_bin:$PATH" \
    sh "$runtime_project/start-after-network.sh" >"$output" 2>&1
}

healthy_output=$temporary_root/healthy-output.log
healthy_docker_log=$temporary_root/healthy-docker.log
run_boot_script healthy "$healthy_output" "$healthy_docker_log" \
  || fail "healthy boot-service no-op path failed"
grep -Fqx 'Harness binding and network attachment are already correct; nothing to do.' "$healthy_output" \
  || fail "healthy boot-service path did not report a no-op"
grep -Fq "compose --env-file $runtime_project/.env -f $runtime_project/compose.yaml -f $runtime_project/compose.external-ollama.yaml config --quiet" "$healthy_docker_log" \
  || fail "boot service did not read .env and Compose files from its own repository root"
if grep -Fq ' up -d --force-recreate ' "$healthy_docker_log"; then
  fail "healthy boot-service path unexpectedly recreated a container"
fi

repair_output=$temporary_root/repair-output.log
repair_docker_log=$temporary_root/repair-docker.log
run_boot_script missing-ports "$repair_output" "$repair_docker_log" \
  || fail "missing-port boot-service repair path failed"
grep -Fqx 'The harness is not bound to 192.0.2.21:3443 and 192.0.2.21:3081; a recreate is required.' "$repair_output" \
  || fail "missing-port path did not diagnose the absent live binding"
for service in harness gateway; do
  grep -Fqx "compose --env-file $runtime_project/.env -f $runtime_project/compose.yaml -f $runtime_project/compose.external-ollama.yaml up -d --force-recreate --no-deps $service" "$repair_docker_log" \
    || fail "missing-port path did not force-recreate $service with the external Compose overlay"
done
grep -Fqx 'Boot check complete: harness bound to 192.0.2.21, attached to test-ollama, gateway healthy.' "$repair_output" \
  || fail "missing-port repair path did not complete verification"

# Permanent configuration failures use EX_CONFIG so systemd can suppress the
# restart loop while ordinary runtime failures remain retryable.
mv "$runtime_project/.env" "$runtime_project/.env.valid"
set +e
MOCK_SCENARIO=healthy MOCK_RUNTIME_STATE=$runtime_state MOCK_DOCKER_LOG=$temporary_root/missing-env-docker.log \
  PATH="$runtime_bin:$PATH" sh "$runtime_project/start-after-network.sh" >"$temporary_root/missing-env-output.log" 2>&1
missing_env_status=$?
set -e
[ "$missing_env_status" -eq 78 ] \
  || fail "missing .env exited $missing_env_status instead of permanent-configuration status 78"
mv "$runtime_project/.env.valid" "$runtime_project/.env"

sed 's/^DSH_DEPLOYMENT_MODE=.*/DSH_DEPLOYMENT_MODE=invalid/' \
  "$runtime_project/.env" >"$runtime_project/.env.invalid"
mv "$runtime_project/.env" "$runtime_project/.env.valid"
mv "$runtime_project/.env.invalid" "$runtime_project/.env"
set +e
MOCK_SCENARIO=healthy MOCK_RUNTIME_STATE=$runtime_state MOCK_DOCKER_LOG=$temporary_root/invalid-env-docker.log \
  PATH="$runtime_bin:$PATH" sh "$runtime_project/start-after-network.sh" >"$temporary_root/invalid-env-output.log" 2>&1
invalid_env_status=$?
set -e
[ "$invalid_env_status" -eq 78 ] \
  || fail "invalid .env exited $invalid_env_status instead of permanent-configuration status 78"
mv "$runtime_project/.env.valid" "$runtime_project/.env"

echo "ok - boot service rendering, install, root resolution, no-op, and repair paths are safe"
