#!/usr/bin/env node
/** Preserve the 0.21 workspace policy across Sidebar 0.24's removal of it. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARKER = 'dsh-sidebar-workspace-fence-v1';
export const SIDEBAR_VERSION = '0.24.1';

/** Embedded in the host bundle; dependencies are provided by its existing imports. */
export function createWorkspaceGuards({ realpath, relative, isAbsolute, join, dirname, basename, requireAbsolute, resolveSessionPath, SidebarError }) {
  function within(root, target) {
    const path = relative(root, target);
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\'));
  }
  function assertWithin(root, target) {
    if (!within(root, target)) throw new SidebarError('forbidden', `path "${target}" is outside workspace`, 403);
  }
  async function canonical(path) {
    try { return await realpath(path); }
    catch (error) { throw new SidebarError('fs-error', `cannot resolve "${path}": ${error.message}`, 400); }
  }
  async function ensureWorkspacePath(cwd, target, fence = true) {
    const absolute = requireAbsolute(resolveSessionPath(cwd, target));
    const [root, real] = await Promise.all([canonical(cwd), canonical(absolute)]);
    if (fence) assertWithin(root, real);
    return real;
  }
  async function ensureWorkspaceWritePath(cwd, target, fence = true) {
    const root = await canonical(cwd);
    let existing = requireAbsolute(resolveSessionPath(cwd, target));
    const missing = [];
    for (;;) {
      try {
        const real = await realpath(existing);
        const destination = join(real, ...missing);
        if (fence) assertWithin(root, destination);
        return destination;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          if (error instanceof SidebarError) throw error;
          throw new SidebarError('fs-error', `cannot resolve "${existing}": ${error.message}`, 400);
        }
        const parent = dirname(existing);
        if (parent === existing) throw new SidebarError('fs-error', `cannot resolve "${target}"`, 400);
        missing.unshift(basename(existing));
        existing = parent;
      }
    }
  }
  async function resolveEntry(cwd, target, fence = true) {
    const absolute = requireAbsolute(resolveSessionPath(cwd, target));
    const [realCwd, real] = await Promise.all([canonical(cwd), canonical(absolute)]);
    // The parent must also be within the workspace: mutations address the link itself.
    if (fence) {
      assertWithin(realCwd, real);
      if (real !== realCwd) assertWithin(realCwd, await canonical(dirname(absolute)));
    }
    return { absolute, real, realCwd };
  }
  return { ensureWorkspacePath, ensureWorkspaceWritePath, resolveEntry };
}

function replace(source, before, after, count = 1) {
  if (source.split(before).length - 1 !== count) throw new Error(`Workspace patch anchor changed: ${before}`);
  return source.split(before).join(after);
}

