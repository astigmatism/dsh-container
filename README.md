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

The `0.1.7-rc.2` upgrade passed the full automated Linux qualification, including
the portal updater's recovery rehearsal. No production or Mac installation has
been upgraded. See [qualification results, limitations and rollback instructions](docs/harness-0.1.7-upgrade.md)
before using the update workflow.

- DeepSeek Harness `0.1.7-rc.2`, the official package built from GitHub tag
  `dsh-v0.1.7-rc.2` at commit
  `477b4f420553e8a52c2fbccc464d7561b239c443`; pnpm `11.7.0`; Docker CLI
  `29.6.0`. The release and commit are immutable build inputs rather than a
  moving `master` reference.
- Node 22 base pinned to the digest used by the source image.
- Ollama pinned to
  `sha256:77f1a2a54460f0380f2611e1464233d9b82cb6e58afc8f60abec0061049d2d82`.
- Two resident OpenAI Responses models at `http://ai-router:11434/v1`:
  Daytime (128K) and Nighttime (128K), each with one independent generation slot
  and no inherited output ceiling.
- The model picker exposes exactly those two resident choices. The built-in
  DeepSeek adapter is disabled in the web profile. Startup and discovery refresh
  remove obsolete provider/model choices after validating both residents, while
  preserving credential storage, conversation history, and valid reasoning choices.
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

The locked web profile contains these ten plugins:

1. `@zoytown/dsh-token` 0.1.3 with a narrowly anchored session-format-v3
   compatibility patch, installed but disabled by default because its
   inode/device-sensitive refold path and per-frame synchronous Zstandard
   decompression have caused repeatable multi-gigabyte Harness RSS growth
2. `dsh-context` 0.56.1
3. `dsh-local-speech-input` 0.1.0 (local)
4. `dsh-loop-detector` 1.0.0 with the captured local patch
5. `dsh-playwright` 0.1.0 with its existing panel-layout patch and a narrowly
   anchored web-transport-scope compatibility patch, with the web-server
   dependency declared at the profile loader boundary; it provides the shared
   Browser Use panel and model-facing Playwright tools
6. `dsh-plugin-task-notification` 0.2.1 at commit
   `f10cd6869b7a50e55780627a6d55bbb310fd59b4`
7. `dsh-session-pin` 0.7.15
8. `dsh-ui-appearance` 0.1.11
9. `dsh-favicon-status` 0.1.0-rc.8 (published without a manifest BOM)
10. `dsh-better-sidebar` 0.21.1 with task views and session file activity;
    terminal and image/PDF rendering use the upstream Harness implementations

The profile also disables DeepSeek's keyed web search and installs the captured
keyless DuckDuckGo/Bing fallback provider. See `config/plugins.lock.json` and
`seed/` for the exact manifest, lockfile, provider, and patch.

The upstream repositories were rechecked on 2026-09-24. Their current heads
still publish `@zoytown/dsh-token` 0.1.3 and `dsh-playwright` 0.1.0; the exact
observed commits are recorded in `config/plugins.lock.json`. No unpublished
token-memory repair or newer shared-panel implementation was available to
adopt.

Token statistics are the only deliberately unavailable default feature. There
is no fixed `@zoytown/dsh-token` release whose memory behavior can be proven
bounded. The retained v3 reader has not been qualified for v4 versioned session files.
`DSH_TOKEN_ENABLED=true` is an unsupported diagnostic opt-in, not a qualified
feature of this release. Omitting the variable
or setting it to `false` keeps both the host scanner and token-statistics UI
unloaded; package installation alone does not enable them.

