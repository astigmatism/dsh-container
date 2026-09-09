#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_root=$(CDPATH= cd -- "$test_dir/.." && pwd)
legacy_updater_commit=05f68939f5f3c81e1ef54464fd80281c953d5dc4
temporary_root=$(mktemp -d)
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM

fail() {
  echo "not ok - $*" >&2
  exit 1
}

assert_status() {
  fixture_path=$1
  expected=$2
  if [ ! -f "$fixture_path/data/maintenance-status" ]; then
    sed -n '1,160p' "$fixture_path/output.log" >&2
    fail "maintenance status was not written"
  fi
  grep -Fxq "$expected" "$fixture_path/data/maintenance-status" \
    || fail "status missing '$expected'"
}

assert_no_interruption() {
  fixture_path=$1
  if grep -Eq '(^| )stop( |$)|(^| )start( |$)|(^| )up( |$)' "$fixture_path/docker.log"; then
    fail "configuration preflight invoked an interrupting Compose command"
  fi
}

assert_no_fetch_or_mutation() {
  fixture_path=$1
  if grep -Fq 'fetch --prune' "$fixture_path/git.log"; then
    fail "rejected preflight reached the fetch step"
  fi
  if grep -Eq '(^| )pull( |$)|(^| )build( |$)|(^| )stop( |$)|(^| )start( |$)|(^| )up( |$)|^deploy ' "$fixture_path/docker.log"; then
    fail "rejected preflight reached an image or deployment mutation"
  fi
}

line_number() {
  pattern=$1
  file=$2
  grep -n -m 1 -F -- "$pattern" "$file" | awk -F: '{ print $1 }'
}

make_fixture() {
  fixture_name=$1
  runtime_kind=$2
  fixture=$temporary_root/$fixture_name
  mkdir -p "$fixture/scripts" "$fixture/config" "$fixture/data/dsh" "$fixture/fake-bin" "$fixture/home"
  cp "$source_root/scripts/update-and-restart.sh" "$fixture/scripts/"
  cp "$source_root/scripts/configure.sh" "$fixture/scripts/"
  cp "$source_root/scripts/verify-persisted-settings.sh" "$fixture/scripts/"
  cp "$source_root/scripts/install-boot-service.sh" "$fixture/scripts/"
  cp "$source_root/tests/fixtures/deploy-stub.sh" "$fixture/scripts/deploy.sh"
  mkdir -p "$fixture/deploy"
  cp "$source_root/deploy/deepseek-harness-after-network.service" "$fixture/deploy/"
  cp "$source_root/tests/fixtures/update-bin/git" "$fixture/fake-bin/"
  cp "$source_root/tests/fixtures/update-bin/docker" "$fixture/fake-bin/"
  # The systemctl stub keeps every fixture on the installer's documented
  # bus-unreachable path, with the unit files landing in the fixture HOME.
  cp "$source_root/tests/fixtures/update-bin/systemctl" "$fixture/fake-bin/"
  # The id stub keeps `id -un` resolvable in sandboxes whose /etc/passwd has
  # no entry for the running UID.
  cp "$source_root/tests/fixtures/update-bin/id" "$fixture/fake-bin/"
  cp "$source_root/config/settings.yaml" "$fixture/config/settings.yaml"
  {
    printf '%s\n' 'DSH_DEPLOYMENT_MODE=external'
    printf 'HOST_UID=%s\n' "$(id -u)"
    printf 'HOST_GID=%s\n' "$(id -g)"
    printf 'HOST_HOME=%s\n' "$fixture/home"
    printf '%s\n' 'DSH_TOKEN_ENABLED=false'
  } >"$fixture/.env"
  : >"$fixture/git.log"
  : >"$fixture/docker.log"
  printf '%s\n' '1111111111111111111111111111111111111111' >"$fixture/git-head"
  case "$runtime_kind" in
    matching) cp "$fixture/config/settings.yaml" "$fixture/data/dsh/settings.yaml" ;;
    empty) : >"$fixture/data/dsh/settings.yaml" ;;
    missing) ;;
    mismatched) printf '%s\n' 'models: {}' >"$fixture/data/dsh/settings.yaml" ;;
    *) fail "unknown runtime fixture kind: $runtime_kind" ;;
  esac
}

