# Portable DeepSeek Harness

This repository reconstructs the live `deepseek-harness` deployment captured
on 2026-08-31. It produces a reusable Harness image plus its authenticated
HTTP/HTTPS gateway and can connect directly to a production router elsewhere
on the LAN, join an existing local router network, or start a managed, pinned
Ollama/router stack.

The image is reproducible configuration, not a `docker commit` snapshot. Plugin
versions and patches are locked in Git; sessions, derived credential hashes,
TLS private keys, request logs, and 58 GB of model blobs are deliberately kept
outside Git.

The captured base-image digests and release workflow target Linux `amd64`.
Destination hosts need Docker Engine with Compose v2; managed Ollama mode also
needs the NVIDIA Container Toolkit.

## Captured configuration

- DeepSeek Harness `0.1.5-alpha.1`, the official package built from GitHub tag
  `dsh-v0.1.5-alpha.1` at commit
  `5dda764ed3aa172535a7967b06ff95d9cbfe536a`; pnpm `11.7.0`; Docker CLI
  `29.6.0`. The release and commit are immutable build inputs rather than a
  moving `master` reference.
- Node 22 base pinned to the digest used by the source image.
- Ollama pinned to
  `sha256:77f1a2a54460f0380f2611e1464233d9b82cb6e58afc8f60abec0061049d2d82`.
- Two resident OpenAI Responses models at `http://ai-router:11434/v1`:
  Daytime (128K) and Nighttime (128K), each with one independent generation slot
  and no inherited output ceiling.
- Explicit DSH medium reasoning by default; the raw router default remains
  template-defined. Off, low, medium, and xhigh are supported,
  while the existing minimal, high, and max selectors map to low, xhigh, and
  xhigh respectively.
- Remote mode delegates active-model selection, Responses, tools, reasoning,
  vision, and schema-v2 discovery to the production router at
  `REMOTE_OLLAMA_HOST`.
- Managed mode retains the captured `qwen3.8:27b-mtp-q8_0` Ollama model,
  262,144-token context, persistent keep-alive, one parallel request, one
  loaded model, flash attention, `f16` KV cache, and reasoning-effort mapping.
- The managed-mode vendored router is from
  `astigmatism/local-ai-ollama-router@14be1958e17328afa6eec53b3a153224a9aea078`.
- OpenAI-compatible faster-whisper STT and routed Kokoro/Chatterbox TTS on the
  captured voice host, with separate file-based keys and locked deployment
  metadata in `config/speech.lock.json`.

The locked web profile contains these nine plugins:

1. `@zoytown/dsh-token` 0.1.3 with a narrowly anchored session-format-v3
   compatibility patch, installed but disabled by default because its
   inode/device-sensitive refold path and per-frame synchronous Zstandard
   decompression have caused repeatable multi-gigabyte Harness RSS growth
2. `dsh-context` 0.47.0
3. `dsh-local-speech-input` 0.1.0 (local)
4. `dsh-loop-detector` 1.0.0 with the captured local patch
5. `dsh-playwright` 0.1.0 with its existing panel-layout patch and a narrowly
   anchored web-transport-scope compatibility patch, with the web-server
   dependency declared at the profile loader boundary; it provides the shared
   Browser Use panel and model-facing Playwright tools
6. `dsh-plugin-task-notification` 0.2.1 at commit
   `f10cd6869b7a50e55780627a6d55bbb310fd59b4`
7. `dsh-session-pin` 0.7.7
8. `dsh-ui-appearance` 0.1.8
9. `dsh-favicon-status` 0.1.0-rc.5

The profile also disables DeepSeek's keyed web search and installs the captured
keyless DuckDuckGo/Bing fallback provider. See `config/plugins.lock.json` and
`seed/` for the exact manifest, lockfile, provider, and patch.

The upstream repositories were rechecked on 2026-09-09. Their current heads
still publish `@zoytown/dsh-token` 0.1.3 and `dsh-playwright` 0.1.0; the exact
observed commits are recorded in `config/plugins.lock.json`. No unpublished
token-memory repair or newer shared-panel implementation was available to
adopt.

