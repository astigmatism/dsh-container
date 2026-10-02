# Harness 0.2 and ego browser qualification

Release decision and immutable CI evidence: [upgrade PR #4](https://github.com/astigmatism/dsh-container/pull/4).
Its required `test-and-build` check must pass at the reviewed revision before
merging to canonical `main`. A draft or failing PR remains held. This document
records the migration and acceptance contract, not a completed production
deployment. Neither production host has been updated.

## Immutable inputs

| Component | Candidate |
| --- | --- |
| Harness | `0.2.0-rc.2`, `639ed015397290b3745d163aafe02ffee4aa3f84` |
| ego-browser | tag `v0.8.6`, `dfde57221443bdade5e0cbee7c773a6839ffe560` |
| Better Sidebar | `0.24.1`, restored workspace fence |
| Context | `0.62.2` |
| Session Pin | `0.7.16`, retained navigation patch |
| Appearance | `0.1.17`, retained settings icon patch |
| Token | `0.1.3`, installed but bundle inactive |

Sources: [Harness release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2),
[ego release](https://github.com/Fisfzy/dsh-ego-browser/releases/tag/v0.8.6).
`config/dsh-runtime.package-lock.json` and `seed/profile/pnpm-lock.yaml` freeze
the dependency graphs. Source-anchor patches fail the build on unexpected drift.

## Configuration and browser behavior

The updater stops the application before its complete state snapshot. On first
startup, `migrate-harness-02-profile.mjs` archives the previous manifest and
writable profile under `profile-before-02`, prepares a journal, atomically publishes each
file under that recoverable journal, then commits a receipt. An interrupted publication resumes only
if each input still matches its recorded original or prepared content. Profile
synchronization runs afterward, preserving the ordered bundle selection and
writable preferences. Unknown extra plugins stop synchronization for review.

The old browser bundle is replaced in place in that order. Playwright-only
preferences are archived; explicit browser enablement is retained. The new
browser uses the installed `/usr/bin/chromium`, CDP capture and Better Sidebar.
Its state is beneath `/data/dsh/ego-browser`; the parent Harness environment and
workspace stay intact. No desktop cookies are imported. Conversation workspaces
and their tabs are separate, but website cookies and local storage are shared
by explicit operator choice. A logged-in website account is therefore available
to all conversations using this profile.

The browser policy proxy validates every requested destination, including all
DNS answers, then connects to the validated address. Chromium sends private
navigation, redirects and subresources through that proxy. Existing
`DSH_BROWSER_ALLOW_PRIVATE_HOSTS` controls private-network access. CDP, proxy and
capture-worker ports are loopback-only and are not published by Compose.

Screenshot output includes both its file path and native image attachment.
Desktop pop-out and desktop cookie-import actions are unavailable. The raw
`ego_cli`/`ego_script` Node/CDP escape hatches are also unavailable: they bypass
conversation tab selection and can make requests outside the policy proxy.
Use the structured ego tools, including page-scoped `ego_js`, instead. Chromium's
idle reaper uses a ten-minute default. Native Sidebar input is sent in order;
the browser fixture deliberately delays mouse-down to ensure mouse-up and
keyboard events cannot overtake it. Browser logins are durable; live browser
processes and capture streams restart on demand.

Schedule moves to the official Automation tasks bundle only when explicitly
enabled in the saved profile (conditional activation is carried over). Otherwise
its obsolete core overrides are archived and it stays off. Other supported
optional bundle selections retain their order. Experimental async questions use
the upstream disabled default unless explicitly configured. Saved work-detail
choices remain intact; missing/legacy `normal` values become `standard`, matching
0.1.7's presentation rather than 0.2's changed default.

Sidebar 0.24.1 removed its upstream workspace containment. The container restores
canonical-path checks for reads, uploads, writes, mutations, archives and file
watching, including symlink escapes. An explicit saved `workspaceFence: false`
remains effective; the default is fenced.

Token's package remains installed, but its published 0.1 peer range excludes this
Harness release. Its bundle and overrides are inactive, without weakening the
compatibility gate. The legacy `DSH_TOKEN_ENABLED` variable cannot opt it in.
Previous preferences are retained in the migration archive.

The existing resident-model configuration, local speech integration, keyless
search, credentials, sessions, permissions, presets, pins and appearance remain
under their existing ownership. The resident catalog must still contain exactly
Daytime and Nighttime, with the existing router identities, context/output
policies, per-provider concurrency and reasoning choices.

## Qualification evidence

Host checks pass for the maintenance contract, recovery, profile synchronization,
gateway TLS, patch contracts, proxy policy, screenshot attachment adapter and
settings migration. Passing host tests alone does not qualify this release.
The release decision in PR #4 records the exact reviewed revision and successful
full Linux CI run; the required check also covers the final documentation commit.

The Linux gates exercise the installed plugin tree, native Sidebar/terminal/file
previews, session pins, Context/Appearance, model picker, ego conversation tabs,
shared fixture login, image attachments, live frames, manual input, downloads,
reconnect and cancellation. Synthetic dictation uses actual Chromium microphone
capture and the shipping HTTPS gateway with a fixture transcription backend.
Portal rehearsals preserve and restore a synthetic browser profile alongside
session state and previous images. The real Docker/Compose rehearsals cover
direct routing, an external shared model network, and a managed router. Portable
and remote Compose configurations both use the direct-routing maintenance path;
the topology fixtures verify their network and dependency definitions. External
network identity, managed router state, shared model files, deployment-local TLS
and unrelated running containers are checked across adoption, update and rollback.

On 2026-10-02, both existing resident routes returned `READY` through the router's
Responses API with medium reasoning. Daytime also interpreted the actual
canvas-only PNG captured by ego in [CI run 36985783667](https://github.com/astigmatism/dsh-container/actions/runs/36985783667)
(commit `ecf9366c`): a blue circle on the left of a white canvas, vertically
centered. The prompt supplied no shape or color hints. That image was sent as a
Responses `function_call_output` image. This proves the screenshot pixels and
resident vision route; the selected deployment still needs its full application
acceptance after update. Nighttime remains text-only by the existing policy.

The upgraded Harness also passed live application inference in a disposable
native host profile against both resident routes on 2026-10-02. Discovery retained
Daytime at 163,840 tokens (displayed as 160K) and Nighttime at 131,072 (128K), with
separate reasoning controls. Both model choices and reasoning preferences survived
client reconnection, and both models continued the same durable conversation.
No production settings were changed for these requests.

The synthetic microphone round trip also passed in a disposable native host
setup using the shipping gateway and fake Chromium microphone: transcription
insertion, backend failure presentation, and recorder-failure track cleanup.
Linux container qualification remains authoritative for the release.

The optional Automation tasks service also passed creation, listing, title
updates and deletion of a future synthetic task in an isolated native Harness
profile. The task was removed without being delivered; timed delivery was not
part of that check.

The release decision must name the exact commit and CI run; failed or partial
runs do not qualify the release. A physical microphone check and full production
acceptance remain pending until the operator selects and updates a deployment.
Timed Automation delivery, personal website-specific login behavior and a
physical microphone are not claimed by the synthetic fixtures.

## Release and rollback

Keep the candidate on its review branch until essential qualification passes.
Only then may the reviewed commit reach canonical `main`. Every deployment
continues updating through Service Portal. Deployment identity and local settings
remain outside Git; do not patch production containers or disable update labels.

The shared updater fetches a pinned source revision into temporary storage,
qualifies replacement images, snapshots state and records previous image
identities. On failure it restores the complete state and previous images.
Rollback must include the browser profile and all migrated Harness data; running
the previous image against newly migrated state is not a valid rollback.

After the operator triggers an update and selects a machine, verify the host,
repository provenance and Compose project, authenticated gateway access, both
resident models and reasoning persistence, native ego controls, screenshot
vision, saved website logins, dictation and Portal Update/restart availability.
Complete the physical microphone check with the operator. Append dated production
results here, separating observed behavior from remaining limitations.
