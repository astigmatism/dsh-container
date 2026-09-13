import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const marker = 'dsh-step-progress-status-v1';

export function currentStep(timeline) {
  let latest;
  for (const turn of timeline.turns.values()) {
    if (turn.status === 'open') latest = turn.steps.at(-1);
  }
  return latest === undefined ? null : {
    number: latest.step,
    startedAt: latest.start?.time ?? null,
    status: latest.status,
  };
}

function replace(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error(`Pinned progress UI source drift: ${before.slice(0, 90)}`);
  }
  return source.replace(before, after);
}

export function patchSource(input) {
  if (input.includes(marker)) return input;
  let source = replace(input, 'function TurnStatus({ startTime, t }) {',
    `// ${marker}: distinguish a long current step from a long multi-step turn.\n\t\t${currentStep.toString()}\n\t\tfunction TurnStatus({ startTime, timeline, t }) {\n\t\t\tconst step = currentStep(timeline);`);
  source = replace(source, 'const showClock = elapsedMs >= 15e3;', 'const showClock = true;');
  source = replace(source, 'children: [t("chat.deepDiving"), showClock &&',
    'children: [step ? `Working · step ${step.number}${step.status === "open" && step.startedAt !== null ? ` · current step ${formatRunDuration(Math.max(0, anchor + elapsedMs - step.startedAt), t)}` : " · between steps"} · total` : "Working · total", showClock &&');
  source = replace(source, 'startTime: runningTurnStart,', 'startTime: runningTurnStart,\n\t\t\t\t\t\t\t\t\ttimeline,');
  return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2] ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js';
  await writeFile(target, patchSource(await readFile(target, 'utf8')));
}
