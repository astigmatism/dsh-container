#!/usr/bin/env node
/** Rehearse the supported migration only on an explicitly marked disposable copy. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
const home = path.resolve(process.argv[2] ?? '');
assert.equal((await fs.readFile(path.join(home, '.qualification-copy'), 'utf8')).trim(), 'disposable');
assert.notEqual(home, '/data/dsh');
const require = createRequire(`${process.env.DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh'}/package.json`);
const { Context } = await import(require.resolve('@deepseek-ai/cordis'));
const { default: Persistence } = await import(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl'));
const digest = value => createHash('sha256').update(value).digest('hex');
async function files(root) {
  const result = new Map();
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) for (const [name, hash] of await files(file)) result.set(name, hash);
    else if (item.isFile()) result.set(file, digest(await fs.readFile(file)));
  }
  return result;
}
const root = path.join(home, 'sessions');
const original = await files(root);
const ctx = new Context();
let count = 0, events = 0, forks = 0;
const failures = [];
try {
  await ctx.plugin(Persistence, { root });
  const store = ctx.sessionPersistence;
  const snapshots = await store.list();
  assert.ok(snapshots.length > 0, 'copied corpus must contain sessions');
  for (const { header } of snapshots) {
    const handles = [];
    try {
    const read = await store.open(header.id, 'read');
    handles.push(read);
    const before = await read.read();
    const hash = digest(JSON.stringify(before.events));
    const inherited = read.inheritedEventCount;
    await read.close();
    const write = await store.open(header.id, 'write');
    handles.push(write);
    assert.equal(write.header.version, 4);
    assert.equal(digest(JSON.stringify((await write.read()).events)), hash, 'publication retains migrated events');
    assert.equal(write.inheritedEventCount, inherited, 'fork prefix retained');
    await write.flush();
    await write.close();
    const reopened = await store.open(header.id, 'read');
    handles.push(reopened);
    assert.equal(digest(JSON.stringify((await reopened.read()).events)), hash, 'reopen preserves history');
    await reopened.close();
    count += 1;
    if (count % 10 === 0) console.log(`Migrated and reopened ${count} copied sessions.`);
    events += before.events.length;
    if (inherited > 0 || header.parentSession) forks += 1;
    } catch (error) {
      failures.push({ session: header.id, error: error.message });
    } finally {
      for (const handle of handles) await handle.close();
    }
  }
  for (const [file, hash] of original) assert.equal(digest(await fs.readFile(file)), hash, 'original generation/attachment preserved');
  console.log(JSON.stringify({ sessions: count, events, forks, originalFilesPreserved: original.size, format: 4, failures }));
  if (failures.length) process.exitCode = 1;
} finally { await ctx.fiber.dispose(); }
