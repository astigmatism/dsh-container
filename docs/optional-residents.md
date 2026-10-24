# Resident models: the router's published catalog, opt-in services, and deployment-local code overrides

Resident routing follows the [LLM Router client contract](llm-router-contract.md)
(version 1.2). Its conformance map records how each requirement is met. Harness
configures **one provider route per router** — `local-ollama` — and that route's
model list **is** the catalog the router publishes at
`/v1/router/capabilities`: one row per service ID, right now `daytime`,
`nighttime` and `daisy`, a service published by a second host. Requests carry the
router's stable service IDs. A row is titled with the name the router publishes
for the service it offers — `metadata.alias_display_names` for that name, else
the model's `display_name_qualified`, else its `display_name` — with the service
ID appended in parentheses only when two offered names would read alike, plus
` · NSFW` when the document declares it. Harness keeps no service list of its own
and invents no model names: a service a router starts publishing joins the picker
on the next revision, and one it stops publishing stays visible only as its
recorded state. The canonical model behind a service (for example an MTP3 variant
of `nighttime`) can change with any AI Runtime configuration and is never
configured or stored. Below, a *resident* means one model of that route — one
service the router publishes.

Every service the router publishes is offered in the picker, and a default
selection always resolves to one of them or to an external provider a human
chose. **An opt-in service such as `trial`** answers to a stricter rule (the
owner's rule,
2026-10-13, and the contract's own §3 example). Harness never selects it, never
makes it a default, never moves a session onto it or off it automatically, and
never falls back to it. It appears in the picker as a model row with a state, and
only a human selection puts a session on it. Its serving profile — text-only in
every configuration that has served it — comes from its own router metadata, so
it never inherits another model's image modality or context. Which names are
opt-in is configuration, not a Harness concept: the plugin setting
`optInServices`, whose default is `[ trial ]`.

## What the router can do to a resident, and what Harness shows

AI Runtime switches configurations by hand and without notice. Paired
configurations serve both names of one model together; a solo configuration stops
one of them and gives the other every GPU. A configuration may also serve only an
opt-in service, or stop offering it again. Within any configuration, a service's
context window and canonical model can change, and a router can start publishing
a name no configuration had offered — `daisy` from a second host, for example.
Discovery reads `/v1/router/capabilities` at startup and follows
`/v1/router/events`. Each new
`revision` re-synchronizes at once, and the picker updates without reload.
Each model is evaluated on its own, so one model's state never blocks updates
to another. The picker shows exactly one state per resident:

| State | Picker label | Selecting | Requests |
| --- | --- | --- | --- |
| available | the name the router publishes for that service, `· NSFW` when the router declares it | allowed | sent with the serving model's limits |
| offline (in `offline_services`) | `<published title> — offline (flash-next-solo-128k)` | blocked | fail at once with `MODEL_UNAVAILABLE`; no retries |
| unavailable (backend unhealthy, ID absent, or router unreachable) | `<published title> — unavailable` | blocked | fail at once; no retries |
| router switching configuration (draining or maintenance) | `<published title> — router switching configuration` | allowed | wait 2 → 30 s and retry the same model |
| incomplete metadata (warnings, `complete: false`, invalid fields) | `<published title> — incomplete metadata` | blocked | fail at once; no retries |

Every label in that table is the router's published title for that name plus the
state, which is why two names of one model are hard to tell apart and the code
appends the name being chosen: today's router publishes `daytime` and `nighttime`
both titled `Qwen3.8 Flash-Next (256K)`, and the picker offers
`Qwen3.8 Flash-Next (256K) (daytime)` and `Qwen3.8 Flash-Next (256K) (nighttime)`
under the group `llm-router`, next to the second host's
`Qwen3.8 Flash-Next IQ3_XXS (64K)`. The title is **dropped while nothing serves
that name** — the configuration stopped offering it, or the router is not
answering at all — because a remembered title describes a configuration that may
no longer exist and reads as a model on offer; such a row names itself and its
state, for example `nighttime — unavailable`, and the title returns with the
model. A router that is switching still attributes the model, so its title stays.
Nothing in a row is Harness vocabulary: a row leads with the title the router
publishes and continues with the state the contract names.

An opt-in service answers to the same table, with its own title and state:
`Qwen3.8 Flash-Next (Strata trial) (160K) — offline (flash-next-solo-160k)` when
the active configuration stops it, or `trial — unavailable` when the current
configuration does not offer it at all. A service a row already exists for, which
the configuration stops offering, is **held,
never unknown**: the model row stays, its recorded state says `unavailable` with
reason `not offered by the router`, and its message states that it is an opt-in
model Harness never selects and never moves a session off. A session a human put
there fails with that message instead of being moved to another model. A router
that has never offered it has no row for it yet; discovery writes one when it
appears.

**Fallback is deliberately disabled** (contract §5). A Harness session is a long
conversation. Switching models silently would change its context window,
compaction and refusal behavior. A blocked request says what happened and asks
the user to switch the session to another model. When the model returns, it
becomes selectable again with no action, and failed prompts are never replayed.
Nothing moves a session onto an opt-in service either: it is entered and left
only by a human.

The state is recorded **per model**, in
`llm-pi-ai.providers.local-ollama.residentStates.<service>`: status, label,
message, configuration ID, reason and whether limits are `current`, `stale` or
`stored`. The route keeps `residentUnavailable` and `residentState` only for
router-wide facts: a router that answers nothing or publishes a document Harness
cannot read, that document's configuration ID, the services the router offers,
and the service the document calls its default. Only those gate a whole route;
one model's state never blocks its route.
Limits change only while a model is available. A model's context budget is the
serving model's `context_window` minus `metadata.context_safety_reserve`, and its
output allowance, input modalities and effort levels come from the same metadata.
The route's `maxConcurrency` is the serving `slots` summed over the **distinct**
models the router offers — aliases of one model share their slots — while the
router's own per-model queue stays the authority. While a model is not available,
its last limits are kept, marked stale and not acted on. The 128K values in
`config/settings.yaml` are placeholders until the first successful discovery.

## The opt-in picker filter: `modelPicker.availableOnly`

The setting `modelPicker.availableOnly` (boolean, **off by default**) changes
what the picker shows, never what exists. With it on, the catalog keeps
reporting every model, but the picker offers only models whose current state
is usable: an unavailable model is not shown at all (not greyed out), a
provider group with nothing usable drops out of the list — for a router route
that means every model it publishes is unusable, since one router is one group —
and a route draining a router switch is not offered either. When nothing is left
to offer, the picker
renders one status line — "Waiting on the router…" while a switch is
draining, "No models available." otherwise — instead of a wall of greyed rows.

It is read from the same settings document the state above persists to: the
live profile patch, then the pre-0.2 settings file. The first readable
document decides; an absent, unreadable or unparsable document, or any value
that is not exactly `true`, leaves the filter off.

```yaml
# $DSH_PROFILE_DIR/cordis.patch.yml (list form)
- id: modelPicker
  config:
    availableOnly: true
```

```yaml
# $DSH_HOME/settings.yaml (pre-0.2 map form)
modelPicker:
  availableOnly: true
```

The flag rides the `modelCatalog` result as `availableOnly`; the server side
is unchanged and old clients ignore it. With the filter off the picker is
byte-for-byte the current release: every state in the table above stays
selectable or blocked exactly as shown, and a switching row keeps its
selectable status (its requests wait on the switch's own retry chain). The
section is not a registered settings entry, so it is edited in the file
directly; booting a host that carries it without the filter logs a harmless
`entry modelPicker not found` notice.

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
Harness starts with its stored settings, marks every model the route carries
unavailable and recovers automatically. A router whose current configuration
offers no opt-in service such as `trial` is recorded state and a notice, never a
failed update: the migration lists the service with its state, prints
`trial: unavailable (not offered by the router) [opt-in service; never selected
automatically]` and exits 0. The migration also rewrites selections written
before a router's catalog drove the model list. The retired routes
`local-everyday` and `local-trial` become the catalog route `local-ollama`
carrying the service their own route used to answer, so a session recorded on
`local-everyday` with model `nighttime` becomes `local-ollama` with model
`nighttime`. It covers the provider map, the saved default, compaction
`modelPolicies` and any other `provider`/`model` pair of a resident route; a
migrated compaction policy keeps its ratio, and the maintained profile now sets
the 70% threshold once for the router route instead of one row per resident, so
a service the catalog adds later inherits it. No migration case ever makes an
opt-in service the saved default: a rewrite that would move the default onto one
throws instead. Existing sessions recorded their route with a retired ID. Each
one is rewritten to the service ID
on its next request, and the adapter accepts old IDs for side calls such as
compaction summaries.

Discovery owns the router route — its model rows, their titles, limits and
recorded states — and the retired route IDs; nothing else. External providers
(including Amazon Bedrock), credentials, external default selections, unrelated
settings and session history survive. A deployment whose
`router-model-discovery` `providers` list still names the one-route-per-service
releases, `local-ollama` and `local-everyday`, is read as the single catalog
route those releases pointed at; any other list is obeyed exactly, so a
deployment that deliberately names a subset, or names a second router, gets
exactly that. The plugin setting `optInServices` (default `[ trial ]`) is what
makes a service opt-in; it is configuration, so the next opt-in name is a
settings edit and not a Harness release. Every router request and discovery
fetch sends `X-Client-Name: deepseek-harness/<instance>`. The instance comes
from `HARNESS_CLIENT_INSTANCE`, else `HARNESS_TLS_IP`, else the container
hostname. The `router-model-discovery` setting `clientInstance` overrides it.
Transitions are logged per service, to the Harness log and the container log,
for example
`router-model-discovery: nighttime: available → offline (flash-next-solo-128k)`
or `router-model-discovery: trial: unavailable → available`.

A pre-contract router without `/v1/router/capabilities`, such as the vendored
managed-mode router, is read from its `/v1/models` listing, and limits it does not
publish are kept as stored. That router runs the legacy single-marker mode, where
the reserved alias `local-active` names the one model the router has active; the
managed topology sends that route's traffic to the `daytime` service, so the
synthesized document reads it as `daytime`. That is this deployment's choice
about which model the active slot feeds. It is not a contract claim:
`local-active` is not a service and not an alias of `daytime`, it is accepted
undeclared only in that legacy mode, and in a published resident catalog only the
configuration's default entry may declare it — anywhere else it is
`404 MODEL_NOT_FOUND`. It is never a default and never an automatic choice, and
it names no `trial`: the synthesis knows only the two services that existed
before the contract, and its rows feed the same catalog route as a contract
document.

Two more cases follow from the same section of the contract. A service the
current configuration does not declare, with no `offline_services` row for it
either, is recorded `unavailable` with reason `not offered by the router` — this
can now apply to `daytime` as well as to an opt-in service such as `trial`, and
it is never answered by sending another name. And a model the catalog gives no
service ID (`service` set to its canonical ID, no service alias,
`MODEL_HAS_NO_SERVICE_ID`) is never surfaced as a model anyone can choose: the
names a route offers are the `service` and `aliases` of a published row, minus
the canonical ID and the reserved alias, so such a row never becomes a model row
at all, and a document whose catalog declares no service ID holds every model it
carried with the router's own reason.

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
Bedrock configuration/default, working inference for each available model of the
router route, the expected state for any other model, and the Portal
**Update and restart** capability. The router's current configuration never
fails verification: an
offline, unavailable, incomplete or switching model is reported and skipped,
while its recorded state, label and (when available) limits must match the
capabilities document; the route itself must be titled with the name its router
publishes for itself. The resident client gate uses isolated sessions and
restores the raw default fields, including a default whose model is currently
unavailable. It does not run paid external-provider inference. Verify the four
effective mounts now point into the selected operational release.

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
Releases before service IDs fail their startup script when the model their own
route expected is
missing or unhealthy. Rollback verification accepts their old route IDs
(`allowLegacyIds`) but cannot repair that script. Successful
file/image restoration is not proof of a healthy service: a failed health or
contract probe leaves recovery failed and retains the journal. Do not change the
production router or edit old files to hide this; recover to a separately
reviewed compatible release through the authorized deployment workflow.

## Qualification

Host: `./scripts/check.sh --host` runs the router contract tests
(`tests/router-model-discovery.test.mjs`, `tests/router-provider-remote.test.mjs`,
`tests/resident-settings-migration.test.mjs`, `tests/local-inference-contract.test.mjs`,
`tests/dsh-resident-availability.test.mjs`, `tests/dsh-llm-pi-ai-patch.test.mjs`,
`tests/llm-router-contract.test.mjs`, and `tests/router-client-wire.test.mjs` when a
patched runtime is available) against synthetic paired, solo, unhealthy,
incomplete, draining, unreachable and changing documents, plus documents that
publish a third service — an opt-in service such as `trial` offered, absent, or
stopped by the active configuration — documents in which one model answers two
service names, and a second router's catalog, together with a fake event stream.
They assert that one route carries the catalog the router publishes, titled as
the router titles it, that an absent or stopped opt-in service is held with its
own state, that its limits and text-only modality come from its own metadata,
that slots are counted per model and not per name, that no migration case makes
an opt-in service the default, and that verifiers list and state-check it
without ever selecting it or sending inference through it. Set
`DSH_RUNTIME_ROOT` to a host-compatible pinned Harness runtime to
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
