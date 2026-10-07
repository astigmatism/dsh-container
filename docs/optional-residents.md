# Optional Nighttime and deployment-local code overrides

Resident routing follows the [LLM Router client contract](llm-router-contract.md)
(version 1). Its conformance map records how each requirement is met. Daytime
is provider `local-ollama` with model `daytime`; Nighttime is provider
`local-everyday` with model `nighttime`. These are the router's stable service
IDs. The canonical model behind a service (for example an MTP3 variant of
Nighttime) can change with any AI Runtime configuration and is never configured
or stored.

## What the router can do to a resident, and what Harness shows

AI Runtime switches configurations by hand and without notice. Paired
configurations run Daytime and Nighttime together; solo configurations stop
Nighttime and give Daytime every GPU. Within either kind, a service's context
window and canonical model can change. Discovery reads
`/v1/router/capabilities` at startup and follows `/v1/router/events`. Each new
`revision` re-synchronizes at once, and the picker updates without reload.
Each model is evaluated on its own, so one model's state never blocks updates
to the other. The picker shows exactly one state per resident:

| State | Picker label | Selecting | Requests |
| --- | --- | --- | --- |
| available | display name, `· NSFW` when the router declares it | allowed | sent with the serving model's limits |
| offline (in `offline_services`) | `Nighttime — offline (flash-next-solo-128k)` | blocked | fail at once with `MODEL_UNAVAILABLE`; no retries |
| unavailable (backend unhealthy, ID absent, or router unreachable) | `Nighttime — unavailable` | blocked | fail at once; no retries |
| router switching configuration (draining or maintenance) | `Nighttime — router switching configuration` | allowed | wait 2 → 30 s and retry the same model |
| incomplete metadata (warnings, `complete: false`, invalid fields) | `Nighttime — incomplete metadata` | blocked | fail at once; no retries |

**Fallback is deliberately disabled** (contract §5). A Harness session is a long
conversation. Switching models silently would change its context window,
compaction and refusal behavior. A blocked request says what happened and asks
the user to switch the session to Daytime. When Nighttime returns, it becomes
selectable again with no action, and failed prompts are never replayed.

The state is recorded in each resident provider's settings
(`residentUnavailable` and `residentState`: status, label, message,
configuration ID, reason and whether limits are `current`, `stale` or `stored`).
Limits change only while a model is available. They are the serving model's
`context_window` minus `metadata.context_safety_reserve`, and its `slots` as
`maxConcurrency`. While a model is not available, its last limits are kept,
marked stale and not acted on. The 128K values in `config/settings.yaml` are
placeholders until the first successful discovery.

Request-time router errors are classified by `error.code` first. This covers
HTTP bodies and in-stream `response.failed`/`error` events.

- **`SERVICE_OFFLINE`, `MODEL_NOT_FOUND`:** the request ends at once without
  consuming retries; the model is held offline or unavailable and the document
  is re-read.
- **`BACKEND_UNAVAILABLE`:** the provider's bounded retry policy applies; three
  such failures mark the model unavailable until a new revision or 60 seconds.
- **`BACKEND_DRAINING`, `MAINTENANCE_MODE`:** the request waits on its own retry
  chain (2 → 30 s, unbounded while the router keeps switching). It does not
  touch the provider retry budget, and each attempt re-resolves the model, so a
  model that went offline in the new configuration fails then.
- **Other 5xx, 408, 429 and network errors:** retried. **Other 4xx:** fail.

Queue keepalive comments count as stream activity. A request that waits in the
router queue longer than `streamIdleTimeoutMs` is therefore never abandoned.

Startup never fails because of router state. Only invalid local settings stop
`scripts/migrate-resident-models.mjs --startup`. If the router is unreachable,
Harness starts with its stored settings, marks both models unavailable and
recovers automatically. The migration also converts old model IDs to service
IDs. It covers the provider map, the saved default, compaction `modelPolicies`
and any other `provider`/`model` pair of a resident route. Existing sessions
recorded their route with the old ID. Each one is rewritten to the service ID
on its next request, and the adapter accepts old IDs for side calls such as
compaction summaries.

Discovery owns the two resident entries and the recognized retired Daytime
profile only. External providers (including Amazon Bedrock), credentials,
external default selections, unrelated settings and session history survive.
Every router request and discovery fetch sends
`X-Client-Name: deepseek-harness/<instance>`. The instance comes from
`HARNESS_CLIENT_INSTANCE`, else `HARNESS_TLS_IP`, else the container hostname.
The `router-model-discovery` setting `clientInstance` overrides it. Transitions
are logged to the Harness log and the container log, for example
`router-model-discovery: nighttime: available → offline (flash-next-solo-128k)`.

A pre-contract router without `/v1/router/capabilities`, such as the vendored
managed-mode router, is read from its `/v1/models` listing. `local-active`
maps to Daytime there, and limits it does not publish are kept as stored.

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

A deployment that also exposes operator-configured providers (such as Claude
via Bedrock) can have the resident client gate check them too, without
overriding any image file: set `DSH_VERIFY_EXTRA_PROVIDERS=1` in the Harness
environment. Each persisted non-resident provider must then be routable, with
its picker group listing exactly its configured models in order; no inference
is sent to it.

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
Bedrock configuration/default, working inference for each available resident,
the expected state for any other resident, and the Portal **Update and restart**
capability. The router's current configuration never fails verification: an
offline, unavailable, incomplete or switching model is reported and skipped,
while its recorded state, label and (when available) limits must match the
capabilities document. The resident client gate uses isolated sessions and
restores the raw default fields, including an unavailable Nighttime default. It
does not run paid external-provider inference. Verify the four effective mounts
now point into the selected operational release.

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

**Restoring a release older than this contract can restore its restart loop.**
Releases before service IDs fail their startup script when Nighttime is
missing or unhealthy. Rollback verification accepts their old route IDs
(`allowLegacyIds`) but cannot repair that script. Successful
file/image restoration is not proof of a healthy service: a failed health or
contract probe leaves recovery failed and retains the journal. Do not change the
production router or edit old files to hide this; recover to a separately
reviewed compatible release through the authorized deployment workflow.

## Qualification

Host: `./scripts/check.sh --host` runs the router contract tests
(`tests/router-model-discovery.test.mjs`, `tests/router-provider-remote.test.mjs`,
`tests/dsh-resident-availability.test.mjs`, `tests/dsh-llm-pi-ai-patch.test.mjs`,
`tests/llm-router-contract.test.mjs`, and `tests/router-client-wire.test.mjs` when a
patched runtime is available) against synthetic paired, solo, unhealthy,
incomplete, draining, unreachable and changing documents, plus a fake event
stream. Set `DSH_RUNTIME_ROOT` to a host-compatible pinned Harness runtime to
run YAML migration tests; they are mandatory in the packaged CI runtime
(`DSH_TEST_HARNESS=1`) and must not silently skip there.

GitHub CI: `./scripts/check.sh --build`. It runs `verify-router-client-wire.mjs`
against the installed adapter (queue keepalives past the idle timeout, every
error code, `X-Client-Name`). It runs both real-entrypoint startup fixtures,
which serve capabilities and events, and checks Bedrock preservation. It
checks the rendered picker moving offline → available (with the NSFW badge) →
offline without reconnection, and synthetic maintenance/recovery tests. No
Docker is required on the development Mac. Never switch AI Runtime
configurations to test; use the synthetic fixtures.
