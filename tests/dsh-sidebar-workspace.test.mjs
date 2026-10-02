import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, isAbsolute, join, dirname, basename, resolve } from 'node:path';
import { createWorkspaceGuards } from '../scripts/patch-dsh-sidebar-workspace.mjs';

class SidebarError extends Error { constructor(code, message, status) { super(message); this.code = code; this.status = status; } }
const guards = createWorkspaceGuards({ realpath, relative, isAbsolute, join, dirname, basename,
  requireAbsolute: path => { assert.ok(isAbsolute(path)); return resolve(path); },
  resolveSessionPath: (_, path) => path, SidebarError });

test('Sidebar reads and mutations retain the default workspace fence, including symlinks', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'sidebar-fence-')));
  const root = join(base, 'workspace');
  const outside = join(base, 'outside');
  await Promise.all([mkdir(root), mkdir(outside)]);
  await Promise.all([writeFile(join(root, 'inside'), 'inside'), writeFile(join(outside, 'secret'), 'outside')]);
  await symlink(outside, join(root, 'escape'));
  await symlink(join(root, 'inside'), join(outside, 'inward'));
  try {
    const denied = operation => assert.rejects(operation, error => error.status === 403);
    assert.equal(await guards.ensureWorkspacePath(root, join(root, 'inside')), join(root, 'inside'));
    await denied(guards.ensureWorkspacePath(root, join(outside, 'secret')));
    await denied(guards.ensureWorkspacePath(root, join(root, 'escape', 'secret')));
    await denied(guards.ensureWorkspaceWritePath(root, join(root, 'escape', 'new', 'file')));
    await denied(guards.resolveEntry(root, join(root, 'escape')));
    await denied(guards.resolveEntry(root, join(outside, 'inward')));
    assert.equal(await guards.ensureWorkspaceWritePath(root, join(root, 'new', 'file')), join(root, 'new', 'file'));
    assert.equal(await guards.ensureWorkspacePath(root, join(root, 'escape', 'secret'), false), join(outside, 'secret'));
    assert.equal(await guards.ensureWorkspaceWritePath(root, join(root, 'escape', 'new'), false), join(outside, 'new'));
    assert.equal((await guards.resolveEntry(root, join(root, 'escape'), false)).absolute, join(root, 'escape'));
  } finally { await rm(base, { recursive: true, force: true }); }
});
