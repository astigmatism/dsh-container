import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { verifyTokenPolicy } from "../scripts/verify-dsh-token-policy.mjs";

const root = new URL("../", import.meta.url);

test("effective loader policy is fail-closed with an explicit opt-in", () => {
  const effective = `
- id: previous
  disabled: false
- id: dsh-token
  disabled: !!js (process.env.DSH_TOKEN_ENABLED ?? 'false').toLowerCase() !== 'true'
  config:
    refreshIntervalMs: 30000
- id: next
  disabled: false
`;
  verifyTokenPolicy(effective, "disabled");
  verifyTokenPolicy(effective, "enabled");
  assert.throws(
    () => verifyTokenPolicy("- id: dsh-token\n  disabled: true\n", "enabled"),
    /must explicitly enable/,
  );
});

test("manifest, lockfile, Compose, and operator configuration share the policy", async () => {
  const [manifestSource, lockSource, patch, compose, envExample, inventorySource] = await Promise.all([
    readFile(new URL("seed/profile/package.json", root), "utf8"),
    readFile(new URL("seed/profile/pnpm-lock.yaml", root), "utf8"),
    readFile(new URL("seed/profile/cordis.patch.yml", root), "utf8"),
    readFile(new URL("compose.yaml", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
    readFile(new URL("config/plugins.lock.json", root), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource);
  const inventory = JSON.parse(inventorySource);

  assert.equal(manifest.dependencies["@zoytown/dsh-token"], "0.1.3");
  assert.match(lockSource, /'@zoytown\/dsh-token':\n\s+specifier: 0\.1\.3\n\s+version: 0\.1\.3/);
  assert.match(patch, /process\.env\.DSH_TOKEN_ENABLED \?\? 'false'/);
  assert.match(compose, /DSH_TOKEN_ENABLED: "\$\{DSH_TOKEN_ENABLED:-false\}"/);
  assert.match(envExample, /^DSH_TOKEN_ENABLED=false$/m);
  assert.deepEqual(inventory.policies["@zoytown/dsh-token"], {
    enabledByDefault: false,
    optIn: "DSH_TOKEN_ENABLED=true",
    reason: inventory.policies["@zoytown/dsh-token"].reason,
  });
  assert.match(inventory.policies["@zoytown/dsh-token"].reason, /multi-gigabyte Harness RSS growth/);
});
