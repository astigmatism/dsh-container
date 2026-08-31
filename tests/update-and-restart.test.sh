#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_root=$(CDPATH= cd -- "$test_dir/.." && pwd)
temporary_root=$(mktemp -d)
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM

fail() {
  echo "not ok - $*" >&2
  exit 1
}

assert_status() {
  fixture_path=$1
  expected=$2
  grep -Fxq "$expected" "$fixture_path/data/maintenance-status" \
    || fail "status missing '$expected'"
}

assert_no_interruption() {
  fixture_path=$1
  if grep -Eq '(^| )stop( |$)|(^| )start( |$)|(^| )up( |$)' "$fixture_path/docker.log"; then
    fail "configuration preflight invoked an interrupting Compose command"
  fi
}

make_fixture() {
  fixture_name=$1
  runtime_kind=$2
  fixture=$temporary_root/$fixture_name
  mkdir -p "$fixture/scripts" "$fixture/config" "$fixture/data/dsh" "$fixture/fake-bin"
  cp "$source_root/scripts/update-and-restart.sh" "$fixture/scripts/"
  cp "$source_root/scripts/verify-persisted-settings.sh" "$fixture/scripts/"
  cp "$source_root/tests/fixtures/deploy-stub.sh" "$fixture/scripts/deploy.sh"
  cp "$source_root/tests/fixtures/update-bin/git" "$fixture/fake-bin/"
  cp "$source_root/tests/fixtures/update-bin/docker" "$fixture/fake-bin/"
  cp "$source_root/config/settings.yaml" "$fixture/config/settings.yaml"
  printf '%s\n' 'DSH_DEPLOYMENT_MODE=external' >"$fixture/.env"
  : >"$fixture/git.log"
  : >"$fixture/docker.log"
  case "$runtime_kind" in
    matching) cp "$fixture/config/settings.yaml" "$fixture/data/dsh/settings.yaml" ;;
    empty) : >"$fixture/data/dsh/settings.yaml" ;;
    mismatched) printf '%s\n' 'models: {}' >"$fixture/data/dsh/settings.yaml" ;;
    *) fail "unknown runtime fixture kind: $runtime_kind" ;;
  esac
}

run_update() {
  fixture_path=$1
  shift
  set +e
  PATH="$fixture_path/fake-bin:$PATH" \
    FAKE_GIT_LOG="$fixture_path/git.log" \
    FAKE_DOCKER_LOG="$fixture_path/docker.log" \
    FAKE_GIT_DIRTY="${TEST_GIT_DIRTY:-}" \
    FAKE_DOCKER_INFO_EXIT="${TEST_DOCKER_INFO_EXIT:-0}" \
    FAKE_COMPOSE_LABELS="${TEST_COMPOSE_LABELS:-}" \
    FAKE_TARGET_SETTINGS_OBJECT="${TEST_TARGET_SETTINGS_OBJECT:-same-settings-object}" \
    FAKE_DEPLOY_EXIT="${TEST_DEPLOY_EXIT:-0}" \
    sh "$fixture_path/scripts/update-and-restart.sh" "$@" \
      >"$fixture_path/output.log" 2>&1
  update_status=$?
  set -e
}

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
[ "$update_status" -ne 0 ] || fail "mismatched settings unexpectedly passed"
assert_status "$fixture" 'failure_type=configuration-verification'
assert_status "$fixture" 'failure_stage=preflight-current-settings'
assert_no_interruption "$fixture"
if grep -Fq 'fetch --prune' "$fixture/git.log"; then
  fail "mismatched settings reached the fetch step"
fi
[ "$mismatch_before" = "$(cksum "$fixture/data/dsh/settings.yaml")" ] \
  || fail "mismatched settings were modified"
grep -Fq 'Persisted settings differ' "$fixture/output.log" \
  || fail "mismatched-settings diagnostic was not reported"

make_fixture target-settings-change matching
TEST_TARGET_SETTINGS_OBJECT=different-settings-object
run_update "$fixture" --external-ollama
unset TEST_TARGET_SETTINGS_OBJECT
[ "$update_status" -ne 0 ] || fail "target settings change unexpectedly passed"
assert_status "$fixture" 'failure_type=configuration-verification'
assert_status "$fixture" 'failure_stage=preflight-target-settings'
assert_no_interruption "$fixture"
grep -Fq 'fetch --prune origin main' "$fixture/git.log" \
  || fail "target-settings test did not fetch"
if grep -Fq 'merge --ff-only' "$fixture/git.log"; then
  fail "target settings mismatch was merged"
fi

make_fixture git-state-failure matching
TEST_GIT_DIRTY=' M config/settings.yaml'
run_update "$fixture" --external-ollama
unset TEST_GIT_DIRTY
[ "$update_status" -ne 0 ] || fail "dirty Git state unexpectedly passed"
assert_status "$fixture" 'failure_type=git-state'

make_fixture mode-inference-failure matching
printf '%s\n' 'DSH_DEPLOYMENT_MODE=' >"$fixture/.env"
run_update "$fixture"
[ "$update_status" -ne 0 ] || fail "unknown deployment mode unexpectedly passed"
assert_status "$fixture" 'failure_type=deployment-mode-inference'

make_fixture docker-failure matching
TEST_DOCKER_INFO_EXIT=1
run_update "$fixture" --external-ollama
unset TEST_DOCKER_INFO_EXIT
[ "$update_status" -ne 0 ] || fail "unavailable Docker Engine unexpectedly passed"
assert_status "$fixture" 'failure_type=docker-compose'

for mapping in \
  '20 docker-compose' \
  '21 configuration-verification' \
  '22 model-provider-or-credential' \
  '23 application-health'
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
done

echo "ok - updater preflight preserves settings, avoids interruption, and classifies failures"
