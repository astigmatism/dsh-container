#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
env_file=$project_dir/.env
force=0
bind_address=127.0.0.1
host_uid=$(id -u)
host_gid=$(id -g)
host_username=$(id -un)
host_workspace=$(getent passwd "$host_uid" 2>/dev/null | awk -F: 'NR == 1 { print $6 }')
if [ -z "$host_workspace" ]; then
  host_workspace=/home/$host_username
fi

usage() {
  cat <<'EOF'
usage: ./scripts/configure.sh [options]

Options:
  --bind-address IP   HTTPS/CA bind address and TLS IP (default: 127.0.0.1)
  --workspace PATH    host workspace mounted at the same absolute path
  --username NAME     gateway username and in-container USER value
  --force             replace an existing .env
  -h, --help          show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bind-address)
      [ "$#" -ge 2 ] || { echo "--bind-address needs a value" >&2; exit 2; }
      bind_address=$2
      shift 2
      ;;
    --workspace)
      [ "$#" -ge 2 ] || { echo "--workspace needs a value" >&2; exit 2; }
      host_workspace=$2
      shift 2
      ;;
    --username)
      [ "$#" -ge 2 ] || { echo "--username needs a value" >&2; exit 2; }
      host_username=$2
      shift 2
      ;;
    --force)
      force=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$host_workspace" in
  /*) ;;
  *) echo "workspace must be an absolute path: $host_workspace" >&2; exit 2 ;;
esac
[ -d "$host_workspace" ] || { echo "workspace does not exist: $host_workspace" >&2; exit 2; }

docker_gid=999
if [ -S /var/run/docker.sock ]; then
  docker_gid=$(stat -c '%g' /var/run/docker.sock)
fi

set_env() {
  key=$1
  value=$2
  temporary=$(mktemp "$project_dir/.env.XXXXXX")
  awk -v wanted="$key" -v replacement="$value" '
    BEGIN { found = 0 }
    index($0, wanted "=") == 1 { print wanted "=" replacement; found = 1; next }
    { print }
    END { if (!found) print wanted "=" replacement }
  ' "$env_file" >"$temporary"
  chmod 0600 "$temporary"
  mv "$temporary" "$env_file"
}

if [ -e "$env_file" ] && [ "$force" -ne 1 ]; then
  echo "Keeping existing $env_file (use --force to regenerate it)."
else
  umask 077
  cp "$project_dir/.env.example" "$env_file"
  chmod 0600 "$env_file"
  set_env HOST_UID "$host_uid"
  set_env HOST_GID "$host_gid"
  set_env HOST_USERNAME "$host_username"
  set_env HOST_WORKSPACE_ROOT "$host_workspace"
  set_env DOCKER_GID "$docker_gid"
  set_env HARNESS_AUTH_USERNAME "$host_username"
  set_env HARNESS_BIND_ADDRESS "$bind_address"
  set_env HARNESS_TLS_IP "$bind_address"
  set_env HARNESS_TRUSTED_HOSTS "$bind_address:3443,deepseek-harness.local:3443,localhost:3443"
  echo "Wrote $env_file for $host_username (UID:GID $host_uid:$host_gid)."
fi

mkdir -p \
  "$project_dir/data/dsh" \
  "$project_dir/data/gateway" \
  "$project_dir/data/ollama" \
  "$project_dir/data/router" \
  "$project_dir/data/router-runtime" \
  "$project_dir/secrets"

if [ ! -e "$project_dir/secrets/stt_api_key" ]; then
  umask 077
  : >"$project_dir/secrets/stt_api_key"
fi
chmod 0600 "$project_dir/secrets/stt_api_key"

docker compose --env-file "$env_file" -f "$project_dir/compose.yaml" config --quiet
docker compose --env-file "$env_file" \
  -f "$project_dir/compose.yaml" \
  -f "$project_dir/compose.managed-ollama.yaml" \
  config --quiet

echo "Configuration is valid."
echo "External Ollama: ./scripts/deploy.sh --external-ollama"
echo "Managed Ollama:  ./scripts/deploy.sh --managed-ollama"
