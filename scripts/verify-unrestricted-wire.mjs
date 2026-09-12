import assert from 'node:assert/strict';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const root = process.argv[2] ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules';
const { streamSimple } = await import(pathToFileURL(`${root}/@earendil-works/pi-ai/dist/api/openai-responses.js`));
const { buildBaseOptions } = await import(pathToFileURL(`${root}/@earendil-works/pi-ai/dist/api/simple-options.js`));
const requests = [];
let partialTool = false;
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks)));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
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
  console.log('Installed DSH SDK wire: omitted quota/effort remain omitted; explicit off/medium and 1/65536 are exact; no SDK deadline.');
} finally { server.closeAllConnections(); server.close(); }
