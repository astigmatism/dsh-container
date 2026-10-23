# Moving DSH consumers between routers, one at a time

A network in transition runs several routers at once. Each DSH deployment picks
one with a single environment setting, moves independently, and keeps the router
it left as a backstop until it has verified on the new one. The application
mechanics are in [README.md](README.md#move-a-deployment-to-another-router);
this document records the precondition, the per-consumer procedure, and the
deployment list the procedure is run against.

## The precondition: schema-2 aware means safe to point at a multi-host router

A consumer older than `d2a0332cf6033b8d1103345d924bd46194226dee` — *"Label a
resident by the name the human is choosing, not by the model behind it"* (2026-10-21),
the first commit that introduced `alias_display_names` — must not be pointed at
a router where one model answers several service names. That router shape is
normal on a multi-host router, and a schema-1 revision titles every row it
serves from the model, so `daytime` and `nighttime` collapse into two picker
options with the same label and `scripts/verify-resident-client.mjs` fails on
the collision.

So for every revision that may ever be moved: **upgrade to `d2a0332` or later
first, then move the router.** The two steps are separate and independently
reversible; only the second one is a router change. The minimum safe revision is
therefore `d2a0332`, and `2b6250e4` (its immediate predecessor on `main`) is
the most recent revision that is *not* safe.

## The per-consumer procedure

```sh
# 0. Which router am I on now, and which would an update apply?
scripts/update-and-restart.sh router --manifest data/operations/deployment.json
# 1. Is the consumer on a schema-2-aware revision? Upgrade if it is not, and verify.
# 2. Move it (validates the endpoint, optionally probes the new router, writes one setting):
scripts/update-and-restart.sh set-router --router http://192.168.1.23:11434 --router-probe \
  --manifest data/operations/deployment.json
# 3. Apply it, like any other update: recreate, verify, roll back on failure.
scripts/update-and-restart.sh --manifest data/operations/deployment.json
# 4. Verify on the new router (model picker labels, inference, discovery refresh).
# 5. Leave the old router running. Roll back with the value step 2 printed.
```

Nothing here stops or restarts a router, and nothing here touches another
consumer. The previous router keeps serving everything that still names it,
which is why a migration can be gradual and why a retired router is a deliberate
decision made from the list below rather than an assumption.

## Deployments on this network

Enumerated from each host's own **Service Portal** (`/api/services`), which is
the authoritative registry of what that host runs, cross-checked against the two
routers' request history (`sourceIp` + `clientIdentity` per request) and against
each reachable host's container configuration. `docker ps` from one box and a
`:3443` sweep are *not* authoritative: `.20` and `.22` both run DSH with no
published `:3443`, so a sweep from this box sees nothing.

| Host | DSH | Revision (evidence) | Active router (evidence) | Safe to move to `.23`? |
|---|---|---|---|---|
| `192.168.1.7` pauline-host | yes | `d80608a` (this deployment) | `.23` (`compose.json`, `.env`) | already there |
| `192.168.1.4` rosalina | yes | `2b6250e4` (portal update check, 3 behind) | its own local router (`extra_hosts` empty; Docker DNS) | **no — upgrade first** |
| `192.168.1.5` samus | yes | `df6248a6` 2026-09-22 (portal update check, 83 behind) | `.4` (its requests appear in the `.4` router history as `deepseek-harness/samus-…`) | **no — upgrade first** |
| `192.168.1.8` daisy | yes | not reported by its portal; recorded as `2b6250e4` | `.4` (container `ExtraHosts: ai-router:192.168.1.4`) | **no — upgrade first** |
| `192.168.1.20` (Open WebUI host) | yes | not reported by its portal | **unknown** — absent from both routers' history | unknown — inspect first |
| `192.168.1.22` local-ai-voice | yes | checkout at `daf7b471` 2026-10-07; no portal update check | `.23` (container `ExtraHosts: ai-router:192.168.1.23`; `.env` agrees) | already on `.23`; **its revision predates `d2a0332`** |
| `192.168.1.23` local-ai-router | yes | not reported by its portal; recorded as `2b6250e4` | `.4` (container `ExtraHosts: ai-router:192.168.1.4`) | **no — upgrade first** |

The legacy `.4` router therefore still serves rosalina (its own), samus, daisy
and local-ai-router, plus non-DSH consumers (Open WebUI on `.20`, the Playroom).
It stays up.

## How to keep this list true

1. Ask every host's Service Portal for `/api/services` and select the
   `deepseek-harness` project. That is complete for hosts running a portal, and
   it reports the deployed revision wherever the update check is enabled.
2. For each DSH container, read the router it actually uses:
   `docker inspect --format '{{.HostConfig.ExtraHosts}}' <container>` (or
   `router` from its own deployment directory). This is the running truth, not
   what a file once said.
3. Cross-check both routers' request history by `sourceIp`: a router that a
   consumer's requests reach is a router that consumer uses, including hosts no
   probe can see.
4. `ssh` reachability is not part of the deployment topology: `samus` (`.5`) and
   `.20` run DSH but are not reachable from the inventory host, and `.22` binds
   `:3443` to its own address behind a host firewall that refuses the port from
   other hosts. A missing SSH session or a refused TCP probe is a gap in the
   evidence, never evidence of absence.
