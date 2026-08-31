#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: host-exec <host-program> [argument ...]" >&2
  echo "example: host-exec /bin/bash -lc 'systemctl status docker --no-pager'" >&2
  exit 2
fi

image=${HOST_EXEC_IMAGE:?HOST_EXEC_IMAGE must name the local Harness image}

exec docker run \
  --rm \
  --pull=never \
  --privileged \
  --pid=host \
  --network=host \
  --ipc=host \
  --uts=host \
  --cgroupns=host \
  --user 0:0 \
  --entrypoint /usr/local/bin/host-enter \
  "$image" \
  "$@"
