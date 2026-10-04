import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Session titles are a short auxiliary request. The upstream generator leaves
// reasoningEffort unset, so a resident reasoning model inherits its provider's
// medium default and spends the whole 64-token title budget thinking: the
// request then ends with max-tokens and every automatic title is rejected.
// Ask for "off" when the exact route advertises it; otherwise keep the
// upstream request unchanged.
export const marker = 'dsh-session-title-reasoning-off-v1';

export const DEFAULT_TARGET = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-title-llm/lib/index.js';

const helperAnchor = '/** Stable language-aware system instruction shared by both provider plugins. */';

const helper = `/** ${marker}: reasoning effort for the auxiliary title call, or undefined to keep the route default. */
async function titleReasoningEffort(ctx, route, signal) {
	let info;
	try {
		info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal);
	} catch (error) {
		if (signal.aborted) throw error;
		return void 0;
	}
	const efforts = info?.reasoning?.efforts;
	return Array.isArray(efforts) && efforts.some((effort) => effort?.id === "off") ? "off" : void 0;
}
`;

const optionsAnchor = `		const options = deepFreeze({
			provider: route.provider,
			model: route.model,
			messages,
			system,
			maxTokens: config.maxOutputTokens,`;

const patchedOptions = `		const reasoningEffort = await titleReasoningEffort(ctx, route, callDeadline.signal);
		const options = deepFreeze({
			provider: route.provider,
			model: route.model,
			...reasoningEffort === void 0 ? {} : { reasoningEffort },
			messages,
			system,
			maxTokens: config.maxOutputTokens,`;

function replaceOnce(source, before, after) {
  const first = source.indexOf(before);
  if (first === -1 || first !== source.lastIndexOf(before)) {
    throw new Error(`Pinned session-title source drift: ${before.trim().split('\n')[0].slice(0, 90)}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function patchSource(input) {
  if (input.includes(marker)) return input;
  let source = replaceOnce(input, helperAnchor, helper + helperAnchor);
  source = replaceOnce(source, optionsAnchor, patchedOptions);
  return source;
}

export function isPatched(source) {
  return source.includes(marker) && source.includes('...reasoningEffort === void 0 ? {} : { reasoningEffort },');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const check = args[0] === '--check';
  const target = (check ? args[1] : args[0]) ?? DEFAULT_TARGET;
  const source = await readFile(target, 'utf8');
  if (check) {
    if (!isPatched(source)) throw new Error(`Session-title reasoning patch is missing from ${target}`);
  } else {
    await writeFile(target, patchSource(source));
  }
}