run_update() {
  fixture_path=$1
  shift
  set +e
  # Fixtures run outside the harness container; do not inherit a deployment
  # DSH_HOME, which would trigger the delegation path.
  PATH="$fixture_path/fake-bin:$PATH" \
    HOME="$fixture_path/home" \
    DSH_HOME= \
    DSH_UPDATE_DELEGATED="${TEST_UPDATE_DELEGATED:-0}" \
    DSH_UPDATE_CONTAINER_NAME="${TEST_UPDATE_CONTAINER_NAME:-}" \
    SERVICE_PORTAL_UPDATE_JOB_ID="${TEST_SERVICE_PORTAL_JOB_ID:-}" \
    SERVICE_PORTAL_UPDATE_HOST_HOME="${TEST_SERVICE_PORTAL_HOST_HOME:-}" \
    DSH_BOOT_SERVICE_HOME="${TEST_BOOT_SERVICE_HOME:-}" \
    FAKE_GIT_LOG="$fixture_path/git.log" \
    FAKE_GIT_STATE_FILE="$fixture_path/git-head" \
    FAKE_FAST_FORWARD_SOURCE="${TEST_FAST_FORWARD_SOURCE:-}" \
    FAKE_GIT_VERSION_EXIT="${TEST_GIT_VERSION_EXIT:-0}" \
    FAKE_GIT_DETACHED="${TEST_GIT_DETACHED:-0}" \
    FAKE_GIT_BRANCH="${TEST_GIT_BRANCH:-main}" \
    FAKE_GIT_REMOTE="${TEST_GIT_REMOTE:-origin}" \
    FAKE_GIT_MERGE_REF="${TEST_GIT_MERGE_REF:-refs/heads/main}" \
    FAKE_GIT_ORIGIN_URL="${TEST_GIT_ORIGIN_URL:-https://github.com/astigmatism/dsh-container.git}" \
    FAKE_GIT_MERGE_BASE_EXIT="${TEST_GIT_MERGE_BASE_EXIT:-0}" \
    FAKE_DOCKER_LOG="$fixture_path/docker.log" \
    FAKE_DEPLOY_LOG="$fixture_path/docker.log" \
    FAKE_GIT_DIRTY="${TEST_GIT_DIRTY:-}" \
    FAKE_DOCKER_INFO_EXIT="${TEST_DOCKER_INFO_EXIT:-0}" \
    FAKE_LOCK_CONTAINER_NAME="${TEST_UPDATE_CONTAINER_NAME:-}" \
    FAKE_LOCK_CONTAINER_ID="${TEST_LOCK_CONTAINER_ID:-}" \
    FAKE_LOCK_CONTAINER_EXISTS="${TEST_LOCK_CONTAINER_EXISTS:-1}" \
    FAKE_LOCK_CONTAINER_RUNNING="${TEST_LOCK_CONTAINER_RUNNING:-true}" \
    FAKE_COMPOSE_VERSION_EXIT="${TEST_COMPOSE_VERSION_EXIT:-0}" \
    FAKE_COMPOSE_CONFIG_EXIT="${TEST_COMPOSE_CONFIG_EXIT:-0}" \
    FAKE_COMPOSE_CONTAINER_ID="${TEST_COMPOSE_CONTAINER_ID:-}" \
    FAKE_CONTAINER_IMAGE_ID="${TEST_CONTAINER_IMAGE_ID:-}" \
    FAKE_CONTAINER_IMAGE_INSPECT_EXIT="${TEST_CONTAINER_IMAGE_INSPECT_EXIT:-0}" \
    FAKE_COMPOSE_PS_EXIT="${TEST_COMPOSE_PS_EXIT:-0}" \
    FAKE_COMPOSE_PULL_EXIT="${TEST_COMPOSE_PULL_EXIT:-0}" \
    FAKE_COMPOSE_BUILD_EXIT="${TEST_COMPOSE_BUILD_EXIT:-0}" \
    FAKE_COMPOSE_START_EXIT="${TEST_COMPOSE_START_EXIT:-0}" \
    FAKE_COMPOSE_LABELS="${TEST_COMPOSE_LABELS:-}" \
    FAKE_TARGET_SETTINGS_OBJECT="${TEST_TARGET_SETTINGS_OBJECT:-same-settings-object}" \
    FAKE_DEPLOY_EXIT="${TEST_DEPLOY_EXIT:-0}" \
    sh "$fixture_path/scripts/update-and-restart.sh" "$@" \
      >"$fixture_path/output.log" 2>&1
  update_status=$?
  set -e
}

make_legacy_fixture() {
  fixture_name=$1
  runtime_kind=$2
  make_fixture "$fixture_name" "$runtime_kind"
  mkdir -p "$fixture/target/scripts"
  cp "$source_root/scripts/update-and-restart.sh" "$fixture/target/scripts/"
  cp "$source_root/scripts/configure.sh" "$fixture/target/scripts/"
  cp "$source_root/scripts/verify-persisted-settings.sh" "$fixture/target/scripts/"
  cp "$source_root/scripts/initialize-persisted-settings.sh" "$fixture/target/scripts/"
  cp "$source_root/tests/fixtures/deploy-stub.sh" "$fixture/target/scripts/deploy.sh"
  git -C "$source_root" show "$legacy_updater_commit:scripts/update-and-restart.sh" \
    >"$fixture/scripts/update-and-restart.sh"
  git -C "$source_root" show "$legacy_updater_commit:scripts/configure.sh" \
    >"$fixture/scripts/configure.sh"
}

for runtime_kind in missing empty
do
  make_legacy_fixture "legacy-$runtime_kind-settings" "$runtime_kind"
  if [ -e "$fixture/data/dsh/settings.yaml" ]; then
    legacy_before=$(cksum "$fixture/data/dsh/settings.yaml")
  else
    legacy_before=missing
  fi
  TEST_FAST_FORWARD_SOURCE=$fixture/target
  run_update "$fixture" --external-ollama
  unset TEST_FAST_FORWARD_SOURCE
  if [ "$update_status" -eq 0 ]; then
    sed -n '1,240p' "$fixture/output.log" >&2
    sed -n '1,240p' "$fixture/git.log" >&2
    fail "legacy updater accepted $runtime_kind settings"
  fi
  assert_no_interruption "$fixture"
  grep -Fq 'merge --ff-only' "$fixture/git.log" \
    || fail "legacy $runtime_kind test did not simulate a fast-forward"
  grep -Fq 'Configuration validation failed during active maintenance' "$fixture/output.log" \
    || fail "target configure guard did not reject legacy $runtime_kind settings"
  if [ "$legacy_before" = missing ]; then
    [ ! -e "$fixture/data/dsh/settings.yaml" ] \
      || fail "legacy guard created missing settings"
  else
    [ "$legacy_before" = "$(cksum "$fixture/data/dsh/settings.yaml")" ] \
      || fail "legacy guard modified $runtime_kind settings"
  fi
done

make_legacy_fixture legacy-mismatched-settings mismatched
legacy_before=$(cksum "$fixture/data/dsh/settings.yaml")
TEST_FAST_FORWARD_SOURCE=$fixture/target
run_update "$fixture" --external-ollama
unset TEST_FAST_FORWARD_SOURCE
if [ "$update_status" -ne 0 ]; then
  sed -n '1,240p' "$fixture/output.log" >&2
  sed -n '1,240p' "$fixture/git.log" >&2
  sed -n '1,240p' "$fixture/docker.log" >&2
  fail "fetched verifier rejected valid machine-specific settings"
fi
[ "$legacy_before" = "$(cksum "$fixture/data/dsh/settings.yaml")" ] \
  || fail "legacy upgrade modified machine-specific settings"
grep -Fq 'preserving the non-empty runtime configuration' "$fixture/output.log" \
  || fail "legacy upgrade did not report preserved runtime settings"

make_fixture empty-settings empty
empty_before=$(cksum "$fixture/data/dsh/settings.yaml")
run_update "$fixture" --external-ollama
[ "$update_status" -ne 0 ] || fail "empty settings unexpectedly passed"
assert_status "$fixture" 'failure_type=configuration-verification'
assert_status "$fixture" 'failure_stage=preflight-current-settings'
assert_no_interruption "$fixture"
if grep -Fq 'fetch --prune' "$fixture/git.log"; then
  fail "empty settings reached the fetch step"
