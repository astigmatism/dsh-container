#!/usr/bin/env node
/** Exercise the installed native PTY, not just its package manifest. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const runtimeRoot = process.env.DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh';
const require = createRequire(`${runtimeRoot}/node_modules/@deepseek-ai/dsh-subprocess-local/package.json`);
assert.equal(require('./package.json').version, '0.1.7-rc.2');
const pty = require('node-pty');
await new Promise((resolve, reject) => {
  const terminal = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-c',
    'printf "DSH_PTY_FIRST\\n"; sleep 1; printf "DSH_PTY_LAST\\n"'],
  { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp', env: { PATH: process.env.PATH, HOME: '/tmp' } });
  let output = '';
  let firstAt;
  const timeout = setTimeout(() => { terminal.kill(); reject(new Error('Native Harness terminal timed out')); }, 10000);
  terminal.onData(chunk => {
    output += chunk;
    if (output.includes('DSH_PTY_FIRST') && firstAt === undefined) firstAt = Date.now();
  });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timeout);
    try {
      assert.equal(exitCode, 0);
      assert.ok(output.includes('DSH_PTY_LAST'));
      assert.ok(firstAt !== undefined && Date.now() - firstAt >= 700, 'PTY streams before command completion');
      resolve();
    } catch (error) { reject(error); }
  });
});
console.log('Verified Harness 0.1.7-rc.2 native PTY and incremental output.');
