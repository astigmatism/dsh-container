# Plugin inventory — what this deployment actually runs

This is the human-readable companion to the machine-readable sources of truth:

| Question | Authoritative answer |
| --- | --- |
| What is composed into the Web profile? | `seed/profile/package.json` → `dsh.profile.bundles` |
| What is mounted through the profile patch? | `seed/profile/managed/cordis.patch.yml` |
| Which versions and commits were captured? | `config/plugins.lock.json` |
| What does a running container really load? | `dsh plugin --profile web list`, captured and gated by `scripts/verify.sh` and the built-image gate in `scripts/check.sh`; both lists are proved identical by `tests/captured-inventory.test.py` |

Everything below is the state at the Harness `0.2.2-rc.1` pin.

## Bundles (profile composition order)

| Bundle | Version / source | Why this deployment carries it | Container-owned behaviour |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-base` | `0.2.2-rc.1` (upstream core) | Runtime base every profile needs | — |
| `@deepseek-ai/dsh-web-app` | `0.2.2-rc.1` (upstream core) | Browser/HTTPS web surface behind the gateway | `patch-dsh-web-runtime-compat.mjs` re-provides the `webRuntime` cordis service upstream dropped; `patch-dsh-web-auth.mjs` keeps the launch-token/cookie boundary |
| `@deepseek-ai/dsh-web-frontend` | `0.2.2-rc.1` (upstream core; the served bundle, not a profile bundle) | The browser bundle the transcript is rendered in, markdown and TeX included | `patch-dsh-markdown-money-math.mjs` keeps two dollar amounts from becoming one equation; `verify.sh` proves the chunk `index.html` loads carries it |
| `@deepseek-ai/dsh-experimental-voice-input-bundle` | `0.2.2-rc.1` (upstream experimental) | **Dictation UI.** Composer microphone with a live waveform, capture/transcription/retry rows, provider and language selection | required deployment invariant; verified by rendering the composer with a fake microphone device (`scripts/verify-dictation-client.mjs`) |
| `dsh-speech-whisper` | local, `plugin/dsh-speech-whisper` | Registers the private faster-whisper host as the default recognizer for the bundle above | no patch; configuration is the Compose `STT_*` environment, proved by `tests/dsh-speech-whisper.test.mjs` |
| `dsh-plugin-task-notification` | `0.2.1` @ commit `f10cd6869b7a50e55780627a6d55bbb310fd59b4` | Task-finished notification reaches the operator across the tunnel | commit-pinned, unpatched |
| `dsh-context` | `0.82.2` | Context usage/insight panel used to keep long dictation sessions inside the router budget | preset policy patch keeps its compaction rows honest |
| `dsh-session-pin` | `0.7.21` | Pinning sessions and workspaces in the sidebar list | `patch-dsh-session-pin.mjs` (pinned-version navigation) |
| `dsh-ui-appearance` | `0.1.28` | Themes and chat appearance controls; dark mode must reach dialog surfaces | `patch-dsh-appearance.mjs` (verification) |
| `dsh-favicon-status` | `0.1.0-rc.8` | Favicon shows working/waiting/done so a background tab is readable | unpatched |
| `dsh-better-sidebar` | `0.26.1`; `0.30.1` is held — see the upgrade record | Sidebar workspaces, file previews, and the sidebar terminal | `patch-dsh-file-previews.mjs`, `patch-dsh-sidebar-workspace.mjs` (workspace fence), `verify-sidebar-terminal.mjs` |
| `dsh-ego-browser` | tag `v0.8.6`, commit `dfde57221443bdade5e0cbee7c773a6839ffe560`; `v0.9.11` is held — see the upgrade record | The agent's own browser, driven headless through the Sidebar tab | `patch-dsh-ego-browser.mjs` + `plugin/dsh-ego-adapter`: container browser state, conversation scoping, image and transport adapters; desktop window/cookie-import affordances disabled |
| `dsh-container-profile` | local, `seed/profile/managed` | This fork's own cordis patch bundle: the only place the profile's non-bundle wiring lives | mounts the four plugins below |

## Mounted through the profile patch, not the bundle list

| Plugin | Version / source | Purpose here |
| --- | --- | --- |
| `dsh-loop-detector` | `1.0.0` + `seed/profile/patches/dsh-loop-detector@1.0.0.patch` | Stops a model repeating itself into a runaway loop; the patch keeps cancellation provenance honest |
| `dsh-web-search-free.js` | `seed/plugins/`, served from `/opt/dsh-seed/.dsh-plugins` | Free web search provider (DuckDuckGo with Bing fallback) so search needs no API key |
| `dsh-router-model-discovery.js` | `seed/plugins/` | Discovers models from the local LLM router's capabilities document |
| `dsh-follow-up-suggestions` | local, `seed/profile/plugins/dsh-follow-up-suggestions` | Next-message suggestions placed in the composer for editing |

## Installed but deliberately inactive

| Plugin | Version | Why it is not enabled |
| --- | --- | --- |
| `@zoytown/dsh-token` | `0.1.3` | Policy: full refolds with per-frame synchronous Zstandard decompression caused repeatable multi-gigabyte RSS growth, and `0.1.3` still declares an incompatible `0.1` peer range with an unqualified v4 session reader. Installed so the bundle stays enumerable, kept out of the bundle list; `verify-dsh-token-policy.mjs --effective-config disabled` enforces it, and `patch-dsh-token-session-format.mjs` keeps the session-format shim in place for a future requalification |
| `dsh-local-speech-input` | local, `plugin/dsh-local-speech` | Retired by the official Voice Input bundle, not broken: it patched a button beside the model selector, gave no feedback while recording, and posted to the gateway. Both controls together mean two microphones, so startup substitutes for it once per data directory (`scripts/reconcile-voice-bundles.mjs`). Installed and selectable for a one-toggle rollback |

## Official optional bundles

`@deepseek-ai/dsh-experimental-agent-team-profile`,
`@deepseek-ai/dsh-experimental-voice-input-bundle`,
`@deepseek-ai/dsh-experimental-auto-review`,
`@deepseek-ai/dsh-experimental-schedule-bundle`.

They are cordis patch-bundles that leave the dumped config unchanged, and
`tests/optional-bundle-composition.test.mjs` proves each selection composes.
The voice-input bundle is the exception: it contributes browser modules rather
than only wiring, it ships at the exact runtime version so it needs no seed
dependency, and it is **enabled** — it is the dictation UI (see the bundle table).
It stays listed here because `dshContainer.optionalBundles` is what lets the
profile sync keep a bundle an operator selects, and `dsh-local-speech-input`
hangs off the same list for the same reason after being retired: the
substitution removes it from the selection at startup, and this is what makes
re-enabling it one toggle instead of a manual manifest edit. Enabling both at
once puts two microphones in the composer, which
`scripts/verify-dictation-client.mjs` rejects.
`dsh-playwright` was dropped from the profile in an earlier release and is no
longer installed.

Earlier releases recorded the voice-input bundle as stale at `0.1.7-alpha.1` and
its recognizers as unusable. That was true of the 0.1.x line: at `0.2.2-rc.1`
the bundle carries the capture row with its live waveform, a browser
microphone path that ships the recording to the Host over the authenticated
carrier, and a working provider roster. `dsh-local-speech-input` is retired
against it, not against that older claim.

## Third-party sources, in one place

| Plugin | Upstream |
| --- | --- |
| `dsh-better-sidebar` | <https://www.npmjs.com/package/dsh-better-sidebar> |
| `dsh-context` | <https://www.npmjs.com/package/dsh-context> |
| `dsh-session-pin` | <https://www.npmjs.com/package/dsh-session-pin> |
| `dsh-ui-appearance` | <https://www.npmjs.com/package/dsh-ui-appearance> |
| `dsh-favicon-status` | <https://www.npmjs.com/package/dsh-favicon-status> |
| `dsh-loop-detector` | <https://www.npmjs.com/package/dsh-loop-detector> |
| `dsh-plugin-task-notification` | <https://github.com/Cocowwy/dsh-plugin-task-notification> |
| `dsh-ego-browser` | <https://github.com/Fisfzy/dsh-ego-browser> (commit-pinned fork source) |
| `@zoytown/dsh-token` | <https://github.com/zoyluoblue/deepseek-harness-token> |

npm-pinned plugins install at the exact version in `seed/profile/package.json`;
`dsh-ego-browser` and `dsh-plugin-task-notification` install from an immutable
commit. `seed/profile/pnpm-workspace.yaml` holds the release-age exemptions the
graph needs, and `tests/profile-lockfile.test.sh` fails when a patch hash or a
pinned source moves without the lock being reviewed.