fi
[ "$empty_before" = "$(cksum "$fixture/data/dsh/settings.yaml")" ] \
  || fail "empty settings were modified"
grep -Fq 'Persisted settings are empty' "$fixture/output.log" \
  || fail "empty-settings diagnostic was not reported"

make_fixture mismatched-settings mismatched
mismatch_before=$(cksum "$fixture/data/dsh/settings.yaml")
run_update "$fixture" --external-ollama
if [ "$update_status" -ne 0 ]; then
  sed -n '1,240p' "$fixture/output.log" >&2
  fail "valid machine-specific settings blocked maintenance"
fi
[ "$mismatch_before" = "$(cksum "$fixture/data/dsh/settings.yaml")" ] \
  || fail "machine-specific settings were modified"
grep -Fq 'preserving the non-empty runtime configuration' "$fixture/output.log" \
  || fail "machine-specific settings preservation was not reported"

make_fixture dsh-settings-mode matching
chmod 0600 "$fixture/data/dsh/settings.yaml"
run_update "$fixture" --external-ollama
[ "$update_status" -eq 0 ] || fail "DSH mode 0600 blocked maintenance"

make_fixture missing-host-home-record matching
awk -F= '$1 != "HOST_HOME"' "$fixture/.env" >"$fixture/.env.without-home"
mv "$fixture/.env.without-home" "$fixture/.env"
run_update "$fixture" --external-ollama
[ "$update_status" -eq 0 ] || fail "missing host-home metadata blocked direct maintenance"
grep -Fxq "HOST_HOME=$fixture/home" "$fixture/.env" \
  || fail "direct maintenance did not persist the delegated host-home metadata"
grep -Fq 'Recorded host home for delegated Service Portal maintenance' "$fixture/output.log" \
  || fail "host-home metadata migration was not reported"

make_fixture wrong-settings-mode matching
chmod 0666 "$fixture/data/dsh/settings.yaml"
run_update "$fixture" --external-ollama
[ "$update_status" -ne 0 ] || fail "insecure settings mode unexpectedly passed"
assert_status "$fixture" 'failure_type=configuration-verification'
assert_status "$fixture" 'failure_stage=preflight-current-settings'
assert_no_interruption "$fixture"
grep -Fq 'expected a service-writable, non-executable mode' "$fixture/output.log" \
  || fail "settings-mode diagnostic was not reported"

make_fixture wrong-settings-owner matching
{
  printf '%s\n' 'DSH_DEPLOYMENT_MODE=external'
  printf 'HOST_UID=%s\n' "$(( $(id -u) + 1 ))"
  printf 'HOST_GID=%s\n' "$(id -g)"
} >"$fixture/.env"
run_update "$fixture" --external-ollama
[ "$update_status" -ne 0 ] || fail "wrong settings ownership unexpectedly passed"
assert_status "$fixture" 'failure_type=configuration-verification'
assert_status "$fixture" 'failure_stage=preflight-current-settings'
assert_no_interruption "$fixture"
grep -Fq 'expected service ownership' "$fixture/output.log" \
  || fail "settings-ownership diagnostic was not reported"

make_fixture target-settings-change matching
TEST_TARGET_SETTINGS_OBJECT=different-settings-object
run_update "$fixture" --external-ollama
unset TEST_TARGET_SETTINGS_OBJECT
[ "$update_status" -eq 0 ] || fail "repository default change blocked preserved runtime settings"
grep -Fq 'fetch --prune origin main' "$fixture/git.log" \
  || fail "target-settings test did not fetch"
grep -Fq 'merge --ff-only' "$fixture/git.log" \
  || fail "target settings change did not fast-forward"

make_fixture updater-resume matching
run_update "$fixture" --external-ollama
[ "$update_status" -eq 0 ] || fail "updater resume path failed"
assert_status "$fixture" 'state=ok'
assert_status "$fixture" 'exit_code=0'
# Preflight converged the boot-service files in the fixture HOME and the
# post-deployment activation found the bus unreachable; only activation is
# deferred, so state and exit_code remain successful.
assert_status "$fixture" 'boot_service=warning:bus-unreachable'
[ -f "$fixture/home/.config/systemd/user/deepseek-harness-after-network.service" ] \
  || fail "post-deployment step did not install the boot unit into the fixture home"
assert_status "$fixture" 'from_commit=1111111111111111111111111111111111111111'
assert_status "$fixture" 'target_commit=2222222222222222222222222222222222222222'
grep -Fq 'Restarting maintenance under the fetched updater before service interruption' "$fixture/output.log" \
  || fail "updater did not re-exec after fast-forward"
[ "$(grep -Fc 'fetch --prune origin main' "$fixture/git.log")" -eq 1 ] \
  || fail "resumed updater fetched more than once"
[ ! -e "$fixture/data/update-and-restart.lock" ] \
  || fail "successful updater left its transferred lock behind"

make_fixture missing-token-policy matching
awk -F= '$1 != "DSH_TOKEN_ENABLED"' "$fixture/.env" >"$fixture/.env.without-token-policy"
mv "$fixture/.env.without-token-policy" "$fixture/.env"
run_update "$fixture" --external-ollama
[ "$update_status" -eq 0 ] || fail "missing token-plugin policy blocked maintenance"
grep -Fxq 'DSH_TOKEN_ENABLED=false' "$fixture/.env" \
  || fail "updater did not persist the safe token-plugin default"
grep -Fq 'token statistics remain available only by explicit opt-in' "$fixture/output.log" \
  || fail "token-plugin safety migration was not reported"

make_fixture opted-in-token-policy matching
sed 's/^DSH_TOKEN_ENABLED=false$/DSH_TOKEN_ENABLED=true/' "$fixture/.env" >"$fixture/.env.opted-in"
mv "$fixture/.env.opted-in" "$fixture/.env"
run_update "$fixture" --external-ollama
[ "$update_status" -eq 0 ] || fail "explicit token-plugin opt-in blocked maintenance"
grep -Fxq 'DSH_TOKEN_ENABLED=true' "$fixture/.env" \
  || fail "updater did not preserve the explicit token-plugin opt-in"

