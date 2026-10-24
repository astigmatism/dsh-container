# Router compatibility release

Historical release notes: the current availability, external-provider preservation,
and portable update procedures are documented in [optional residents](optional-residents.md)
and [portable maintenance](portable-maintenance.md). The two-model-only migration
and destination-specific rollout below describe the earlier release, and a route
that carried exactly one service is no longer how a router's models are
configured.

**Superseded on 2026-10-07** by the [LLM Router client contract](llm-router-contract.md)
release. Resident routes then sent the service IDs `daytime` and `nighttime`.
Discovery read `/v1/router/capabilities` and `/v1/router/events` instead of
`/v1/models`. Each model is evaluated independently, so router state never stops
startup or verification. The IDs and the all-or-nothing validation described
below are no longer current.

**Superseded again by the catalog-driven route.** Harness now configures one
provider route per router, and that route's model list is the catalog the router
publishes: one row per service ID, titled with the names the router publishes for
them, under a group headed by the name the router publishes for itself. The
one-route-per-service shape described below — a route per service, each titled
with a word Harness invented — is gone: `local-everyday` and `local-trial` are
retired provider IDs used only to rewrite persisted selections onto the catalog
route. [optional residents](optional-residents.md) is the current reference.

**A third resident service was added on 2026-10-13**, then as provider
`local-trial` with service `trial`. It is opt-in — never a default, never a
fallback target, never selected by a migration or a verifier, and never left
automatically — it is text-only with limits from its own router metadata, and a
human selection is the only way onto it. Which names are opt-in is the plugin
setting `optInServices`, default `[ trial ]`. Discovery and the startup
migration list and hold the row when the router offers the service, pickers and
deployment verification list and state-check it, and no request is ever sent
through it by an automated check. A router configuration that does not offer it
leaves it held with its reason recorded; the update still succeeds.
[optional residents](optional-residents.md) is the current reference for the
route and every model it carries.

This Harness change replaces historical router-profile assertions with shared,
validated discovery and preserves explicit DSH reasoning choices. It supports
legacy alias-only catalogs, canonical model IDs with alias metadata, and the
router's repaired explicit alias row. The configured local provider contracts
must match complete schema-v2 metadata; ambiguous aliases, warnings and
inconsistent output policies still fail validation, while an unavailable backend
is a recorded state that stops neither startup nor verification.

The resident defaults of that release were the `daytime` service of
`local-ollama` (then addressed as `local-active`, 163840 context, one active
request) and the `nighttime` service of the now-retired `local-everyday` route
(`qwen3.8-27b-abliterated-q6_k`, 131072 context, one active request).
Capabilities for both models, including image/tool support, come from discovery.
Those values are discovered, not required as historical constants, and today
each model of the catalog route is provisioned the same way, from the model that
actually serves it. The remote verifier retains the vision/tool requirement for
the model a browser session would really use — the saved selection, or the
service the router calls its default — and browser readiness checks that model.

The router's raw reasoning default is template-defined. Harness deliberately
seeds medium, while retaining explicit provider/agent/request effort choices.
Complete unrestricted output metadata keeps null capability maxima all the way
through the installed SDK. An omitted allowance stays omitted; explicit finite
allowances, including 1 and 65536, remain exact. Bounded policies retain their
finite validation and SDK behavior. Incomplete tool JSON is retained without
becoming an executable completed tool call. Working-context compaction preserves
durable original events and does not inject a summary quota.

## Normal update and persisted settings

On `.21`, then `.5`, use Service Portal's existing DeepSeek Harness **Update and restart**
control (`POST /api/projects/deepseek-harness/update`). Portal resolves the
checkout directory and updater from its Docker labels. The supported checkout
entry point is `update and restart`, which executes `scripts/update-and-restart.sh`.
The updater requires clean `main`
tracking canonical `origin/main`, fetches and fast-forwards, reexecutes the fetched
updater, builds/pulls the replacement images, recreates the existing project and
runs verification. A pushed main commit is sufficient for this source-build
workflow; a separate GHCR tag is not required.

