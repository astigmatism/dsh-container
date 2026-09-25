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
    'printf "DSH_PTY_FIRST\\n"; IFS= read -r acknowledgement; '
      + '[ "$acknowledgement" = DSH_PTY_ACK ] || exit 1; printf "DSH_PTY_LAST\\n"'],
  { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp', env: { PATH: process.env.PATH, HOME: '/tmp' } });
  let output = '';
  let acknowledged = false;
  const timeout = setTimeout(() => { terminal.kill(); reject(new Error('Native Harness terminal timed out')); }, 10000);
  terminal.onData(chunk => {
    output += chunk;
    if (output.includes('DSH_PTY_FIRST') && !acknowledged) {
      // The child cannot finish until streamed output reaches this callback.
      // This proves incremental delivery without assuming CI scheduling latency.
      acknowledged = true;
      terminal.write('DSH_PTY_ACK\r');
    }
  });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timeout);
    try {
      assert.equal(exitCode, 0);
      assert.ok(output.includes('DSH_PTY_LAST'));
      assert.ok(acknowledged, 'PTY streams before command completion');
      resolve();
    } catch (error) { reject(error); }
  });
});
console.log('Verified Harness 0.1.7-rc.2 native PTY and incremental output.');
