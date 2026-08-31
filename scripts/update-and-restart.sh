#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
env_file=$project_dir/.env
mode=
dry_run=0
stack_stopped=0
before_commit=unknown
target_commit=unknown
lock_dir=$project_dir/data/update-and-restart.lock
status_file=$project_dir/data/maintenance-status

usage() {
  cat <<'EOF'
usage: ./scripts/update-and-restart.sh [mode] [--dry-run]

Modes:
  --external-ollama   join an existing local Ollama-router network
  --remote-ollama     use the router at REMOTE_OLLAMA_HOST
  --managed-ollama    update the managed Ollama/router stack too

With no mode flag, the script uses the running container's Compose labels,
then DSH_DEPLOYMENT_MODE from .env, then external mode. It fast-forwards the
current tracking branch, stops the selected stack, rebuilds/redeploys it,
verifies it, and removes only superseded images captured from this project.
It creates no backup, archive, stash, rollback tag, or rollback directory.
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

command -v git >/dev/null 2>&1 || { echo "git is required." >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required." >&2; exit 1; }
[ -f "$env_file" ] || { echo "Missing .env; run ./scripts/configure.sh first." >&2; exit 1; }

if [ -z "$mode" ]; then
  config_files=$(docker inspect deepseek-harness \
    --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' 2>/dev/null || true)
  case "$config_files" in
    *compose.managed-ollama.yaml*) mode=managed ;;
    *compose.remote-ollama.yaml*) mode=remote ;;
  esac
fi
if [ -z "$mode" ]; then
  mode=$(get_env DSH_DEPLOYMENT_MODE)
fi
case "$mode" in
  external|remote|managed) ;;
  '') mode=external ;;
  *) echo "Invalid DSH_DEPLOYMENT_MODE in .env: $mode" >&2; exit 2 ;;
esac

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
git_repo() { git -c "safe.directory=$project_dir" -C "$project_dir" "$@"; }

write_status() {
  state=$1
  exit_code=$2
  temporary=$(mktemp "$project_dir/data/.maintenance-status.XXXXXX")
  {
    echo "state=$state"
    echo "updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "mode=$mode"
    echo "branch=${branch:-unknown}"
    echo "from_commit=$before_commit"
    echo "target_commit=$target_commit"
    echo "exit_code=$exit_code"
  } >"$temporary"
  chmod 0600 "$temporary"
  mv "$temporary" "$status_file"
}

finish() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    write_status failed "$status" || true
    if [ "$stack_stopped" -eq 1 ]; then
      echo "Maintenance failed after the stack stopped; attempting to start the existing containers." >&2
      compose start >&2 || true
    fi
  fi
  rm -f "$lock_dir/pid"
  rmdir "$lock_dir" 2>/dev/null || true
  exit "$status"
}

if [ "$dry_run" -ne 1 ]; then
  mkdir -p "$project_dir/data"
  if ! mkdir "$lock_dir" 2>/dev/null; then
    echo "Another maintenance run may be active: $lock_dir" >&2
    exit 1
  fi
  printf '%s\n' "$$" >"$lock_dir/pid"
  trap finish EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  write_status running 0
fi

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

dirty=$(git_repo status --porcelain)
before_commit=$(git_repo rev-parse HEAD)
if [ "$dry_run" -eq 1 ]; then
  echo "Repository: $project_dir"
  echo "Branch:     $branch -> $remote/$remote_branch"
  echo "Commit:     $before_commit"
  echo "Mode:       $mode"
  if [ -z "$dirty" ]; then
    echo "Worktree:   clean"
  else
    echo "Worktree:   dirty (a real maintenance run would refuse)"
  fi
  echo "Plan:       fetch/fast-forward, stop, rebuild, deploy, verify, remove superseded project images"
  echo "Rollback:   no backups or rollback artifacts will be created"
  exit 0
fi

if [ -n "$dirty" ]; then
  echo "Refusing to update a dirty repository. Commit or remove these changes first:" >&2
  printf '%s\n' "$dirty" >&2
  exit 1
fi

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

git_repo merge --ff-only "$target_commit"
"$script_dir/configure.sh"
old_image_ids=$(compose images -q 2>/dev/null | sort -u || true)

echo "Stopping the $mode deployment..."
stack_stopped=1
compose stop

echo "Rebuilding, deploying, and verifying commit $(git_repo rev-parse --short HEAD)..."
"$script_dir/deploy.sh" "$mode_flag"
stack_stopped=0

new_image_ids=$(compose images -q 2>/dev/null | sort -u || true)
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
write_status ok 0
echo "Maintenance complete: $before_commit -> $target_commit ($mode mode)."
echo "No backup or rollback artifacts were created."
