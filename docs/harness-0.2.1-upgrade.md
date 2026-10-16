# Harness 0.2.1-alpha.5 upgrade

Release decision and immutable CI evidence: the upgrade pull request for this
branch and its required `test-and-build` check at the reviewed revision. A
draft or failing PR remains held. This document records the migration and the
acceptance contract, not a completed production deployment. No production host
has been updated until its dated result appears in the acceptance record below.

## Immutable inputs

| Component | Candidate |
| --- | --- |
| Harness | `0.2.1-alpha.5`, tag `dsh-v0.2.1-alpha.5`, commit `1517a4dbca0a2789ff1d41ba439600f8547d23fa` |
| Cordis | `4.0.5` (pulled in by the Harness lock) |
| Better Sidebar | `0.26.1`, workspace fence patch reimplemented on the upstream resolver surface |
| Context | `0.72.0` |
| Session Pin | `0.7.19`, retained navigation verification |
| Appearance | `0.1.23`, retained settings icon verification |
| Token | `0.1.3`, installed but bundle inactive |
| ego-browser | tag `v0.8.6`, unchanged from the 0.2 qualification |
| pnpm | `11.7.0` |

Sources: [Harness release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.5).
`config/dsh-runtime.package-lock.json` (regenerated, 730 packages) and
`seed/profile/pnpm-lock.yaml` freeze the dependency graphs. Every source-anchor
patch fails the image build on unexpected drift; the full build sequence was
replayed from a fresh tarball and a fresh `pnpm install` before this PR.

## What upstream changed and how the container follows

- **The `webRuntime` cordis service is gone.** alpha.5 dropped the service the
  profile plugins (Better Sidebar and others) required at boot;
  `patch-dsh-web-runtime-compat.mjs` re-provides `webRuntime` from
  `webStartup.trustedHosts` so the composed profile mounts unchanged.
- **Unrestricted output stays container-local.** The published 0.2.1-alpha.5
  packages still resolve `maxTokens` without the null (unrestricted)
  capability, so the adapter, simple-options, and compaction patches in
  `patch-unrestricted-policy.mjs` remain real patches, not verifications.
- **Session-title reasoning is upstream.** The title generator now selects the
  least reasoning effort for title calls; `patch-dsh-session-title-reasoning.mjs`
  is a build-gated verification of that behavior.
- **Appearance settings icons are upstream.** The personalization icon adapter
  ships in 0.1.23; the patch is now a verification.
- **Sidebar 0.26.1 grew fence seams.** Its workspace resolvers accept a fence
  parameter placeholder; `patch-dsh-sidebar-workspace.mjs` now implements the
  container fence behind those upstream resolvers and threads the live
  `workspaceFence` setting through RPC, HTTP, and fs-watch surfaces instead of
  replacing the path-security region.
- **File previews defer until workspace hydration** upstream; the preview patch
  re-anchored onto the `records.ensure` flow, and the image-retry change was
  upstreamed (the patch skips it).
- **Native file opening is upstream in-app.** The chat bundle opens workspace
  files through `dsh-resource://` sidebar resources; the native-file patch
  verifies that path and keeps the deliverables-side capability guard.
- **The minimal preset omits tool-result pruning** in alpha.5; the preset
  policy patch inserts the pruner row so all four presets prune.
- **The schedule bundle folded into the core web-app graph.** Its module is now
  always present, and the remaining official optional bundles are cordis
  patch-bundles that leave the dumped config unchanged; the composition test
  verifies each selection loads with the incompatible Token inactive and each
  installed bundle's patch manifest, rather than by module presence.
- **Client verification re-anchored to alpha.5 UI.** Context Insights is now a
  full-height panel with no close control, and app Settings moved under the
  account menu as a menuitem; the boot-check browser verifications follow.
- Resident availability, web auth, launch-token grep, busy-enter steer,
  cancellation presentation, progress status, token session format, and the
  ego adapters re-anchored to alpha.5 surfaces with the same contracts.

## Qualification

- Fresh-tarball replay (no Docker on the development host): reviewed runtime
  lock `npm ci`, then every Dockerfile runtime patch and verifier in build
  order, including `--check` idempotency passes; fresh `pnpm install` of the
  Web profile, then the full profile patch sequence, `--dump-config`
  composition, effective-config verifiers, plugin inventory, and marker greps.
- `node-pty` PTY verifier on the alpha.5 subprocess package.
- Repository unit tests and `./scripts/check.sh --host`.
- Image-level Docker verifications replayed against the built alpha.5 image:
  the plain and `DSH_VERIFY_RESIDENT_CATALOG` boot checks, the client test
  batch, module marker greps, token policy, router startup in both modes,
  profile-sync divergence, and persisted-settings initialization.
- CI `test-and-build` (`./scripts/check.sh --build`) on the PR revision:
  recorded below when the run completes.

## Production acceptance (per deployment)

For each deployment (this host, `192.168.1.4`, `local-ai-voice`), after the
Portal update: gateway authentication; resident models show available and
reasoning selections persist across restart; ego browser opens, controls, and
screenshots reach the model; website logins survive restart; dictation
transcribes; sidebar terminal streams; Portal still offers Update and restart
and the update check reports `current`. Record dated results here:

- (pending)

## Rollback

The updater snapshots application state and images and restores both on a
failed cutover. Source-level rollback is a `main` revert followed by a normal
Portal update; persisted sessions and settings remain compatible because the
0.2.1 profile migration is a no-op over the 0.2 layout.
