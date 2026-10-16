#!/usr/bin/env node
/**
 * Re-provide the `webRuntime` Cordis service that dsh-web-app dropped in
 * 0.2.1-alpha.5.
 *
 * dsh-better-sidebar (every published release through 0.26.1, published before
 * alpha.5) declares `inject: ["webServer", "sessions", "webRuntime", "tools"]`
 * and fences its `/sidebar/api` route with `ctx.webRuntime.trustedHosts`. In
 * 0.2.0-rc.2 dsh-web-app provided `webRuntime` from `resolveLanTrust(bindHost,
 * config.trustedHosts)`; alpha.5 folded LAN trust into the connection fence and
 * now provides only `webApp` (`{ getAdvertisedUrl }`), so the sidebar stays
 * `pending (waiting for service: webRuntime)` and never mounts.
 *
 * The web server binds to `127.0.0.1` unless `--host` is passed (the web-app
 * bundle patch wires `host: ctx.webStartup.host ?? '127.0.0.1'`), so rc.2's
 * `resolveLanTrust` sampled no LAN addresses for every supported topology and
 * `webRuntime.trustedHosts` was exactly the `--trusted-host` authorities. Those
 * arrive in alpha.5 through the `webStartup` service, so re-provide `webRuntime`
 * from them. Loopback requests pass the sidebar fence unconditionally, so this
 * restores the rc.2 behaviour without reintroducing LAN sampling (which alpha.5's
 * own connection fence no longer performs either).
 *
 * Drop this patch when a dsh-better-sidebar release injects `webStartup`/`webApp`
 * instead of `webRuntime`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const marker = 'dsh-container-web-runtime-compat-v1';

function replace(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error(`web-app source drift: ${before.slice(0, 90)}`);
  }
  return source.replace(before, after);
}

export function patchSource(input) {
  if (input.includes(marker)) return input;
  // Anchor on the webApp provide: the single line that replaced rc.2's
  // webRuntime provide. Inject webStartup (never hard-required at the top level,
  // so `dsh --profile web --help`, which provides no webStartup, is unaffected)
  // and re-provide webRuntime from its trusted-host authorities.
  const anchor = '\tctx.provide("webApp", { getAdvertisedUrl: appRootUrl });';
  return replace(input, anchor,
    `${anchor}\n`
    + `\t// ${marker}: dsh-better-sidebar (<=0.26.1) injects the webRuntime service that\n`
    + `\t// dsh-web-app 0.2.1-alpha.5 removed. Re-provide it from webStartup's --trusted-host\n`
    + `\t// authorities (loopback binds sample no LAN addresses, matching the rc.2\n`
    + `\t// resolveLanTrust result) so the sidebar mounts. Remove when a sidebar release\n`
    + `\t// injects webStartup/webApp.\n`
    + `\tctx.inject(["webStartup"], (startupCtx) => {\n`
    + `\t\tconst trustedHosts = startupCtx.webStartup?.trustedHosts ?? [];\n`
    + `\t\tctx.provide("webRuntime", { lanAddresses: [], trustedHosts });\n`
    + `\t});`);
}

export function verifySource(source) {
  if (!source.includes(marker)) throw new Error('webRuntime compatibility patch is not applied');
  return source;
}

async function main() {
  const check = process.argv.includes('--check');
  const target = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
    ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/lib/index.js';
  const source = await readFile(target, 'utf8');
  if (check) {
    verifySource(source);
    console.log('Verified dsh-web-app re-provides webRuntime for dsh-better-sidebar.');
    return;
  }
  await writeFile(target, patchSource(source));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
