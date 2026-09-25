# Portable Service Portal maintenance

Every Harness deployment must expose Service Portal **Update and restart**.
There is no opt-out. Installation, adoption, updates, and verification share
the same capability validator. A reachable deployment-local Portal URL is
required, and updates succeed only after the Portal discovers the recreated
application container and confirms its update capability.

The remote (also portable/default), external, and managed topologies remain.
Intentional model-router and speech-service endpoints retain their existing
defaults. No destination-specific profile is needed: addresses, ports, users,
mounts, credentials, certificates and local entrypoints belong to the deployment.

## Initial installation and adoption

Bootstrap requires Python 3.11+, Git, Docker Engine and Compose v2 on the
installation host. Use reviewed source, run configuration once for a new
installation, and set `SERVICE_PORTAL_URL` in the private `.env` file. Existing
installations must retain their credentials and configuration; do not regenerate
them. Finish active application work before installing or updating.

From the reviewed source directory, preview and install a portable deployment:

```sh
./scripts/deploy.sh --remote-ollama --dry-run
./scripts/deploy.sh --remote-ollama
```

Use the existing external or managed mode flag for those topologies. When no
flag is supplied the recorded mode is preserved, or remote is selected for a
new configuration. Conflicting or duplicated recorded modes are rejected.

For an existing custom Compose deployment, use the generic adoption interface:

```sh
./scripts/deploy.sh --adopt \
  --project-directory /srv/example-app \
  --compose-file /srv/example-app/compose.yaml \
  --env-file /srv/example-app/private.env \
  --deployment-dir /srv/example-app/operations \
  --portal-url https://portal.example.test \
  --role application=harness --role edge=gateway \
  --dry-run
```

These are synthetic paths and names. Remove `--dry-run` to install. Repeat
`--compose-file` in merge order for local overrides. Standard service names are
recognized automatically; otherwise map every source-built service with
`--role SERVICE=harness`, `gateway`, or `router`. Managed router initialization
and router services share the router role. Other application images must be
digest-pinned. Named-volume application state must be migrated to explicit bind
mounts before adoption; it is never silently omitted from recovery.

Known application-state bind destinations are classified automatically. Declare
additional writable application state with `--state-path PATH`. Declare host
workspaces and shared libraries with `--external-path PATH`; those paths are
preserved and excluded from snapshots. The updater rejects unclassified writable
mounts. Maintenance needs permission to preserve ownership and modes and to stage
restoration beside each state root, so those parent directories must be narrowly
scoped and writable by the deployment UID.

Adoption renders and imports the effective Compose configuration, including
private environment values. The private operational `compose.json` becomes the
authoritative configuration; edits to an old checkout's `.env` or Compose files
do not change it. Credentials and application data retain their original paths.
The original Compose/environment inputs are copied privately for provenance;
ordinary updates do not reread or modify the old checkout. Source-managed bind
files are installed as versioned operational artifacts. Do not delete persistent
data or credential directories when retiring the unused checkout.

Review operational configuration changes locally and use the installed verifier
before the next update. Changes cannot disable update labels or alter registered
service roles, project identity, state classifications, or the Docker Engine
without a deliberate new adoption. Resolved Compose JSON escapes literal dollars
as `$$`; retain that representation when editing private environment values.

The default operational directory is `data/deployment` beneath the selected
project directory. An explicit `--deployment-dir` may choose another directory.
Existing operational files are not overwritten. An interrupted adoption records
`adoption.json`; rerun the same bootstrap command to resume, including recovery
of an interrupted cutover. The original deployment stays active during building.

An existing application-owned systemd unit is recognized from the prior Portal
host-home label, or can be supplied using `--boot-unit PATH`. Only a unit pointing
directly at the prior application's `start-after-network.sh` is adopted. Its
content is snapshotted, and its working directory and entrypoint are redirected
to the operational bundle. Existing enablement is preserved. Run
`systemctl --user daemon-reload` on that host when status records
`boot_activation=host-daemon-reload-required`. Other host boot arrangements can
invoke the installed `start-after-network.sh`; no host-specific maintenance
framework is installed.

## Normal updates and recovery

Use the Portal button, or the installed `scripts/update-and-restart.sh`.
The source-tree wrapper also finds the default operational bundle. It accepts
`--manifest FILE`, `--deployment-dir DIR`, and the existing topology flags;
explicit topology must match the manifest. Host invocation uses the installed
immutable runner image. The Portal's detached runner needs only its usual project
and Docker socket mounts; the dispatcher supplies required state mounts to the
transaction worker. Python, Git and build tools are packaged in that image.

`--dry-run` requires local Python for a read-only check. It does not fetch source,
build, write a lock/status file, or change services. `--verify` checks health,
authenticated HTTPS, provider discovery, container metadata and Portal capability.

Maintenance resolves canonical `main` once, fetches exactly that commit into
disposable storage, checks digest-pinned bases, and builds and qualifies candidate
images before stopping services. It does not rewrite an application checkout.
Configuration and image identities are retained in `deployment.json`; operational
artifacts and image provenance are retained under `releases/`.

Before cutover the worker stops application writers and verifies a complete
snapshot of declared state, configuration and operational files under `recovery/`.
Managed deployments include mutable router state. Shared model libraries are not
pruned. Recreation uses existing verified images with `--no-build --pull never
--wait`. Health alone is insufficient: authenticated access, model discovery and
live Portal capability must also pass.

Failure restores the entire previous generation and recreates containers so
restored bind mounts take effect. Changed failed-state roots are retained beside
their original locations with a `.failed-` suffix. Private transaction/status
records identify the recovery point. A successful rollback still reports the
update as failed. Interrupted transactions are recovered before another update;
an incomplete recovery retains its journal and requires inspection.

Snapshots and rollback images are retained until explicitly retired. They contain
credentials and must not be published. No global pruning occurs. A same-disk
recovery point does not replace an independent backup.

## Externally provisioned TLS

Set `HARNESS_TLS_MODE=external` to use an existing `ca.crt`, `server.crt` and
`server.key` under the gateway TLS directory. No CA private key or generator
`identity.json` is needed. Missing files, a mismatched key, an invalid chain, an
expired leaf or the wrong configured identity fail without regenerating files.
`HARNESS_TLS_VERIFY_NAME` selects the DNS/IP identity; it defaults to
`HARNESS_TLS_IP`. Delegated probes connect locally but validate that configured
identity with full certificate verification. The existing `auto` mode remains
available for installations that provision their own local identity.

## Qualification and rollout

`./scripts/check.sh --host` runs checks that cannot invoke Docker.
`./scripts/check.sh --build` runs the full gate in GitHub CI, including a real
Portal at an immutable revision and synthetic detached-runner/update/recovery
tests. The registry covers all first-party Harness Compose definitions; unknown
definitions fail qualification. Separate speech projects keep their own lifecycle.

Code changes alone cannot replace labels already stored in existing containers.
Installing the first operational bundle requires a separately authorized,
reviewed bootstrap deployment. Subsequent releases use the Portal button.