The versioned entrypoint reconciles the local providers atomically before DSH
launches, preserving file ownership/mode and creating no backup artifacts. It
refreshes the repository-owned plugin, which continues to use DSH's settings
service for subsequent capability refresh. It validates all discovered targets
and any inherited effort before writing, provisions each offered service with
the metadata of the model that serves it, and preserves unrelated settings and
explicit effort choices. At that release the selectable catalog was restricted to
`local-ollama/local-active` and `local-everyday/qwen3.8-27b-abliterated-q6_k`;
a router route now offers the catalog its router publishes, one model row per
published service, titled as that router titles it. Obsolete providers, Swift
model choices, and duplicate alias rows were removed in the same provider-map
mutation. Defaults pointing to a removed choice moved to the `daytime` service
and kept any supported reasoning effort; unsupported efforts fell back to medium.
Credential storage, conversation history, and unrelated settings remain intact.
The versioned web
composition disables `llm-deepseek`, preventing its upstream default catalog
from entering the picker. Repeated synchronization is a no-op once current.

Image tests inspect the real application catalog, rendered model picker, and
separate reasoning menu. Deployment verification repeats those checks and sends
one short text-only request through an available model of the route in an
isolated session, never through an opt-in service. It restores the original
default selection and archives the verification session.
Require a successful `.21` update before requesting the `.5` update.

If discovery failed, that release left the file unchanged and started the
application, and provider verification remained blocking until synchronization
succeeded; today an unreachable router is recorded as the state of each model the
route carries and startup still succeeds. The
deployment verifier allows startup synchronization to finish, then runs
`/opt/dsh-build/verify-router-contract.mjs` against persisted settings and current
router discovery. Remote mode independently confirms the `ai-router` DNS mapping
and runs the same verifier with `--mode remote`. Browser readiness uses the same
module with `--browser`. No manual production source copy, SDK patch or settings
migration is needed. The packaged `migrate-resident-models.mjs --startup` is the entrypoint helper.
Its explicit local-maintenance mode uses the same logic and retains a private
backup; startup mode does not create such a backup.

## Validation

`tests/router-provider-remote.test.mjs` executes the exact remote-mode block
extracted from `verify.sh`, using the real shared verification CLI and local HTTP
fixtures after startup synchronization. Cases cover startup migration onto one
catalog route with limits taken from each serving model, an opt-in service
offered when its router publishes it and held when it stops, a solo
configuration leaving one service offline without blocking the others, a
draining router, an unreachable router, a new canonical model behind a service,
explicit effort/settings preservation, the live verifier rejecting stale limits,
titles, states, identity and an unpublished model, a concurrent edit to the
route, the event stream with backoff and `If-None-Match` revalidation, and a
pre-contract router read from its model listing.

`verify-router-startup.mjs` additionally runs the real entrypoint against legacy
settings with controlled discovery, before any browser/agent activation. It
checks atomic migration, file mode, no leftover migration artifacts, null limits,
the catalog rows and per-model states the document publishes, the route titled
with the name its router publishes for itself, and preserved unrelated
settings/explicit effort. Its `--daytime-only` qualification boots the shape
where the router stops offering the other services.

The image build runs actual installed SDK wire and compaction checks. The normal
repository `scripts/check.sh --build` includes updater/self-reexec, persisted
settings, Compose, delegated gateway, dictation, plugin boot and Node regression
checks. Local runtime acceptance uses `scripts/verify.sh --remote-ollama` and
`scripts/verify-browser-readiness.sh`. Production acceptance is owned by the
coordinating Service Portal task after the reviewed source is published.

Both `.5` and `.21` are production. Development and tests stay on the Mac; see
[environment instructions](../AGENTS.md). This release does not claim production
Portal success until its normal update job completes.
