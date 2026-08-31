# DeepSeek Harness maintenance prompt

Use this prompt with an AI model managing a machine through DeepSeek Harness:

> Update this machine's existing DeepSeek Harness deployment. Locate its
> existing `dsh-container` checkout; do not create another clone. From that
> checkout, run `./scripts/update-and-restart.sh` with no mode flag so it
> preserves the machine's current Ollama deployment mode. The script may hand
> the operation to a detached maintenance container and disconnect this
> session while Harness restarts; that is expected. Do not create backups,
> archives, stashes, rollback branches, tags, or directories. Do not use
> `git reset`, force-push, or any global Docker prune command. If the script
> refuses a dirty/diverged repository or reports another error, stop and
> report the exact blocker rather than overriding it. After Harness is back,
> read `data/maintenance-status` and confirm the containers are healthy. Report
> the deployment mode, starting commit, ending commit, and verification result.

For a machine whose mode cannot be inferred, append exactly one of
`--external-ollama`, `--remote-ollama`, or `--managed-ollama` after reviewing
that machine's `.env` and existing Compose deployment.