Token statistics are the only deliberately unavailable default feature. There
is no fixed `@zoytown/dsh-token` release whose memory behavior can be proven
bounded. To accept the known refold/OOM risk for a controlled experiment, set
`DSH_TOKEN_ENABLED=true` in `.env` and rebuild/restart. Omitting the variable
or setting it to `false` keeps both the host scanner and token-statistics UI
unloaded; package installation alone does not enable them.

After deploying a host with the incident data, run
`./scripts/verify-dsh-token-memory.sh --require-incident-fixture`. It requires
the 52-artifact fixture, samples the Harness Node RSS at startup and across
three 35-second boundaries (longer than the plugin's 30-second refresh), and
fails on monotonic growth, excessive RSS/growth, an OOM flag, a restart or
recreation, or any write to the disabled plugin's durable index.

## Shared browser and visual validation

The web profile includes `dsh-playwright`, which runs a headless Chromium page
per DSH session and streams that same page into the in-app Browser Use panel.
The model can navigate, inspect semantic snapshots, click or type, and request
PNG screenshots through DSH's native image-attachment path. Both local model
routes declare image input, and the production Responses router accepts
image-bearing function-call results directly.

Chromium is installed at `/usr/bin/chromium` in the Harness image. Public web
targets work with the secure default. To validate an application on localhost,
a Docker network, or a trusted LAN, set this deployment-local value in `.env`
and rebuild/restart:

```sh
DSH_BROWSER_ALLOW_PRIVATE_HOSTS=true
```

This setting permits all private hosts and private subresources reachable from
the Harness container; the upstream plugin does not currently expose a
per-domain allowlist. Enable it only for trusted validation tasks, keep the
Harness on its existing trusted network boundary, and turn it off for general
browsing. Inside Chromium, `localhost` refers to the Harness container. Use a
Compose service name for a colocated application or `host.docker.internal` on
Docker Desktop for an application served by the host.

See `docs/visual-validation-playbook.md` for acceptance tests and prompts for
local and production validation agents.

## Choose a deployment mode

Remote Ollama mode is the portable default and is intended for deploying
Harness on another machine on the LAN. Compose maps the canonical `ai-router`
name directly to `REMOTE_OLLAMA_HOST`. The production router owns the OpenAI
Responses endpoint, tools, reasoning, vision, schema-v2 discovery, and
`local-active` translation; remote mode does not start a local router service.

```sh
git clone https://github.com/astigmatism/dsh-container.git
cd dsh-container
./scripts/configure.sh --bind-address 192.168.1.50
# Set REMOTE_OLLAMA_HOST in .env to the router host's LAN address.
./scripts/deploy.sh
```

The no-flag deploy command selects remote mode for a new deployment and reuses
the recorded mode on an existing deployment. Use `deploy.sh`, which includes a
no-op remote mode marker, builds Harness and the gateway, records the mode, and
verifies the direct route. When upgrading the obsolete proxy topology, it
verifies the direct production route before stopping and removing only the
`deepseek-harness-ollama-router` container, verifies again, and retains the
router image plus all persistent data for rollback.

The container-only default exposes as much of the host filesystem as the
platform permits at the stable Linux path `/host`. Native Windows Compose
mounts the Windows system drive there; native Linux mounts `/`. Existing `.env`
files do not need a platform-specific path. Set `HOST_FILESYSTEM_SOURCE` only
when intentionally limiting Harness to a narrower drive or directory.

Docker Desktop for macOS keeps containers inside a Linux VM and exposes only
locations allowed by its file-sharing settings. `/host` therefore contains the
VM root and its shared host locations (commonly below `/host/host_mnt`), rather
than unrestricted macOS root. Add needed locations in Docker Desktop's file
sharing settings when they are outside the defaults.

The POSIX deployment and maintenance scripts can also run from a WSL 2
distribution with Docker Desktop's WSL integration and Linux containers
enabled. A checkout in the WSL filesystem avoids slow source-code bind mounts.

External Ollama mode matches the source host most closely. It joins an existing
Docker network, and that network must expose the Responses-compatible router
under the alias `ai-router`. Docker bridge networks are local to one Docker
Engine, so this mode is only appropriate when Harness and the existing router
run on the same machine.

```sh
git clone https://github.com/astigmatism/dsh-container.git
cd dsh-container
./scripts/configure.sh --bind-address 192.168.1.50
# Edit OLLAMA_NETWORK in .env if it is not local-ai-ollama_default.
./scripts/deploy.sh --external-ollama
```

Managed Ollama mode is the self-contained option. It adds the pinned Ollama
image, the vendored router, the captured active-model marker, and both models
present on the source host.

```sh
git clone https://github.com/astigmatism/dsh-container.git
cd dsh-container
./scripts/configure.sh --bind-address 192.168.1.50
# Review GPU/model values in .env, especially LLAMA_ARG_TENSOR_SPLIT.
./scripts/deploy.sh --managed-ollama
```

Managed mode requires the NVIDIA Container Toolkit and enough storage/VRAM for
the selected models. Its first start pulls approximately 58 GB. Set
`PULL_OLLAMA_MODELS=0` if the model store is already populated, or edit
`config/ollama-models.txt` if only the active model should be installed. The
source stack selected three GPUs; review both `GPU_DEVICE_IDS` and the captured
`15,10,8` tensor split whenever the destination GPU layout differs.

All modes bind to loopback unless `--bind-address` is supplied. The router's
admin ports remain loopback-only by default even when Harness is exposed on a
trusted LAN.

`DSH_DEPLOYMENT_MODE` starts blank in a newly generated `.env`.
`deploy.sh` atomically records its explicit external, remote, or managed mode
before it can change Compose state, so even a failed first deployment retains
an unambiguous intended topology. It refuses a duplicated or conflicting
existing value. Maintenance requires exactly one non-empty mode and refuses
any disagreement with the running Compose labels, including when a mode flag
is supplied explicitly.

## Persisted settings lifecycle

`config/settings.yaml` seeds **Daytime (128K)** through
`local-ollama/local-active` and **Nighttime (128K)** through
`local-everyday/qwen3.8-27b-abliterated-q6_k`. Each resident model has one
independent generation slot. The former 256K selection is retired.

The discovery plugin reads each model's router metadata, including
`x_ollama_router.display_name`, context, concurrency, modalities and effort
mappings. Daytime supports text, images, tools and reasoning; Nighttime supports
text and reasoning. Stable API IDs remain separate from display names.
Discovery provisions Nighttime and removes the obsolete 256K provider, moving
a retired default back to Daytime. Existing deliberate effort choices remain.

A normal image update atomically reconciles the known providers in the
entrypoint before Harness launches; the refreshed plugin then maintains them
through DSH's settings service. It validates the target metadata
and inherited effort before provisioning Nighttime, applies each model's actual
capacity and modalities, and removes only the recognized legacy 256K route.
A default selecting that retired route moves to the primary while preserving
its explicit effort. Unrelated providers, model properties and settings remain.
Discovery failure leaves the file unchanged and the application available;
provider verification still fails until the contract is synchronized. No manual
production settings migration is required. The optional
`scripts/migrate-resident-models.mjs` uses the same synchronization for explicit
local maintenance and keeps a private backup when it changes a file.

Both providers seed medium as an explicit DSH preference. Existing agent,
request and provider choices are preserved; the router's raw `default` remains
template-defined. Output capability maxima are null under the current
unrestricted policy, so no positive request allowance, enabled thinking budget
or total generation deadline is injected. Explicit off and finite allowances
remain caller choices. The installed SDK patch preserves those choices and
leaves connection/progress/stall handling to the router. The build tests actual
installed SDK requests so null cannot become a fallback allowance.

The discovery plugin and both readiness scripts share one resolver and validator.
They accept the legacy exact alias, canonical entries with alias metadata, and
explicit alias rows whose metadata agrees with the canonical target. Unknown,
partial or contradictory output policy fails validation. The remote verifier
compares persisted context, concurrency, output and effort mappings with current
router metadata and retains the primary route's vision/tool requirements;
browser readiness validates the selected route. It does not require the
text-only secondary to advertise vision or tools.

Automatic and manual compaction and replay-safe tool pruning remain enabled.
The 70% working-context trigger is 91,750 tokens for both Daytime and
Nighttime. Summaries have no injected output quota; full original events remain
in durable session storage. Working-context summaries are lossy. The router
counts actual formatted input and rejects infeasible explicit allowances
without clipping them. See `scripts/patch-unrestricted-policy.mjs` and
`scripts/verify-unrestricted-wire.mjs` for the deployed integration.

The shared DSH overflow classifier is patched to recognize the router's
`CONTEXT_LIMIT_EXCEEDED` code and its “formatted input … exceeds the … token
slot” wording, while retaining all existing context-length/window forms. The
adapter preserves the complete human-readable provider detail but emits the
canonical `CONTEXT_WINDOW_EXCEEDED` failure code. That code is deliberately not
in ordinary retry policy: `compaction-basic` prunes, compacts a balanced durable
region, checkpoints it, and retries from the reduced surface at most once. If
no replacement advances the surface, the original provider failure remains
explicit.

An already-ended failed turn is never resumed automatically during deployment.
After the owner opens that task, the safest explicit recovery is to submit
`/compact`, wait for its successful checkpoint result, and then send
`Continue from where the failed turn stopped.` A normal continuation also runs
the proactive `agent/pre-step` policy before dispatch, but `/compact` makes the
one-time recovery visible and complete while the task is idle.

The Web profile also maintains a semantic-progress ledger for each human turn.
The ledger is held outside the transcript, survives automatic compaction, and
stores only counters, safe action categories, and hashes of canonical tool
semantics or normalized reasoning prefixes. It never records source, prompt,
reasoning, credential, or raw tool-argument text in routine telemetry. Exact
duplicate reads are suppressed once and cancel the turn if immediately retried;
a successful mutation or a new relevant test result advances the progress
epoch and permits a changed file to be read again.

Distinct repository reads and model continuations are not capped by raw action
counts, so broad discovery can inspect as many unique files, ranges, or related
implementation questions as the work requires. Exact duplicate reads are still
suppressed. For implementation requests with write-capable tools, a nonblocking
checkpoint at continuation 12 asks the model to begin implementation when its
discovery is complete, but never cancels a turn merely because it is still
gathering distinct evidence. Normalized reasoning prefixes of at least 128
characters direct on their second occurrence and stop on their third. These
values are centralized under
`dsh-loop-detector` in `seed/profile/cordis.patch.yml`. Diagnosis and review
tasks remain read-only; duplicate-read and reasoning-cycle protection still
applies. Semantic guard cancellations use distinct reason codes and accurately
report whether implementation occurred, while the character-level repetition
detector remains enabled as an independent secondary defense. None of these
policies changes the selected model, reasoning effort, context window, sampling,
or concurrency.

Both providers declare `maxConcurrency: 1`. The adapter keeps provider gates
independent, and both resident models may run simultaneously. The router queues
same-backend contention without disturbing an active generation.

Busy/rate-limit, server, transport, and empty-response failures retain at most
two bounded Harness retries; the underlying SDK retry loop is disabled.
Timeout and context-overflow failures are not in that retry set. Unrestricted local generation has no total client deadline; its stream-idle
setting defers to router backend-progress detection. Both routes set `cacheRetention: none` so pi-ai omits an unnecessary OpenAI
`prompt_cache_key` field; the production backend still performs its own
volatile slot-prefix caching. Reasoning summaries and opaque signatures are
stored separately in replay state and reconstructed before tool calls on
tool-result continuations.

`scripts/configure.sh` atomically initializes a missing
`data/dsh/settings.yaml` from that canonical file with the configured
`HOST_UID:HOST_GID` ownership and mode `0644`. Container startup performs the
same initialization defensively. It also recognizes and repairs the zero-byte
mountpoint left by the repository's original nested settings bind mount, with a
distinct diagnostic. After initialization, a non-empty persisted file is the
machine's runtime source of truth. DSH may atomically reserialize it and save it
with mode `0600`; that is expected. Non-empty divergent settings are preserved
and are never overwritten by setup, startup, or maintenance.

After confirming that the canonical file is intended for a particular existing
consumer, an operator may explicitly reconcile only a zero-byte placeholder:

```sh
sudo ./scripts/initialize-persisted-settings.sh --replace-empty
```

The initializer refuses a non-empty divergent file even with that flag. It
stages content in the persisted directory, applies service ownership and mode
`0644`, rechecks the original state, and replaces the empty file atomically.
The maintenance verifier requires a regular, non-empty file owned by the
configured service identity. It accepts secure modes `0600`, `0640`, and
`0644`; it reports whether the content differs from the defaults without
blocking or replacing machine-specific runtime settings.

## First login and TLS

The gateway uses the intentionally tracked, source-managed home-network login
on every deployment:

```text
username: astigmatism
password: ICar12..
```

On startup, the gateway replaces any divergent persisted login hash with these
credentials, while continuing to store only the PBKDF2 hash in runtime data.
The plaintext default is public repository configuration by design; do not
expose the gateway outside the trusted home network without replacing this
policy.

Open `http://HOST:3081/` for the portable, no-certificate-install login. Browser
navigation opens a normal sign-in page and creates an HTTP-only, same-site
session cookie after the stored gateway credentials are accepted. HTTP Basic
Auth remains available for non-browser clients. Sessions last up to 12 hours
and are invalidated when the gateway restarts.

Harness `0.1.5-alpha.1` also authenticates its own browser and RPC carrier.
The container entrypoint generates a fresh 32-byte launch token on every
start, stores it as `data/backend-auth/launch-token` with mode `0600`, and supplies
the same value to Harness. The gateway sees that file through a read-only
mount, exchanges it over the shared loopback namespace for Harness's
authority-bound cookie, and adds that cookie only after the existing external
gateway authentication succeeds. The private token and upstream cookie are
never sent to the browser. Deployment verification requires a real HTTPS page
request to pass through both authentication layers, not merely the gateway's
own health endpoint.

HTTPS remains available at `https://HOST:3443/` when browser microphone access
is needed. That optional path requires downloading `http://HOST:3081/ca.crt`
and trusting the local CA on the browser device; ordinary Harness use does not.

## Speech-to-text and text-to-speech

The captured `.env.example` points at the private voice host on `192.168.1.22`.
The speech button sends recordings only to the authenticated gateway at
`/local-stt/transcriptions`; the gateway adds the STT key and forwards them to
faster-whisper. The corresponding TTS proxy is `/local-tts/speech`, defaulting
to model `tts-1` and Kokoro voice `af_heart` when a client omits them.

The home-network STT token is intentionally tracked so a fresh Harness
deployment has working dictation. The distinct TTS token remains ignored:

- `secrets/stt_api_key` — tracked home-network configuration
- `secrets/tts_api_key` — ignored deployment-local configuration

An empty URL or key disables only that speech service. The Docker build context
excludes `secrets/`, so neither key is built into an image, returned in the
`/local-stt/config` or `/local-tts/config` responses, sent to the browser, or
mounted into Harness. Compose mounts the required key only into the gateway.

To replace the tracked STT token from an OpenWebUI SQLite database without
printing it:

```sh
./scripts/import-openwebui-stt.py \
  --database /path/to/open-webui/data/webui.db \
  --output ./secrets/stt_api_key
```

To reproduce the full GPU voice stack on a Linux/NVIDIA host, review
`speech/README.md`, copy `speech/.env.example` to `speech/.env`, and deploy
`speech/compose.yaml`. Its source revisions, image digests, model identifiers,
and captured reference test are in `config/speech.lock.json`.

Run a live TTS-to-STT round trip against the configured voice services:

```sh
./scripts/verify-speech.sh
```

Dictation is a required deployment invariant. Image qualification renders the
current Harness composer and fails unless the local microphone control mounts.
Every `deploy.sh` and `update-and-restart.sh` run also executes the same check
against the deployed browser client, then requires the authenticated
`/local-stt/config` route, expected STT model, non-empty private key, and live
STT health. An update cannot be reported successful if any part of that
contract is missing.

## Moving existing runtime state

Fresh deployment is the safer default. To retain existing sessions and the
same gateway TLS identity, stop the source stack and securely copy ignored runtime
state into the same paths in this checkout. To keep the canonical software and
plugin set, do not copy `data/dsh/profiles/`, `data/dsh/.dsh-plugins/`, or an
old `settings.yaml`; the container will seed those from the repository image.

- selected contents of `data/dsh/` — sessions, indexes, and workspace metadata,
  excluding the software/profile paths named above.
- `data/gateway/` — password hash, local CA private key, and certificates.
- `data/router/` and `data/router-runtime/` — managed-router logs and active
  model marker, if using managed mode.
- `data/ollama/` — optional large Ollama store; copying it avoids model pulls.

Do not commit any of those directories. A copied `data/dsh/profiles/web`
is replaced from the image on every container start, as is
`data/dsh/.dsh-plugins`. This makes the repository authoritative for plugin
additions, removals, versions, patches, and lockfiles while preserving session
and workspace data.

## Host maintenance boundary

Harness runs as the configured UID/GID, mounts the broadest portable host
filesystem scope at `/host`, and has the Docker socket. This is Unix root on a
native Linux Docker Engine and the system drive on native Windows Compose. The
`--workspace` configuration option can deliberately narrow that scope while
keeping the container path `/host`. `nvidia-smi` is a constrained disposable
container proxy. `host-exec` is intentionally more powerful on a native Linux
host: it launches a short-lived privileged helper, enters the host namespaces,
and executes as host root.

The Harness process itself runs in headless Linux, so it must not dispatch
assistant-produced paths through `xdg-open` inside the container. The current
upstream release instead maps workspace paths to `dsh-resource://file/`
addresses and opens them in Harness's in-app workspace resource viewer. The
image build verifies that contract against the exact pinned browser bundles;
an upstream layout or behavior change fails the build rather than silently
restoring native host dispatch.

Docker Desktop's Linux VM is not the Windows kernel. On Windows, Harness can
manage the mounted Windows files and Docker resources, but `host-exec` cannot
run native Windows programs or administer Windows services. That requires a
separate Windows-native helper rather than a Linux-container setting.

The default Harness permission preset is `danger-full-access`. This is a server
maintenance agent with effective host-root capability, not a multi-tenant web
application. Keep it on loopback, a trusted LAN, or a VPN; do not publish it
directly to the Internet. Review `compose.yaml`, `scripts/host-exec.sh`, and the
gateway code before deployment.

## Boot and auto-start

Both containers run with `restart: unless-stopped`, so the Docker Engine
restarts them as soon as the daemon starts after a reboot. That start happens
before the host's LAN address exists, so the harness cannot publish its ports
on `HARNESS_BIND_ADDRESS` yet. In external mode the problem is worse: the
harness joins the shared Ollama network (`OLLAMA_NETWORK`, normally
`local-ai-ollama_default`), which the host's local-ai bootstrap destroys and
replaces on every boot, so the harness loses that attachment even while it is
running.

The repository therefore ships an after-network boot service that repairs the
deployment once the network is actually up:

- `start-after-network.sh` (project root) — waits for the Docker daemon, the
  `HARNESS_BIND_ADDRESS` LAN address, the local-ai bootstrap
  (`local-ai-apply-default.service` or the user
  `local-ai-apply-default-after-network.service`), and, in external mode, the
  shared network. It then verifies the harness port binding and network
  attachment. When either is missing it recreates the harness for the recorded
  `DSH_DEPLOYMENT_MODE` with
  `docker compose up -d --force-recreate --no-deps harness`, waits up to
  240 seconds for the harness healthcheck — exiting 1 with a clear message on
  timeout so a broken image fails the unit visibly instead of hanging the
  boot — then recreates the gateway and re-verifies binding, attachment, and
  gateway status. A healthy deployment is a fast no-op that exits 0.
- `deploy/deepseek-harness-after-network.service` — the canonical user unit
  template (`Type=oneshot`, `RemainAfterExit=yes`, `Restart=on-failure`,
  `RestartPreventExitStatus=78`, `RestartSec=10`,
  `TimeoutStartSec=infinity`, wanted by `default.target`). Configuration
  failures use exit 78 and therefore do not enter a restart loop; transient
  runtime failures remain retryable.
  The unbounded start timeout is intentional: the pre-recreate waits
  legitimately run long early in boot, while the recreate wait is bounded
  inside the script.
- `scripts/install-boot-service.sh` — idempotent, content-driven installer.
  It renders the template for this checkout into
  `~/.config/systemd/user/`, creates the `default.target.wants` symlink, then
  `systemctl --user daemon-reload` and `start` (or `restart`) the unit.
  Identical files cause no writes and normally no reload. When the user bus is
  unreachable (for example from a maintenance container without the host user
  session) it still installs the files, prints the exact commands to run on
  the host, and exits 0. `--dry-run` previews the rendered unit and the
  planned actions without changing anything. `--defer-activation` converges
  only the on-disk files and enablement; deployment and maintenance use it as
  a preflight before any Compose mutation.
  The installer also removes the exact obsolete
  `10-project-path.conf` shell-wrapper drop-in from early installations. It
  preserves other user drop-ins and refuses an unrecognized `ExecStart`
  override with a diagnostic instead of deleting user-authored configuration.
  It also reloads once if unchanged files leave the user manager exposing a
  stale effective `ExecStart` from an earlier bus-unreachable migration.

`scripts/deploy.sh` and `scripts/update-and-restart.sh` treat this on-disk boot
integration as a required deployment invariant. They converge it before
building or changing services and activate it after successful deployment.
Maintenance performs this preflight before fetch. If the host home cannot be
resolved, mounted, inspected, or written, maintenance stops and records
`state=failed`, `failure_type=boot-service`, and the `boot_service` reason in
`data/maintenance-status`; it cannot report `state=ok`. An unavailable user
systemd bus is intentionally different: the canonical unit, recognized legacy
drop-in migration, and `default.target` link are still converged on disk, so
maintenance may succeed with `boot_service=warning:bus-unreachable` while
activation is deferred.

Check the service on the host as the deploying user:

```sh
systemctl --user status deepseek-harness-after-network
systemctl --user cat deepseek-harness-after-network
journalctl --user -u deepseek-harness-after-network --no-pager
```

A failed deployment leaves the unit as it was: if recreation fails at runtime,
the unit shows failed and systemd retries it every 10 seconds. Permanent
configuration failures exit 78 and remain failed without retrying. In either
case the deployment stays down until the next successful
`update-and-restart.sh`, `deploy.sh`, or boot-service run repairs it.

## Operations

Validate the repository and generated Compose configuration:

```sh
./scripts/configure.sh
./scripts/check.sh
```

Apply later repository/plugin updates without changing per-host configuration:

```sh
./scripts/update-and-restart.sh
```

The maintenance command infers the current Ollama mode, requires a clean and
fast-forwardable `main` checkout tracking the canonical `origin/main`, and
requires exactly one recorded deployment mode consistent with the running
Compose labels. It checks that the persisted `data/dsh/settings.yaml` is a
regular, non-empty file with the configured service ownership and a secure
mode before fetching. It does not require byte equality with repository
defaults, so DSH serialization changes and intentional per-machine settings
survive updates. Missing, empty, wrongly owned, or insecurely permissioned
settings stop maintenance before any Compose interruption. After
settings validation, the updater also requires boot-service files to converge
before fetch. After fast-forwarding, the original process transfers
its maintenance lock and status to the fetched updater and re-executes it. The
fetched code therefore performs the final preflight and Compose validation
before it can change services. During this handoff, exact legacy
`0.1.1-rc.2` package/image pins are atomically migrated to the qualified
`0.1.5-alpha.1` tag and its recorded upstream commit; deliberately customized
pins are left unchanged, and dry-run reports the migration without editing
`.env`. The fetched updater also records `DSH_TOKEN_ENABLED=false` when an
older `.env` has no token-plugin policy, while preserving an existing exact
`true` opt-in or `false` setting. Any other or duplicated value is rejected
before Compose is interrupted. This lets the same updater carry the release across existing home-network
deployments without replacing their model, router, credentials, or other
machine-local settings. The updater pulls non-buildable images and builds
the selected topology while the current deployment remains available, then uses
the normal verified deployment command without an explicit `compose down` or
`compose stop`. It creates no backup or rollback artifacts. After success it
removes only superseded image IDs captured directly from this Compose project's
containers. This remains reliable when an active container's original image tag
has been replaced or its old image-store record has been collected. It never
runs a global Docker prune. Remote-mode deployment additionally removes the
exact obsolete `deepseek-harness/ai-router` container only after direct-route
verification, while retaining its image and persistent data.

Delegated updates use the same pinned Docker CLI, Compose, and Buildx plugins
inside the maintenance image as direct updates. Service Portal receives the
explicit `HOST_HOME` deployment label and validates it, but exposes only that
home's `.config/systemd/user` directory with Docker's missing-source-safe mount
form. Harness-originated maintenance resolves the same home for the configured
numeric host UID through the host passwd database and verifies that both it and
its user-unit directory exist inside the configured host-filesystem view. The
project checkout remains a separate bind; the entire home is never mounted.
If either path cannot establish this narrow mount, the helper records a
blocking boot-service failure before any fetch, build, or service change. Each
maintenance lock records
whether its owner is a host process or an exact Docker container ID. A later
run refuses a live owner, but atomically reclaims a schema-1 lock when that
process has exited or that exact container no longer exists or is no longer
running. This prevents an interrupted Service Portal runner from permanently
blocking future update attempts; legacy PID-only locks remain fail-closed and
require operator inspection before removal.

The `harness` service is the only service carrying the Service Portal update
labels. The portal therefore offers one project-level update job for every
container in the active `deepseek-harness` project, including managed-mode
containers, while using the already-local `HARNESS_IMAGE` as its maintenance
runner. The optional `deepseek-harness-speech` project is intentionally not
opted in because it has a separate host configuration and deployment lifecycle.
After changing these labels, recreate the root project with its active Compose
overlay so Docker stores them on the `harness` container.

Service Portal updates run from an isolated maintenance container. Post-deploy
gateway verification detects that delegated context and performs the same
CA-validated HTTPS health probe inside the gateway container's network
namespace. Verification is not skipped or weakened, and failures retain the
normal updater exit classifications.

A single atomically replaced status file is kept at
`data/maintenance-status`. In addition to the mode, commits, and exit status,
it records `failure_type`, `failure_stage`, and recovery outcome. Failure types
distinguish Git state, deployment-mode inference, Docker/Compose, configuration
verification, boot-service convergence, model-provider or credential access,
and application health. `state=ok` requires successful on-disk boot-service
convergence; only activation may remain deferred when the user bus is
unreachable.

For an existing checkout, the supported redeployment is one normal update as
the deploying user:

```sh
./scripts/update-and-restart.sh
```

That run preserves `.env`, credentials, sessions, workspaces, gateway identity,
and other persistent data while migrating the narrowly recognized legacy
drop-in. If maintenance reports `boot_service=warning:bus-unreachable`, run the
three host-side `systemctl --user` commands shown by the installer; no file
edits are required. A fresh or deliberately selected-mode deployment continues
to use `./scripts/deploy.sh --external-ollama`, `--remote-ollama`, or
`--managed-ollama` as appropriate.

Preview the operation or select a mode explicitly:

```sh
./scripts/update-and-restart.sh --dry-run
./scripts/update-and-restart.sh --remote-ollama
```

When invoked by an AI inside Harness, the command delegates to a temporary
maintenance container so stopping Harness cannot interrupt its own update.
That helper and its Docker logs remove themselves afterward. See
`docs/maintenance-agent-prompt.md` for a reusable agent prompt.

The rebuild refreshes the canonical profile in the image, and container start
atomically replaces the runtime software-managed profile from that image.

Verify a running external, remote, or managed deployment:

```sh
./scripts/verify.sh --external-ollama
./scripts/verify.sh --remote-ollama
./scripts/verify.sh --managed-ollama
```

Routine Compose commands for the default direct-remote mode are standard:

```sh
docker compose ps
docker compose logs -f --tail=200
docker compose restart
docker compose down
```

For external mode, include its overlay:

```sh
docker compose -f compose.yaml -f compose.external-ollama.yaml ps
docker compose -f compose.yaml -f compose.external-ollama.yaml logs -f --tail=200
docker compose -f compose.yaml -f compose.external-ollama.yaml down
```

For managed mode, include the overlay:

```sh
docker compose -f compose.yaml -f compose.managed-ollama.yaml ps
docker compose -f compose.yaml -f compose.managed-ollama.yaml logs -f --tail=200
docker compose -f compose.yaml -f compose.managed-ollama.yaml down
```

`docker compose down` removes containers and Compose network state, but not the
ignored `data/`, `secrets/`, images, or mounted host workspace.
