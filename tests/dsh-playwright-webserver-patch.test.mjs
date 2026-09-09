import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { patchSource } from "../scripts/patch-dsh-playwright-webserver.mjs";

const fixture = `
function apply(ctx, config) {
\tregisterStreamRoute(ctx, browser);
\tctx.systemPrompt.section({ name: "tool:browser-use", text: "shared browser" });
\tctx.connection.rpc.handle(RPC_CHANNEL, async (endpoint, payload, signal) => {
\t\treturn { ok: true };
\t}, { authority: "loopback" });
}
`;

test("mounts each HTTP-backed transport in its complete service scope", () => {
  const patched = patchSource(fixture);
  assert.match(patched, /dsh-playwright-web-transport-scope-v5/);
  assert.match(patched, /ctx\.inject\(\["webServer"\], \(webCtx\) => \{/);
  assert.match(patched, /registerStreamRoute\(webCtx, browser\)/);
  assert.match(patched, /\n\t\}\);\n\tctx\.systemPrompt\.section/);
  assert.match(patched, /ctx\.systemPrompt\.section[\s\S]*ctx\.inject\(\["webServer", "connection"\]/);
  assert.match(patched, /webCtx\.connection\.rpc\.handle/);
  assert.equal(patchSource(patched), patched);
});

test("profile declares the scoped webServer dependency at the loader boundary", () => {
  const overlay = readFileSync(new URL("../seed/profile/cordis.patch.yml", import.meta.url), "utf8");
  assert.match(overlay, /- id: dsh-playwright\n  inject:\n    - webServer\n  config:/);
});

test("upstream drift fails loudly", () => {
  assert.throws(
    () => patchSource(fixture.replace("registerStreamRoute(ctx, browser)", "registerStreamRouteV2(ctx, browser)")),
    /cannot patch screencast route webServer scope/,
  );
});
