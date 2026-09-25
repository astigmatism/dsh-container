# Harness 0.1.7-rc.2 upgrade

This candidate is pinned to [the published `dsh-v0.1.7-rc.2` release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2), commit
`477b4f420553e8a52c2fbccc464d7561b239c443`, published on npm's `next`
channel. Both dependency locks use this exact Harness generation and Cordis
4.0.4. Plugin versions and exact Git provenance are in `config/plugins.lock.json`.

## Qualification status — September 24, 2026

**Qualification incomplete; rollout remains blocked.** This upgrade was prepared
from the pulled `5742e98` revision. No upgraded image has been deployed and
the Mac's original application data has not been migrated. Production was not
modified. Docker on the Mac is now excluded at the user's request. Image and runtime
qualification runs in GitHub CI; local checks use lightweight host tools.

Completed checks:

- Host Node 24 tests: **254 passed, 1 skipped** across the application,
  gateway and router suites. The skipped atomic Sidebar/YAML fixture requires
  the built Harness image and remains part of the container checks.
- The plugin graph installs with pnpm 11.7.0 and `--frozen-lockfile`, including
  the normal supply-chain checks. Established compatible Lezer versions are
  pinned rather than exempting new unrelated transitive releases from the age
  policy. The exact notification Git commit and local plugin patches remain.
- The target packages accept the cancellation, progress, resource-opening,
  preview and Playwright source patches. The composed fresh and migrated
  profiles pass the 70% compaction, null summary limit, zero headroom, bounded
  recovery and pruning checks for all four native presets.
- Settings migration tests cover explicit values, nested credential references,
  tagged expressions, input backups, repeat starts, invalid input and interrupted
  publication. Runtime-profile synchronization passes seven tests, including
  preserving the writable patch while repairing managed files.
- Migrating a copy of the actual Mac settings preserves model settings,
  credential references, pins, permissions and DeepSeek configuration exactly.
  The composed configuration resolves without bundle warnings. Failed active
  model migration stops startup; an unavailable router is deferred only for an
  already valid pair of resident routes.
- The supported persistence backend migrated and reopened **108 of 110 copied
  sessions**, containing **34,582 events**, including a fork. Original copied
  artifacts retained their hashes. Two old unversioned sessions contain a
  version-2 subagent descriptor that both `0.1.6-alpha.1` and `0.1.7-rc.2`
  refuse to migrate. This is a pre-existing limitation, not a new regression.
  Their original files remain intact; no event rewriting or deletion was used.
- Updater, persisted-settings, deployment-mode, Service Portal, Compose-topology,
  patch-lock consistency, shell syntax and whitespace checks pass. The full
  repository check stops at its first Docker-backed credential test because the
  daemon is unavailable; it has not passed as a whole.

Plugin qualification is still incomplete:

| Plugin | Target | Result so far |
| --- | --- | --- |
| Better Sidebar | 0.21.1 | Installed; preview adapter patch applies; native terminal browser checks pending |
| Context | 0.56.1 | Installed; mounting and scrolling checks pending |
| Favicon Status | 0.1.0-rc.8 | Installed without the old BOM workaround; browser checks pending |
| Session Pin | 0.7.15 | Installed; persisted pins retained; browser checks pending |
| UI Appearance | 0.1.11 | Installed; theme controls pending |
| Playwright | 0.1.0 | Client-module and transport patch applies; navigation/screenshots pending |
| Task Notification | 0.2.1, exact Git commit | Installed; event dispatch and actual notification delivery pending |
| Token | 0.1.3 | Default-disabled policy checked; runtime index guard pending; v4 opt-in unsupported |
| Loop Detector | 1.0.0, local patch | Patch and policy tests pass; live tool-loop checks pending |
| Local Speech Input | 0.1.0 | Linked; new-composer dictation and real STT checks pending |

The first image-build attempt passed the core package and policy checks but
stopped at the dependency age policy. That dependency issue has been corrected
and the frozen install rechecked on the host. A complete image build has not
passed. Both the Mac runtime image and shipping `linux/amd64` image still need
building and authenticated boot/browser qualification.

Also pending: enabled host/client plugin mounting, both live models and tools,
cancellation presentation, live compaction, preview/terminal lifecycle,
notifications, dictation, appearance, pins, context scrolling, full attachment
verification, persistence over two restarts and recreation, gateway login,
Token's no-index-write check, and old-image plus pre-upgrade-snapshot rollback.
Task Notification uses host `node-notifier`; container event handling must not
be reported as confirmed notification delivery to a Mac desktop or browser.

Private rehearsal copies and logs are under `/tmp/dsh-rc2-assessment`; they are
not a consistent full rollback snapshot. The required snapshot must still be
taken before any local rollout.

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
Preservation across real restarts and container recreation is an acceptance gate
that remains to be verified.

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
Token's disabled-index guard. Record results and limitations before updating the
Mac through the repository's Compose deployment workflow.

## Rollback

1. Stop the upgraded local Harness and gateway.
2. Move the upgraded data aside as a separate recovery copy. Do not merge its v4
   sessions or new writable profile into the old installation.
3. Restore the complete pre-upgrade `data/dsh`, `data/gateway`, `.env`, and
   `secrets` snapshot, preserving modes and ownership.
4. Select the recorded old images and recreate the same local Compose project
   with the same deployment-mode override and `--no-build`.
5. Verify authenticated login, old session history, model settings and plugin
   preferences before resuming work.

Keeping only the old image is insufficient: storage and settings both changed.
Do not delete the pre-upgrade snapshot after merely confirming HTTP health.
