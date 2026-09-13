# Router compatibility release

This Harness change replaces historical router-profile assertions with shared,
validated discovery and preserves explicit DSH reasoning choices. It supports
legacy alias-only catalogs, canonical model IDs with alias metadata, and the
router's repaired explicit alias row. The configured local provider contracts
must match complete schema-v2 metadata; ambiguous aliases, warnings, unavailable
backends and inconsistent output policies still fail verification.

Current resident defaults are Daytime (`local-ollama/local-active`, 163840
context, one active request) and Nighttime
(`local-everyday/qwen3.8-27b-abliterated-q6_k`, 131072 context, one active request).
The primary supports image/tool work; the secondary supports text and reasoning.
Those values are discovered, not required as historical constants. The remote
verifier retains the primary route's vision/tool requirement; browser readiness
checks the selected route.

The router's raw reasoning default is template-defined. Harness deliberately
seeds medium, while retaining explicit provider/agent/request effort choices.
Complete unrestricted output metadata keeps null capability maxima all the way
through the installed SDK. An omitted allowance stays omitted; explicit finite
allowances, including 1 and 65536, remain exact. Bounded policies retain their
finite validation and SDK behavior. Incomplete tool JSON is retained without
becoming an executable completed tool call. Working-context compaction preserves
durable original events and does not inject a summary quota.

## Normal update and persisted settings

On `.5`, use Service Portal's existing DeepSeek Harness **Update and restart**
control (`POST /api/projects/deepseek-harness/update`). Portal resolves the
checkout directory and updater from its Docker labels. The supported checkout
entry point is `update and restart`, which executes `scripts/update-and-restart.sh`;
this task did not independently confirm the absolute checkout path on `.5`. The updater requires clean `main`
tracking canonical `origin/main`, fetches and fast-forwards, reexecutes the fetched
updater, builds/pulls the replacement images, recreates the existing project and
runs verification. A pushed main commit is sufficient for this source-build
workflow; a separate GHCR tag is not required.

The versioned entrypoint reconciles the local providers atomically before DSH
launches, preserving file ownership/mode and creating no backup artifacts. It
refreshes the repository-owned plugin, which continues to use DSH's settings
service for subsequent capability refresh. It validates all discovered targets and any
inherited effort before writing, provisions the secondary with its own metadata
atomically, and preserves unrelated settings and explicit effort choices. The
recognized legacy `local-ollama-256k` route is retired only when it uses the same
endpoint and sole `local-active` model. A default selecting that route moves to
the primary without losing its effort or other fields; a customized route is
preserved. Repeated synchronization is a no-op once capabilities agree.

If discovery fails, startup leaves the file unchanged and starts the application;
provider verification remains blocking until synchronization succeeds. The
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
fixtures after startup synchronization. Cases cover canonical-only and repaired
alias discovery, legacy bounded output, actual IDs, idempotent migration, explicit
effort/settings preservation, inherited-effort rejection before mutation,
truthful secondary capabilities, stale concurrency and malformed policy failures.

`verify-router-startup.mjs` additionally runs the real entrypoint against legacy
settings with controlled discovery, before any browser/agent activation. It
checks atomic migration, file mode, no leftover migration artifacts, null limits,
secondary capabilities and preserved unrelated settings/explicit effort.

The image build runs actual installed SDK wire and compaction checks. The normal
repository `scripts/check.sh --build` includes updater/self-reexec, persisted
settings, Compose, delegated gateway, dictation, plugin boot and Node regression
checks. Local runtime acceptance uses `scripts/verify.sh --remote-ollama` and
`scripts/verify-browser-readiness.sh`. Production acceptance is owned by the
coordinating Service Portal task after the reviewed source is published.

Both `.5` and `.21` are production. Development and tests stay on the Mac; see
[environment instructions](../AGENTS.md). This release does not claim production
Portal success until its normal update job completes.
