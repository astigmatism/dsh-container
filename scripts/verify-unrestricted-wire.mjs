import assert from 'node:assert/strict';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const root = process.argv[2] ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules';
const { streamSimple } = await import(pathToFileURL(`${root}/@earendil-works/pi-ai/dist/api/openai-responses.js`));
const { buildBaseOptions } = await import(pathToFileURL(`${root}/@earendil-works/pi-ai/dist/api/simple-options.js`));
const { PiAiAdapter } = await import(pathToFileURL(`${root}/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`));
const requests = [];
let partialTool = false;
let mode = 'complete';
let received;
let closed;
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks)));
  res.once('close', () => closed?.());
  received?.();
  if (mode === 'silent-headers') return;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (mode === 'silent-body') { res.flushHeaders(); return; }
  if (partialTool) {
    const item = { id: 'fc_partial', type: 'function_call', call_id: 'call_partial', name: 'lookup', arguments: '{"query":', status: 'incomplete' };
    const events = [
      { type: 'response.created', response: { id: 'resp_partial', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.incomplete', response: { id: 'resp_partial', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [item] } }
    ];
    res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    return;
  }

  const output = { id: 'msg_test', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'complete', annotations: [] }] };
  const events = [
    { type: 'response.created', response: { id: 'resp_test', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...output, content: [], status: 'in_progress' } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: 'msg_test', part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_test', delta: 'complete' },
    { type: 'response.output_item.done', output_index: 0, item: output },
    { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [output], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } }
  ];
  if (mode === 'progress') {
    let index = 0;
    const timer = setInterval(() => {
      res.write(`data: ${JSON.stringify(events[index++])}\n\n`);
      if (index === events.length) { clearInterval(timer); res.end(); }
    }, 30);
    res.once('close', () => clearInterval(timer));
    return;
  }
  // Greater than the deliberately tiny old SDK timeout below; completion is natural.
  setTimeout(() => res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')), 30);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const model = { id: 'local-active', provider: 'local-ollama', api: 'openai-responses',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 32768, maxTokens: null,
    reasoning: true, thinkingLevelMap: { off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' },
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const context = { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] };
  assert.equal(buildBaseOptions(model, context, {}).maxTokens, undefined);
  assert.equal(buildBaseOptions(model, { ...context, systemPrompt: 'x'.repeat(200000) }, { maxTokens: 65536 }).maxTokens, 65536);
  for (const options of [{}, { reasoning: 'off' }, { reasoning: 'medium', maxTokens: 1 }, { maxTokens: 65536 }]) {
    const events = [];
    for await (const event of streamSimple(model, context, { ...options, apiKey: 'synthetic-fixture', timeoutMs: 1, cacheRetention: 'none', maxRetries: 0 })) events.push(event);
    assert.equal(events.at(-1).type, 'done', JSON.stringify(events.at(-1)));
    const wire = requests.at(-1);
    assert.equal(wire.max_output_tokens, options.maxTokens);
    assert.equal(wire.reasoning?.effort, options.reasoning === 'off' ? 'none' : options.reasoning);
    assert.equal(wire.reasoning_budget_tokens, undefined);
  }
  partialTool = true;
  const partialEvents = [];
  for await (const event of streamSimple(model, context, { apiKey: 'synthetic-fixture', maxTokens: 1, maxRetries: 0 })) partialEvents.push(event);
  assert.equal(partialEvents.at(-1).type, 'error');
  assert.ok(!partialEvents.some(event => event.type === 'toolcall_end'));
  assert.equal(partialEvents.at(-1).error.content.find(block => block.type === 'toolCall').rawArguments, '{"query":');
  console.log('Partial tool JSON is retained verbatim and never emitted as an executable completed tool call.');
  partialTool = false;
  // Run the installed adapter and installed custom HTTP transport together.
  // A stalled endpoint must settle and release its socket for both explicit
  // Stop and inactivity expiry, before headers and after headers arrive.
  const adapter = new PiAiAdapter({ resolveApiKey: async () => 'synthetic-fixture' });
  const profile = { provider: model.provider, baseURL: model.baseUrl, modelErrors: new Map(), piProvider: {}, streamIdleTimeoutMs: 80, maxConcurrency: 1, cacheRetention: 'none' };
  const snapshot = { profiles: new Map([[model.provider, profile]]), models: { getModel: () => model, streamSimple } };
  const options = { provider: model.provider, model: model.id, messages: [] };
  async function bounded(promise) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cancellation failed to settle within 2 seconds')), 2000); })]);
    } finally { clearTimeout(timer); }
  }
  for (mode of ['silent-headers', 'silent-body']) {
    for (const action of ['stop', 'idle']) {
      const requestReceived = new Promise(resolve => { received = resolve; });
      const responseClosed = new Promise(resolve => { closed = resolve; });
      const controller = new AbortController();
      const collect = (async () => {
        try {
          for await (const _ of adapter.streamWithSnapshot({ ...options, signal: controller.signal }, snapshot)) {}
          return null;
        } catch (error) { return error; }
      })();
      await bounded(requestReceived);
      if (action === 'stop') controller.abort('user Stop');
      const error = await bounded(collect);
      // Caller abort may end the adapter iterator quietly; the owning agent
      // records its already-aborted signal as the durable cancellation cause.
      if (action === 'stop') assert.ok(error === null || error?.code === 'ABORTED', String(error));
      else assert.equal(error?.code, 'TIMEOUT', String(error));
      await bounded(responseClosed);
    }
  }
  mode = 'complete';
  // The same concurrency slot remains usable after cancellation and timeout.
  const recovered = [];
  for await (const chunk of adapter.streamWithSnapshot(options, snapshot)) recovered.push(chunk);
  assert.ok(recovered.some(chunk => chunk.type === 'text-delta'));
  mode = 'progress';
  // Provider progress resets the inactivity clock: total generation duration
  // exceeds that clock without adding a generation deadline or output quota.
  profile.streamIdleTimeoutMs = 150;
  for await (const _ of adapter.streamWithSnapshot(options, snapshot)) {}
  console.log('Installed adapter: Stop and idle expiry close silent header/body sockets; the next request completes.');
  console.log('Installed DSH SDK wire: omitted quota/effort remain omitted; explicit off/medium and 1/65536 are exact; no SDK deadline.');
} finally { server.closeAllConnections(); server.close(); }
