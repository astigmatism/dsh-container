import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Plain Enter (and the primary Send button) while an agent is busy steers the
// running Turn instead of queueing a new one. Cmd/Ctrl+Enter keeps the
// opposite action, so queueing stays one chord away.
//
// The repository profile sets `ui-conversation.busyEnter: steer`, which pages
// that read Host settings (desktop and loopback Web) adopt. Remote Web pages,
// including every LAN and gateway URL, keep Config forms process-local and never
// read that value, so the browser default itself must also be steer. An
// explicit choice in Settings still wins wherever Settings persist.
export const marker = 'dsh-busy-enter-steer-v1';

export const DEFAULT_TARGET = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js';

const before = 'const DEFAULT_BUSY_ENTER_BEHAVIOR = "queue";';
const after = `const DEFAULT_BUSY_ENTER_BEHAVIOR = "steer"; // ${marker}`;

export function patchSource(input) {
  if (input.includes(marker)) return input;
  const first = input.indexOf(before);
  if (first === -1 || first !== input.lastIndexOf(before)) {
    throw new Error(`Pinned busy-Enter source drift: ${before}`);
  }
  if (!input.includes('const BUSY_ENTER_BEHAVIORS = ["queue", "steer"];')) {
    throw new Error('Pinned busy-Enter source drift: behavior vocabulary changed');
  }
  return input.slice(0, first) + after + input.slice(first + before.length);
}

export function isPatched(source) {
  return source.includes(after) && !source.includes(before);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const check = args[0] === '--check';
  const target = (check ? args[1] : args[0]) ?? DEFAULT_TARGET;
  const source = await readFile(target, 'utf8');
  if (check) {
    if (!isPatched(source)) throw new Error(`Busy-Enter steer default is missing from ${target}`);
  } else {
    await writeFile(target, patchSource(source));
  }
}
