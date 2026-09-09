import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeCurrentSessionRow,
  inheritedEventCount,
  patchSource,
} from "../scripts/patch-dsh-token-session-format.mjs";

const fixture = `
import { SESSION_FORMAT_VERSION, decodeStorageRecord } from "@deepseek-ai/dsh-session";
function decodeArtifactBytes(bytes, compressed, fromCursor = 0, cachedHeader) {
\tlet header = cachedHeader;
\tconst body = [];
\tconst events = [];
\tfor (const line of body) for (const event of decodeStorageRecord(JSON.parse(line))) events.push(event);
\treturn { header, events };
}
`;

test("accepts released format v3 event rows without changing their payload", () => {
  const event = { type: "turn/start", seq: 3, time: 1700000000000, data: { turn: 1 } };
  assert.equal(decodeCurrentSessionRow(event), event);
});

test("rejects malformed physical rows instead of silently losing usage", () => {
  for (const value of [null, [], {}, { type: "turn/start", seq: -1, time: 1, data: {} }]) {
    assert.throws(() => decodeCurrentSessionRow(value), /malformed format v3 session row/);
  }
});

test("derives the fork-owned event boundary from the inherited seed marker", () => {
  assert.equal(inheritedEventCount([
    { type: "user/message", seq: 0, time: 1, data: {} },
    { type: "session/end-seed", seq: 1, time: 2, data: { inherited: true } },
    { type: "turn/start", seq: 2, time: 3, data: {} },
  ]), 1);
  assert.equal(inheritedEventCount([]), 0);
});

test("patch is anchored, complete, and idempotent", () => {
  const patched = patchSource(fixture);
  assert.match(patched, /dsh-token-session-format-v3-compat-v1/);
  assert.doesNotMatch(patched, /decodeStorageRecord/);
  assert.match(patched, /events\.push\(decodeCurrentSessionRow\(JSON\.parse\(line\)\)\)/);
  assert.match(patched, /seedLength: inheritedEventCount\(events\)/);
  assert.equal(patchSource(patched), patched);
});

test("upstream drift fails loudly", () => {
  assert.throws(
    () => patchSource(fixture.replace("decodeStorageRecord", "decodeRenamedRecord")),
    /cannot patch removed dsh-session decoder import/,
  );
});
