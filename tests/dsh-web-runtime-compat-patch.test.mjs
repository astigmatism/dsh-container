import assert from "node:assert/strict";
import test from "node:test";

import { patchSource, verifySource } from "../scripts/patch-dsh-web-runtime-compat.mjs";

// The single line in dsh-web-app 0.2.1-alpha.5 that replaced rc.2's webRuntime
// provide. The compat patch anchors on it to re-provide webRuntime for
// dsh-better-sidebar (<=0.26.1), which still injects the removed service.
const fixture = `
function apply(ctx, config) {
\tconst appRootUrl = () => publicUrl ?? ctx.webServer.getOrigin();
\tctx.provide("webApp", { getAdvertisedUrl: appRootUrl });
\tctx.plugin(FrontendStatic, { distIndex: internals.resolveDistIndex() });
}
`;

test("re-provides webRuntime from webStartup trusted hosts for the sidebar", () => {
  const patched = patchSource(fixture);
  assert.match(patched, /dsh-container-web-runtime-compat-v1/);
  // Injected lazily so `dsh --profile web --help` (no webStartup) is unaffected.
  assert.match(patched, /ctx\.inject\(\["webStartup"\], \(startupCtx\) => \{/);
  assert.match(patched, /startupCtx\.webStartup\?\.trustedHosts \?\? \[\]/);
  assert.match(patched, /ctx\.provide\("webRuntime", \{ lanAddresses: \[\], trustedHosts \}\)/);
  // The original webApp provide is preserved.
  assert.match(patched, /ctx\.provide\("webApp", \{ getAdvertisedUrl: appRootUrl \}\)/);
  assert.equal(patchSource(patched), patched);
  verifySource(patched);
});

test("fails loudly when the webApp provide anchor drifts", () => {
  assert.throws(
    () => patchSource(fixture.replace('ctx.provide("webApp", { getAdvertisedUrl: appRootUrl });', 'ctx.provide("webApp", {});')),
    /web-app source drift/,
  );
});

test("verifySource rejects an unpatched module", () => {
  assert.throws(() => verifySource(fixture), /compatibility patch is not applied/);
});
