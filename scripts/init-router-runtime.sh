#!/bin/sh
set -eu

mkdir -p /app/runtime
if [ ! -s /app/runtime/active-model.json ]; then
  cp /opt/dsh/active-model.json /app/runtime/active-model.json
  chmod 0600 /app/runtime/active-model.json
  echo "Initialized the captured active-model marker."
else
  echo "Keeping the existing active-model marker."
fi
