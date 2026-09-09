import assert from "node:assert/strict";
import test from "node:test";

import { patchSource } from "../scripts/patch-dsh-web-auth.mjs";

const fixture = `
function processLaunchToken(owner) {
\tconst existing = PROCESS_LAUNCH_TOKENS.get(owner);
\tif (existing !== void 0) return existing;
\tconst created = encodeBase64Url(randomBytes(SECRET_BYTES));
\tPROCESS_LAUNCH_TOKENS.set(owner, created);
\treturn created;
}
`;

test("uses an entrypoint-provided launch token without changing the standalone fallback", () => {
  const patched = patchSource(fixture);
  assert.match(patched, /dsh-container-web-launch-token-v1/);
  assert.match(patched, /process\.env\.DSH_WEB_LAUNCH_TOKEN/);
  assert.match(patched, /canonicalSecret\(configured\)/);
  assert.match(patched, /const created = encodeBase64Url\(randomBytes\(SECRET_BYTES\)\)/);
  assert.equal(patchSource(patched), patched);
});

test("fails loudly when the upstream launch-token implementation drifts", () => {
  assert.throws(
    () => patchSource(fixture.replace("randomBytes(SECRET_BYTES)", "randomBytes(64)")),
    /cannot patch browser launch-token source/,
  );
});
