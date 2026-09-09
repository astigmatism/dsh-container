# Headless native file opening handoff

Date: 2026-09-06

> Superseded on 2026-09-08 for DeepSeek Harness `0.1.5-alpha.1`. That upstream
> release provides an in-app `dsh-resource://file/` workspace viewer, so the
> container no longer needs the native-host capability patch described below.
> The build now verifies the upstream resource-opening contract and fails on
> drift. The remainder of this document records the earlier implementation.

## Outcome

The source fix is complete and verified. DSH conversation file actions are now
exposed only while the current Host description explicitly reports
`canOpenPath: true`. False, absent, disconnected, and not-yet-known states are
fail-closed. A second invocation-time check prevents an opener retained across
a disconnect from sending a stale `host.openPath` request.

Relative paths still resolve against the current session working directory via
DSH's existing `resolveWorkspacePath(cwd, path)` call. Native opening remains
available when an attached Host explicitly advertises it.

The adjacent produced-file chips use the same capability boundary. In headless
mode they render as inert, selectable path text, and the existing folder action
remains hidden. No `file://` link, shell command, browser package, display
server, or arbitrary-file HTTP endpoint was added. The pinned DSH release has
only a session-export download route; it has no authenticated arbitrary
workspace-file viewer/download route suitable as a fallback.

## Root cause

`@deepseek-ai/dsh-client-ui-conversation/lib/client.js` always injected an
`openFile` callback that resolved the session-relative path and called
`workspaces.openPath`. It did not subscribe to or check
`connection.hostDescription.canOpenPath`, even though the host API correctly
advertises `false` for headless Linux. The UI therefore rendered a native-open
affordance and sent `host.openPath`, which eventually invoked `xdg-open` inside
the container.

## Modified files

- `scripts/patch-dsh-native-file-opening.mjs`: deterministic, idempotent patch
  for the pinned conversation and deliverables browser bundles; exact unique
  anchors fail loudly on upstream drift.
- `tests/dsh-native-file-opening-patch.test.mjs`: focused capability, relative
  resolution, disconnect, idempotence, and anchor-drift coverage.
- `Dockerfile`: copies and applies the patch immediately after DSH install.
- `scripts/check.sh`: syntax-checks the patch and verifies both built bundles.
- `scripts/verify-plugin-boot.sh`: boots without display variables and asserts
  that the actual `host.describe` response has `canOpenPath: false`.
- `scripts/verify.sh`: verifies both patch markers and behavior anchors in a
  deployed image.
- `README.md`: documents headless behavior and the lack of a secure viewer
  fallback in this DSH release.
- `docs/headless-file-opening-handoff.md`: this durable implementation,
  verification, and deployment record.

## Verification

- `node --test tests/dsh-native-file-opening-patch.test.mjs`: 6/6 passed.
- Patch applied twice to the exact pinned upstream bundles: byte-identical on
  the second application; both resulting bundles passed `node --check`.
- `./scripts/check.sh`: passed (including 30 repository Node tests and 110
  router tests).
- `./scripts/check.sh --build`: passed for harness, gateway, and router images.
- Shell syntax validation passed; the optional `shellcheck` step was skipped
  because `shellcheck` is not installed on this host.
- The harness image build and a separate disposable boot both received
  `canOpenPath: false` from the real headless `host.describe` endpoint.
- The focused true-capability test exposes the action and resolves
  `../README.md` against `/workspace/project/docs` as
  `/workspace/project/README.md`.
- The focused disconnect test retains the formerly exposed callback, removes
  the capability, invokes it, and verifies that the native opener receives no
  call.
- A disposable container from the newly built harness image was loaded in the
  browser; the normal headless UI rendered successfully with the new injected
  Host-description hook. The disposable container was then removed.

## Deployment status

The active `deepseek-harness` container is healthy but still runs the previous
image; inspection confirms the new patch marker is absent. It was deliberately
not replaced from the Harness session. Its Compose labels identify the current
deployment as remote-Ollama mode.

From a separate macOS host terminal, deploy the verified source with:

```sh
cd /Users/astigmatism/Projects/dsh-container && ./scripts/deploy.sh --remote-ollama
```

The deployment command builds the normal image tag, recreates the Compose
services in detached mode, and runs the repository's deployment verification.

## Remaining limitation

Headless mode intentionally provides no in-app open or download action for an
arbitrary workspace path because this DSH release has no authenticated,
workspace-scoped route for it. Users must copy the displayed path and open it
with a host application. Adding a secure viewer is separate upstream work.
