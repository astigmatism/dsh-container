#!/usr/bin/env node
/** Appearance 0.1.23 upstreamed the host icon adapter (weight-suffixed icon
 * exports with an inline-SVG fallback), so the rc2 settings-icon replacement
 * is no longer applied. This script now verifies the upstream adapter is
 * present, keeping the build gate: a future Appearance release that drops it
 * must fail here rather than crash the settings row.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function verifyClient(source) {
  const adapter = 'IconPersonalizationOutlineRegular ?? _deepseek_ai_dsh_client_ui_primitives.IconPersonalizationOutlineMedium';
  if (!source.includes(adapter)) throw new Error('Appearance settings icon adapter changed');
  return source;
}
async function main() {
  const root = process.argv[2] ?? '/opt/dsh-seed/profiles/web/node_modules/dsh-ui-appearance';
  const manifest = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  if (manifest.version !== '0.1.23') throw new Error('Appearance patch requires published 0.1.23');
  verifyClient(await readFile(`${root}/lib/client.js`, 'utf8'));
  console.log('Verified Appearance settings use the upstream personalization icon adapter.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
