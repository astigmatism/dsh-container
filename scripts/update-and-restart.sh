#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
env_file=$project_dir/.env
mode=
dry_run=0
deployment_started=0
before_commit=unknown
target_commit=unknown
branch=unknown
failure_type=none
failure_stage=initialization
recovery=not-needed
boot_service=not-run
lock_dir=$project_dir/data/update-and-restart.lock
status_file=$project_dir/data/maintenance-status
resume_file=$lock_dir/resume
owner_file=$lock_dir/owner
resume=${DSH_UPDATE_RESUME:-0}
resume_temporary=
pin_temporary=
unset DSH_UPDATE_RESUME
export GIT_TERMINAL_PROMPT=0

legacy_dsh_version=0.1.1-rc.2
legacy_harness_image=local/deepseek-harness:0.1.1-rc.2-portable
current_dsh_version=0.1.5-alpha.1
current_upstream_commit=5dda764ed3aa172535a7967b06ff95d9cbfe536a
current_harness_image=local/deepseek-harness:0.1.5-alpha.1-portable

case "$resume" in
  0|1) ;;
  *) echo "Invalid internal maintenance resume state." >&2; exit 2 ;;
esac

usage() {
  cat <<'EOF'
usage: ./scripts/update-and-restart.sh [mode] [--dry-run]

Modes:
  --external-ollama   join an existing local Ollama-router network
  --remote-ollama     route directly to REMOTE_OLLAMA_HOST (no local router)
  --managed-ollama    update the managed Ollama/router stack too

With no mode flag, the script uses the running container's Compose labels and
the required DSH_DEPLOYMENT_MODE from .env. It refuses missing, empty,
duplicated, invalid, or conflicting mode state. It requires clean main tracking
canonical origin/main, checks persisted settings before fetching and again
under the fetched updater after fast-forwarding. Runtime settings are preserved
when they differ from repository defaults. It validates Compose and
pulls/builds replacement images while the deployment remains available before
recreating the project and verifying it. In remote mode, deploy.sh removes only
the obsolete deepseek-harness/ai-router container after direct-route
verification and retains its image and data. The updater removes only
superseded images captured from this project and creates no backup, archive,
stash, rollback tag, or rollback directory.
Required boot-service files are converged before fetch; an unavailable host
home is blocking, while an unavailable user systemd bus defers only activation.
EOF
}

requested_dry_run=0
for argument do
  [ "$argument" = --dry-run ] && requested_dry_run=1
done

get_env() {
  [ -f "$env_file" ] || return 0
  awk -F= -v wanted="$1" '$1 == wanted { print substr($0, index($0, "=") + 1); exit }' "$env_file"
}

record_host_home() {
  resolved_home=$1
  case "$resolved_home" in
    /|""|*:*|*=*)
      echo "Refusing a host home that cannot be represented safely in Compose metadata: $resolved_home" >&2
      return 1
      ;;
  esac
  home_count=$(awk -F= '$1 == "HOST_HOME" { count++ } END { print count + 0 }' "$env_file")
  [ "$home_count" -le 1 ] || {
    echo "HOST_HOME must occur at most once in .env; found $home_count entries." >&2
    return 1
  }
  configured_home=$(get_env HOST_HOME)
  if [ -n "$configured_home" ] && [ "$configured_home" != "$resolved_home" ]; then
    echo "Configured HOST_HOME ($configured_home) does not match the maintenance home ($resolved_home)." >&2
    return 1
  fi
  [ "$configured_home" = "$resolved_home" ] && return 0
  if [ "$dry_run" -eq 1 ]; then
    echo "Host home:  would record $resolved_home for delegated Service Portal updates"
    return 0
  fi
  home_temporary=$(mktemp "$project_dir/.env.host-home.XXXXXX")
  awk -v replacement="$resolved_home" '
    BEGIN { found = 0 }
    $0 ~ /^HOST_HOME=/ { print "HOST_HOME=" replacement; found = 1; next }
    { print }
    END { if (!found) print "HOST_HOME=" replacement }
  ' "$env_file" >"$home_temporary"
  chmod 0600 "$home_temporary"
  mv "$home_temporary" "$env_file"
  echo "Recorded host home for delegated Service Portal maintenance: $resolved_home"
}

