#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const marker = 'dsh-appearance-rc2-icon-v1';
export function patchClient(source) {
  if (source.includes(marker)) return source;
  const before = '_deepseek_ai_dsh_client_ui_primitives.IconPersonalizationOutline16';
  if (source.split(before).length !== 2) throw new Error('Appearance icon source changed');
  return `// ${marker}\n${source.replace(before, '_deepseek_ai_dsh_client_ui_primitives.IconPersonalizationOutlineMedium')}`;
}
async function main() {
  const root = process.argv[2] ?? '/opt/dsh-seed/profiles/web/node_modules/dsh-ui-appearance';
  const manifest = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  if (manifest.version !== '0.1.11') throw new Error('Appearance patch requires published 0.1.11');
  const before = await readFile(`${root}/lib/client.js`, 'utf8');
  const after = patchClient(before);
  Function(after);
  if (after !== before) await writeFile(`${root}/lib/client.js`, after);
  console.log('Verified Appearance settings use the rc2 personalization icon.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
