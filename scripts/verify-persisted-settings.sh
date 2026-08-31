#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
canonical_settings=$project_dir/config/settings.yaml
runtime_settings=$project_dir/data/dsh/settings.yaml

if [ ! -f "$canonical_settings" ]; then
  echo "Canonical settings are missing: config/settings.yaml" >&2
  exit 1
fi

if [ ! -e "$runtime_settings" ]; then
  echo "Persisted settings are missing: data/dsh/settings.yaml" >&2
  echo "Maintenance will not create or replace persisted settings." >&2
  exit 1
fi

if [ ! -f "$runtime_settings" ]; then
  echo "Persisted settings are not a regular file: data/dsh/settings.yaml" >&2
  exit 1
fi

if [ ! -s "$runtime_settings" ]; then
  echo "Persisted settings are empty: data/dsh/settings.yaml" >&2
  echo "Maintenance will not create or replace persisted settings." >&2
  exit 1
fi

if ! cmp -s "$canonical_settings" "$runtime_settings"; then
  echo "Persisted settings differ from config/settings.yaml." >&2
  echo "Maintenance will not overwrite them; an explicit configuration decision is required." >&2
  exit 1
fi

echo "Persisted settings match config/settings.yaml."