make_fixture invalid-token-policy matching
sed 's/^DSH_TOKEN_ENABLED=false$/DSH_TOKEN_ENABLED=surprise/' "$fixture/.env" >"$fixture/.env.invalid-token-policy"
mv "$fixture/.env.invalid-token-policy" "$fixture/.env"
run_update "$fixture" --external-ollama
[ "$update_status" -ne 0 ] || fail "invalid token-plugin policy unexpectedly passed"
assert_no_interruption "$fixture"
grep -Fq 'must be exactly true or false' "$fixture/output.log" \
  || fail "invalid token-plugin policy diagnostic was not reported"

make_fixture legacy-harness-pins matching
{
  printf '%s\n' 'DSH_VERSION=0.1.1-rc.2'
  printf '%s\n' 'HARNESS_IMAGE=local/deepseek-harness:0.1.1-rc.2-portable'
} >>"$fixture/.env"
run_update "$fixture" --external-ollama
[ "$update_status" -eq 0 ] || fail "exact legacy Harness pins blocked maintenance"
grep -Fxq 'DSH_VERSION=0.1.5-alpha.1' "$fixture/.env" \
  || fail "legacy DSH version was not migrated"
grep -Fxq 'DSH_UPSTREAM_COMMIT=5dda764ed3aa172535a7967b06ff95d9cbfe536a' "$fixture/.env" \
  || fail "upstream commit provenance was not added"
grep -Fxq 'HARNESS_IMAGE=local/deepseek-harness:0.1.5-alpha.1-portable' "$fixture/.env" \
  || fail "legacy Harness image was not migrated"
if grep -Fq '0.1.1-rc.2' "$fixture/.env"; then
  fail "legacy Harness pin remained after migration"
fi
grep -Fq 'Migrated exact legacy Harness pins' "$fixture/output.log" \
  || fail "legacy Harness pin migration was not reported"

make_fixture custom-harness-pins matching
{
  printf '%s\n' 'DSH_VERSION=local-development'
  printf '%s\n' 'HARNESS_IMAGE=local/deepseek-harness:0.1.1-rc.2-portable'
} >>"$fixture/.env"
custom_pins_before=$(cksum "$fixture/.env")
run_update "$fixture" --external-ollama
[ "$update_status" -eq 0 ] || fail "custom Harness pins blocked maintenance"
[ "$custom_pins_before" = "$(cksum "$fixture/.env")" ] \
  || fail "custom Harness pins were partially rewritten"
grep -Fq 'Preserving custom DSH_VERSION/HARNESS_IMAGE pins' "$fixture/output.log" \
  || fail "custom Harness pin preservation was not reported"

make_fixture legacy-harness-pins-dry-run matching
{
  printf '%s\n' 'DSH_VERSION=0.1.1-rc.2'
  printf '%s\n' 'HARNESS_IMAGE=local/deepseek-harness:0.1.1-rc.2-portable'
} >>"$fixture/.env"
dry_run_pins_before=$(cksum "$fixture/.env")
run_update "$fixture" --external-ollama --dry-run
[ "$update_status" -eq 0 ] || fail "legacy Harness pin dry-run failed"
[ "$dry_run_pins_before" = "$(cksum "$fixture/.env")" ] \
  || fail "dry-run modified legacy Harness pins"
grep -Fq 'exact legacy Harness pins will migrate' "$fixture/output.log" \
  || fail "dry-run did not report planned Harness pin migration"

# Delegated maintenance exposes only the real host user-unit directory to the
# helper, not the entire home or its ephemeral HOME. The initial handoff maps
# the checkout from HARNESS_WORKSPACE_ROOT to HOST_FILESYSTEM_SOURCE, while
# both Docker bind sources remain host-native paths.
grep -Fq -- '--mount "type=bind,source=$host_unit_dir,target=$host_unit_dir"' "$source_root/scripts/update-and-restart.sh" \
  || fail "delegation does not safely bind the real host user-unit directory into Docker"
if grep -Fq -- '--mount "type=bind,source=$host_home,target=$host_home"' "$source_root/scripts/update-and-restart.sh"; then
  fail "delegation mounts the entire host home instead of only its user-unit directory"
fi
if grep -Fq -- '--volume "${workspace_root}${host_home}:' "$source_root/scripts/update-and-restart.sh"; then
  fail "delegation passes the harness /host view as a Docker bind source"
fi
grep -Fq 'host_workspace=$(get_env HOST_FILESYSTEM_SOURCE)' "$source_root/scripts/update-and-restart.sh" \
  || fail "delegation ignores the configured host-filesystem bind source"
grep -Fq 'project_relative=${project_dir#"$workspace_root"}' "$source_root/scripts/update-and-restart.sh" \
  || fail "delegation does not calculate the checkout path within the workspace mount"
grep -Fq 'host_project_dir=$host_workspace$project_relative' "$source_root/scripts/update-and-restart.sh" \
  || fail "delegation does not reconstruct the host-native checkout path"
grep -Fq -- '--volume "$host_project_dir:$host_project_dir"' "$source_root/scripts/update-and-restart.sh" \
  || fail "delegation does not mount the checkout at its host-native path"
grep -Fq -- '--workdir "$host_project_dir"' "$source_root/scripts/update-and-restart.sh" \
  || fail "delegated installer would render the harness /host checkout path"
if grep -Fq -- '--volume "$project_dir:$project_dir"' "$source_root/scripts/update-and-restart.sh"; then
  fail "delegation passes the harness checkout view as a Docker bind source"
fi

make_fixture delegated-without-host-home matching
TEST_UPDATE_DELEGATED=1
run_update "$fixture" --external-ollama
unset TEST_UPDATE_DELEGATED
[ "$update_status" -ne 0 ] || fail "delegated maintenance without a host home reported success"
assert_status "$fixture" 'state=failed'
assert_status "$fixture" 'exit_code=1'
assert_status "$fixture" 'failure_type=boot-service'
assert_status "$fixture" 'failure_stage=boot-service-preflight'
assert_status "$fixture" 'boot_service=warning:host-home-unavailable'
assert_no_fetch_or_mutation "$fixture"
[ ! -e "$fixture/home/.config/systemd/user/deepseek-harness-after-network.service" ] \
  || fail "host-home failure installed the boot unit into the helper's ephemeral HOME"

