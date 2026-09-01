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
lock_dir=$project_dir/data/update-and-restart.lock
status_file=$project_dir/data/maintenance-status
resume_file=$lock_dir/resume
resume=${DSH_UPDATE_RESUME:-0}
resume_temporary=
unset DSH_UPDATE_RESUME
export GIT_TERMINAL_PROMPT=0

case "$resume" in
  0|1) ;;
  *) echo "Invalid internal maintenance resume state." >&2; exit 2 ;;
esac

usage() {
  cat <<'EOF'
usage: ./scripts/update-and-restart.sh [mode] [--dry-run]

Modes:
  --external-ollama   join an existing local Ollama-router network
  --remote-ollama     use the router at REMOTE_OLLAMA_HOST
  --managed-ollama    update the managed Ollama/router stack too

With no mode flag, the script uses the running container's Compose labels and
the required DSH_DEPLOYMENT_MODE from .env. It refuses missing, empty,
duplicated, invalid, or conflicting mode state. It requires clean main tracking
canonical origin/main, checks persisted settings before fetching and again
against the fetched target, then fast-forwards. It validates Compose and
pulls/builds replacement images while the deployment remains available before
recreating the project and verifying it. It removes only superseded images
captured from this project and creates no backup, archive, stash, rollback tag,
or rollback directory.
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

delegate_from_harness() {
  helper_image=${HOST_EXEC_IMAGE:-$(get_env HARNESS_IMAGE)}
  [ -n "$helper_image" ] || helper_image=local/deepseek-harness:0.1.1-rc.2-portable
  docker_gid=$(stat -c '%g' /var/run/docker.sock)
  maintenance_name=deepseek-harness-maintenance-$(date -u +%Y%m%d%H%M%S)-$$

  maintenance_id=$(docker run --detach --rm --init \
    --name "$maintenance_name" \
    --pull=never \
    --user "$(id -u):$(id -g)" \
    --group-add "$docker_gid" \
    --env DSH_UPDATE_DELEGATED=1 \
    --env DSH_UPDATE_CONTAINER_NAME="$maintenance_name" \
    --env HOME=/tmp \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume "$project_dir:$project_dir" \
    --workdir "$project_dir" \
    --entrypoint /bin/sh \
    "$helper_image" \
    ./scripts/update-and-restart.sh "$@")

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
  } >"$temporary"
  chmod 0600 "$temporary"
  mv "$temporary" "$status_file"
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
  rm -f "$lock_dir/pid" "$resume_file"
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
  elif ! mkdir "$lock_dir" 2>/dev/null; then
    echo "Another maintenance run may be active: $lock_dir" >&2
    exit 1
  fi
  if [ "$resume" -ne 1 ]; then
    printf '%s\n' "$$" >"$lock_dir/pid"
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
  *compose.managed-ollama.yaml*compose.remote-ollama.yaml*|*compose.remote-ollama.yaml*compose.managed-ollama.yaml*)
    echo "Running Compose labels contain both managed and remote overlays." >&2
    exit 2
    ;;
  *compose.managed-ollama.yaml*) label_mode=managed ;;
  *compose.remote-ollama.yaml*) label_mode=remote ;;
  *compose.yaml*) label_mode=external ;;
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
    compose_files="-f $project_dir/compose.yaml"
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

if [ "$dry_run" -eq 1 ]; then
  echo "Repository: $project_dir"
  echo "Branch:     $branch -> $remote/$remote_branch"
  echo "Commit:     $before_commit"
  echo "Mode:       $mode"
  echo "Worktree:   clean"
  echo "Settings:   match current canonical configuration"
  echo "Plan:       fetch/check target settings/fast-forward, validate, pull/build, deploy, verify, remove superseded project images"
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

  failure_type=configuration-verification
  failure_stage=preflight-target-settings
  target_settings_object=$(git_repo rev-parse "$target_commit:config/settings.yaml" 2>/dev/null || true)
  runtime_settings_object=$(git_repo hash-object "$project_dir/data/dsh/settings.yaml" 2>/dev/null || true)
  if [ -z "$target_settings_object" ] || [ -z "$runtime_settings_object" ] \
    || [ "$target_settings_object" != "$runtime_settings_object" ]; then
    echo "Persisted settings do not match config/settings.yaml in the fetched target." >&2
    echo "Maintenance will not merge or interrupt services; an explicit configuration decision is required." >&2
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
"$script_dir/deploy.sh" "$mode_flag" --no-build
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
    *)
      failure_type=docker-compose
      failure_stage=compose-deploy
      ;;
  esac
  exit "$deploy_status"
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
  [ -n "$cleanup_image" ] || cleanup_image=local/deepseek-harness:0.1.1-rc.2-portable
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
