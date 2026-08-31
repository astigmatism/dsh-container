# Portable DeepSeek Harness

This repository reconstructs the live `deepseek-harness` deployment captured
on 2026-08-31. It produces a reusable Harness image plus its authenticated HTTPS
gateway and can either join an existing Ollama router network or start a managed,
pinned Ollama/router stack.

The image is reproducible configuration, not a `docker commit` snapshot. Plugin
versions and patches are locked in Git; sessions, credentials, TLS private keys,
request logs, and 58 GB of model blobs are deliberately kept outside Git.

The captured base-image digests and release workflow target Linux `amd64`.
Destination hosts need Docker Engine with Compose v2; managed Ollama mode also
needs the NVIDIA Container Toolkit.

## Captured configuration

- DeepSeek Harness `0.1.1-rc.2`, pnpm `11.7.0`, Docker CLI `29.6.0`.
- Node 22 base pinned to the digest used by the source image.
- Ollama pinned to
  `sha256:77f1a2a54460f0380f2611e1464233d9b82cb6e58afc8f60abec0061049d2d82`.
- `local-active` OpenAI Responses model at `http://ai-router:11434/v1`.
- 131,072-token Harness context and Medium default reasoning.
- Active Ollama model `qwen3.8:27b-mtp-q8_0`, 262,144-token Ollama context,
  persistent keep-alive, one parallel request, one loaded model, flash attention,
  `f16` KV cache, and the captured reasoning-effort mapping.
- The vendored router is from
  `astigmatism/local-ai-ollama-router@8bd89e17dd5d5c34dc4c66a60ab0db817e2bb257`.

The locked web profile contains these seven plugins:

1. `@zoytown/dsh-token` 0.1.3
2. `dsh-context` 0.37.0
3. `dsh-local-speech-input` 0.1.0 (local)
4. `dsh-loop-detector` 1.0.0 with the captured local patch
5. `dsh-plugin-task-notification` 0.2.1 at commit
   `f10cd6869b7a50e55780627a6d55bbb310fd59b4`
6. `dsh-session-pin` 0.6.1
7. `dsh-ui-appearance` 0.1.6

The profile also disables DeepSeek's keyed web search and installs the captured
keyless DuckDuckGo/Bing fallback provider. See `config/plugins.lock.json` and
`seed/` for the exact manifest, lockfile, provider, and patch.

## Choose a deployment mode

External Ollama mode matches the source host most closely. It joins an existing
Docker network, and that network must expose the Responses-compatible router
under the alias `ai-router`.

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

Both modes bind to loopback unless `--bind-address` is supplied. The router's
admin ports remain loopback-only by default even when Harness is exposed on a
trusted LAN.

## First login and TLS

The gateway generates a private local CA, server certificate, and random Basic
Auth password on first start. Retrieve that first-start password without
printing any secrets from files:

```sh
docker compose logs gateway
```

Download `http://HOST:3081/ca.crt`, trust it on the browser device, and open
`https://HOST:3443/`. Microphone access requires a trusted HTTPS origin. Port
3081 serves only the public CA, health response, and redirects; it does not
serve Harness or credentials.

To replace the gateway password without putting it in shell history:

```sh
./scripts/change-password.py
docker compose restart gateway
```

## Optional speech-to-text

The speech button is always included, but reports itself disabled when no STT
endpoint/key is configured. Set `STT_BASE_URL` in `.env` and write the key to
`secrets/stt_api_key` with mode `0600`.

To import the configured key from an OpenWebUI SQLite database without printing
it:

```sh
./scripts/import-openwebui-stt.py \
  --database /path/to/open-webui/data/webui.db \
  --output ./secrets/stt_api_key
```

The key is mounted only into the gateway. It is not built into an image, sent
to the browser, or mounted into Harness.

## Moving existing runtime state

Fresh deployment is the safer default. To retain existing sessions and the
same gateway identity, stop the source stack and securely copy these ignored
directories to the same paths in this checkout:

- `data/dsh/` — sessions, profile state, indexes, and workspace metadata.
- `data/gateway/` — password hash, local CA private key, and certificates.
- `data/router/` and `data/router-runtime/` — managed-router logs and active
  model marker, if using managed mode.
- `data/ollama/` — optional large Ollama store; copying it avoids model pulls.

Do not commit any of those directories. Existing `data/dsh` takes precedence
over the image seed so user sessions and later profile changes are preserved.
For a clean plugin reset, archive `data/dsh` elsewhere and start with an empty
directory.

## Host maintenance boundary

Harness runs as the host UID/GID, mounts one host workspace at the same absolute
path, and has the Docker socket. `nvidia-smi` is a constrained disposable
container proxy. `host-exec` is intentionally more powerful: it launches a
short-lived privileged helper, enters the host namespaces, and executes as host
root.

The default Harness permission preset is `danger-full-access`. This is a server
maintenance agent with effective host-root capability, not a multi-tenant web
application. Keep it on loopback, a trusted LAN, or a VPN; do not publish it
directly to the Internet. Review `compose.yaml`, `scripts/host-exec.sh`, and the
gateway code before deployment.

## Operations

Validate the repository and generated Compose configuration:

```sh
./scripts/configure.sh
./scripts/check.sh
```

Verify a running external or managed deployment:

```sh
./scripts/verify.sh --external-ollama
./scripts/verify.sh --managed-ollama
```

Routine Compose commands for external mode are standard:

```sh
docker compose ps
docker compose logs -f --tail=200
docker compose restart
docker compose down
```

For managed mode, include the overlay:

```sh
docker compose -f compose.yaml -f compose.managed-ollama.yaml ps
docker compose -f compose.yaml -f compose.managed-ollama.yaml logs -f --tail=200
docker compose -f compose.yaml -f compose.managed-ollama.yaml down
```

`docker compose down` removes containers and Compose network state, but not the
ignored `data/`, `secrets/`, images, or mounted host workspace.