make_fixture delegated-host-home matching
delegated_home=$fixture/mounted-host-home
awk -F= -v replacement="$delegated_home" '
  $1 == "HOST_HOME" { print "HOST_HOME=" replacement; next }
  { print }
' "$fixture/.env" >"$fixture/.env.portal-home"
mv "$fixture/.env.portal-home" "$fixture/.env"
delegated_legacy=$delegated_home/.config/systemd/user/deepseek-harness-after-network.service.d/10-project-path.conf
mkdir -p "$(dirname "$delegated_legacy")"
{
  echo '[Service]'
  echo 'ExecStart='
  echo 'ExecStart=/bin/sh -c '\''. "$1"'\'' /old/checkout/scripts/start-after-network.sh /old/checkout/start-after-network.sh'
} >"$delegated_legacy"
TEST_UPDATE_DELEGATED=1
TEST_SERVICE_PORTAL_HOST_HOME=$delegated_home
run_update "$fixture" --external-ollama
unset TEST_UPDATE_DELEGATED TEST_SERVICE_PORTAL_HOST_HOME
if [ "$update_status" -ne 0 ]; then
  sed -n '1,200p' "$fixture/output.log" >&2
  fail "delegated host-home update failed"
fi
assert_status "$fixture" 'state=ok'
assert_status "$fixture" 'exit_code=0'
assert_status "$fixture" 'boot_service=warning:bus-unreachable'
delegated_unit=$delegated_home/.config/systemd/user/deepseek-harness-after-network.service
[ -f "$delegated_unit" ] \
  || fail "delegated update did not install the user unit into the mounted host home"
[ ! -e "$delegated_legacy" ] \
  || fail "delegated host-home install did not migrate the exact legacy drop-in"
grep -Fxq "ExecStart=$fixture/start-after-network.sh" "$delegated_unit" \
  || fail "delegated update installed a non-direct or incorrect ExecStart"
[ "$(readlink "$delegated_home/.config/systemd/user/default.target.wants/deepseek-harness-after-network.service")" = ../deepseek-harness-after-network.service ] \
  || fail "delegated update did not preserve default.target enablement"
grep -Fq 'Removed recognized legacy drop-in' "$fixture/output.log" \
  || fail "delegated update did not report the legacy migration"
[ ! -e "$fixture/home/.config/systemd/user/deepseek-harness-after-network.service" ] \
  || fail "delegated update installed the unit into its ephemeral HOME"

make_fixture boot-activation-failure matching
{
  echo '#!/bin/sh'
  echo 'if [ "${1:-}" = --defer-activation ]; then'
  echo '  echo boot_service=unchanged'
  echo '  exit 0'
  echo 'fi'
  echo 'echo boot_service=warning:installer-failed'
  echo 'exit 1'
} >"$fixture/scripts/install-boot-service.sh"
chmod +x "$fixture/scripts/install-boot-service.sh"
run_update "$fixture" --external-ollama
[ "$update_status" -eq 24 ] \
  || fail "required boot-service activation failure exited $update_status instead of 24"
assert_status "$fixture" 'state=failed'
assert_status "$fixture" 'exit_code=24'
assert_status "$fixture" 'failure_type=boot-service'
assert_status "$fixture" 'failure_stage=boot-service-activation'
assert_status "$fixture" 'boot_service=warning:installer-failed'
assert_status "$fixture" 'recovery=succeeded'

external_prefix="compose --env-file $fixture/.env -f $fixture/compose.yaml -f $fixture/compose.external-ollama.yaml"
config_line=$(line_number "$external_prefix config --quiet" "$fixture/docker.log")
pull_line=$(line_number "$external_prefix pull --ignore-buildable" "$fixture/docker.log")
build_line=$(line_number "$external_prefix build" "$fixture/docker.log")
deploy_line=$(line_number 'deploy --external-ollama --no-build' "$fixture/docker.log")
[ "$config_line" -lt "$pull_line" ] \
  && [ "$pull_line" -lt "$build_line" ] \
  && [ "$build_line" -lt "$deploy_line" ] \
  || fail "Compose validation, pull, build, and deployment ordering is unsafe"
if grep -Eq '(^| )stop( |$)|(^| )down( |$)' "$fixture/docker.log"; then
  fail "successful update explicitly stopped or removed the project"
fi
if grep -Eq '(^| )prune( |$)|^(rm|kill|restart|stop) |^container (rm|kill|restart|stop) ' "$fixture/docker.log"; then
  fail "successful update used a global cleanup or unrelated-container operation"
fi

make_fixture git-state-failure matching
TEST_GIT_DIRTY=' M config/settings.yaml'
run_update "$fixture" --external-ollama
unset TEST_GIT_DIRTY
[ "$update_status" -ne 0 ] || fail "dirty Git state unexpectedly passed"
assert_status "$fixture" 'failure_type=git-state'
assert_no_fetch_or_mutation "$fixture"
[ ! -e "$fixture/data/update-and-restart.lock" ] \
  || fail "dirty-worktree refusal left its lock behind"

make_fixture wrong-branch matching
TEST_GIT_BRANCH=feature
run_update "$fixture" --external-ollama
unset TEST_GIT_BRANCH
[ "$update_status" -ne 0 ] || fail "unexpected branch was accepted"
assert_status "$fixture" 'failure_type=git-state'
assert_no_fetch_or_mutation "$fixture"

make_fixture wrong-upstream matching
TEST_GIT_MERGE_REF=refs/heads/release
run_update "$fixture" --external-ollama
unset TEST_GIT_MERGE_REF
[ "$update_status" -ne 0 ] || fail "unexpected upstream was accepted"
assert_status "$fixture" 'failure_type=git-state'
assert_no_fetch_or_mutation "$fixture"

make_fixture wrong-tracking-remote matching
TEST_GIT_REMOTE=upstream
run_update "$fixture" --external-ollama
unset TEST_GIT_REMOTE
[ "$update_status" -ne 0 ] || fail "unexpected tracking remote was accepted"
assert_status "$fixture" 'failure_type=git-state'
assert_no_fetch_or_mutation "$fixture"

