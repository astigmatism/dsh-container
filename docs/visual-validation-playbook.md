# Visual validation playbook

This playbook validates the complete path from the shared Chromium page to the
selected multimodal model. Infrastructure checks alone are insufficient: the
acceptance prompt deliberately asks for text drawn only into a canvas, so a
passing answer proves that the model received screenshot pixels from a tool
result rather than inferring an answer from the DOM.

## Data path

```text
dsh-playwright browser_screenshot
  -> DSH image attachment
  -> Responses function_call_output with input_image
  -> local-ai-ollama-router tool message with images[]
  -> Ollama
  -> Qwen3.8 visual reasoning
```

`dsh-playwright` and Chromium are included in the Harness image. The router in
this repository preserves image-bearing function outputs. Managed and remote
deployment modes build it automatically. Remote mode uses it as a local adapter
in front of `REMOTE_OLLAMA_HOST`. In external Ollama mode, the separate router
already answering as `ai-router` must be updated to the same router code before
the screenshot acceptance test can pass.

## Deployment preflight

Public targets work with the secure default. For an application on localhost,
a Compose network, or a trusted LAN, set the following deployment-local value:

```sh
DSH_BROWSER_ALLOW_PRIVATE_HOSTS=true
```

The upstream browser plugin exposes a Boolean private-network switch rather
than a host allowlist. Enabling it permits every private destination and
private subresource reachable from the Harness container. Use it only on the
existing trusted validation network and disable it for general browsing.

After rebuilding and restarting the deployment, run:

```sh
./scripts/verify-browser-readiness.sh
```

For an internal target, require the setting explicitly:

```sh
./scripts/verify-browser-readiness.sh --require-private-targets
```

The script verifies the pinned plugin, launches Chromium headlessly as a smoke
test, and checks that `local-active` advertises complete image, vision, and tool
support. It does not replace the model-level acceptance prompt below.

## Pipeline acceptance prompt

Serve the checked-in fixture from the repository root. On Docker Desktop, the
container can reach this through `host.docker.internal`:

```sh
python3 -m http.server 4173 --bind 0.0.0.0
```

Create a fresh DSH session and send this prompt verbatim:

```text
Run a read-only acceptance test of the new shared browser and vision pipeline.

Use only the browser_* tools for the page investigation. Do not inspect
repository files, use shell commands, or modify anything.

1. Call browser_navigate for
   http://host.docker.internal:4173/tests/fixtures/visual-validation/
2. Call browser_snapshot so you have interaction context.
3. Call browser_screenshot and analyze the actual pixels.
4. Report the exact VISION TOKEN drawn inside the chart canvas.
5. Report every clearly visible layout, clipping, overlap, or contrast defect,
   with short pixel-based evidence.

Return a concise result with these exact headings:
PIPELINE: PASS or FAIL
VISION TOKEN:
VISUAL DEFECTS:
CONFIDENCE:

Set PIPELINE to PASS only if you can read the complete canvas token from the
screenshot. Do not guess a token from surrounding text.
```

A pass requires all of the following:

- `browser_navigate`, `browser_snapshot`, and `browser_screenshot` appear in
  the trajectory;
- the Browser Use panel displays the fixture;
- the model reports `COBALT-731` exactly;
- the report identifies the overlapping action buttons, low-contrast helper
  copy, clipped Approve deployment button, and overlapping support/toast
  layers; and
- there is no router, attachment, or empty-upstream-response error.

The fixture is intentionally broken and is test data, not an application to
repair.

## Production application audit prompt

Replace the bracketed fields before sending this to a fresh production DSH
session. Keep the first run read-only; authorize application changes in a
separate task after reviewing the findings.

```text
Perform a read-only visual and interaction audit of this deployed application.

TARGET URL: <TARGET_URL>
EXPECTED BUILD OR VERSION: <EXPECTED_BUILD>
CRITICAL USER FLOWS: <FLOW_1>; <FLOW_2>; <FLOW_3>

Use the shared browser_* tools only. Do not use shell commands, inspect source
files, change application data, submit destructive forms, or complete a
purchase, deployment, deletion, invitation, or external message. If sign-in,
MFA, CAPTCHA, or a potentially consequential submit action is required, stop
at that boundary and request human takeover.

Method:
1. Navigate to TARGET URL and confirm the visible build/version when one is
   exposed by the UI.
2. Take a fresh semantic snapshot after every navigation or dynamic state
   change. Use current element IDs for ordinary controls.
3. Take a screenshot at the initial state and at every materially different
   state in each critical flow. Use pixels—not DOM assumptions—to assess
   clipping, overlap, off-screen controls, unreadable contrast, unexpected
   blank areas, loading-state residue, broken imagery, chart/canvas output,
   selected/disabled states, and error presentation.
4. Use coordinate clicks only for canvas or genuinely non-semantic controls.
   When a coordinate click matters, request a marked screenshot to verify the
   location.
5. Do not call a visual issue confirmed unless the screenshot shows it. Record
   the page/state, visible evidence, severity, and likely user impact.

Return:
- VERDICT: PASS, PASS WITH WARNINGS, or FAIL
- ENVIRONMENT: URL and visible build/version
- COVERAGE: states and flows actually inspected
- FINDINGS: severity, state, pixel evidence, impact, and reproduction steps
- BLOCKED COVERAGE: anything not safely reachable
- EVIDENCE SUMMARY: screenshots taken and what each established
- CONFIDENCE: High, Medium, or Low with one-sentence rationale

FAIL for any blocker that prevents a critical flow, hidden or unreachable
primary action, materially overlapping content, unreadable critical text, or
unhandled error state. Never report unvisited states as passing.
```

## Enhancement comparison prompt

Use this when both a stable baseline and candidate deployment are reachable.
The browser plugin uses a 1440×900 viewport in this project so comparisons are
made at identical dimensions.

```text
Compare the visible behavior of a baseline and candidate application build.
This is a read-only validation task.

BASELINE URL: <BASELINE_URL>
CANDIDATE URL: <CANDIDATE_URL>
ENHANCEMENT CONTRACT: <EXPECTED_VISIBLE_CHANGE>
CRITICAL STATES: <STATE_1>; <STATE_2>; <STATE_3>

Use only browser_* tools. For each critical state, reproduce the same safe
navigation in the baseline and candidate, then take screenshots at the same
1440×900 viewport. Use semantic snapshots for control targeting and screenshot
pixels for the comparison. Do not submit consequential actions or modify
application data.

Separate your findings into:
1. EXPECTED CHANGE CONFIRMED
2. VISUAL REGRESSIONS
3. INTERACTION REGRESSIONS
4. PRE-EXISTING BASELINE ISSUES
5. BLOCKED OR UNTESTED STATES

For every difference, name both compared states and give precise visible
evidence. PASS only when the enhancement contract is visibly satisfied and no
new critical or high-severity regression is present. Do not infer equivalence
from DOM text alone.
```

## Production evidence to retain

For each environment, record the DSH version, plugin version, active model and
quantization, router revision, target build, private-target setting, prompt
used, final model report, and whether the Browser Use panel visibly followed
the tool trajectory. Never include credentials, cookies, or private keys in
the evidence bundle.
