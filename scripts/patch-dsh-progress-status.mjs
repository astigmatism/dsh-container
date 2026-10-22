import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const marker = 'dsh-step-progress-status-v1';
const hookDeclaration = 'const runningStep = useChatNode(';
const hookUse = 'rawStep: runningStep';

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

/**
 * Parameter list of the innermost `function <name>(…)`,
 * used as the scope a patched statement executes in.
 */
function enclosingParameters(source, index) {
  const signature = /(?:^|[^.\w$])function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  let enclosing;
  while ((match = signature.exec(source)) !== null) {
    if (match.index >= index) break;
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let at = open;
    while (at < source.length) {
      const char = source[at];
      if (char === '"' || char === "'" || char === '`') {
        const quote = char;
        at += 1;
        while (at < source.length && source[at] !== quote) at += source[at] === '\\' ? 2 : 1;
      } else if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') {
        depth -= 1;
        if (depth === 0 && char === ')') break;
      }
      at += 1;
    }
    enclosing = { name: match[1], parameters: source.slice(open + 1, at) };
  }
  return enclosing;
}

/**
 * `useChatNode` is a prop of the memoized ChatFlow component, not of the
 * outer chat view slot. A pinned anchor can survive a release yet move into a
 * neighbouring component, where the hook is an undefined identifier that
 * throws on every render and blanks the transcript. Verify the real scope of
 * both injected statements instead of trusting where the anchor matched.
 */
export function verifyHookScope(source) {
  for (const site of [
    ['runningStep hook', source.indexOf(hookDeclaration)],
    ['rawStep property', source.indexOf(hookUse)],
  ]) {
    const [what, at] = site;
    if (at < 0) throw new Error(`Progress patch verification failed: ${what} is missing`);
    const enclosing = enclosingParameters(source, at);
    if (!enclosing) throw new Error(`Progress patch verification failed: ${what} is not inside a function`);
    const scoped = enclosing.parameters
      .split(',')
      .some((parameter) => parameter.replace(/[{}\s]/g, '') === 'useChatNode');
    if (!scoped) {
      throw new Error(
        `Progress patch verification failed: ${what} was anchored in ${enclosing.name}(), `
        + 'which has no useChatNode prop; the hook must be anchored inside ChatFlow.',
      );
    }
  }
  return source;
}

export function patchSource(input) {
  if (input.includes(marker)) return verifyHookScope(input);
  if (input.includes('function RunningStatus({ startTime, t })')) {
    let source = replace(input, 'function RunningStatus({ startTime, t })',
      `function RunningStatus({ startTime, rawStep, t })`);
    source = replace(source,
      'const label = startTime === void 0 ? t("chat.deepDiving") : t("chat.deepDivingFor", { duration: formatRunDuration(Math.max(1e3, now - startTime), t).map((part) => part.text).join("") });',
      `// ${marker}\nconst step = rawStep === undefined ? null : { number: rawStep.step, startedAt: rawStep.start?.time ?? null, status: rawStep.status };\nconst durationText = ms => formatRunDuration(Math.max(0, ms), t).map(part => part.text).join('');\nconst label = (step ? 'Working · step ' + step.number + (step.status === 'open' && step.startedAt !== null ? ' · current step ' + durationText(now - step.startedAt) : ' · between steps') : 'Working') + (startTime === undefined ? '' : ' · total ' + durationText(now - startTime));`);
    source = replace(source, '\t\t\tconst runningStartTime = useChatNode(useChat((snapshot) => snapshot.navigation.items().at(-1)?.anchorKey) ?? "", (node) => {',
      '\t\t\tconst runningStep = useChatNode(useChat((snapshot) => snapshot.navigation.items().at(-1)?.anchorKey) ?? "", (node) => { const location = node?.location; return location?.kind === "turn" || location?.kind === "step" ? location.turn.status === "open" ? location.turn.steps.at(-1) : undefined : undefined; });\n\t\t\tconst runningStartTime = useChatNode(useChat((snapshot) => snapshot.navigation.items().at(-1)?.anchorKey) ?? "", (node) => {');
    source = replace(source, 'startTime: runningStartTime,', 'startTime: runningStartTime, rawStep: runningStep,');
    return verifyHookScope(source);
  }
  if (input.includes('function TurnProcessNodeView({ node, turnProcess, t })')) {
    return replace(input,
      'const label = running ? duration === void 0 ? t("chat.deepDiving") : t("message.turnProcess.deepDivingFor", { duration }) :',
      `// ${marker}: keep the upstream process disclosure and show the active step.\n\t\t\tconst step = turn.steps.at(-1);\n\t\t\tconst progress = step === void 0 ? 'Working' : \`Working · step \${step.step}\${step.status === 'open' && step.start !== undefined ? ' · current step ' + formatLiveRunDuration(Math.max(0, now - step.start.time), t) : ' · between steps'}\`;\n\t\t\tconst label = running ? progress + (duration === void 0 ? '' : ' · total ' + duration) :`);
  }
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
