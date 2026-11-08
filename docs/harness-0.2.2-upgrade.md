# Harness 0.2.2-rc.1 upgrade

Release decision and immutable CI evidence: the upgrade pull request for this
branch and its required `test-and-build` check at the reviewed revision. A
draft or failing PR remains held. This document records the migration and the
acceptance contract, not a completed production deployment. No production host
has been updated until its dated result appears in the acceptance record below.

## Immutable inputs

| Component | Candidate |
| --- | --- |
| Harness | `0.2.2-rc.1`, tag `dsh-v0.2.2-rc.1`, commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` |
| Node base image | `node:24.22.2-bookworm`, index digest `8fa96264f302f58bbb13aa7339c541547b56975766ce956c875da149452a3e40` |
| Cordis / Schemastery / Cosmokit | `4.1.0` / `3.19.0` / `1.9.0` (pulled in by the Harness lock) |
| Better Sidebar | `0.30.1` — the component that forces this runtime step |
| Context | `0.82.2` |
| Session Pin | `0.7.21` |
| Appearance | `0.1.28` |
| Favicon Status | `0.1.0-rc.8` (already current) |
| Task Notification | `0.2.1`, commit `f10cd6869b7a50e55780627a6d55bbb310fd59b4` (already current; equals `main`) |
| Token | `0.1.3`, installed but bundle inactive (policy, unchanged) |
| ego-browser | tag `v0.9.11`, commit `18068f95dc8acab1bc7489b76c201f6147c58a49`, still commit-pinned to the fork's own source |
| pi-ai (provider SDK) | `1.5.0` (pulled in by the Harness lock) |
| pnpm | `11.7.0` |

Sources: [Harness release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1),
[Fisfzy/dsh-ego-browser v0.9.11](https://github.com/Fisfzy/dsh-ego-browser).
`config/dsh-runtime.package-lock.json` (regenerated, 774 packages, all 320
`@deepseek-ai/dsh*` manifests at `0.2.2-rc.1`) and
`seed/profile/pnpm-lock.yaml` freeze the dependency graphs. Every source-anchor
patch fails the image build on unexpected drift; the full build sequence was
replayed from a fresh `npm ci` of the reviewed lock and a fresh
`pnpm --frozen-lockfile` profile install before this PR.

`0.2.2-rc.1` is the first Harness release that declares `engines.node >= 24.9.0`.
The base image therefore moves off Node 22; `scripts/install-dsh-runtime.sh`
still hard-fails on a version mismatch or a mixed-generation runtime tree.

## What upstream changed and how the container follows

- **Better Sidebar 0.30.1 requires the new runtime.** It declares `^0.2.2-rc.1`
  on fourteen `@deepseek-ai/*` peers, so no plugin-major work is needed to
  justify the step: the profile cannot compose an older Harness. Its workspace
  fence, file-preview, and appearance surfaces re-anchored without behaviour
  change, and its bundle still never consumes the `webRuntime` cordis service
  (see below).
- **The router stream anchor moved.** `requestHeaders()` now takes the request
  options, the serving base URL, and the adapter's `prepareHeaders` hook. The
  keepalive spread that lets router queue comments count as stream activity
  stays limited to the `openai-responses` api — the only api this deployment's
  router route publishes; the `azure-openai-responses` and
  `openai-codex-responses` variants upstream now recognises are deliberately
  left unpatched and unqualified.
- **pi-ai 1.5.0 restructured provider error handling.** The single ChatGPT
  usage-limit ternary became an if/else-if/else chain, so the contract marker
  that carries the router's machine-readable code now attaches after the chain
  resolves the display text and before the failure is pushed to the stream
  (contract §10).
- **The running-status component gained `paused` and `holding`,** and the turn
  anchor is hoisted to a ChatFlow-local `latestTurnAnchor`. The step progress
  patch now anchors on that shape, and `verifyHookScope` still proves the hook
  lands in the component that owns `useChatNode`.
- **Native file opening is now satisfied by construction.** The conversation
  bundle resolves a `dsh-resource://file/` address and hands it to
  `sidebarRight.openResource`; it holds no `workspaces.openPath` dispatch at
  all. `patch-dsh-native-file-opening.mjs` therefore *verifies* that shape
  instead of threading a gated opener through seven anchors, and fails the
  build if a Host dispatch ever comes back. 0.2.2 also added a second
  file-affordance surface (markdown links open through
  `MarkdownDelegateProvider`); while the gate was still an anchor patch both
  call sites took the gated opener, so the verification documents that both
  surfaces are covered by the in-app path. The Deliverables-side capability
  guard remains a real patch.
- **`webRuntime` is still re-provided, and is now provably unused by the
  profile.** `dsh-web-app@0.2.2-rc.1` still provides only `webApp`, so
  `patch-dsh-web-runtime-compat.mjs` keeps re-providing `webRuntime` and its
  `--check` gate stays. Nothing in the composed profile requires the service
  any more, so removing the patch is a follow-up candidate, not part of this
  qualification.
- **Dictation is untouched upstream.** The full 0.2.2-rc.1 release feed contains
  no speech, voice, audio, dictation, microphone, or ASR change, and
  `@deepseek-ai/dsh-experimental-voice-input-bundle` is still stale at
  `0.1.7-alpha.1`, so it is not adopted and cannot double-mic the composer.
  The rendered composer keeps `[data-composer-card]`, a
  `[data-composer-input][role="textbox"]` editor, and the trailing action group
  as the row's last child — the exact contract
  `plugin/dsh-local-speech/client.js` mounts on.
- **Five patch scripts re-anchored** (llm-pi-ai, unrestricted-policy,
  progress-status, native-file-opening, ego-browser). The ego adapter needed
  two shifts: the Electron launch block moved one indentation level, and
  `LivePreviewController.prototype.noteViewport()` was inserted between the
  input-queue chain and `browserXY()`. Six more carried only their
  pinned-version assertions (appearance, session-pin, file-previews,
  preset-policy, sidebar-workspace, verify-sidebar-terminal). The remaining
  sixteen build steps — resident availability, inference contract, context
  compaction, cancellation presentation, web auth, session-title reasoning,
  busy-enter steer, preset policy, token session format, sidebar terminal, and
  the profile registry half of resident availability — applied unchanged.

## Qualification

- Fresh-tarball replay (no Docker on the development host): reviewed runtime
  lock `npm ci --omit=dev`, then every Dockerfile runtime patch and verifier in
  build order; fresh `pnpm --frozen-lockfile` install of the Web profile, then
  the full profile patch sequence in build order. All 21 build steps apply, and
  the five `--check` idempotency gates (session-title reasoning, busy-enter
  steer, web-runtime compat, file previews, sidebar workspace) pass against the
  patched tree.
- `node-pty`, classifier, and shared-outlet checks: both
  `dsh-llm` context-overflow classifier targets patch and are asserted by
  `verify-dsh-inference-contract.mjs` and `verify-dsh-context-compaction.mjs`.
- Repository unit tests: 239 passing, none failing. The progress-status and
  pi-ai patch fixtures were raised to the 0.2.2-rc.1 shapes they stand for;
  the native-file-opening test now asserts the in-app verification and the
  fail-closed diagnostic.
- `./scripts/check.sh --host`, plus the CI-only host-safe steps run locally:
  `tests/profile-lockfile.test.sh`, `tests/dictation-validation.test.sh`,
  `tests/runtime-release.test.py`, `tests/gateway-credentials.test.py`.
- `tests/fixtures/dsh-resident-availability-0.2.1-alpha.5.json`,
  `dsh-client-ui-conversation-busy-enter-0.2.1-alpha.5.js`, and
  `dsh-session-title-llm-0.2.1-alpha.5.js` are curated multi-region excerpts
  and keep their capture labels; every line was re-checked against the
  `0.2.2-rc.1` modules, and the image-build sequence proves the same patches
  against the real pinned modules. Re-curating them under the new label is
  follow-up work.
- CI `test-and-build` (`./scripts/check.sh --build`) is the required status
  check that gates landing on `main`; `docker-rehearsals` qualifies the
  updater. Neither the image build nor the in-image browser verifications have
  run anywhere but CI for this pin yet.

## Production acceptance (per deployment)

For each deployment (this host, `192.168.1.4`, `local-ai-voice`), after the
Portal update: gateway authentication; resident models show available and
reasoning selections persist across restart; ego browser opens, controls, and
screenshots reach the model; website logins survive restart; **dictation
transcribes and spoken replies play** (`verify-dictation-client.mjs`,
`verify-dictation-backend.mjs`, and the roundtrip through the speech gateway);
sidebar terminal streams; Portal still offers Update and restart and the update
check reports `current`. Record dated results here:

- (pending)

## Rollback

The updater snapshots application state and images and restores both on a
failed cutover. Source-level rollback is a `main` revert followed by a normal
Portal update. Because `0.2.2-rc.1` raises the Node runtime, a rollback is a
real image change and not a configuration edit: verify the restored container
reports the previous version label before declaring the rollback done.
