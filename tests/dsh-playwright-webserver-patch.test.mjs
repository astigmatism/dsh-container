import assert from "node:assert/strict";
import test from "node:test";

import { patchSource } from "../scripts/patch-dsh-playwright-webserver.mjs";

const fixture = `
function apply(ctx, config) {
\tregisterStreamRoute(ctx, browser);
\tctx.connection.rpc.handle(RPC_CHANNEL, async (endpoint, payload, signal) => {
\t\treturn { ok: true };
\t}, { authority: "loopback" });
}
`;

test("mounts both browser transports inside the explicit webServer scope", () => {
  const patched = patchSource(fixture);
  assert.match(patched, /dsh-playwright-webserver-scope-v1/);
  assert.match(patched, /ctx\.inject\(\["webServer"\], \(webCtx\) => \{/);
  assert.match(patched, /registerStreamRoute\(webCtx, browser\)/);
  assert.match(patched, /webCtx\.connection\.rpc\.handle/);
  assert.equal(patchSource(patched), patched);
});

test("upstream drift fails loudly", () => {
  assert.throws(
    () => patchSource(fixture.replace("registerStreamRoute(ctx, browser)", "registerStreamRouteV2(ctx, browser)")),
    /cannot patch screencast route webServer scope/,
  );
});
