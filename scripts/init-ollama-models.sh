#!/bin/sh
set -eu

if [ "${PULL_OLLAMA_MODELS:-1}" != "1" ]; then
  echo "Skipping Ollama model pulls (PULL_OLLAMA_MODELS=${PULL_OLLAMA_MODELS:-})."
  exit 0
fi

while IFS= read -r model || [ -n "$model" ]; do
  case "$model" in
    ''|'#'*) continue ;;
  esac
  if ollama show "$model" >/dev/null 2>&1; then
    echo "Ollama model already present: $model"
  else
    echo "Pulling Ollama model: $model"
    ollama pull "$model"
  fi
done </opt/dsh/ollama-models.txt