make_fixture wrong-origin matching
TEST_GIT_ORIGIN_URL=https://github.com/example/dsh-container.git
run_update "$fixture" --external-ollama
unset TEST_GIT_ORIGIN_URL
[ "$update_status" -ne 0 ] || fail "unexpected origin was accepted"
assert_status "$fixture" 'failure_type=git-state'
assert_no_fetch_or_mutation "$fixture"

make_fixture detached-head matching
TEST_GIT_DETACHED=1
run_update "$fixture" --external-ollama
unset TEST_GIT_DETACHED
[ "$update_status" -ne 0 ] || fail "detached HEAD was accepted"
assert_status "$fixture" 'failure_type=git-state'
assert_no_fetch_or_mutation "$fixture"

make_fixture non-fast-forward matching
TEST_GIT_MERGE_BASE_EXIT=1
run_update "$fixture" --external-ollama
unset TEST_GIT_MERGE_BASE_EXIT
[ "$update_status" -ne 0 ] || fail "non-fast-forward update was accepted"
assert_status "$fixture" 'failure_type=git-state'
grep -Fq 'fetch --prune origin main' "$fixture/git.log" \
  || fail "non-fast-forward test did not fetch first"
if grep -Fq 'merge --ff-only' "$fixture/git.log"; then
  fail "non-fast-forward update reached merge"
fi
assert_no_interruption "$fixture"

make_fixture mode-inference-failure matching
{
  printf '%s\n' 'DSH_DEPLOYMENT_MODE='
  printf 'HOST_UID=%s\n' "$(id -u)"
  printf 'HOST_GID=%s\n' "$(id -g)"
} >"$fixture/.env"
run_update "$fixture"
[ "$update_status" -ne 0 ] || fail "unknown deployment mode unexpectedly passed"
assert_status "$fixture" 'failure_type=deployment-mode-inference'

make_fixture missing-mode-entry matching
{
  printf 'HOST_UID=%s\n' "$(id -u)"
  printf 'HOST_GID=%s\n' "$(id -g)"
} >"$fixture/.env"
TEST_COMPOSE_LABELS="$fixture/compose.yaml,$fixture/compose.remote-ollama.yaml"
run_update "$fixture"
unset TEST_COMPOSE_LABELS
[ "$update_status" -ne 0 ] || fail "missing deployment-mode entry unexpectedly passed"
assert_status "$fixture" 'failure_type=deployment-mode-inference'
grep -Fq 'found 0 entries' "$fixture/output.log" \
  || fail "missing deployment-mode diagnostic was not reported"

make_fixture duplicate-mode-entry matching
{
  printf '%s\n' 'DSH_DEPLOYMENT_MODE=remote'
  printf '%s\n' 'DSH_DEPLOYMENT_MODE=remote'
  printf 'HOST_UID=%s\n' "$(id -u)"
  printf 'HOST_GID=%s\n' "$(id -g)"
} >"$fixture/.env"
TEST_COMPOSE_LABELS="$fixture/compose.yaml,$fixture/compose.remote-ollama.yaml"
run_update "$fixture"
unset TEST_COMPOSE_LABELS
[ "$update_status" -ne 0 ] || fail "duplicate deployment-mode entries unexpectedly passed"
assert_status "$fixture" 'failure_type=deployment-mode-inference'
grep -Fq 'found 2 entries' "$fixture/output.log" \
  || fail "duplicate deployment-mode diagnostic was not reported"

make_fixture explicit-mode-conflict matching
TEST_COMPOSE_LABELS="$fixture/compose.yaml,$fixture/compose.remote-ollama.yaml"
run_update "$fixture" --remote-ollama
unset TEST_COMPOSE_LABELS
[ "$update_status" -ne 0 ] || fail "explicit mode bypassed label/.env conflict"
assert_status "$fixture" 'failure_type=deployment-mode-inference'

make_fixture portable-base-label matching
{
  printf '%s\n' 'DSH_DEPLOYMENT_MODE=remote'
  printf 'HOST_UID=%s\n' "$(id -u)"
  printf 'HOST_GID=%s\n' "$(id -g)"
} >"$fixture/.env"
TEST_COMPOSE_LABELS="$fixture/compose.yaml"
run_update "$fixture"
unset TEST_COMPOSE_LABELS
[ "$update_status" -eq 0 ] || fail "base-only Compose labels were not inferred as remote mode"
grep -Fq 'deploy --remote-ollama --no-build' "$fixture/docker.log" \
  || fail "base-only Compose labels did not preserve remote mode"

make_fixture explicit-external-label matching
TEST_COMPOSE_LABELS="$fixture/compose.yaml,$fixture/compose.external-ollama.yaml"
run_update "$fixture"
unset TEST_COMPOSE_LABELS
[ "$update_status" -eq 0 ] || fail "external overlay labels were not inferred as external mode"
grep -Fq 'deploy --external-ollama --no-build' "$fixture/docker.log" \
  || fail "external overlay labels did not preserve external mode"

make_fixture conflicting-overlay-labels matching
TEST_COMPOSE_LABELS="$fixture/compose.yaml,$fixture/compose.external-ollama.yaml,$fixture/compose.remote-ollama.yaml"
run_update "$fixture"
unset TEST_COMPOSE_LABELS
[ "$update_status" -ne 0 ] || fail "conflicting external and remote overlays were accepted"
assert_status "$fixture" 'failure_type=deployment-mode-inference'

make_fixture docker-failure matching
TEST_DOCKER_INFO_EXIT=1
run_update "$fixture" --external-ollama
unset TEST_DOCKER_INFO_EXIT
[ "$update_status" -ne 0 ] || fail "unavailable Docker Engine unexpectedly passed"
assert_status "$fixture" 'failure_type=docker-compose'
assert_no_fetch_or_mutation "$fixture"

make_fixture git-prerequisite-failure matching
TEST_GIT_VERSION_EXIT=1
run_update "$fixture" --external-ollama
unset TEST_GIT_VERSION_EXIT
[ "$update_status" -ne 0 ] || fail "unusable Git unexpectedly passed"
assert_status "$fixture" 'failure_type=git-state'
assert_status "$fixture" 'failure_stage=prerequisites'
assert_no_fetch_or_mutation "$fixture"

