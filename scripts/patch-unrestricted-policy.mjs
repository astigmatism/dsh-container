import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const marker = 'router-unrestricted-policy-v1';
function replace(source, before, after) {
  if (!source.includes(before)) throw new Error(`Pinned DSH source drift at ${before.slice(0, 90)}`);
  return source.replace(before, after);
}
export function patchAdapter(input) {
  if (input.includes(marker)) return input;
  let s = replace(input, 'const maxTokens = entry.maxTokens ?? base?.maxTokens ?? request.defaultMaxTokens;',
    `// ${marker}: null is an explicit unrestricted capability, never a request default.\n\t\tconst maxTokens = entry.maxTokens === null ? null : entry.maxTokens ?? base?.maxTokens ?? request.defaultMaxTokens;`);
  s = replace(s, 'if (!Number.isInteger(maxTokens) || maxTokens <= 0)', 'if (maxTokens !== null && (!Number.isInteger(maxTokens) || maxTokens <= 0))');
  s = replace(s, 'if (entry.maxTokens !== void 0) configuredMaxTokens.set', 'if (entry.maxTokens != null) configuredMaxTokens.set');
  s = replace(s, 'maxTokens: z.number().step(1).min(1),', 'maxTokens: z.union([z.number().step(1).min(1), z.const(null)]),');
  s = replace(s, 'function profileOptions(profile, reasoning, apiKey)', 'function profileOptions(profile, reasoning, apiKey, model)');
  s = replace(s, 'const enabledReasoning = reasoning === "off" ? void 0 : reasoning;', 'const enabledReasoning = reasoning === "off" && model.maxTokens !== null ? void 0 : reasoning;');
  s = replace(s, '...profileOptions(profile, reasoning, apiKey)', '...profileOptions(profile, reasoning, apiKey, model)');
  s = replace(s, 'idleWatchdog(upstream, streamIdleTimeoutMs, "LLM_STREAM_IDLE_TIMEOUT")',
    '(model.maxTokens === null ? { signal: upstream, next: iterator => iterator.next(), [Symbol.dispose]() {} } : idleWatchdog(upstream, streamIdleTimeoutMs, "LLM_STREAM_IDLE_TIMEOUT"))');
  return s;
}
export function patchSimpleOptions(input) {
  if (input.includes(marker)) return input;
  return replace(input, 'maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),',
    `// ${marker}: exact deliberate quota, otherwise omitted. Router counts formatted context.\n        maxTokens: model.maxTokens === null ? options?.maxTokens : clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),`);
}
export function patchResponses(input) {
  if (input.includes(marker)) return input;
  let s = input;
  s = replace(s, 'const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;',
    'const reasoningEffort = clampedReasoning === "off" && model.maxTokens !== null ? undefined : clampedReasoning;');
  s = replace(s, 'Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS)',
    '(model.maxTokens === null ? options.maxTokens : Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS))');
  s = replace(s, 'else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null)',
    'else if (model.maxTokens !== null && model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null)');
  s = replace(s, 'return new OpenAI({', 'return new (model.maxTokens === null ? RouterOpenAI : OpenAI)({');
  // The SDK has a default header timer; timeout=0 is an immediate abort in this
  // pinned SDK. Override the local route's fetch method, not its numeric timeout.
  s += `\n// ${marker}: the router owns connection/stall recovery and generation has no total deadline.\nclass RouterOpenAI extends OpenAI {\n  async fetchWithTimeout(url, init, _ms, controller) {\n    const { request } = await import(String(url).startsWith('https:') ? 'node:https' : 'node:http');\n    const { Readable } = await import('node:stream');\n    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;\n    return new Promise((resolve, reject) => {\n      const headers = new Headers(init.headers);\n      if (typeof init.body === 'string') headers.set('content-length', String(Buffer.byteLength(init.body)));\n      const req = request(url, { method: init.method || 'POST', headers: Object.fromEntries(headers), signal }, res => {\n        resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers: res.headers }));\n      });\n      req.once('error', reject);\n      if (init.body) req.write(init.body);\n      req.end();\n    });\n  }\n}\n`;
  return s;
}

export function patchCompaction(input) {
  if (input.includes(marker)) return input;
  let s = replace(input, 'maxTokens: config.maxTokens ?? 8192,',
    `// ${marker}: null explicitly omits a summarization output quota.\n\t\tmaxTokens: config.maxTokens === null ? void 0 : config.maxTokens ?? 8192,`);
  s = replace(s, 'maxTokens: override?.maxTokens ?? config.maxTokens,',
    'maxTokens: override?.maxTokens === null ? void 0 : override?.maxTokens ?? config.maxTokens,');
  s = replace(s, 'if (maxTokens !== void 0) assertPositiveInteger', 'if (maxTokens != null) assertPositiveInteger');
  s = replace(s, 'const maxTokensSchema = z.number().step(1).min(1);',
    'const maxTokensSchema = z.union([z.number().step(1).min(1), z.const(null)]);');
  return s;
}

export function patchResponsesShared(input) {
  const toolMarker = 'router-incomplete-tool-policy-v1';
  if (input.includes(toolMarker)) return input;
  return replace(input, '            const slot = getOrCreateSlot(event.output_index, item);\n            if (item.type === "reasoning"',
    `            const slot = getOrCreateSlot(event.output_index, item);
            // ${toolMarker}: never repair partial JSON into an executable tool.
            if (model.maxTokens === null && item.type === "function_call" && slot?.type === "toolCall") {
                const raw = item.arguments ?? slot.block.partialJson ?? "";
                slot.block.rawArguments = raw;
                if (item.status !== "completed") throw new Error("Incomplete tool call; raw argument deltas are retained and cannot execute.");
                try { const value = JSON.parse(raw); if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(); }
                catch { throw new Error("Malformed tool arguments; raw deltas are retained and cannot execute."); }
            }
            if (item.type === "reasoning"`);
}

export async function install(root = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules') {
  for (const [file, patch] of [
    ['@deepseek-ai/dsh-llm-pi-ai/lib/index.js', patchAdapter],
    ['@deepseek-ai/dsh-compaction-basic/lib/index.js', patchCompaction],
    ['@earendil-works/pi-ai/dist/api/simple-options.js', patchSimpleOptions],
    ['@earendil-works/pi-ai/dist/api/openai-responses.js', patchResponses],
    ['@earendil-works/pi-ai/dist/api/openai-responses-shared.js', patchResponsesShared]
  ]) {
    const target = `${root}/${file}`;
    await writeFile(target, patch(await readFile(target, 'utf8')));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await install(process.argv[2]);