After deploying a host with the incident data, run
`./scripts/verify-dsh-token-memory.sh --require-incident-fixture`. It requires
the 52-artifact fixture, samples the Harness Node RSS at startup and across
three 35-second boundaries (longer than the plugin's 30-second refresh), and
fails on monotonic growth, excessive RSS/growth, an OOM flag, a restart or
recreation, or any write to the disabled plugin's durable index.

## Native terminal workflow

Harness 0.1.7-rc.2 owns the terminal in the right sidebar. Open a conversation,
add a **Terminal** tab, and select Bash. The shell runs inside the container in
that session's workspace. Output streams as it arrives; reconnecting restores
the retained screen, and closing the terminal ends its process. Processes do
not survive a Harness restart.

Agent tools follow the selected preset. Standard uses Bash and background
jobs; Minimal has a persistent Bash session. The upgrade preserves the user's
preset selection. Better Sidebar 0.21.1 no longer supplies `terminal_*` tools.
The existing Playwright **Browser Use** panel and Sidebar file activity remain.

The image compiles the core `node-pty` dependency, then exercises a real PTY.
Authenticated browser qualification checks the terminal tab, incremental output,
reconnect, interactive input, Ctrl-C, session isolation and process cleanup.
For the isolated local browser/terminal/file-preview check:

```sh
docker exec deepseek-harness node /opt/dsh-build/verify-sidebar-client.mjs --live
```

See [the upgrade and rollback procedure](docs/harness-0.1.7-upgrade.md) before
recreating an existing installation. Rollback requires both the previous image
and the pre-upgrade data snapshot.

## Shared browser and visual validation

The web profile includes `dsh-playwright`, which runs a headless Chromium page
per DSH session and streams that same page into the in-app Browser Use panel.
The model can navigate, inspect semantic snapshots, click or type, and request
PNG screenshots through DSH's native image-attachment path. Both local model
routes declare image input, and the production Responses router accepts
image-bearing function-call results directly.

The pinned alpha.1 Connection registry needs the plugin's web context passed
explicitly when registering Browser Use controls. The version-checked build
patch retains the existing authentication and request checks. The disposable
browser gate exercises the panel's control RPC, local HTTP navigation, private
subresources, and rendered screenshot, as well as the stream upgrade route.

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
mappings. Both resident models advertise their actual input and tool capabilities.
Daytime currently selects Qwen3.8-Flash-Next AD-4.27 at 128K. Switching the
model host to `daytime-27b` advertises the original 27B model at 160K; discovery
and the Update and Restart verifier follow that advertised label and capacity.
The live picker and context meter are checked against validated router metadata,
while offline image checks use their isolated seed settings. No Harness source
edit is needed when switching between these profiles.
Stable API IDs remain separate from display names. Discovery converges the
picker to Daytime and Nighttime, moving removed defaults back to Daytime while
preserving supported reasoning choices.

A normal image update atomically reconciles the known providers in the
entrypoint before Harness launches; the refreshed plugin then maintains them
through DSH's settings service. It validates the target metadata
and inherited effort before provisioning Nighttime, applies each model's actual
capacity and modalities, and removes all other selectable provider/model rows.
Model properties, credential storage, conversation history and unrelated
non-model settings remain. The built-in DeepSeek adapter is disabled by the
versioned profile, so updates cannot repopulate its default model menu.
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
The 70% working-context trigger is 114,688 tokens for Daytime and
91,750 tokens for Nighttime. Summaries have no injected output quota; full original events remain
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
`dsh-loop-detector` in `seed/profile/managed/cordis.patch.yml`. Diagnosis and review
tasks remain read-only; duplicate-read and reasoning-cycle protection still
applies. Semantic guard cancellations use distinct reason codes and accurately
report whether implementation occurred, while the character-level repetition
detector remains enabled as an independent secondary defense. None of these
policies changes the selected model, reasoning effort, context window, sampling,
or concurrency.

Recognized shell test commands (`pytest`, `python -m pytest`, npm/pnpm/yarn/bun
`test`, `node --test`, and the common Go/Rust/Java/.NET test runners) must run
in the foreground. Background test requests receive an actionable error before
spawning a job. The native shell executor owns the deadline and process-tree
cleanup: `bash-sandbox` defaults foreground commands to 120 seconds and honors
explicit `timeoutMs` requests up to 600 seconds. This default also applies to
other foreground shell commands. The loop detector does not add another timer
or shorten an explicit deadline. Timeout results retain partial stdout/stderr
and spill-file references, with the actual timeout and recovery guidance.
User Stop remains caller cancellation and never counts as a timeout strike.

Two timeouts for the same test invocation without a source mutation or a new
completed-test milestone pause the turn with `repeated_test_timeout`. Simple
pytest invocations normalize runner/verbosity wrappers while retaining test
selectors. Dynamic or compound shell commands use their complete invocation
and working directory; `$f.py` is never mistaken for a literal test filename.
A normal failed assertion provides evidence. The guard survives transcript
compaction and resets on a new human turn. Background development servers keep
their existing policy. Indirect shell scripts and arbitrary custom runners
cannot always be recognized; explicitly bound those commands when diagnosing
a hang. A timeout alone does not establish a deadlock.

These corrections live in this repository's maintained plugin patch and Web
profile, not in manually edited installed packages or upstream Harness source.
Release the committed integration source through the normal update workflow
to every Harness installation: qualify the shipping Linux images in GitHub CI,
then use the normal deployment workflow when a production update is authorized.
Do not start Docker on the Mac for qualification. The frozen plugin
lock and image qualification verify that subsequent builds retain the patch;
upstream upgrades must refresh and requalify it when necessary.

The running status now shows the current step number, time in that step, and
total turn duration. A long turn with advancing steps is distinguishable from
one long step; the clock does not claim that the model is making useful
progress. Reloading the page retains the durable turn/step time anchors.

Both providers declare `maxConcurrency: 1`. The adapter keeps provider gates
independent, and both resident models may run simultaneously. The router queues
same-backend contention without disturbing an active generation.

Busy/rate-limit, server, transport, and empty-response failures retain at most
two bounded Harness retries; the underlying SDK retry loop is disabled.
Timeout and context-overflow failures are not in that retry set. Unrestricted
local generation has no total client deadline or implicit output quota. The
Harness now honors `streamIdleTimeoutMs` even for unrestricted models (fifteen
minutes in the seeded settings), independently of the router's backend-progress
watchdog. Inactivity expiry and user Stop close the HTTP request and response
body, release the provider slot, and preserve the durable task history. A
stream that continues producing model events resets the inactivity timer.
Existing installations preserve their provider settings; set each provider's
`streamIdleTimeoutMs` to `900000` through Harness settings to adopt this allowance.
Both routes set `cacheRetention: none` so pi-ai omits an unnecessary OpenAI
`prompt_cache_key` field; the production backend still performs its own
volatile slot-prefix caching. Reasoning summaries and opaque signatures are
stored separately in replay state and reconstructed before tool calls on
tool-result continuations.

`scripts/configure.sh` initializes missing legacy settings from
`config/settings.yaml`. On first 0.1.7 startup, the repository migrator moves
those values into `data/dsh/profiles/web/cordis.patch.yml`, maps renamed settings
namespaces, archives `settings.yaml` as `settings.yaml.imported`, and retains
`profile-before-0.1.7.yaml`. Invalid inputs stop startup before Harness launches.

The `dsh-container-profile` bundle under `seed/profile/managed/` owns maintained
defaults. The final writable profile owns user preferences and is never replaced
by runtime synchronization. The `.container-settings-v1.json` receipt prevents
subsequent startup/configuration runs from recreating `settings.yaml`. Settings
may be saved atomically with mode `0600`; `0600`, `0640` and `0644` are accepted
by verification. The service UID must own the file.

The build applies the maintained compaction and pruning policy inside every
shipped agent preset: 70% pressure for both resident models, zero extra headroom,
one overflow recovery, and no injected summary-output quota. Host copies stay
disabled to avoid duplicate services. Persisted custom preset definitions retain
precedence over these defaults.

## First login and TLS

The gateway requires a deployment-local username and password. On first setup,
`configure.sh` generates a random password and records it only in the ignored,
mode-0600 `.env` file. It never prints the value. Inspect that file privately
when signing in. No shared login or fallback password is built into the gateway.

Updates automatically migrate an existing gateway login into the private `.env`
before Compose validation. The updater verifies the container's project, checkout,
gateway data mount, and persisted login hash, then saves the same credentials
without printing or rotating them. Configuration, deployment, and boot recovery
use the same preflight. Valid private credentials are retained unchanged.
`python3 scripts/gateway-credentials.py --check .env` checks migration feasibility
without writing anything; the updater's `--dry-run` includes this check.

If the existing gateway cannot be verified or credentials conflict, maintenance
stops before changing services. Provision the login privately with
`./scripts/change-password.py --username YOUR_USER`, which accepts
passwords of at least eight characters, updates only the private `.env`, and
never places the password in shell history. Recreate the gateway with your
normal mode's Compose files (`up -d --no-deps gateway`) to activate the change;
`docker compose restart` alone does not reload environment variables. Startup
converges the private PBKDF2 hash to the configured login, preserving a matching
hash across restarts. Other deployment settings and conversation data remain.

Open `http://HOST:3081/` for the portable, no-certificate-install login. Browser
navigation opens a normal sign-in page and creates an HTTP-only, same-site
session cookie after the stored gateway credentials are accepted. HTTP Basic
Auth remains available for non-browser clients. Sessions last 30 days by
default and are persisted in `data/gateway/sessions.json`, so they survive
gateway restarts until they expire. Override the lifetime in seconds with
`HARNESS_SESSION_TTL_SECONDS` in the private `.env`.

Harness `0.1.7-rc.2` also authenticates its own browser and RPC carrier.
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

An empty URL or key disables only that speech service. Deployment verification
checks the authenticated disabled response when the STT URL is empty; a
configured URL still requires its key and a healthy backend. The Docker build context
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
plugin set, omit installed `node_modules` and `data/dsh/.dsh-plugins/`. Preserve
the writable `profiles/web/cordis.patch.yml`, migration receipt and archived
inputs. For a pre-0.1.7 source, retain `settings.yaml` and its profile patch so
the one-time migration can preserve preferences.

- selected contents of `data/dsh/` — sessions, indexes, and workspace metadata,
  excluding installed dependencies and managed software paths.
- `data/gateway/` — password hash, session store, local CA private key, and certificates.
- `data/router/` and `data/router-runtime/` — managed-router logs and active
  model marker, if using managed mode.
- `data/ollama/` — optional large Ollama store; copying it avoids model pulls.

Do not commit any of those directories. Startup synchronizes managed profile
software and `data/dsh/.dsh-plugins` from the image, while preserving the writable
web profile patch, sessions and workspace data.

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

The pinned `dsh-better-sidebar` 0.21.1 viewer also receives a version-checked
build patch. Session-relative resources resolve against the referenced session's
working directory before entering the shared image, text, HTML, PDF, and download
adapter. Restored tabs wait for the session directory to load; absolute paths and
server-side filesystem containment remain unchanged. Image failures display an
error with Retry. Headless hosts keep native application actions disabled without
showing a desktop warning on working in-app preview cards. The build and deployment
checks verify this patch; an upstream version or bundle change requires review.
HTML documents retain the existing opaque-origin sandbox, whose request fence
rejects linked local assets. Full local sites with assets can run in Browser Use
when private hosts are enabled.

The CLI's dependency graph is also locked in `config/dsh-runtime.package-lock.json`
and installed with `npm ci`. Pinning only the top-level CLI admits newer internal
prereleases through upstream caret ranges. This lock pins every Harness package
to 0.1.7-rc.2 and Cordis to 4.0.4, using published packages resolved on
2026-09-24. Regenerate and review both locks with any Harness upgrade.

Ordinary `docker compose build` uses the Harness version and upstream commit
pinned in `Dockerfile` on Windows, macOS, and Linux. Legacy `DSH_VERSION` and
`DSH_UPSTREAM_COMMIT` values in `.env` or the calling shell are ignored, so an
older deployment configuration cannot select a runtime incompatible with the
checked-in dependency lock. Keep host-specific `.env` settings when pulling
updates; there is no need to regenerate that file. `HARNESS_IMAGE` remains a
customizable image name/tag, not a runtime version selector. The updater retains
its existing migration of recognized legacy image tags. Deployment verification
checks the installed version and image provenance against the repository pins.
Deliberate Harness upgrades must update the Dockerfile pins, runtime/profile
locks, and version-specific patches together.

Browser access to localhost, container addresses, and LAN destinations is controlled
separately by `DSH_BROWSER_ALLOW_PRIVATE_HOSTS` in the deployment's `.env`.
Set it to `true` for deployments that need to browse their own services, then run
the normal update workflow to recreate the container. This also permits private
subresources. The repository default remains `false`; this switch does not provide
a native desktop or change file-viewer permissions.

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
  900 seconds for the harness healthcheck, covering Compose's ten-minute
  startup grace for cold profile copies and its retry window — exiting 1 with
  a clear message on timeout so a broken image fails the unit visibly instead
  of hanging the boot — then recreates the gateway and re-verifies binding, attachment, and
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

Every Harness deployment must expose the Service Portal **Update and restart**
button. The shared updater fetches a pinned source release into temporary storage,
builds and verifies images, snapshots application state, and performs a verified
redeployment with automatic rollback. A retained source checkout is not required.
No local override may disable the update capability.

Set the deployment-local `SERVICE_PORTAL_URL` before installation. Existing
installations require one reviewed adoption through `scripts/deploy.sh --adopt`;
this installs a private operational bundle without rewriting checkout contents,
credentials, sessions, or machine-local settings. No production deployment is
implied by a repository update.

See [portable maintenance, custom Compose adoption, and recovery](docs/portable-maintenance.md)
for commands, configuration, external TLS support, and qualification. The existing
remote, external, and managed topologies and intentional model/speech endpoints
remain supported. Use `./scripts/check.sh --host` for checks without Docker;
container qualification runs with `./scripts/check.sh --build` in GitHub CI.

The rebuild refreshes the canonical profile in the image, and container start
synchronizes the runtime software-managed profile from that image. It compares
file contents, repairs changed or missing files, and removes obsolete plugins
while leaving matching dependencies in place. This avoids copying and deleting
thousands of unchanged files on Docker Desktop host mounts at every restart.
Changed files are replaced atomically, and Harness starts only after the full
synchronization succeeds. Saved settings and sessions are outside these managed
directories and remain intact.

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