export function patchSidebarWorkspace(input) {
  if (input.includes(MARKER)) return input;
  let source = replace(input, 'import { access, lstat,', 'import { realpath, access, lstat,');
  source = replace(source, 'const SIDEBAR_PREFS_DEFAULTS = {', 'const SIDEBAR_PREFS_DEFAULTS = {\n\tworkspaceFence: true,');
  source = replace(source, 'const PrefsSchema = z.object({', 'const PrefsSchema = z.object({\n\tworkspaceFence: z.boolean().default(true),');
  const start = source.indexOf('//#region src/path-security.ts');
  const end = source.indexOf('//#region src/fs-operations.ts', start);
  if (start < 0 || end < start) throw new Error('Workspace path module anchor changed');
  source = source.slice(0, start) + `// ${MARKER}\n${createWorkspaceGuards.toString()}\nconst { ensureWorkspacePath, ensureWorkspaceWritePath, resolveEntry } = createWorkspaceGuards({ realpath, relative, isAbsolute, join, dirname, basename, requireAbsolute, resolveSessionPath, SidebarError });\nfunction fenceEnabledOf(getSettings) { return getSettings()?.get().value?.workspaceFence !== false; }\n` + source.slice(end);
  source = replace(source, 'async function resolveEntry(cwd, target) {\n\tconst absolute = requireAbsolute(resolveSessionPath(cwd, target));\n\treturn {\n\t\tabsolute,\n\t\treal: absolute,\n\t\trealCwd: requireAbsolute(cwd)\n\t};\n}', '');
  // Carry the live preference explicitly through every filesystem entry point.
  for (const [before, after, count] of [
    ['const { cwd, dir, relativePath, chunks, limit } = input;', 'const { cwd, dir, relativePath, chunks, limit, fence = true } = input;'],
    ['ensureWorkspacePath(cwd, base)', 'ensureWorkspacePath(cwd, base, fence)'],
    ['ensureWorkspaceWritePath(cwd, target)', 'ensureWorkspaceWritePath(cwd, target, fence)'],
    ['const { cwd, path, name } = input;', 'const { cwd, path, name, fence = true } = input;', 2],
    ['const { cwd, path } = input;', 'const { cwd, path, fence = true } = input;'],
    ['resolveEntry(cwd, path)', 'resolveEntry(cwd, path, fence)', 3],
    ['ensureWorkspaceWritePath(cwd, join(dirname(absolute), name))', 'ensureWorkspaceWritePath(cwd, join(dirname(absolute), name), fence)'],
    ['ensureWorkspaceWritePath(cwd, join(absolute, name))', 'ensureWorkspaceWritePath(cwd, join(absolute, name), fence)'],
    ['ensureWorkspacePath(cwd, requireString(payload, "path"))', 'ensureWorkspacePath(cwd, requireString(payload, "path"), fenceEnabledOf(getSettings))'],
    ['ensureWorkspacePath(cwd, requested)', 'ensureWorkspacePath(cwd, requested, fenceEnabledOf(getSettings))'],
    ['ensureWorkspacePath(cwd, await resolveGitPath(cwd, requireString(payload, "path"), selected))', 'ensureWorkspacePath(cwd, await resolveGitPath(cwd, requireString(payload, "path"), selected), fenceEnabledOf(getSettings))'],
    ['ensureWorkspaceWritePath(cwd, requireString(payload, "path"))', 'ensureWorkspaceWritePath(cwd, requireString(payload, "path"), fenceEnabledOf(getSettings))'],
    ['ensureWorkspacePath(cwd, raw)', 'ensureWorkspacePath(cwd, raw, fenceEnabledOf(getSettings))'],
    ['return renameWorkspaceEntry({\n\t\t\t\tcwd,', 'return renameWorkspaceEntry({\n\t\t\t\tfence: fenceEnabledOf(getSettings),\n\t\t\t\tcwd,'],
    ['return mkdirWorkspaceEntry({\n\t\t\t\tcwd,', 'return mkdirWorkspaceEntry({\n\t\t\t\tfence: fenceEnabledOf(getSettings),\n\t\t\t\tcwd,'],
    ['return removeWorkspaceEntry({\n\t\t\t\tcwd,', 'return removeWorkspaceEntry({\n\t\t\t\tfence: fenceEnabledOf(getSettings),\n\t\t\t\tcwd,'],
    ['const { path, size } = await writeWorkspaceUpload({', 'const { path, size } = await writeWorkspaceUpload({\n\t\t\t\t\tfence: fenceEnabledOf(() => settingsFace),'],
    ['ensureWorkspacePath(await sessionCwdOf(ctx, sessionId, url.searchParams.get("cwd") ?? void 0), raw)', 'ensureWorkspacePath(await sessionCwdOf(ctx, sessionId, url.searchParams.get("cwd") ?? void 0), raw, fenceEnabledOf(() => settingsFace))'],
    ['const absolute = await ensureWorkspacePath(await sessionCwdOf(ctx, sessionId), path);', 'const absolute = await ensureWorkspacePath(await sessionCwdOf(ctx, sessionId), path, fenceEnabledOf(() => settingsFace));'],
    ['attachFsWatch(ctx, ws, req);', 'attachFsWatch(ctx, ws, req, () => fenceEnabledOf(() => settingsFace));'],
    ['async function attachFsWatch(ctx, ws, req)', 'async function attachFsWatch(ctx, ws, req, fenceEnabled)'],
    ['handleFsWatchFrame(ctx, ws, watchers, sessionId, data)', 'handleFsWatchFrame(ctx, ws, watchers, sessionId, data, fenceEnabled)', 2],
    ['const dir = await ensureWorkspacePath(await sessionCwdOf(ctx, sessionId), path);', 'const dir = await ensureWorkspacePath(await sessionCwdOf(ctx, sessionId), path, fenceEnabled());'],
  ]) source = replace(source, before, after, count ?? 1);
  return source;
}

export async function main(args = process.argv.slice(2)) {
  const profileIndex = args.indexOf('--profile');
  const profile = profileIndex < 0 ? '/opt/dsh-seed/profiles/web' : args[profileIndex + 1];
  const root = resolve(profile, 'node_modules/dsh-better-sidebar');
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (manifest.version !== SIDEBAR_VERSION) throw new Error(`Expected Sidebar ${SIDEBAR_VERSION}`);
  const path = resolve(root, 'lib/index.js');
  const before = await readFile(path, 'utf8');
  const after = patchSidebarWorkspace(before);
  if (args.includes('--check')) {
    if (before !== after) throw new Error('Sidebar workspace patch missing');
  } else if (before !== after) await writeFile(path, after);
  console.log(`Verified ${MARKER}.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
