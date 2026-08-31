#!/bin/sh
set -eu

image=${NVIDIA_SMI_IMAGE:?NVIDIA_SMI_IMAGE must name an existing local GPU-capable image}

exec docker run \
  --rm \
  --pull=never \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 64 \
  --gpus all \
  --entrypoint nvidia-smi \
  "$image" \
  "$@"
