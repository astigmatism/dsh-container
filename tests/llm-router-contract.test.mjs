import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const text = await readFile(new URL('../docs/llm-router-contract.md', import.meta.url), 'utf8');
const MAP = '## How DeepSeek Harness upholds this contract';
// sha256 of llm-router docs/CLIENT_CONTRACT.md at 0b1668669214a7c67cbba8008ddc98ffc1e14b72.
// The 1.2 text was copied from that commit and the SHA recomputed from the raw URL
// https://raw.githubusercontent.com/astigmatism/llm-router/0b1668669214a7c67cbba8008ddc98ffc1e14b72/docs/CLIENT_CONTRACT.md
// which is byte-identical to the commit's blob.
const CONTRACT_SHA256 = '8d93fd81520bef2779ce7b57eb8555c51a1c8cb8e46a9264c70e62cdbc84721e';
const HEADER = [
  '> **Vendored copy — do not edit.** LLM Router client contract, version 1.2, copied from',
  '> llm-router commit `0b1668669214a7c67cbba8008ddc98ffc1e14b72`. Canonical source:',
  '> https://github.com/astigmatism/llm-router/blob/main/docs/CLIENT_CONTRACT.md',
  '> Replace this copy only when the router maintainer announces a new contract version.',
  '',
].join('\n') + '\n';

test('the vendored contract is verbatim under its §11 header', () => {
  assert.ok(text.startsWith(HEADER), 'header');
  const end = text.indexOf(`\n${MAP}\n`);
  assert.ok(end > 0, 'the conformance map follows the copy');
  const vendored = text.slice(HEADER.length, end);
  assert.equal(createHash('sha256').update(vendored).digest('hex'), CONTRACT_SHA256,
    'never edit the vendored text; replace it only for a new contract version');
  assert.match(vendored, /^# LLM Router client contract\n\n\*\*Version 1\.2 · 2026-10-13\.\*\*/);
});

test('the conformance map covers every §13 item and records the §5 deviation', () => {
  const contract = text.slice(0, text.indexOf(`\n${MAP}\n`));
  const map = text.slice(text.indexOf(`\n${MAP}\n`));
  const checklist = contract.slice(contract.indexOf('## 13. Conformance checklist'), contract.indexOf('## 14. References'));
  const items = [...checklist.matchAll(/^- \[ \] (.+)$/gm)].map(match => match[1]);
  assert.equal(items.length, 12);
  const rows = [...map.matchAll(/^\| (.+?) \| .+ \| .+ \| .+ \|$/gm)].map(match => match[1]);
  for (const item of items) assert.ok(rows.includes(item), `conformance map row for: ${item}`);
  for (const row of map.matchAll(/^\| (?!§13 item|---)(.+?) \| (.+) \| (.+) \| (.+) \|$/gm)) {
    assert.match(row[3], /`[^`]+`/, `${row[1]}: names the code`);
    assert.match(row[4], /tests\/|scripts\/verify|CI /, `${row[1]}: names the tests`);
  }
  assert.match(map, /### Deviation permitted by §5: fallback disabled/);
  assert.match(map, /quietly\s+switching models mid-session would change its context window,\s+compaction and\s+refusal behavior/);
});

test('AGENTS.md requires router integration to uphold the vendored contract', async () => {
  const agents = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');
  assert.match(agents.replace(/\s+/g, ' '), /Router integration \(provider requests, model discovery, availability, retries, limits\) must uphold `docs\/llm-router-contract\.md`\. Update its conformance map with any such change\. Never edit the vendored contract text; replace it only when the LLM Router maintainer announces a new version\./);
});

test('docs/optional-residents.md describes the contract behavior and links it', async () => {
  const doc = await readFile(new URL('../docs/optional-residents.md', import.meta.url), 'utf8');
  assert.match(doc, /\[LLM Router client contract\]\(llm-router-contract\.md\)/);
  // Every state of the §5/§9 table, shown as the router publishes it: the row's
  // own title, then the state. Harness adds no words of its own to a label.
  for (const label of ['<published title> — offline (flash-next-solo-128k)', '<published title> — unavailable',
    '<published title> — router switching configuration', '<published title> — incomplete metadata']) {
    assert.ok(doc.includes(label), label);
  }
  assert.doesNotMatch(doc, /qwen3\.8-27b-abliterated-q6_k|model `local-active`/);
  // The retired release's labels named the service with a Harness word; a current
  // document must not show one as what a person reads in the picker.
  assert.doesNotMatch(doc, /`(Daytime|Nighttime|Trial) — (offline|unavailable|router switching|incomplete)/);
});
