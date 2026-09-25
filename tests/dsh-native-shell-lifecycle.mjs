// Runs against the installed native executor without creating a Harness session.
// From the repository: docker exec -i deepseek-harness node --input-type=module < tests/dsh-native-shell-lifecycle.mjs
// DSH_RUNTIME_ROOT may point at another installed profile dependency root.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'linux', 'Run this process-tree check inside a local Linux Harness container.');
const require = createRequire(path.join(process.env.DSH_RUNTIME_ROOT ?? '/data/dsh/profiles', 'package.json'));
const { Context } = await import(require.resolve('@deepseek-ai/cordis'));
const { LocalSubprocessRuntime } = await import(require.resolve('@deepseek-ai/dsh-subprocess-local'));
const { LocalBashExecutor } = await import(require.resolve('@deepseek-ai/dsh-bash-local'));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-native-shell-lifecycle-'));
const spillPaths = new Set();
const ctx = new Context();
// rc2 exposes a live execution handle; result() waits for final collection.
const run = async spec => (await ctx.shell.execute(spec)).result();
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  assert.fail(message);
}

async function processIdentity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], startTicks: fields[19] };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined;
    throw error;
  }
}

async function assertStopped(identities) {
  await waitFor(async () => {
    const running = await Promise.all(identities.map(async ({ pid, startTicks }) => {
      const current = await processIdentity(pid);
      // A zombie has exited; PID reuse must never be mistaken for our fixture.
      return current && current.startTicks === startTicks && !['Z', 'X'].includes(current.state);
    }));
    return running.every(value => !value);
  }, 'Native cancellation left a fixture parent, child, or grandchild running.');
}

function retainSpillPaths(result) {
  for (const stream of [result.stdout, result.stderr]) {
    if (stream.spillPath) spillPaths.add(stream.spillPath);
  }
}

try {
  await ctx.plugin(LocalSubprocessRuntime);
  await ctx.plugin(LocalBashExecutor, {
    cwd: temporaryRoot,
    timeoutMs: 120000,
    maxTimeoutMs: 600000,
    maxOutputBytes: 256,
    maxSpillBytes: 65536,
    graceMs: 100,
  });

  for (const [requested, expected] of [[undefined, 120000], [570000, 570000], [700000, 600000], [5000, 5000]]) {
    const spec = ctx.shell.resolve({ command: 'printf budget-ok', ...(requested === undefined ? {} : { timeoutMs: requested }) });
    assert.equal(spec.timeoutMs, expected);
    const result = await run(spec);
    assert.equal(result.timeoutMs, expected);
    assert.equal(result.stdout.text, 'budget-ok');
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false, `A quick command with a ${expected}ms budget should complete.`);
    assert.equal(result.aborted, false, `The ${expected}ms budget check was not cancelled.`);
  }
  for (const timeoutMs of [0, -1, NaN, Infinity]) {
    assert.throws(() => ctx.shell.resolve({ command: 'true', timeoutMs }), /positive finite/);
  }
  console.log('PASS native default, explicit, capped, and shorter timeout budgets');

  const failed = await run(ctx.shell.resolve({
    command: `${quote(process.execPath)} -e ${quote("require('node:assert/strict').equal(1, 2)")}`,
    timeoutMs: 5000,
  }));
  retainSpillPaths(failed);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.timedOut, false);
  assert.equal(failed.aborted, false);
  const failureOutput = failed.stderr.spillPath ? await readFile(failed.stderr.spillPath, 'utf8') : failed.stderr.text;
  assert.match(failureOutput, /AssertionError/);
  console.log('PASS failed assertions remain completed commands');

  const fixture = path.join(temporaryRoot, 'process-tree.mjs');
  await writeFile(fixture, `
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [role, root] = process.argv.slice(2);
process.on('SIGTERM', () => {});
const fields = readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ');
writeFileSync(path.join(root, role + '.json'), JSON.stringify({ pid: process.pid, startTicks: fields[19] }));
if (role !== 'grandchild') spawn(process.execPath, [process.argv[1], role === 'parent' ? 'child' : 'grandchild', root], { stdio: 'inherit' });
if (role === 'parent') {
  process.stdout.write('STDOUT-HEAD\\n' + 'x'.repeat(4096) + '\\nSTDOUT-TAIL\\n');
  process.stderr.write('STDERR-HEAD\\n' + 'y'.repeat(4096) + '\\nSTDERR-TAIL\\n');
}
setInterval(() => {}, 1000);
// A failed cleanup assertion must not leave an indefinite fixture behind.
setTimeout(() => process.exit(99), 30000);
`);

  for (const cause of ['timeout', 'caller-stop']) {
    const runRoot = await mkdtemp(path.join(temporaryRoot, `${cause}-`));
    const controller = new AbortController();
    const timeoutMs = cause === 'timeout' ? 10000 : 20000;
    const running = run(ctx.shell.resolve({
      command: `exec ${quote(process.execPath)} ${quote(fixture)} parent ${quote(runRoot)}`,
      timeoutMs,
      signal: controller.signal,
    }));
    // Always await the native execution after a test failure as well as success.
    let result;
    try {
      const identities = [];
      await waitFor(async () => {
        identities.length = 0;
        try {
          for (const role of ['parent', 'child', 'grandchild']) {
            identities.push(JSON.parse(await readFile(path.join(runRoot, `${role}.json`), 'utf8')));
          }
          return true;
        } catch (error) {
          if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
          throw error;
        }
      }, 'The controlled three-process fixture did not become ready.', 8000).catch(async error => {
        controller.abort('fixture startup failed');
        result = await running;
        retainSpillPaths(result);
        error.message += ` Files: ${(await readdir(runRoot)).join(', ')}. stdout=${result.stdout.text}; stderr=${result.stderr.text}`;
        throw error;
      });
      if (cause === 'caller-stop') controller.abort('intentional fixture Stop');
      result = await running;
      retainSpillPaths(result);
      assert.equal(result.timedOut, cause === 'timeout');
      assert.equal(result.aborted, cause === 'caller-stop');
      assert.equal(result.timeoutMs, timeoutMs);
      assert.equal(result.signal, 'SIGKILL', 'TERM-ignoring fixture must exercise kill escalation.');
      await assertStopped(identities);
      for (const [name, stream] of [['STDOUT', result.stdout], ['STDERR', result.stderr]]) {
        assert.equal(stream.truncated, true);
        assert.match(stream.text, new RegExp(`${name}-TAIL`));
        assert.ok(stream.spillPath, `${name} should retain a full-output spill path.`);
        const full = await readFile(stream.spillPath, 'utf8');
        assert.match(full, new RegExp(`${name}-HEAD`));
        assert.match(full, new RegExp(`${name}-TAIL`));
      }
      console.log(`PASS ${cause}: captured output, spill recovery, and parent/child/grandchild cleanup`);
    } finally {
      controller.abort('fixture cleanup');
      result ??= await running;
      retainSpillPaths(result);
    }
  }
} finally {
  try {
    await ctx.fiber.dispose();
  } finally {
    await Promise.all([...spillPaths].map(spillPath => rm(spillPath, { force: true })));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
