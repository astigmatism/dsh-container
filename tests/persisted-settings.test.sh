#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_root=$(CDPATH= cd -- "$test_dir/.." && pwd)
initializer=$source_root/scripts/initialize-persisted-settings.sh
temporary_root=$(mktemp -d)
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM

expected_uid=$(id -u)
expected_gid=$(id -g)

fail() {
  echo "not ok - $*" >&2
  exit 1
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

file_mode() {
  case "$(uname -s)" in
    Darwin) stat -f '%Lp' "$1" ;;
    *) stat -c '%a' "$1" ;;
  esac
}

assert_canonical_file() {
  fixture_path=$1
  cmp -s "$fixture_path/config/settings.yaml" "$fixture_path/data/dsh/settings.yaml" \
    || fail "persisted settings do not match canonical settings"
  [ "$(file_uid "$fixture_path/data/dsh/settings.yaml")" = "$expected_uid" ] \
    || fail "persisted settings have the wrong service UID"
  [ "$(file_gid "$fixture_path/data/dsh/settings.yaml")" = "$expected_gid" ] \
    || fail "persisted settings have the wrong service GID"
  [ "$(file_mode "$fixture_path/data/dsh/settings.yaml")" = 644 ] \
    || fail "persisted settings do not have mode 0644"
}

make_fixture() {
  fixture_name=$1
  fixture=$temporary_root/$fixture_name
  mkdir -p "$fixture/config" "$fixture/data/dsh"
  cp "$source_root/config/settings.yaml" "$fixture/config/settings.yaml"
  {
    printf 'HOST_UID=%s\n' "$expected_uid"
    printf 'HOST_GID=%s\n' "$expected_gid"
  } >"$fixture/.env"
}

run_initializer() {
  fixture_path=$1
  shift
  set +e
  DSH_ENV_FILE=$fixture_path/.env \
    DSH_CANONICAL_SETTINGS=$fixture_path/config/settings.yaml \
    DSH_RUNTIME_SETTINGS=$fixture_path/data/dsh/settings.yaml \
    "$initializer" "$@" >"$fixture_path/output.log" 2>&1
  initializer_status=$?
  set -e
}

make_fixture missing
run_initializer "$fixture"
[ "$initializer_status" -eq 0 ] || fail "missing settings were not initialized"
assert_canonical_file "$fixture"
grep -Fq 'Initialized missing persisted settings' "$fixture/output.log" \
  || fail "missing-settings state was not reported"

make_fixture empty
: >"$fixture/data/dsh/settings.yaml"
empty_before=$(cksum "$fixture/data/dsh/settings.yaml")
run_initializer "$fixture"
[ "$initializer_status" -ne 0 ] || fail "empty settings were replaced without explicit authorization"
[ "$empty_before" = "$(cksum "$fixture/data/dsh/settings.yaml")" ] \
  || fail "unauthorized empty settings were modified"
grep -Fq 'use --replace-empty explicitly' "$fixture/output.log" \
  || fail "empty-settings authorization diagnostic was not reported"

run_initializer "$fixture" --replace-empty
[ "$initializer_status" -eq 0 ] || fail "explicit empty-placeholder migration failed"
assert_canonical_file "$fixture"
grep -Fq 'Replaced an existing empty persisted-settings placeholder' "$fixture/output.log" \
  || fail "legacy-empty migration was not reported distinctly"

make_fixture divergent
printf '%s\n' 'intentionally-custom: true' >"$fixture/data/dsh/settings.yaml"
divergent_before=$(cksum "$fixture/data/dsh/settings.yaml")
run_initializer "$fixture" --replace-empty
[ "$initializer_status" -ne 0 ] || fail "divergent settings were accepted for replacement"
[ "$divergent_before" = "$(cksum "$fixture/data/dsh/settings.yaml")" ] \
  || fail "divergent settings were modified"
grep -Fq 'will not be overwritten' "$fixture/output.log" \
  || fail "divergent-settings protection was not reported"

run_initializer "$fixture" --replace-empty --preserve-divergent
[ "$initializer_status" -eq 0 ] || fail "entrypoint-compatible divergent preservation failed"
[ "$divergent_before" = "$(cksum "$fixture/data/dsh/settings.yaml")" ] \
  || fail "preserved divergent settings were modified"

make_fixture matching
cp "$fixture/config/settings.yaml" "$fixture/data/dsh/settings.yaml"
chmod 0600 "$fixture/data/dsh/settings.yaml"
run_initializer "$fixture"
[ "$initializer_status" -eq 0 ] || fail "matching settings metadata was not normalized"
assert_canonical_file "$fixture"
grep -Fq 'Normalized matching persisted settings' "$fixture/output.log" \
  || fail "matching metadata correction was not reported"

run_entrypoint() {
  fixture_path=$1
  : >"$fixture_path/dsh.log"
  cp "$source_root/tests/fixtures/deploy-stub.sh" "$fixture_path/profile-sync"
  set +e
  PATH="$source_root/tests/fixtures/settings-bin:$PATH" \
    FAKE_DSH_LOG="$fixture_path/dsh.log" \
    DSH_HOME="$fixture_path/data/dsh" \
    DSH_CANONICAL_SETTINGS="$fixture_path/config/settings.yaml" \
    DSH_RUNTIME_PROFILE_SYNC="$fixture_path/profile-sync" \
    DSH_SETTINGS_INITIALIZER="$initializer" \
    HARNESS_TRUSTED_HOSTS= \
    sh "$source_root/entrypoint.sh" >"$fixture_path/entrypoint.log" 2>&1
  entrypoint_status=$?
  set -e
}

make_fixture fresh-entrypoint
run_entrypoint "$fixture"
[ "$entrypoint_status" -eq 0 ] || fail "fresh entrypoint seeding failed"
assert_canonical_file "$fixture"
grep -Fq 'Initialized missing persisted settings' "$fixture/entrypoint.log" \
  || fail "fresh entrypoint did not classify missing settings"
grep -Fxq 'web --no-open' "$fixture/dsh.log" \
  || fail "fresh entrypoint did not launch DSH"

make_fixture legacy-empty-entrypoint
: >"$fixture/data/dsh/settings.yaml"
chmod 0644 "$fixture/data/dsh/settings.yaml"
run_entrypoint "$fixture"
[ "$entrypoint_status" -eq 0 ] || fail "legacy empty-placeholder entrypoint upgrade failed"
assert_canonical_file "$fixture"
grep -Fq 'Replaced an existing empty persisted-settings placeholder' "$fixture/entrypoint.log" \
  || fail "legacy entrypoint upgrade was not reported"

echo "ok - persisted settings states, metadata, fresh seeding, and legacy-empty upgrade are safe"