make_fixture compose-prerequisite-failure matching
TEST_COMPOSE_VERSION_EXIT=1
run_update "$fixture" --external-ollama
unset TEST_COMPOSE_VERSION_EXIT
[ "$update_status" -ne 0 ] || fail "missing Compose plugin unexpectedly passed"
assert_status "$fixture" 'failure_type=docker-compose'
assert_status "$fixture" 'failure_stage=prerequisites'
assert_no_fetch_or_mutation "$fixture"

make_fixture docker-command-missing matching
missing_docker_bin=$fixture/no-docker-bin
mkdir "$missing_docker_bin"
for utility in sh dirname mkdir mktemp date chmod mv rm rmdir
do
  ln -s "$(command -v "$utility")" "$missing_docker_bin/$utility"
done
cp "$fixture/fake-bin/git" "$missing_docker_bin/git"
# As in run_update: a deployment DSH_HOME would trigger the delegation path.
set +e
PATH="$missing_docker_bin" \
  DSH_HOME= \
  FAKE_GIT_LOG="$fixture/git.log" \
  sh "$fixture/scripts/update-and-restart.sh" --external-ollama \
    >"$fixture/output.log" 2>&1
update_status=$?
set -e
[ "$update_status" -ne 0 ] || fail "missing Docker command unexpectedly passed"
assert_status "$fixture" 'failure_type=docker-compose'
assert_status "$fixture" 'failure_stage=prerequisites'
grep -Fq 'docker is required.' "$fixture/output.log" \
  || fail "missing Docker command diagnostic was not reported"
[ ! -e "$fixture/data/update-and-restart.lock" ] \
  || fail "missing Docker command left its lock behind"

make_fixture compose-validation-failure matching
TEST_COMPOSE_CONFIG_EXIT=1
run_update "$fixture" --external-ollama
unset TEST_COMPOSE_CONFIG_EXIT
[ "$update_status" -ne 0 ] || fail "invalid Compose configuration unexpectedly passed"
assert_status "$fixture" 'failure_type=docker-compose'
assert_status "$fixture" 'failure_stage=compose-configuration'
assert_no_interruption "$fixture"
if grep -Eq '(^| )pull( |$)|(^| )build( |$)|^deploy ' "$fixture/docker.log"; then
  fail "invalid Compose configuration reached image preparation or deployment"
fi

make_fixture container-image-inventory matching
TEST_COMPOSE_CONTAINER_ID=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
TEST_CONTAINER_IMAGE_ID=sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
run_update "$fixture" --external-ollama
unset TEST_COMPOSE_CONTAINER_ID TEST_CONTAINER_IMAGE_ID
[ "$update_status" -eq 0 ] || fail "container-based image inventory blocked maintenance"
[ "$(grep -Fc "inspect cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc --format {{.Image}}" "$fixture/docker.log")" -eq 2 ] \
  || fail "updater did not inventory deployed image IDs from containers before and after deployment"
if grep -Fq ' images -q' "$fixture/docker.log"; then
  fail "updater still depends on Compose image-store resolution for deployed image inventory"
fi

make_fixture container-image-inventory-failure matching
TEST_COMPOSE_CONTAINER_ID=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
TEST_CONTAINER_IMAGE_ID=sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
TEST_CONTAINER_IMAGE_INSPECT_EXIT=1
run_update "$fixture" --external-ollama
unset TEST_COMPOSE_CONTAINER_ID TEST_CONTAINER_IMAGE_ID TEST_CONTAINER_IMAGE_INSPECT_EXIT
[ "$update_status" -ne 0 ] || fail "uninspectable deployed container image unexpectedly passed inventory"
assert_status "$fixture" 'failure_stage=compose-configuration'
if grep -Eq '(^| )pull( |$)|(^| )build( |$)|^deploy ' "$fixture/docker.log"; then
  fail "failed container image inventory reached image preparation or deployment"
fi

make_fixture pull-failure matching
TEST_COMPOSE_PULL_EXIT=1
run_update "$fixture" --external-ollama
unset TEST_COMPOSE_PULL_EXIT
[ "$update_status" -ne 0 ] || fail "failed image pull unexpectedly passed"
assert_status "$fixture" 'failure_stage=compose-image-pull'
assert_status "$fixture" 'recovery=not-needed'
if grep -Eq '(^| )build( |$)|^deploy |(^| )start( |$)' "$fixture/docker.log"; then
  fail "failed pull reached build, deployment, or recovery"
fi

make_fixture build-failure matching
TEST_COMPOSE_BUILD_EXIT=1
run_update "$fixture" --external-ollama
unset TEST_COMPOSE_BUILD_EXIT
[ "$update_status" -ne 0 ] || fail "failed image build unexpectedly passed"
assert_status "$fixture" 'failure_stage=compose-image-build'
assert_status "$fixture" 'recovery=not-needed'
grep -Fq ' pull --ignore-buildable' "$fixture/docker.log" \
  || fail "build failure did not occur after pull"
if grep -Eq '^deploy |(^| )start( |$)' "$fixture/docker.log"; then
  fail "failed build reached deployment or recovery"
fi

for mode_mapping in \
  'external --external-ollama' \
  'remote --remote-ollama' \
  'managed --managed-ollama'
do
  selected_mode=${mode_mapping%% *}
  selected_flag=${mode_mapping#* }
  make_fixture "mode-$selected_mode" matching
  {
    printf 'DSH_DEPLOYMENT_MODE=%s\n' "$selected_mode"
    printf 'HOST_UID=%s\n' "$(id -u)"
    printf 'HOST_GID=%s\n' "$(id -g)"
  } >"$fixture/.env"
  run_update "$fixture" "$selected_flag"
  [ "$update_status" -eq 0 ] || fail "$selected_mode mode update failed"
  case "$selected_mode" in
    external)
      expected_prefix="compose --env-file $fixture/.env -f $fixture/compose.yaml -f $fixture/compose.external-ollama.yaml"
      ;;
    remote)
      expected_prefix="compose --env-file $fixture/.env -f $fixture/compose.yaml -f $fixture/compose.remote-ollama.yaml"
      ;;
    managed)
      expected_prefix="compose --env-file $fixture/.env -f $fixture/compose.yaml -f $fixture/compose.managed-ollama.yaml"
      ;;
  esac
  grep -Fq "$expected_prefix config --quiet" "$fixture/docker.log" \
    || fail "$selected_mode mode used incorrect Compose files or env file"
  grep -Fq "$expected_prefix pull --ignore-buildable" "$fixture/docker.log" \
    || fail "$selected_mode mode pull used incorrect Compose files or env file"
  grep -Fq "$expected_prefix build" "$fixture/docker.log" \
    || fail "$selected_mode mode build used incorrect Compose files or env file"
  grep -Fq "deploy $selected_flag --no-build" "$fixture/docker.log" \
    || fail "$selected_mode mode deployed without the selected overlay mode"
