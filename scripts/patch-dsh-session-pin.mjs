#!/usr/bin/env node
/** Keep published Session Pin navigation on rc2's UI-owned navigation service. */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const marker = 'dsh-session-pin-rc2-navigation-v1';
function replaceExpected(source, before, after, count = 1) {
  if (source.split(before).length !== count + 1) throw new Error('Session Pin navigation source changed');
  return source.replaceAll(before, after);
}
export function patchClient(source) {
  if (source.includes(marker)) return source;
  source = replaceExpected(source,
    'var inject = ["sessions", "workspaces", "configForms", "connection", "slots"];',
    'var inject = ["sessions", "workspaces", "configForms", "connection", "slots", "uiWorkspace"];');
  source = replaceExpected(source, 'c.sessions.retain(id, { source: "gateway" });', 'c.uiWorkspace.openSession(id);', 2);
  source = replaceExpected(source,
    `const startSession = c.workspaces.startSession;
        if (typeof startSession === "function") startSession(id);
        else warnOnce("workspace-open-unavailable", "session-pin: workspace open unavailable on this baseline");`,
    `void c.uiWorkspace.openWorkspace(id).catch(() => {
          warnOnce("workspace-open-unavailable", "session-pin: workspace navigation failed");
        });`);
  return `// ${marker}\n${source}`;
}
async function main() {
  const root = process.argv[2] ?? '/opt/dsh-seed/profiles/web/node_modules/dsh-session-pin';
  const manifest = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  if (manifest.version !== '0.7.15') throw new Error('Session Pin patch requires published 0.7.15');
  const client = await readFile(`${root}/lib/client.js`, 'utf8');
  const patched = patchClient(client);
  Function(patched);
  if (patched !== client) await writeFile(`${root}/lib/client.js`, patched);
  const dependency = '@deepseek-ai/dsh-client-ui-workspace';
  if (!manifest.dsh.client.inject.includes(dependency)) {
    manifest.dsh.client.inject.push(dependency);
    await writeFile(`${root}/package.json`, JSON.stringify(manifest, null, 2) + '\n');
  }
  console.log('Verified published Session Pin uses rc2 session and workspace navigation.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