converge_boot_service() {
  convergence_phase=$1
  failure_type=boot-service
  failure_stage=boot-service-$convergence_phase

  if [ "${DSH_UPDATE_DELEGATED:-0}" = 1 ]; then
    install_home=${DSH_BOOT_SERVICE_HOME:-${SERVICE_PORTAL_UPDATE_HOST_HOME:-}}
  else
    install_home=${HOME:-}
  fi
  case "$install_home" in
    /|"")
      boot_service=warning:host-home-unavailable
      echo "Boot-service convergence requires the deploying user's host home; no safe installation home is available." >&2
      return 1
      ;;
    /*) ;;
    *)
      boot_service=warning:host-home-unavailable
      echo "Boot-service convergence requires an absolute host-home path; got: $install_home" >&2
      return 1
      ;;
  esac
  if [ ! -d "$install_home" ]; then
    boot_service=warning:host-home-unavailable
    echo "Boot-service convergence cannot inspect the unavailable host home: $install_home" >&2
    return 1
  fi
  if [ "$convergence_phase" = preflight ]; then
    record_host_home "$install_home" || return 1
    HOST_HOME=$install_home
    export HOST_HOME
  fi
  if [ ! -x "$script_dir/install-boot-service.sh" ]; then
    boot_service=warning:installer-missing
    echo "Required boot-service installer is missing or not executable: $script_dir/install-boot-service.sh" >&2
    return 1
  fi

  installer_argument=
  if [ "$convergence_phase" = preflight ]; then
    if [ "$dry_run" -eq 1 ]; then
      installer_argument=--dry-run
    else
      installer_argument=--defer-activation
    fi
  fi
  if [ -n "$installer_argument" ]; then
    if boot_output=$(HOME="$install_home" DSH_BOOT_SERVICE_HOME="$install_home" \
      "$script_dir/install-boot-service.sh" "$installer_argument" 2>&1); then
      installer_status=0
    else
      installer_status=$?
    fi
  elif boot_output=$(HOME="$install_home" DSH_BOOT_SERVICE_HOME="$install_home" \
    "$script_dir/install-boot-service.sh" 2>&1); then
    installer_status=0
  else
    installer_status=$?
  fi
  if [ -n "$boot_output" ]; then
    printf '%s\n' "$boot_output"
  fi
  recorded_boot_service=$(printf '%s\n' "$boot_output" | grep '^boot_service=' | tail -n 1 || true)
  if [ -n "$recorded_boot_service" ]; then
    boot_service=${recorded_boot_service#boot_service=}
  else
    boot_service=warning:installer-failed
  fi

  if [ "$installer_status" -ne 0 ]; then
    return "$installer_status"
  fi
  case "$boot_service" in
    installed|updated|unchanged|started|dry-run|warning:bus-unreachable) return 0 ;;
    warning:host-home-unavailable|*)
      echo "Boot-service installer did not report successful on-disk convergence: $boot_service" >&2
      return 1
      ;;
  esac
}

migrate_upstream_pins() {
  version_count=$(awk -F= '$1 == "DSH_VERSION" { count++ } END { print count + 0 }' "$env_file")
  commit_count=$(awk -F= '$1 == "DSH_UPSTREAM_COMMIT" { count++ } END { print count + 0 }' "$env_file")
  image_count=$(awk -F= '$1 == "HARNESS_IMAGE" { count++ } END { print count + 0 }' "$env_file")
  if [ "$version_count" -gt 1 ] || [ "$commit_count" -gt 1 ] || [ "$image_count" -gt 1 ]; then
    echo "Refusing to migrate duplicate Harness provenance keys in .env." >&2
    return 1
  fi

  configured_version=$(get_env DSH_VERSION)
  configured_commit=$(get_env DSH_UPSTREAM_COMMIT)
  configured_image=$(get_env HARNESS_IMAGE)
  case "$configured_version" in
    ""|"$legacy_dsh_version"|"$current_dsh_version") ;;
    *) echo "Preserving custom DSH_VERSION/HARNESS_IMAGE pins; automatic upstream migration was not applied." >&2; return 0 ;;
  esac
  case "$configured_commit" in
    ""|"$current_upstream_commit") ;;
    *) echo "Preserving custom DSH_VERSION/HARNESS_IMAGE pins; automatic upstream migration was not applied." >&2; return 0 ;;
  esac
  case "$configured_image" in
    ""|"$legacy_harness_image"|"$current_harness_image") ;;
    *) echo "Preserving custom DSH_VERSION/HARNESS_IMAGE pins; automatic upstream migration was not applied." >&2; return 0 ;;
  esac

  if [ "$configured_version" != "$legacy_dsh_version" ] \
    && [ "$configured_image" != "$legacy_harness_image" ]; then
    return 0
  fi
  if [ "$dry_run" -eq 1 ]; then
    echo "Pins:       exact legacy Harness pins will migrate to DSH $current_dsh_version (upstream $current_upstream_commit)"
    return 0
  fi

  pin_temporary=$(mktemp "$project_dir/.env.upstream-migration.XXXXXX")
  awk \
    -v legacy_version="$legacy_dsh_version" \
    -v current_version="$current_dsh_version" \
    -v legacy_image="$legacy_harness_image" \
    -v current_image="$current_harness_image" \
    -v current_commit="$current_upstream_commit" '
      BEGIN { saw_commit = 0; migrated_version = 0 }
      $0 == "DSH_VERSION=" legacy_version {
        print "DSH_VERSION=" current_version
        migrated_version = 1
        next
      }
      $0 == "HARNESS_IMAGE=" legacy_image {
        print "HARNESS_IMAGE=" current_image
        next
      }
      $0 ~ /^DSH_UPSTREAM_COMMIT=/ { saw_commit = 1 }
      { print }
      END {
        if (migrated_version && !saw_commit) print "DSH_UPSTREAM_COMMIT=" current_commit
      }
    ' "$env_file" >"$pin_temporary"
  chmod 0600 "$pin_temporary"
  mv "$pin_temporary" "$env_file"
  pin_temporary=
  echo "Migrated exact legacy Harness pins to DSH $current_dsh_version (upstream $current_upstream_commit)."
}

delegate_from_harness() {
  helper_image=${HOST_EXEC_IMAGE:-$(get_env HARNESS_IMAGE)}
  [ -n "$helper_image" ] || helper_image=local/deepseek-harness:0.1.5-alpha.1-portable
  docker_gid=$(stat -c '%g' /var/run/docker.sock)
  maintenance_name=deepseek-harness-maintenance-$(date -u +%Y%m%d%H%M%S)-$$

  # Mount the host home (at its real path) into the maintenance container so
  # the post-deployment boot-service step can install the user unit there.
  # The harness container carries the host /etc/passwd. The user systemd bus
  # stays on the host; the installer degrades to installing the files and
  # printing the activation commands.
  host_home=
  host_uid=$(get_env HOST_UID)
  case "$host_uid" in
    ''|*[!0-9]*) ;;
    *)
      if command -v getent >/dev/null 2>&1; then
        host_home=$(getent passwd "$host_uid" 2>/dev/null \
          | awk -F: -v wanted="$host_uid" '$3 == wanted { print $6; exit }')
      fi
      ;;
  esac
  workspace_root=${HARNESS_WORKSPACE_ROOT:-/host}
  host_workspace=$(get_env HOST_FILESYSTEM_SOURCE)
  [ -n "$host_workspace" ] || host_workspace=/
  [ "$workspace_root" = / ] || workspace_root=${workspace_root%/}
  [ "$host_workspace" = / ] || host_workspace=${host_workspace%/}

  case "$workspace_root:$host_workspace" in
    /*:/*) ;;
    *)
      echo "Cannot delegate maintenance: host filesystem source and container target must both be absolute paths." >&2
      return 1
      ;;
  esac

  if [ "$workspace_root" = / ]; then
    project_relative=$project_dir
  else
    case "$project_dir" in
      "$workspace_root") project_relative= ;;
      "$workspace_root"/*) project_relative=${project_dir#"$workspace_root"} ;;
      *)
        echo "Cannot delegate maintenance: checkout $project_dir is not below the host-filesystem view $workspace_root." >&2
        return 1
        ;;
    esac
  fi
  if [ "$host_workspace" = / ]; then
    host_project_dir=${project_relative:-/}
  else
    host_project_dir=$host_workspace$project_relative
  fi

  # A bind source passed with --volume may be silently created by Docker when
  # it does not exist. Verify that passwd supplied an absolute, non-root home
  # inside the configured host-filesystem view, then use --mount so Docker
  # itself also refuses a missing source.
  visible_host_home=
  case "$host_home" in
    /|*','*) host_home= ;;
    /*)
      if [ "$host_workspace" = / ]; then
        home_relative=$host_home
      else
        case "$host_home" in
          "$host_workspace") home_relative= ;;
          "$host_workspace"/*) home_relative=${host_home#"$host_workspace"} ;;
          *) host_home= ;;
        esac
      fi
      if [ -n "$host_home" ]; then
        if [ "$workspace_root" = / ]; then
          visible_host_home=${home_relative:-/}
        else
          visible_host_home=$workspace_root$home_relative
        fi
        if [ ! -d "$visible_host_home" ]; then
          host_home=
        fi
      fi
      ;;
    *) host_home= ;;
  esac

  case "$host_home" in
    /*)
    # Both bind sources are host-native paths. Docker resolves them in the
    # daemon's mount namespace, not through the harness container's workspace
    # view (which may be /host or a same-path mount).
    maintenance_id=$(docker run --detach --rm --init \
      --name "$maintenance_name" \
      --pull=never \
      --user "$(id -u):$(id -g)" \
      --group-add "$docker_gid" \
      --env DSH_UPDATE_DELEGATED=1 \
      --env DSH_UPDATE_CONTAINER_NAME="$maintenance_name" \
      --env HOME=/tmp \
      --mount "type=bind,source=$host_home,target=$host_home" \
      --env "DSH_BOOT_SERVICE_HOME=$host_home" \
      --volume /var/run/docker.sock:/var/run/docker.sock \
      --volume "$host_project_dir:$host_project_dir" \
      --workdir "$host_project_dir" \
      --entrypoint /bin/sh \
      "$helper_image" \
      ./scripts/update-and-restart.sh "$@")
      ;;
    *)
    echo "Warning: delegated maintenance could not safely resolve the configured host user's home; the helper will record a blocking boot-service failure before fetch." >&2
    maintenance_id=$(docker run --detach --rm --init \
      --name "$maintenance_name" \
      --pull=never \
      --user "$(id -u):$(id -g)" \
      --group-add "$docker_gid" \
      --env DSH_UPDATE_DELEGATED=1 \
      --env DSH_UPDATE_CONTAINER_NAME="$maintenance_name" \
      --env HOME=/tmp \
      --volume /var/run/docker.sock:/var/run/docker.sock \
      --volume "$host_project_dir:$host_project_dir" \
      --workdir "$host_project_dir" \
      --entrypoint /bin/sh \
      "$helper_image" \
      ./scripts/update-and-restart.sh "$@")
      ;;
  esac

  short_id=$(printf '%.12s' "$maintenance_id")
  echo "Maintenance handed off to $maintenance_name ($short_id)."
  echo "This Harness session will disconnect when its container stops; the detached updater will continue."
  echo "After Harness returns, inspect $status_file for the final result."
}

if [ "${DSH_UPDATE_DELEGATED:-0}" != 1 ] \
  && [ "$requested_dry_run" -ne 1 ] \
  && [ -f /.dockerenv ] \
  && [ "${DSH_HOME:-}" = /data/dsh ] \
  && [ -S /var/run/docker.sock ]; then
  delegate_from_harness "$@"
  exit 0
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --external-ollama) mode=external ;;
    --remote-ollama) mode=remote ;;
    --managed-ollama) mode=managed ;;
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
requested_mode=$mode

if [ "$resume" -eq 1 ] && [ "$dry_run" -eq 1 ]; then
  echo "Maintenance resume cannot be combined with --dry-run." >&2
  exit 2
fi

git_repo() { git -c "safe.directory=$project_dir" -C "$project_dir" "$@"; }

write_status() {
  state=$1
  exit_code=$2
  reported_failure=none
  if [ "$state" = failed ]; then
    reported_failure=$failure_type
  fi
  temporary=$(mktemp "$project_dir/data/.maintenance-status.XXXXXX")
  {
    echo "state=$state"
    echo "updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "mode=${mode:-unknown}"
    echo "branch=${branch:-unknown}"
    echo "from_commit=$before_commit"
    echo "target_commit=$target_commit"
    echo "exit_code=$exit_code"
    echo "failure_type=$reported_failure"
    echo "failure_stage=$failure_stage"
    echo "recovery=$recovery"
    echo "boot_service=$boot_service"
  } >"$temporary"
  chmod 0600 "$temporary"
  mv "$temporary" "$status_file"
}

lock_field() {
  field_file=$1
  field_name=$2
  awk -F= -v wanted="$field_name" '$1 == wanted { print substr($0, index($0, "=") + 1); exit }' "$field_file"
}

write_lock_owner() {
  owner_temporary=$(mktemp "$project_dir/data/.update-lock-owner.XXXXXX")
  owner_kind=process
  owner_container_name=
  owner_container_id=
  if [ -n "${DSH_UPDATE_CONTAINER_NAME:-}" ]; then
    case "$DSH_UPDATE_CONTAINER_NAME" in
      *[!A-Za-z0-9_.-]*|'')
        echo "Refusing an unsafe maintenance container identity." >&2
        rm -f "$owner_temporary"
        return 1
        ;;
    esac
    if ! command -v docker >/dev/null 2>&1; then
      echo "Cannot record maintenance ownership because Docker is unavailable." >&2
      rm -f "$owner_temporary"
      return 1
    fi
    owner_container_name=$DSH_UPDATE_CONTAINER_NAME
    owner_container_id=$(docker inspect "$owner_container_name" --format '{{.Id}}' 2>/dev/null || true)
    case "$owner_container_id" in
      ''|*[!0-9a-f]*)
        echo "Cannot verify maintenance container $owner_container_name." >&2
        rm -f "$owner_temporary"
        return 1
        ;;
    esac
    owner_kind=container
  fi
  {
    echo 'schema=1'
    echo "kind=$owner_kind"
    echo "pid=$$"
    if [ "$owner_kind" = container ]; then
      echo "container_name=$owner_container_name"
      echo "container_id=$owner_container_id"
      echo "portal_job_id=${SERVICE_PORTAL_UPDATE_JOB_ID:-}"
    fi
  } >"$owner_temporary"
  chmod 0600 "$owner_temporary"
  mv "$owner_temporary" "$owner_file"
}

lock_owner_is_stale() {
  [ -f "$owner_file" ] || return 1
  [ "$(lock_field "$owner_file" schema)" = 1 ] || return 1
  owner_kind=$(lock_field "$owner_file" kind)
  owner_pid=$(lock_field "$owner_file" pid)
  case "$owner_pid" in ''|*[!0-9]*) return 1 ;; esac
  case "$owner_kind" in
    process)
      if kill -0 "$owner_pid" 2>/dev/null; then
        return 1
      fi
      # kill -0 also fails with EPERM. Treat any independently visible PID as
      # live so a differently owned updater can never be reclaimed as stale.
      [ -d "/proc/$owner_pid" ] && return 1
      if command -v ps >/dev/null 2>&1 \
        && ps -p "$owner_pid" -o pid= 2>/dev/null | grep -Eq '[0-9]'; then
        return 1
      fi
      return 0
      ;;
    container)
      owner_container_name=$(lock_field "$owner_file" container_name)
      owner_container_id=$(lock_field "$owner_file" container_id)
      case "$owner_container_name" in ''|*[!A-Za-z0-9_.-]*) return 1 ;; esac
      case "$owner_container_id" in ''|*[!0-9a-f]*) return 1 ;; esac
      command -v docker >/dev/null 2>&1 || return 1
      live_owner=$(docker inspect "$owner_container_name" \
        --format '{{.Id}} {{.State.Running}}' 2>/dev/null || true)
      [ "$live_owner" = "$owner_container_id true" ] && return 1
      return 0
      ;;
    *) return 1 ;;
  esac
}

lock_owned_by_current_run() {
  [ -f "$owner_file" ] || return 1
  [ "$(lock_field "$owner_file" schema)" = 1 ] || return 1
  [ "$(lock_field "$owner_file" pid)" = "$$" ] || return 1
  if [ -n "${DSH_UPDATE_CONTAINER_NAME:-}" ]; then
    [ "$(lock_field "$owner_file" kind)" = container ] || return 1
    [ "$(lock_field "$owner_file" container_name)" = "$DSH_UPDATE_CONTAINER_NAME" ] || return 1
    current_container_id=$(docker inspect "$DSH_UPDATE_CONTAINER_NAME" \
      --format '{{.Id}}' 2>/dev/null || true)
    [ -n "$current_container_id" ] \
      && [ "$(lock_field "$owner_file" container_id)" = "$current_container_id" ]
    return
  fi
  [ "$(lock_field "$owner_file" kind)" = process ]
}

reclaim_stale_lock() {
  stale_lock=$project_dir/data/update-and-restart.lock.stale.$$
  for lock_entry in "$lock_dir"/* "$lock_dir"/.[!.]* "$lock_dir"/..?*; do
    [ -e "$lock_entry" ] || continue
    case "$lock_entry" in
      "$lock_dir/pid"|"$lock_dir/resume"|"$lock_dir/owner") ;;
      *)
        echo "Refusing to reclaim a maintenance lock containing an unknown entry: $lock_entry" >&2
        return 1
        ;;
    esac
    [ -f "$lock_entry" ] || {
      echo "Refusing to reclaim a maintenance lock containing a non-file entry: $lock_entry" >&2
      return 1
    }
  done
  if ! mv "$lock_dir" "$stale_lock" 2>/dev/null; then
    return 1
  fi
  rm -f "$stale_lock/pid" "$stale_lock/resume" "$stale_lock/owner"
  if ! rmdir "$stale_lock"; then
    echo "Could not remove the validated stale maintenance lock." >&2
    return 1
  fi
  echo "Reclaimed an interrupted maintenance lock whose recorded owner is no longer running."
  mkdir "$lock_dir" 2>/dev/null
}

finish() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    if [ "$deployment_started" -eq 1 ]; then
      echo "Maintenance failed after Compose began deployment; attempting to start the existing project containers." >&2
      recovery=attempted
      if compose start >&2; then
        recovery=succeeded
      else
        recovery=failed
      fi
    fi
    write_status failed "$status" || true
  fi
  if [ -n "$resume_temporary" ]; then
    rm -f "$resume_temporary"
  fi
  if [ -n "$pin_temporary" ]; then
    rm -f "$pin_temporary"
  fi
  rm -f "$lock_dir/pid" "$resume_file" "$owner_file"
  rmdir "$lock_dir" 2>/dev/null || true
  exit "$status"
}

if [ "$dry_run" -ne 1 ]; then
  mkdir -p "$project_dir/data"
  if [ "$resume" -eq 1 ]; then
    if [ ! -f "$lock_dir/pid" ] \
      || [ "$(cat "$lock_dir/pid" 2>/dev/null || true)" != "$$" ] \
      || [ ! -f "$resume_file" ]; then
      echo "Refusing an invalid maintenance resume; the original lock is not owned by this process." >&2
      exit 1
    fi
    # Updaters predating schema 1 transfer only pid/resume. Upgrade that
    # same-process lock during exec so existing installations can update.
    if [ ! -f "$owner_file" ] && ! write_lock_owner; then
      echo "Could not upgrade the transferred maintenance lock ownership." >&2
      exit 1
    fi
    if ! lock_owned_by_current_run; then
      echo "Refusing an invalid maintenance resume owner." >&2
      exit 1
    fi
  else
    if ! mkdir "$lock_dir" 2>/dev/null; then
      if ! lock_owner_is_stale || ! reclaim_stale_lock; then
        echo "Another maintenance run may be active: $lock_dir" >&2
        exit 1
      fi
    fi
    printf '%s\n' "$$" >"$lock_dir/pid"
    if ! write_lock_owner; then
      rm -f "$lock_dir/pid" "$owner_file"
      rmdir "$lock_dir" 2>/dev/null || true
      exit 1
    fi
  fi
  trap finish EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ "$resume" -eq 1 ]; then
    before_commit=$(awk -F= '$1 == "from_commit" { print $2; exit }' "$resume_file")
    target_commit=$(awk -F= '$1 == "target_commit" { print $2; exit }' "$resume_file")
    resume_mode=$(awk -F= '$1 == "mode" { print $2; exit }' "$resume_file")
    if [ -z "$before_commit" ] || [ -z "$target_commit" ] || [ -z "$resume_mode" ]; then
      echo "Refusing an invalid maintenance resume record." >&2
      exit 1
    fi
  fi
  write_status running 0
fi

failure_type=git-state
failure_stage=prerequisites
command -v git >/dev/null 2>&1 || { echo "git is required." >&2; exit 1; }
git --version >/dev/null 2>&1 || { echo "git is installed but unusable." >&2; exit 1; }

failure_type=docker-compose
command -v docker >/dev/null 2>&1 || { echo "docker is required." >&2; exit 1; }
if ! docker compose version >/dev/null 2>&1; then
  echo "The Docker Compose plugin is required." >&2
  exit 1
fi

failure_type=configuration-verification
[ -f "$env_file" ] || { echo "Missing .env; run ./scripts/configure.sh first." >&2; exit 1; }

failure_type=docker-compose
failure_stage=docker-engine
if ! docker info >/dev/null 2>&1; then
  echo "Docker Engine is unavailable." >&2
  exit 1
fi

failure_type=deployment-mode-inference
failure_stage=deployment-mode
config_files=$(docker inspect deepseek-harness \
  --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' 2>/dev/null || true)
case "$config_files" in
  *compose.external-ollama.yaml*compose.remote-ollama.yaml*|*compose.remote-ollama.yaml*compose.external-ollama.yaml*|\
  *compose.external-ollama.yaml*compose.managed-ollama.yaml*|*compose.managed-ollama.yaml*compose.external-ollama.yaml*|\
  *compose.managed-ollama.yaml*compose.remote-ollama.yaml*|*compose.remote-ollama.yaml*compose.managed-ollama.yaml*)
    echo "Running Compose labels contain conflicting deployment overlays." >&2
    exit 2
    ;;
  *compose.managed-ollama.yaml*) label_mode=managed ;;
  *compose.external-ollama.yaml*) label_mode=external ;;
  *compose.remote-ollama.yaml*) label_mode=remote ;;
  *compose.yaml*) label_mode=remote ;;
  *) label_mode= ;;
esac

mode_entry_count=$(awk -F= '$1 == "DSH_DEPLOYMENT_MODE" { count++ } END { print count + 0 }' "$env_file")
if [ "$mode_entry_count" -ne 1 ]; then
  echo "DSH_DEPLOYMENT_MODE must occur exactly once in .env; found $mode_entry_count entries." >&2
  exit 2
fi
env_mode=$(get_env DSH_DEPLOYMENT_MODE)
case "$env_mode" in
  external|remote|managed) ;;
  *) echo "Invalid or empty DSH_DEPLOYMENT_MODE in .env." >&2; exit 2 ;;
esac
if [ -n "$label_mode" ] && [ "$label_mode" != "$env_mode" ]; then
  echo "Running Compose labels indicate $label_mode mode but .env records $env_mode mode." >&2
  exit 2
fi
if [ -n "$requested_mode" ] && [ "$requested_mode" != "$env_mode" ]; then
  echo "Requested $requested_mode mode but .env records $env_mode mode." >&2
  exit 2
fi
mode=${requested_mode:-${label_mode:-$env_mode}}
case "$mode" in
  external|remote|managed) ;;
  *) echo "Invalid deployment mode: $mode" >&2; exit 2 ;;
esac
if [ "$resume" -eq 1 ] && [ "$mode" != "$resume_mode" ]; then
  echo "Refusing maintenance because the resumed deployment mode changed from $resume_mode to $mode." >&2
  exit 1
fi

case "$mode" in
  external)
    mode_flag=--external-ollama
    compose_files="-f $project_dir/compose.yaml -f $project_dir/compose.external-ollama.yaml"
    ;;
  remote)
    mode_flag=--remote-ollama
    compose_files="-f $project_dir/compose.yaml -f $project_dir/compose.remote-ollama.yaml"
    ;;
  managed)
    mode_flag=--managed-ollama
    compose_files="-f $project_dir/compose.yaml -f $project_dir/compose.managed-ollama.yaml"
    ;;
esac

# Paths are controlled by this script and contain no whitespace in the normal
# clone layout. Splitting compose_files is intentional for POSIX sh.
# shellcheck disable=SC2086
compose() { docker compose --env-file "$env_file" $compose_files "$@"; }

failure_type=git-state
failure_stage=git-state
branch=$(git_repo symbolic-ref --quiet --short HEAD 2>/dev/null || true)
[ -n "$branch" ] || { echo "The repository must be on a branch, not detached HEAD." >&2; exit 1; }
remote=$(git_repo config --get "branch.$branch.remote" || true)
merge_ref=$(git_repo config --get "branch.$branch.merge" || true)
case "$merge_ref" in
  refs/heads/*) remote_branch=${merge_ref#refs/heads/} ;;
  *) echo "Branch $branch has no normal upstream branch." >&2; exit 1 ;;
esac
[ -n "$remote" ] && [ "$remote" != . ] || {
  echo "Branch $branch has no remote upstream." >&2
  exit 1
}

if [ "$branch" != main ] || [ "$remote" != origin ] || [ "$remote_branch" != main ]; then
  echo "Maintenance requires clean main tracking origin/main; found $branch tracking $remote/$remote_branch." >&2
  exit 1
fi

origin_url=$(git_repo remote get-url origin 2>/dev/null || true)
case "$origin_url" in
  https://github.com/astigmatism/dsh-container|\
  https://github.com/astigmatism/dsh-container.git|\
  git@github.com:astigmatism/dsh-container|\
  git@github.com:astigmatism/dsh-container.git|\
  ssh://git@github.com/astigmatism/dsh-container|\
  ssh://git@github.com/astigmatism/dsh-container.git) ;;
  *)
    echo "Refusing maintenance because origin is not the canonical dsh-container repository." >&2
    exit 1
    ;;
esac

dirty=$(git_repo status --porcelain)
current_commit=$(git_repo rev-parse HEAD)
if [ "$resume" -eq 1 ]; then
  if [ "$current_commit" != "$target_commit" ]; then
    echo "Refusing maintenance because HEAD changed before the fetched updater resumed." >&2
    echo "Expected: $target_commit" >&2
    echo "Current:  $current_commit" >&2
    exit 1
  fi
else
  before_commit=$current_commit
fi
if [ -n "$dirty" ]; then
  echo "Refusing to update a dirty repository. Commit or remove these changes first:" >&2
  printf '%s\n' "$dirty" >&2
  exit 1
fi

failure_type=configuration-verification
if [ "$resume" -eq 1 ]; then
  failure_stage=preflight-merged-settings
else
  failure_stage=preflight-current-settings
fi
if ! "$script_dir/verify-persisted-settings.sh"; then
  if [ "$resume" -eq 1 ]; then
    echo "Configuration preflight failed after fast-forward and before service interruption." >&2
  else
    echo "Configuration preflight failed before any fetch or service interruption." >&2
  fi
  exit 1
fi

if ! converge_boot_service preflight; then
  if [ "$resume" -eq 1 ]; then
    echo "Required boot-service convergence failed after fast-forward and before rebuild or service changes." >&2
  else
    echo "Required boot-service convergence failed before fetch, rebuild, or service changes." >&2
  fi
  exit 1
fi

if [ "$dry_run" -eq 1 ] || [ "$resume" -eq 1 ]; then
  failure_type=configuration-verification
  failure_stage=upstream-pin-migration
  migrate_upstream_pins
fi

if [ "$dry_run" -eq 1 ]; then
  echo "Repository: $project_dir"
  echo "Branch:     $branch -> $remote/$remote_branch"
  echo "Commit:     $before_commit"
  echo "Mode:       $mode"
  echo "Worktree:   clean"
  echo "Settings:   non-empty runtime configuration with service ownership and secure mode"
  echo "Plan:       fetch/fast-forward, revalidate with fetched updater, migrate exact legacy Harness pins, pull/build, deploy, verify, remove superseded project images"
  echo "Rollback:   no backups or rollback artifacts will be created"
  exit 0
fi

if [ "$resume" -ne 1 ]; then
  failure_type=git-state
  failure_stage=fetch
  write_status running 0
  echo "Fetching $remote/$remote_branch while the current deployment remains available..."
  git_repo fetch --prune "$remote" "$remote_branch"
  target_commit=$(git_repo rev-parse FETCH_HEAD)
  write_status running 0

  if ! git_repo merge-base --is-ancestor "$before_commit" "$target_commit"; then
    echo "Refusing a non-fast-forward update; local and remote history differ." >&2
    echo "Local:  $before_commit" >&2
    echo "Remote: $target_commit" >&2
    exit 1
  fi

  failure_type=git-state
  failure_stage=fast-forward
  git_repo merge --ff-only "$target_commit"

  resume_temporary=$(mktemp "$lock_dir/.resume.XXXXXX")
  {
    echo "from_commit=$before_commit"
    echo "target_commit=$target_commit"
    echo "mode=$mode"
  } >"$resume_temporary"
  chmod 0600 "$resume_temporary"
  mv "$resume_temporary" "$resume_file"
  resume_temporary=

  failure_stage=updater-resume
  write_status running 0
  echo "Restarting maintenance under the fetched updater before service interruption..."
  export DSH_UPDATE_RESUME=1
  exec "$script_dir/update-and-restart.sh" "$mode_flag"
  echo "Could not restart maintenance under the fetched updater." >&2
  exit 1
fi

failure_type=docker-compose
failure_stage=compose-configuration
if ! compose config --quiet; then
  echo "Docker Compose configuration validation failed before service interruption." >&2
  exit 1
fi
if ! old_image_ids=$(compose images -q 2>/dev/null); then
  echo "Docker Compose could not capture the currently deployed images." >&2
  exit 1
fi
old_image_ids=$(printf '%s\n' "$old_image_ids" | sort -u)

echo "Pulling non-buildable images while the $mode deployment remains available..."
failure_stage=compose-image-pull
if ! compose pull --ignore-buildable; then
  echo "Docker Compose could not pull replacement runtime images; the current deployment remains unchanged." >&2
  exit 1
fi

echo "Building replacement images while the $mode deployment remains available..."
failure_stage=compose-image-build
if ! compose build; then
  echo "Docker Compose could not build replacement images; the current deployment remains available." >&2
  exit 1
fi

echo "Deploying and verifying commit $(git_repo rev-parse --short HEAD)..."
failure_stage=compose-deploy
deployment_started=1
set +e
DSH_BOOT_SERVICE_MANAGED_BY_UPDATER=1 "$script_dir/deploy.sh" "$mode_flag" --no-build
deploy_status=$?
set -e
if [ "$deploy_status" -ne 0 ]; then
  case "$deploy_status" in
    20)
      failure_type=docker-compose
      failure_stage=compose-deploy
      ;;
    21)
      failure_type=configuration-verification
      failure_stage=deployment-verification
      ;;
    22)
      failure_type=model-provider-or-credential
      failure_stage=model-provider-verification
      ;;
    23)
      failure_type=application-health
      failure_stage=application-health-verification
      ;;
    24)
      failure_type=boot-service
      failure_stage=boot-service-deployment
      ;;
    *)
      failure_type=docker-compose
      failure_stage=compose-deploy
      ;;
  esac
  exit "$deploy_status"
fi

if ! converge_boot_service activation; then
  echo "Deployment succeeded, but required boot-service activation/convergence failed." >&2
  exit 24
fi
deployment_started=0

failure_type=docker-compose
failure_stage=image-inventory
if ! new_image_ids=$(compose images -q 2>/dev/null); then
  echo "Docker Compose could not capture the newly deployed images." >&2
  exit 1
fi
new_image_ids=$(printf '%s\n' "$new_image_ids" | sort -u)
obsolete_image_ids=
for image_id in $old_image_ids; do
  if ! printf '%s\n' "$new_image_ids" | grep -Fxq "$image_id"; then
    obsolete_image_ids="$obsolete_image_ids $image_id"
  fi
done

remove_obsolete_images() {
  for image_id in $obsolete_image_ids; do
    if docker image rm "$image_id" >/dev/null 2>&1; then
      echo "Removed superseded project image ${image_id#sha256:}."
    else
      echo "Retained superseded image ${image_id#sha256:}; another container still uses it." >&2
    fi
  done
}

if [ -n "$obsolete_image_ids" ] && [ "${DSH_UPDATE_DELEGATED:-0}" = 1 ]; then
  cleanup_image=$(get_env HARNESS_IMAGE)
  [ -n "$cleanup_image" ] || cleanup_image=local/deepseek-harness:0.1.5-alpha.1-portable
  docker_gid=$(stat -c '%g' /var/run/docker.sock)
  cleanup_name=deepseek-harness-image-cleanup-$(date -u +%Y%m%d%H%M%S)-$$
  # This helper uses the newly deployed image, waits for the updater container
  # to remove itself, then deletes only image IDs made obsolete by this run.
  # shellcheck disable=SC2086
  docker run --detach --rm --init \
    --name "$cleanup_name" \
    --pull=never \
    --user "$(id -u):$(id -g)" \
    --group-add "$docker_gid" \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --entrypoint /bin/sh \
    "$cleanup_image" -eu -c '
      updater=$1
      shift
      while docker inspect "$updater" >/dev/null 2>&1; do sleep 1; done
      for image_id do docker image rm "$image_id" >/dev/null 2>&1 || true; done
    ' cleanup "${DSH_UPDATE_CONTAINER_NAME:?missing updater container name}" $obsolete_image_ids >/dev/null
else
  remove_obsolete_images
fi

target_commit=$(git_repo rev-parse HEAD)
failure_type=none
failure_stage=complete
write_status ok 0
echo "Maintenance complete: $before_commit -> $target_commit ($mode mode)."
echo "No backup or rollback artifacts were created."
