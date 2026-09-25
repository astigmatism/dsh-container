# Harness 0.1.7-rc.2 upgrade

The checkout-based updater described in the historical qualification below is
superseded by [portable maintenance](portable-maintenance.md). New updates take
complete snapshots on every release and do not fast-forward a retained checkout.
The storage-migration and complete-state rollback requirements still apply.

This upgrade is pinned to [the published `dsh-v0.1.7-rc.2` release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2), commit
`477b4f420553e8a52c2fbccc464d7561b239c443`, published on npm's `next`
channel. Both dependency locks use this exact Harness generation and Cordis
4.0.4. Plugin versions and exact Git provenance are in `config/plugins.lock.json`.

## Qualification status — September 24, 2026

The complete `./scripts/check.sh --build` gate passed at commit `7067e1f` in
[run 36085922811](https://github.com/astigmatism/dsh-container/actions/runs/36085922811),
including the shipping `linux/amd64` Harness, gateway and router images,
authenticated browser qualification and the real Compose recovery rehearsal.
No upgraded image has been deployed to production or the Mac. Docker on the Mac
is excluded at the user's request.

Completed checks:

- Repository unit suites, updater preflight and delegated-runner fixtures,
  credential migration, Compose metadata, frozen dependency installation and
  exact provenance checks. All 273 installed Harness packages use `0.1.7-rc.2`.
- Actual compaction construction accepts the null summary limit. Pressure,
  70% threshold, zero headroom, bounded recovery, pruning, reasoning, request
  concurrency and unrestricted output contracts pass.
- All nine enabled host plugins, all seven browser plugins, maintained search
  and router providers, and all four agent presets mounted in the rebuilt app.
  Token remained unloaded.
- The live catalog and rendered picker contain exactly Daytime (128K) and
  Nighttime (128K), with a separate reasoning effort control. Appearance controls
  change the computed accent color and preserve the theme across browser reload.
- Profile synchronization and plugin inventory passed under deployment UID
  12345. Browser checks passed with an unwritable `HOME=/`; Chromium uses private
  writable state directories that are removed when it closes.
- Native terminal rendering, streaming, session isolation, reconnect, input,
  Ctrl-C and process cleanup passed through the running browser application.
  Native Bash deadlines, explicit timeout budgets, retained output and forced
  cleanup of a parent, child and grandchild passed in the shipping Linux image.
- Playwright navigation, private subresources, screenshots, its shared browser
  panel and authenticated WebSocket transport passed.
- Relative and absolute file previews, encoded names, referenced sessions,
  missing-file recovery using native Reload, text, HTML, PDF, downloads and
  workspace containment passed.
- Settings migration covers explicit preferences, credential references, tagged
  expressions, backups, repeated starts, invalid input and interrupted writes.
  Profile synchronization preserves the writable patch while repairing managed
  files. A copy of the Mac settings retained model settings, credentials, pins,
  permissions and DeepSeek configuration.
- Preferences saved through the actual rc2 Settings API survived two complete
  entrypoint restarts, including reasoning choice, Sidebar settings and credential
  references. Token remained unloaded and its existing index retained its bytes,
  modification time and inode.
- The supported persistence backend migrated and reopened **108 of 110 copied
  sessions**, containing **34,582 events**, including a fork. Original artifacts
  retained their hashes. Two old unversioned sessions contain a version-2
  subagent descriptor that both old and new Harness reject. Their original files
  remain intact; this is a pre-existing limitation.
- Recovery tests cover incomplete snapshots, integrity failures, insufficient
  space and complete restoration. A real CI Compose rehearsal replaced image
  generations, changed data and credentials, then restored the previous images,
  original files and healthy recreated bind mounts. This passed with both the
  CI host's Compose client and the exact client bundled for portal maintenance,
  including credentials containing literal dollar signs. Its old image is a
  fixture derived from the new build, not a full boot of the old Harness release.

| Plugin | Target | Verified / remaining scope |
| --- | --- | --- |
| Better Sidebar | 0.21.1 | Host/client mounted; native terminal and preview paths passed |
| Context | 0.56.1 | Host/client mounted; Context Insights data and interactive scrolling passed |
| Favicon Status | 0.1.0-rc.8 | Host/client mounted; status transitions remain unverified |
| Session Pin | 0.7.15, local navigation patch | Host/client mounted; toggle, browser-reload persistence and opening a pinned conversation passed |
| UI Appearance | 0.1.11, local rc2 icon patch | Host/client mounted; theme controls, computed accent color and browser-reload persistence passed |
| Playwright | 0.1.0 | Navigation, screenshots, shared panel and stream transport passed |
| Task Notification | 0.2.1, exact Git commit | Host mounted; actual desktop notification delivery remains unverified |
| Token | 0.1.3 | Default-disabled and unloaded; v4 opt-in remains unsupported |
| Loop Detector | 1.0.0, local patch | Mounted; policy and failure-recovery fixtures passed |
| Local Speech Input | 0.1.0 | Host/client and composer control mounted; physical microphone/STT round trip remains unverified |

Production deployment additionally runs live resident-model inference, gateway
and dictation verification. Those live
LAN-provider checks cannot be substituted by CI fixtures. Task Notification's
host `node-notifier` integration must not be reported as verified delivery to a
Mac desktop or browser.

The private rehearsal copies under `/tmp/dsh-rc2-assessment` are not a production
rollback snapshot. The updater takes the deployment's own snapshot at cutover.

## Migration

Develop source on the Mac; run container qualification in GitHub CI. Do not
start Docker Desktop on the Mac. Production deployment is a separate
explicit operation; neither production server is a development workspace.

Finish active tasks before choosing Service Portal Update and Restart. The
fetched updater captures the previous Compose configuration and image IDs before
changing pins, builds replacements while the old service runs, then stops the
project and snapshots `data/dsh`, `data/gateway`, `data/backend-auth`, `.env`, and
`secrets`. It verifies copied hashes, ownership and modes before deployment. It
requires space for the snapshot and a recovery working copy. The private recovery
point stays under ignored `data/upgrade-recovery`; previous image tags are retained.

If snapshot creation fails, the original containers restart with unchanged data.
If deployment or verification fails, the updater restores the complete snapshot
and old images, retaining the failed runtime separately, and waits for Compose
health. Maintenance still reports failure, with `recovery=succeeded` only if that
recovery command completes. `recovery_point` records the path. Git stays at the
reviewed new commit so a subsequent reviewed fix can be fetched normally.

A manual restore uses `python3 scripts/upgrade-recovery.py restore --point PATH`
from the same deployment checkout, after confirming no maintenance run is active.
Never publish the recovery directory: its Compose configuration and environment
contain private credentials.

Startup synchronizes packaged dependencies and the managed configuration bundle.
It preserves the writable web profile. A one-time migration strips unchanged
legacy repository defaults, preserves explicit overrides and JS expressions,
imports legacy settings into the profile patch, and archives the inputs. Router
discovery then refreshes advertised capabilities through the new Settings API.
The CI gate saves preferences through the real settings API and checks them after
two full entrypoint restarts. Container recreation and bind-mount restoration are
also covered by the separate recovery rehearsal.

Harness's own persistence backend reads old sessions and publishes v4 generations
when they are opened for writing. The local rehearsal script uses that supported
backend on a directory explicitly marked `.qualification-copy` containing the
text `disposable`. It compares migrated history before/after publication and
reopen, checks inherited fork prefixes, and hashes every original artifact.
It never runs against `/data/dsh`.

Better Sidebar terminal tools are retired. Use Harness's terminal tab and the
selected preset's Bash workflow. The upgrade does not choose a different preset.
Token remains installed but unloaded by default. Its old v3 reader and native
memory behavior do not establish v4 opt-in compatibility; opt-in remains
unsupported until separately qualified.

## Acceptance

Run `./scripts/check.sh --build`, the `linux/amd64` image build, copied-data
migration, authenticated browser checks, live resident-model/tool checks,
settings persistence across two restarts and recreation, gateway login, and
Token's disabled-index guard. Run container checks in CI; Docker on the Mac is
excluded. Production updates remain separately authorized operations using the
Service Portal or the repository's normal deployment workflow.

## Rollback

1. Stop the upgraded Harness and gateway in the selected deployment.
2. Move the upgraded data aside as a separate recovery copy. Do not merge its v4
   sessions or new writable profile into the old installation.
3. Restore the complete pre-upgrade `data/dsh`, `data/gateway`,
   `data/backend-auth`, `.env`, and `secrets` snapshot, preserving modes and ownership.
4. Select the recorded old images and recreate the same Compose project
   with the same deployment-mode override and `--no-build`.
5. Verify authenticated login, old session history, model settings and plugin
   preferences before resuming work.

Keeping only the old image is insufficient: storage and settings both changed.
Do not delete the pre-upgrade snapshot after merely confirming HTTP health.
