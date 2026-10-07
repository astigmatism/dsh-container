import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const text = await readFile(new URL('../docs/llm-router-contract.md', import.meta.url), 'utf8');
const MAP = '## How DeepSeek Harness upholds this contract';
// sha256 of llm-router docs/CLIENT_CONTRACT.md at d5edba88089070e82bb72600e860fd204df88481.
const CONTRACT_V1_SHA256 = '5314c4ac4ec09e3bbe51816883077c28cff2c4538a09a64fa71961cbb432121f';
const HEADER = [
  '> **Vendored copy — do not edit.** LLM Router client contract, version 1, copied from',
  '> llm-router commit `d5edba88089070e82bb72600e860fd204df88481`. Canonical source:',
  '> https://github.com/astigmatism/llm-router/blob/main/docs/CLIENT_CONTRACT.md',
  '> Replace this copy only when the router maintainer announces a new contract version.',
  '',
].join('\n') + '\n';

test('the vendored contract is verbatim under its §11 header', () => {
  assert.ok(text.startsWith(HEADER), 'header');
  const end = text.indexOf(`\n${MAP}\n`);
  assert.ok(end > 0, 'the conformance map follows the copy');
  const vendored = text.slice(HEADER.length, end);
  assert.equal(createHash('sha256').update(vendored).digest('hex'), CONTRACT_V1_SHA256,
    'never edit the vendored text; replace it only for a new contract version');
  assert.match(vendored, /^# LLM Router client contract\n\n\*\*Version 1 · 2026-10-07\.\*\*/);
});

test('the conformance map covers every §13 item and records the §5 deviation', () => {
  const contract = text.slice(0, text.indexOf(`\n${MAP}\n`));
  const map = text.slice(text.indexOf(`\n${MAP}\n`));
  const checklist = contract.slice(contract.indexOf('## 13. Conformance checklist'), contract.indexOf('## 14. References'));
  const items = [...checklist.matchAll(/^- \[ \] (.+)$/gm)].map(match => match[1]);
  assert.equal(items.length, 11);
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
  for (const label of ['Nighttime — offline (flash-next-solo-128k)', 'Nighttime — unavailable', 'Nighttime — router switching configuration', 'Nighttime — incomplete metadata']) {
    assert.ok(doc.includes(label), label);
  }
  assert.doesNotMatch(doc, /qwen3\.8-27b-abliterated-q6_k|model `local-active`/);
});
