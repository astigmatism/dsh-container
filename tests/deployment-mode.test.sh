#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_root=$(CDPATH= cd -- "$test_dir/.." && pwd)
recorder=$source_root/scripts/record-deployment-mode.py
temporary_root=$(mktemp -d)
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM

expected_uid=$(id -u)
expected_gid=$(id -g)

fail() {
  echo "not ok - $*" >&2
  exit 1
}

file_mode() {
  case "$(uname -s)" in
    Darwin) stat -f '%Lp' "$1" ;;
    *) stat -c '%a' "$1" ;;
  esac
}

file_uid() {
  case "$(uname -s)" in
    Darwin) stat -f '%u' "$1" ;;
    *) stat -c '%u' "$1" ;;
  esac
}

file_gid() {
  case "$(uname -s)" in
    Darwin) stat -f '%g' "$1" ;;
    *) stat -c '%g' "$1" ;;
  esac
}

mode_count() {
  awk -F= '$1 == "DSH_DEPLOYMENT_MODE" { count++ } END { print count + 0 }' "$1"
}

mode_value() {
  awk -F= '$1 == "DSH_DEPLOYMENT_MODE" { print substr($0, index($0, "=") + 1); exit }' "$1"
}

make_env() {
  fixture_name=$1
  initial_mode=$2
  fixture=$temporary_root/$fixture_name
  mkdir -p "$fixture"
  mkdir -p "$fixture/scripts"
  cp "$source_root/scripts/gateway-credentials.py" "$fixture/scripts/"
  {
    printf '%s\n' 'PRESERVED_PREFIX=unchanged'
    printf '%s\n' 'HARNESS_AUTH_USERNAME=fixture-user' 'HARNESS_AUTH_PASSWORD=fixture-password'
    if [ "$initial_mode" != missing ]; then
      printf 'DSH_DEPLOYMENT_MODE=%s\n' "$initial_mode"
    fi
    printf 'HOST_UID=%s\n' "$expected_uid"
    printf 'HOST_GID=%s\n' "$expected_gid"
    printf '%s' 'PRESERVED_SUFFIX=unchanged'
  } >"$fixture/.env"
  chmod 0600 "$fixture/.env"
}

run_recorder() {
  fixture_path=$1
  requested_mode=$2
  set +e
  "$recorder" --env-file "$fixture_path/.env" "$requested_mode" \
    >"$fixture_path/output.log" 2>&1
  recorder_status=$?
  set -e
}

assert_remote_env() {
  fixture_path=$1
  [ "$(mode_count "$fixture_path/.env")" -eq 1 ] \
    || fail "deployment mode is not unique"
  [ "$(mode_value "$fixture_path/.env")" = remote ] \
    || fail "deployment mode is not remote"
  [ "$(file_mode "$fixture_path/.env")" = 600 ] \
    || fail ".env mode was not preserved as 0600"
  [ "$(file_uid "$fixture_path/.env")" = "$expected_uid" ] \
    || fail ".env owner changed"
  [ "$(file_gid "$fixture_path/.env")" = "$expected_gid" ] \
    || fail ".env group changed"
  grep -Fxq 'PRESERVED_PREFIX=unchanged' "$fixture_path/.env" \
    || fail ".env prefix changed"
  grep -Fxq 'PRESERVED_SUFFIX=unchanged' "$fixture_path/.env" \
    || fail ".env suffix changed"
}

write_boot_installer() {
  fixture_path=$1
  installer_status=${2:-0}
  {
    printf '%s\n' '#!/bin/sh'
    printf 'exit %s\n' "$installer_status"
  } >"$fixture_path/scripts/install-boot-service.sh"
  chmod +x "$fixture_path/scripts/install-boot-service.sh"
}

make_env missing-mode missing
run_recorder "$fixture" remote
[ "$recorder_status" -eq 0 ] || fail "missing deployment mode was not recorded"
assert_remote_env "$fixture"

make_env blank-mode ''
run_recorder "$fixture" remote
[ "$recorder_status" -eq 0 ] || fail "blank deployment mode was not recorded"
assert_remote_env "$fixture"

make_env matching-mode remote
matching_before=$(cksum "$fixture/.env")
run_recorder "$fixture" remote
[ "$recorder_status" -eq 0 ] || fail "matching deployment mode was rejected"
[ "$matching_before" = "$(cksum "$fixture/.env")" ] \
  || fail "matching deployment mode rewrote .env"

make_env conflicting-mode external
conflicting_before=$(cksum "$fixture/.env")
run_recorder "$fixture" remote
[ "$recorder_status" -ne 0 ] || fail "conflicting deployment mode was overwritten"
[ "$conflicting_before" = "$(cksum "$fixture/.env")" ] \
  || fail "conflicting .env was modified"

make_env duplicate-mode remote
printf '\n%s\n' 'DSH_DEPLOYMENT_MODE=remote' >>"$fixture/.env"
duplicate_before=$(cksum "$fixture/.env")
run_recorder "$fixture" remote
[ "$recorder_status" -ne 0 ] || fail "duplicate deployment mode was accepted"
[ "$duplicate_before" = "$(cksum "$fixture/.env")" ] \
  || fail "duplicate .env was modified"

make_env wrong-mode-metadata missing
chmod 0644 "$fixture/.env"
wrong_metadata_before=$(cksum "$fixture/.env")
run_recorder "$fixture" remote
[ "$recorder_status" -ne 0 ] || fail "wrong .env mode was accepted"
[ "$wrong_metadata_before" = "$(cksum "$fixture/.env")" ] \
  || fail "wrong-mode .env was modified"

make_env symlink-env missing
mv "$fixture/.env" "$fixture/real.env"
ln -s real.env "$fixture/.env"
symlink_before=$(cksum "$fixture/real.env")
run_recorder "$fixture" remote
[ "$recorder_status" -ne 0 ] || fail "symlinked .env was accepted"
[ "$symlink_before" = "$(cksum "$fixture/real.env")" ] \
  || fail "symlink target was modified"

echo "ok - legacy deployment-mode recording preserves credentials and rejects conflicting state"
