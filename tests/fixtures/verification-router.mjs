/** Deterministic Responses provider for Linux deployment-contract tests only. */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const levels = ['off', 'low', 'medium', 'xhigh'];
const data = ['local-active', 'qwen3.8-27b-abliterated-q6_k'].map((id, index) => ({
  id, object: 'model', x_ollama_router: {
    schema_version: 2, complete: true, warnings: [], alias: false, upstream_model: id,
    display_name: index ? 'Nighttime (128K)' : 'Daytime (128K)',
    context_window: 131072, active_request_limit: 1, output_policy: 'unrestricted',
    max_output_tokens: null, default_output_tokens: null,
    input_modalities: index ? ['text'] : ['text', 'image'],
    capabilities: index ? ['completion', 'thinking', 'tools'] : ['completion', 'thinking', 'tools', 'vision'],
    reasoning: { supported: true, default: 'medium', output_limit_policy: 'reject',
      absolute_max_output_tokens: null,
      efforts: { off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' },
      aliases: { none: 'off', minimal: 'low', high: 'xhigh', max: 'xhigh' },
      per_effort: Object.fromEntries(levels.map(level => [level,
        { enabled: level !== 'off', default_output_tokens: null, max_output_tokens: null }])) }
  }
}));

let mode = 'success';
http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (request.url.startsWith('/test/') && request.method === 'POST') {
    mode = request.url.slice('/test/'.length); response.end('ok'); return;
  }
  if (request.url === '/v1/models') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ object: 'list', data })); return;
  }
  if (request.url === '/health') { response.end('{"ok":true}'); return; }
  if (request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
  while (mode === 'hold' && !response.destroyed) await new Promise(resolve => setTimeout(resolve, 100));
  if (response.destroyed) return;
  if (mode === 'fail') {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'deliberate fixture failure', type: 'invalid_request_error' } })); return;
  }
  const input = JSON.parse(Buffer.concat(chunks).toString());
  const text = JSON.stringify(input.input);
  const answer = [...text.matchAll(/RESIDENT_\d+_[a-z0-9]+/g)].at(-1)?.[0] ?? 'READY';
  const id = 'resp_' + randomUUID(), itemId = 'msg_' + randomUUID();
  const message = { id: itemId, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: answer, annotations: [] }] };
  const completed = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed',
    model: input.model, output: [message], usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  let sequence_number = 0;
  function send(type, fields) { response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence_number++, ...fields })}\n\n`); }
  send('response.created', { response: { ...completed, status: 'in_progress', output: [] } });
  send('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
  send('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] } });
  send('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: answer });
  send('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text: answer });
  send('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part: message.content[0] });
  send('response.output_item.done', { output_index: 0, item: message });
  send('response.completed', { response: completed });
  response.end();
}).listen(11434, '0.0.0.0');
