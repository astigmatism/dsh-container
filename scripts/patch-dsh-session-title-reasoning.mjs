import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Session titles are a short auxiliary request. Before 0.2.1 the upstream
// generator left reasoningEffort unset, so a resident reasoning model
// inherited its provider's medium default and spent the whole 64-token title
// budget thinking; this container patched the generator to request "off".
// 0.2.1-alpha.5 upstreamed the fix: the generator resolves the route model
// through ctx.llm.prepareCall and applies the provider's
// selectReasoningEffort — the least supported effort, "off" when advertised.
// This script now verifies that upstream behavior endures; a release that
// drops the effort selection must fail the build instead of silently
// re-breaking every automatic title.
export const marker = 'dsh-session-title-reasoning-off-v1';

export const DEFAULT_TARGET = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-title-llm/lib/index.js';
export const PROVIDER_PACKAGES = ['dsh-session-title-all-prompts-llm', 'dsh-session-title-first-prompt-llm'];

export function verifyGenerator(source) {
  for (const anchor of [
    'const effort = prepared.selectReasoningEffort(model);',
    '...effort === void 0 ? {} : { reasoningEffort: effort }',
  ]) {
    if (!source.includes(anchor)) throw new Error(`Session-title reasoning upstream drift: ${anchor}`);
  }
}

export function verifyProvider(source) {
  const anchor = 'const selectReasoningEffort = (model) => model.reasoning?.efforts';
  if (!source.includes(anchor)) throw new Error('Session-title provider reasoning selector changed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const target = (args[0] === '--check' ? args[1] : args[0]) ?? DEFAULT_TARGET;
  verifyGenerator(await readFile(target, 'utf8'));
  const packagesRoot = path.dirname(path.dirname(path.dirname(target)));
  for (const provider of PROVIDER_PACKAGES) {
    verifyProvider(await readFile(path.join(packagesRoot, provider, 'lib/index.js'), 'utf8'));
  }
  console.log(`Verified ${marker}: upstream selects the least reasoning effort for title calls.`);
}
