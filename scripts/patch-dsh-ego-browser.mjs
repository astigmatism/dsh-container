#!/usr/bin/env node
import { readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const marker = 'dsh-ego-container-v1';
function replace(source, before, after, count = 1) {
  if (source.split(before).length !== count + 1) throw new Error(`Ego 0.8.6 source drift: ${before.slice(0, 90)}`);
  return source.replaceAll(before, after);
}
export function patchHost(source) {
  if (source.includes(marker)) return source;
  source = `// ${marker}\nimport { browserEnvironment, prepareBrowser, currentSpace, wrapTool, scopeSpaces } from './container/integration.mjs';\n` + source;
  source = replace(source, 'const inject = ["tools", "subprocess"];', 'const inject = ["tools", "subprocess", "attachments", "connection"];');
  source = replace(source, 'function apply(ctx, config = {}) {', 'async function apply(ctx, config = {}) {\nawait prepareBrowser(ctx);');
  source = replace(source, 'const env = { ...baseEnv };', 'const env = browserEnvironment(baseEnv);');
  source = replace(source, 'const e = process.env;', 'const e = browserEnvironment();', 4);
  source = replace(source, 'return this.spaceTracker.current();', 'return currentSpace() ?? this.spaceTracker.current();');
  source = replace(source, 'const dispose = ctx.tools.register(tool);', 'const wrapped = wrapTool(ctx, tool);\nif (!wrapped) return;\nconst dispose = ctx.tools.register(wrapped);');
  source = replace(source, 'ctx.inject?.(["webServer"], (wctx) => {', 'ctx.inject?.(["webServer", "connection"], (wctx) => {');
  source = replace(source, 'const isTrustedRequest = (req) => /(?:^|;\\s*)dsh-auth-[^=]+=/.test(String(req.headers.cookie ?? ""));',
    'const isTrustedRequest = (req) => ctx.connection.requestRejection(req) === undefined;');
  source = replace(source, 'env: process.versions.electron ? {\n\t\t\t\t\t\t...process.env,\n\t\t\t\t\t\tELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? "1"\n\t\t\t\t\t} : void 0,', 'env: browserEnvironment(),');
  source = replace(source, 'const data = await proxyFrom(port, "/api/spaces");', 'const raw = await proxyFrom(port, "/api/spaces");\nconst data = raw ? await scopeSpaces(_req, raw) : null;');
  source = replace(source, 'const res = resRaw;\n\t\t\t\tif (req.method !== "POST")', 'const res = resRaw;\nconst rejection = ctx.connection.requestRejection(req);\nif (rejection !== undefined) { res.writeHead(rejection); res.end(); return; }\n\t\t\t\tif (req.method !== "POST")');
  source = replace(source, 'const result = await openAgentWindow();', 'const result = { ok: false, error: "Use the native ego Sidebar tab in this headless deployment." };');
  source = replace(source, 'const result = await loginImport({', 'const result = await (async () => ({ ok: false, error: "Desktop cookie import is unavailable in this container; sign in using the ego Sidebar tab." }))({');
  return source;
}
export function patchClient(source) {
  if (source.includes(marker)) return source;
  source = `// ${marker}\n` + source;
  source = replace(source, 'var res = await fetch(SPACES_ROUTE, { cache: "no-store" });\n\t\t\t\t\tif (self.disposed',
    'var res = await fetch(SPACES_ROUTE + "?sessionId=" + encodeURIComponent(self.sessionId || ""), { cache: "no-store" });\n\t\t\t\t\tif (self.disposed');
  source = replace(source, 'var controller = controllerRef.current;', 'var controller = controllerRef.current;\ncontroller.sessionId = props.scope?.sessionId;');
  source = replace(source, 'if (Array.isArray(list)) self._processSpaces(list);', 'if (Array.isArray(list)) self.refresh();');
  source = replace(source, '\t\t\t\t\tif (!m || !m.targetId || !m.data) return;\n\t\t\t\t\tif (Number.isFinite(m.vw)', '\t\t\t\t\tif (!m || !m.targetId || !m.data || !self.pageMeta.has(m.targetId)) return;\n\t\t\t\t\tif (Number.isFinite(m.vw)');
  source = replace(source, 'title: wt("raiseWindowHint"),', 'style: { display: "none" }, title: wt("raiseWindowHint"),');
  return source;
}
export async function main(root = process.argv[2] || '/opt/dsh-seed/profiles/web/node_modules/dsh-ego-browser') {
  const manifest = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  if (manifest.version !== '0.8.6') throw new Error('Ego adapter requires pinned 0.8.6');
  for (const [file, patch] of [['lib/index.js', patchHost], ['lib/client.js', patchClient]]) {
    const path = `${root}/${file}`; await writeFile(path, patch(await readFile(path, 'utf8')));
  }
  const chrome = `${root}/runtime/ego-linux/src/chrome.mjs`;
  let source = await readFile(chrome, 'utf8');
  if (!source.includes(marker)) {
    source = replace(source, '--proxy-bypass-list=<-loopback>;127.0.0.1;localhost;[::1];172.16.0.0/12;10.0.0.0/8;*.local', '--proxy-bypass-list=<-loopback>');
    await writeFile(chrome, `// ${marker}: all page traffic uses the deployment policy proxy.\n` + source);
  }
  const helpers = process.env.DSH_EGO_ADAPTER_SOURCE || resolve(fileURLToPath(new URL('../plugin/dsh-ego-adapter', import.meta.url)));
  await mkdir(`${root}/lib/container`, { recursive: true });
  await cp(helpers, `${root}/lib/container`, { recursive: true });
  console.log('Applied pinned ego browser state, conversation, image and transport adapters.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
