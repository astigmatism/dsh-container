# Optional Nighttime and deployment-local code overrides

Daytime keeps provider `local-ollama` and model `local-active`. Nighttime keeps
provider `local-everyday` and model `qwen3.8-27b-abliterated-q6_k`. A successful,
valid router catalog may omit Nighttime. Its provider is retained with
`residentUnavailable: true`; the picker displays **Nighttime — unavailable** and
disables selection. The model-catalog entry carries `available: false`, and its
provider is omitted from `routableProviders` while retaining its visible group.
Saved defaults and sessions retain their identities and
reasoning preferences. Sending or dispatching a queued request fails with
`MODEL_UNAVAILABLE`; no alternate model is selected. Existing streams are not
cancelled by discovery. Valid reappearance enables subsequent requests without
replaying failures. A newly absent model has no inferred capability metadata.

Discovery owns the two resident entries and the recognized retired Daytime
profile only. External providers (including Amazon Bedrock), credentials,
external default selections, unrelated settings and session history survive.
Only the optional model's `ROUTER_MODEL_NOT_FOUND` condition in a structurally
valid catalog means absence. HTTP errors, malformed catalogs, ambiguous aliases,
unhealthy advertised models and invalid capability metadata remain errors.
Startup may retain already valid stored resident settings during the existing
narrow timeout/connection-failure fallback; runtime failures preserve the last
validated settings and log the discovery failure.

## Review and adopt executable overrides

A bind mount over image code wins over an image update. The updater therefore
rejects unmanaged binds at the resident discovery plugin and three resident
migration/verification destinations, including directory mounts shadowing those
paths. Directory overlays must be replaced through reviewed deployment
configuration with explicit file binds before adoption. It never silently
rewrites or deletes deployment-local files.

The supported one-time ownership transfer is:

```text
--source-bind SERVICE:/container/path=repository/path@CURRENT_FILE_SHA256
```

Repeat the option for every affected file. The service must be registered, and
the exact destination must identify one read-only regular-file bind. The hash is
of the currently mounted host file **after reviewing its differences**. A stale
hash, symlink, ambiguous mount or unsafe source path fails before cutover. Keep
local addresses, service names, credentials and these mapping arguments outside
Git. Do not infer Compose service names from container names.

| Container destination | Reviewed repository source |
| --- | --- |
| `/opt/dsh-seed/.dsh-plugins/dsh-router-model-discovery.js` | `seed/plugins/dsh-router-model-discovery.js` |
| `/opt/dsh-build/migrate-resident-models.mjs` | `scripts/migrate-resident-models.mjs` |
| `/opt/dsh-build/verify-router-contract.mjs` | `scripts/verify-router-contract.mjs` |
| `/opt/dsh-build/verify-resident-client.mjs` | `scripts/verify-resident-client.mjs` |

Review custom Bedrock changes before transferring ownership. The shared release
preserves external providers and never rewrites their default selection, but
additional local features must first be incorporated into reviewed source.
Record current image IDs, effective mount destinations, the private operational
manifest, settings, credentials and an independent state backup. Do not publish
rendered Compose configuration or backup contents.

Use a temporary checkout of the reviewed release; no permanent checkout is
required. The existing updater resolves canonical main once and builds that
pinned revision, so merge the reviewed fix to main and verify the intended main
revision before this maintenance operation. Do not use an old installed runner
to interpret the new one-time option.

For an existing operational bundle, invoke the shared updater from that reviewed
temporary source (Python 3.11+, Git, Docker/Compose and the deployment UID):

```sh
python3 -B "$reviewed_source/maintenance/main.py" update \
  --manifest "$operations/deployment.json" \
  --source-bind "$mapping_discovery" \
  --source-bind "$mapping_migration" \
  --source-bind "$mapping_contract" \
  --source-bind "$mapping_client" \
  --dry-run
```

Dry-run checks local inputs, current Docker/project identity and Portal
reachability, and reports current/reviewed content hashes without changing files
or containers. After deployment is separately authorized, repeat without
`--dry-run`. Candidate files are taken from the fetched pinned source revision,
placed in versioned operational artifacts, and mounted only during the normal
snapshot/cutover transaction. A concurrent edit to a reviewed override aborts
before stopping services. Ordinary future Portal updates refresh these mapped
artifacts automatically.

If no operational bundle exists, use `scripts/deploy.sh --adopt` with the same
four `--source-bind` options, the effective Compose files in merge order, existing
environment file, verified service-role mappings and reachable Portal URL. First
use `--dry-run`. See [portable maintenance](portable-maintenance.md) for state,
external-path and boot-unit classifications. Never regenerate private settings
or credentials to adopt an existing deployment.

## Acceptance and recovery

After the separately authorized update, the installed verifier must pass:

```sh
"$operations/scripts/update-and-restart.sh" --manifest "$operations/deployment.json" --verify
```

Confirm healthy Harness and gateway containers, authenticated access, retained
Bedrock configuration/default, working Daytime inference, disabled Nighttime,
and the Portal **Update and restart** capability. The resident client gate uses
isolated sessions and restores the raw default fields, including an unavailable
Nighttime default. It does not run paid external-provider inference. Verify the
four effective mounts now point into the selected operational release.

Automatic failure recovery restores settings/state, image identities, operational
configuration and original bind mappings. Private `maintenance-status.json`
identifies `recovery_point`; an incomplete recovery retains `transaction.json`.
Inspect those files locally without sharing credentials. Resume interrupted
recovery using reviewed shared maintenance code:

```sh
python3 -B "$reviewed_source/maintenance/main.py" recover \
  --manifest "$operations/deployment.json"
```

To roll back the latest successful update, select its recorded recovery point:

```sh
python3 -B "$reviewed_source/maintenance/main.py" rollback \
  --manifest "$operations/deployment.json" --recovery-point "$recovery_point" --dry-run
# After rollback authorization, repeat without --dry-run.
```

Rollback restores the whole snapshot, including session state at cutover. Later
state is retained beside the restored roots with a `.failed-` suffix; preserve an
independent backup first. The rollback command accepts only the most recent
successful recovery point. It recreates the previous containers and verifies
health, authenticated access and the current resident contract, rather than
trusting old image-local verifiers.

**Restoring the currently broken release can restore the same restart loop.**
An absent Nighttime model will still break that old startup script. Successful
file/image restoration is not proof of a healthy service: a failed health or
contract probe leaves recovery failed and retains the journal. Do not change the
production router or edit old files to hide this; recover to a separately
reviewed compatible release through the authorized deployment workflow.

## Qualification

Host: focused discovery, migration and adapter/client fixture tests plus
`./scripts/check.sh --host`. Set `DSH_RUNTIME_ROOT` to a host-compatible pinned
Harness runtime to run YAML migration tests; they are mandatory in the packaged
CI runtime (`DSH_TEST_HARNESS=1`) and must not silently skip there.

GitHub CI: `./scripts/check.sh --build`, including both real-entrypoint startup
catalogs, Bedrock preservation, the rendered picker transitioning absent →
present → absent without reconnection, and synthetic maintenance/recovery tests.
No Docker is required on the development Mac.
