# External host-shell maintenance agent prompt

Use the following prompt with an AI model that already has an external SSH
session on the deployment host. The maintenance workflow does not depend on
DeepSeek Harness, its container, or its selected model provider remaining
available.

> Maintain the existing DeepSeek Harness deployment from this external SSH host
> shell. Work only on this machine's active, already-deployed checkout. Do not
> contact another machine, create a clone, or create a duplicate checkout. Do
> not commit or push.
>
> ## Non-negotiable prohibitions
>
> Do not create a backup, archive, stash, rollback branch, rollback tag,
> rollback directory, or any other copy of the checkout or runtime data. Do not
> use `git reset`, `git checkout --`, `git restore`, or another discard
> operation. Do not force-push. Do not run `docker system prune`, a global image
> prune, or any other system-wide Docker cleanup. Do not delete a volume or
> anything under persistent `data/` or `secrets/`. Do not modify cloud-model,
> model-provider, gateway, STT, or TTS credentials. Do not print, copy, or
> transmit a secret, credential, private key, token, password, or complete
> `.env` file. Never replace, regenerate, truncate, copy over, or otherwise
> overwrite `data/dsh/settings.yaml` based on an assumption. A settings mismatch
> requires an explicit, separately reviewed configuration decision.
>
> ## Resolve the one active checkout
>
> Use the running container's Compose labels as the authority, especially when
> more than one checkout exists. Read only these labels from
> `deepseek-harness`:
>
> ```sh
> docker inspect deepseek-harness --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'
> docker inspect deepseek-harness --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}'
> docker inspect deepseek-harness --format '{{ index .Config.Labels "com.docker.compose.project" }}'
> ```
>
> The `com.docker.compose.project.working_dir` value is the active checkout.
> Confirm that it is an existing absolute directory and that the labeled
> configuration files belong to it. Do not select a checkout merely because of
> its name or recency. Stop if the container is absent, a label is absent or
> ambiguous, a labeled file is outside that directory, or the labels identify
> conflicting checkouts.
>
> In that checkout, verify without changing anything that all of these are true:
>
> - `origin` is exactly the canonical repository
>   `https://github.com/astigmatism/dsh-container.git` (the equivalent canonical
>   GitHub SSH URL is acceptable);
> - the checked-out branch is `main`;
> - `main` tracks `origin/main`;
> - `git status --porcelain` is empty; and
> - `.env`, `compose.yaml`, `config/settings.yaml`, and
>   `data/dsh/settings.yaml` exist. Inspect only the single
>   `DSH_DEPLOYMENT_MODE` line from `.env`; never display the whole file.
>
> Stop on a dirty worktree, detached HEAD, wrong branch, wrong upstream,
> noncanonical origin, or missing required file. Do not repair or override any
> of those conditions. Before any fetch, compare
> `data/dsh/settings.yaml` byte-for-byte with `config/settings.yaml` using
> `cmp -s`. Stop if the persisted file is empty or the comparison fails. Do not
> display either file and do not attempt to reconcile them.
>
> ## Preserve the deployed mode
>
> Infer the running mode from the labeled Compose files: the managed overlay
> means `managed`, the remote overlay means `remote`, and base `compose.yaml`
> alone means `external`. Compare that with the single
> `DSH_DEPLOYMENT_MODE` value in `.env`. Stop if the two sources conflict or if
> neither identifies exactly one of `external`, `remote`, or `managed`. Do not
> guess. Run the updater with no mode flag so it repeats this validation and
> preserves the active mode.
>
> ## Bootstrap only when the updater is absent
>
> Record the starting commit with `git rev-parse HEAD`. If
> `scripts/update-and-restart.sh` is absent, and only after every preceding check
> passed, fetch `origin/main` while the deployment remains running. Confirm with
> `git merge-base --is-ancestor HEAD FETCH_HEAD` that the update is a fast
> forward, then run `git merge --ff-only FETCH_HEAD`. This is the only permitted
> bootstrap. If it does not produce an executable updater, stop. If the updater
> already exists, do not perform this manual bootstrap; the updater performs its
> own fetch and fast-forward checks.
>
> ## Run once and capture the real result
>
> From the active checkout, run the updater exactly once and capture its actual
> exit status even if the shell normally exits on errors:
>
> ```sh
> if ./scripts/update-and-restart.sh; then
>   updater_status=0
> else
>   updater_status=$?
> fi
> ```
>
> An external SSH shell should stay connected while the Compose services
> restart. A disconnect is expected only when maintenance was truly initiated
> from inside the Harness container and handed to its detached maintenance
> container. Treat loss of this external SSH session as unexpected; after
> reconnecting, gather read-only evidence and do not blindly rerun the updater.
>
> The updater must check the current persisted settings before fetch and compare
> them with the fetched target before merge or service interruption. It must not
> change persisted settings. After fast-forwarding, it must re-exec the fetched
> updater under the existing maintenance lock before any service interruption.
> On a configuration preflight failure, do not run Compose stop, rebuild,
> deploy, or any attempted fix.
>
> ## Validate independently
>
> Read `data/maintenance-status` without editing it. Require exactly one value
> for each of `state`, `updated_at`, `mode`, `branch`, `from_commit`,
> `target_commit`, `exit_code`, `failure_type`, `failure_stage`, and `recovery`.
> The recorded `exit_code` must equal `updater_status`. Success requires
> `state=ok`, `exit_code=0`,
> `failure_type=none`, the preserved mode, and a target commit equal to the
> checkout's `HEAD`. A failure must use `state=failed` and one of these precise
> `failure_type` values:
>
> - `git-state`
> - `deployment-mode-inference`
> - `docker-compose`
> - `configuration-verification`
> - `model-provider-or-credential`
> - `application-health`
>
> Whether the updater succeeded or failed, perform these independent, read-only
> checks with the same Compose files that the running labels identified:
>
> 1. Run `docker compose ... ps` and inspect both `deepseek-harness` and
>    `deepseek-harness-gateway` directly; both must be running and healthy.
> 2. Run `./scripts/verify.sh` with exactly the preserved mode flag
>    (`--external-ollama`, `--remote-ollama`, or `--managed-ollama`) and capture
>    its exit status separately. Do not treat Compose health alone as equivalent
>    to this verification.
> 3. Probe the actual HTTPS gateway `/healthz` endpoint using the configured
>    `HARNESS_TLS_IP` and `HARNESS_HTTPS_PORT` values read individually from
>    `.env`, and validate it with `data/gateway/ca.crt`. Require HTTP 200. Do not
>    use or display gateway credentials for this unauthenticated health path.
> 4. Fetch `origin/main` without merging, verify that `HEAD` equals
>    `origin/main`, and reconfirm that `git status --porcelain` is empty.
> 5. Inspect only recent logs for startup-failure indicators. Filter out entire
>    lines mentioning credentials, authorization, API keys, passwords, tokens,
>    or secrets before any display. Prefer reporting a count of case-insensitive
>    `error`, `fatal`, `panic`, `exception`, `unhealthy`, or restart-loop
>    indicators rather than copying log content. Never print complete logs.
>
> If `updater_status` is nonzero, the status file is absent, malformed, stale,
> inconsistent, or reports `recovery=failed`, stop after the read-only checks
> and report the exact blocker. Also stop and report if any independent Compose,
> verification, HTTPS, Git synchronization, or recent-log check fails. Do not
> rerun, repair, roll back, change configuration, or clean up unless a human
> separately reviews the evidence and explicitly authorizes that specific
> action.
>
> Report the host name; resolved active checkout; preserved deployment mode;
> starting, target, and ending commits; updater exit status; every field in the
> maintenance status; independent Compose, `verify.sh`, HTTPS, Git, and recent
> log results; and the exact stop condition, if any. Report no secrets.
