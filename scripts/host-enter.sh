#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  set -- /bin/bash
fi

exec nsenter \
  --target 1 \
  --mount \
  --uts \
  --ipc \
  --net \
  --pid \
  --root=/proc/1/root \
  --wd=/proc/1/root \
  -- \
  /usr/bin/env -i \
    HOME=/root \
    USER=root \
    LOGNAME=root \
    LANG=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$@"