done

make_fixture locked-project matching
mkdir "$fixture/data/update-and-restart.lock"
printf '%s\n' 99999 >"$fixture/data/update-and-restart.lock/pid"
run_update "$fixture" --external-ollama
[ "$update_status" -ne 0 ] || fail "concurrent maintenance lock was ignored"
[ -e "$fixture/data/update-and-restart.lock/pid" ] \
  || fail "lock refusal removed another maintenance run's lock"
[ ! -s "$fixture/git.log" ] && [ ! -s "$fixture/docker.log" ] \
  || fail "lock refusal invoked Git or Docker"

make_fixture active-process-lock matching
mkdir "$fixture/data/update-and-restart.lock"
printf '%s\n' "$$" >"$fixture/data/update-and-restart.lock/pid"
{
  echo 'schema=1'
  echo 'kind=process'
  echo "pid=$$"
} >"$fixture/data/update-and-restart.lock/owner"
run_update "$fixture" --external-ollama
[ "$update_status" -ne 0 ] || fail "active process maintenance lock was ignored"
[ -e "$fixture/data/update-and-restart.lock/owner" ] \
  || fail "active process lock refusal removed its owner record"

make_fixture stale-process-lock matching
mkdir "$fixture/data/update-and-restart.lock"
printf '%s\n' 99999999 >"$fixture/data/update-and-restart.lock/pid"
{
  echo 'schema=1'
  echo 'kind=process'
  echo 'pid=99999999'
} >"$fixture/data/update-and-restart.lock/owner"
run_update "$fixture" --external-ollama
[ "$update_status" -eq 0 ] || fail "stale process maintenance lock was not recovered"
grep -Fq 'Reclaimed an interrupted maintenance lock' "$fixture/output.log" \
  || fail "stale process lock recovery was not reported"
[ ! -e "$fixture/data/update-and-restart.lock" ] \
  || fail "recovered process update left a lock behind"

container_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
replacement_id=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
make_fixture active-container-lock matching
mkdir "$fixture/data/update-and-restart.lock"
printf '%s\n' 7 >"$fixture/data/update-and-restart.lock/pid"
{
  echo 'schema=1'
  echo 'kind=container'
  echo 'pid=7'
  echo 'container_name=service-portal-update-deepseek-harness-active'
  echo "container_id=$container_id"
  echo 'portal_job_id=active-job'
} >"$fixture/data/update-and-restart.lock/owner"
TEST_UPDATE_CONTAINER_NAME=service-portal-update-deepseek-harness-active
TEST_LOCK_CONTAINER_ID=$container_id
run_update "$fixture" --external-ollama
unset TEST_UPDATE_CONTAINER_NAME TEST_LOCK_CONTAINER_ID
[ "$update_status" -ne 0 ] || fail "active container maintenance lock was ignored"
[ -e "$fixture/data/update-and-restart.lock/owner" ] \
  || fail "active container lock refusal removed its owner record"

make_fixture replaced-container-lock matching
mkdir "$fixture/data/update-and-restart.lock"
printf '%s\n' 7 >"$fixture/data/update-and-restart.lock/pid"
{
  echo 'schema=1'
  echo 'kind=container'
  echo 'pid=7'
  echo 'container_name=service-portal-update-deepseek-harness-reused'
  echo "container_id=$container_id"
  echo 'portal_job_id=interrupted-job'
} >"$fixture/data/update-and-restart.lock/owner"
TEST_UPDATE_CONTAINER_NAME=service-portal-update-deepseek-harness-reused
TEST_SERVICE_PORTAL_JOB_ID=replacement-job
TEST_LOCK_CONTAINER_ID=$replacement_id
run_update "$fixture" --external-ollama
unset TEST_UPDATE_CONTAINER_NAME TEST_SERVICE_PORTAL_JOB_ID TEST_LOCK_CONTAINER_ID
[ "$update_status" -eq 0 ] || fail "lock from a replaced maintenance container was not recovered"
grep -Fq 'Reclaimed an interrupted maintenance lock' "$fixture/output.log" \
  || fail "replaced container lock recovery was not reported"
[ ! -e "$fixture/data/update-and-restart.lock" ] \
  || fail "recovered container update left a lock behind"

for mapping in \
  '20 docker-compose' \
  '21 configuration-verification' \
  '22 model-provider-or-credential' \
  '23 application-health' \
  '24 boot-service'
do
  exit_code=${mapping%% *}
  expected_type=${mapping#* }
  make_fixture "deploy-$exit_code" matching
  TEST_DEPLOY_EXIT=$exit_code
  run_update "$fixture" --external-ollama
  unset TEST_DEPLOY_EXIT
  [ "$update_status" -eq "$exit_code" ] \
    || fail "deploy exit $exit_code was returned as $update_status"
  assert_status "$fixture" "failure_type=$expected_type"
  assert_status "$fixture" 'recovery=succeeded'
  deploy_line=$(line_number "deploy --external-ollama --no-build" "$fixture/docker.log")
  recovery_line=$(line_number ' start' "$fixture/docker.log")
  [ "$deploy_line" -lt "$recovery_line" ] \
    || fail "deploy exit $exit_code attempted recovery before deployment"
  [ ! -e "$fixture/data/update-and-restart.lock" ] \
    || fail "deploy exit $exit_code left its lock behind"
done

make_fixture failed-recovery matching
TEST_DEPLOY_EXIT=20
TEST_COMPOSE_START_EXIT=1
run_update "$fixture" --external-ollama
unset TEST_DEPLOY_EXIT TEST_COMPOSE_START_EXIT
[ "$update_status" -eq 20 ] || fail "failed recovery changed the deployment failure exit"
assert_status "$fixture" 'recovery=failed'

echo "ok - updater preflights, ordering, modes, locking, recovery, and scoped cleanup are safe"
