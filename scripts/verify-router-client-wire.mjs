#!/usr/bin/env node
/** Wire-level qualification of the installed adapter against a synthetic LLM Router.
 *
 * docs/llm-router-contract.md §6–§10: queue keepalives keep a queued Responses
 * stream alive past the idle timeout, every router error code (HTTP and
 * in-stream) maps to its contract action, request-time codes reach the
 * discovery hub, and every request carries X-Client-Name. No real router or
 * AI Runtime is contacted.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const root = process.argv[2] ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules';
const { streamSimple } = await import(pathToFileURL(`${root}/@earendil-works/pi-ai/dist/api/openai-responses.js`));
const { PiAiAdapter } = await import(pathToFileURL(`${root}/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`));
const HUB = Symbol.for('dsh-container.router-contract.v1');
const CLIENT = 'deepseek-harness/wire-fixture';

let scenario;
const seen = [];
const sse = (res, events) => { for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`); };
const output = { id: 'msg_wire', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'queued answer', annotations: [] }] };
const created = { type: 'response.created', response: { id: 'resp_wire', status: 'in_progress', output: [] } };
const inProgress = { type: 'response.in_progress', response: { id: 'resp_wire', status: 'in_progress', output: [] } };
const completion = [
  { type: 'response.output_item.added', output_index: 0, item: { ...output, content: [], status: 'in_progress' } },
  { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: 'msg_wire', part: { type: 'output_text', text: '', annotations: [] } },
  { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_wire', delta: 'queued answer' },
  { type: 'response.output_item.done', output_index: 0, item: output },
  { type: 'response.completed', response: { id: 'resp_wire', status: 'completed', output: [output], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
];
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  seen.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) });
  const current = scenario;
  if (current.status) {
    res.writeHead(current.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(current.body));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.flushHeaders();
  if (current.inStream) { sse(res, [created, inProgress, current.inStream]); res.end(); return; }
  // Queued: the router sends only response.created/in_progress, then comments.
  sse(res, [created, inProgress]);
  let elapsed = 0;
  const timer = setInterval(() => {
    elapsed += current.keepaliveMs;
    if (elapsed < current.queueMs) { res.write(': waiting for inference slot\n\n'); return; }
    clearInterval(timer);
    sse(res, completion);
    res.end();
  }, current.keepaliveMs);
  res.once('close', () => clearInterval(timer));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const reports = [];
globalThis[HUB] = { report: (provider, event) => reports.push({ provider, ...event }), success: () => {} };
try {
  const model = { id: 'nighttime', provider: 'local-everyday', api: 'openai-responses',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 97280, maxTokens: null,
    reasoning: true, thinkingLevelMap: { off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' },
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const adapter = new PiAiAdapter({ resolveApiKey: async () => 'local-only' });
  const profile = { provider: model.provider, baseURL: model.baseUrl, modelErrors: new Map(), configuredMaxTokens: new Map(), piProvider: {},
    streamIdleTimeoutMs: 150, maxConcurrency: 1, cacheRetention: 'none', headers: { 'X-Client-Name': CLIENT },
    residentState: { service: 'nighttime', status: 'available', label: 'Nighttime (96K) · NSFW', limits: 'current', nsfw: true } };
  const snapshot = { profiles: new Map([[model.provider, profile]]), models: { getModel: (_provider, id) => id === model.id ? model : undefined, getModels: () => [model], streamSimple } };
  adapter.current = () => snapshot;
  const run = async () => {
    const chunks = [];
    try {
      for await (const chunk of adapter.streamWithSnapshot({ provider: model.provider, model: model.id, messages: [] }, snapshot)) chunks.push(chunk);
    } catch (error) { return { error, chunks }; }
    return { chunks, finish: chunks.findLast(chunk => chunk.type === 'finish') };
  };

  // §7: a request queued for longer than the idle timeout survives on keepalive comments.
  scenario = { queueMs: 600, keepaliveMs: 40 };
  const queued = await run();
  assert.equal(queued.error, undefined, String(queued.error));
  assert.equal(queued.finish?.reason.kind, 'stop', JSON.stringify(queued.finish));
  assert.ok(queued.chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'queued answer'));
  assert.equal(seen.at(-1).headers['x-client-name'], CLIENT, 'provider requests identify Harness');
  assert.equal(seen.at(-1).body.model, 'nighttime', 'requests send the service ID');
  assert.equal(seen.at(-1).body.stream, true, 'stream is set explicitly');
  console.log('A Responses request queued 4x past the idle timeout completed on router keepalive comments; X-Client-Name and the service ID were sent.');

  // §10: classify by error.code first, then HTTP status. Bodies use the router's exact shapes.
  const openai = (code, message = `${code} fixture`) => ({ error: { message, type: 'server_error', param: 'model', code } });
  const cases = [
    [{ status: 503, body: openai('SERVICE_OFFLINE', 'Fixture is offline in runtime configuration "fixture-solo" (exclusive_configuration).') }, 'MODEL_UNAVAILABLE', 'SERVICE_OFFLINE'],
    [{ status: 404, body: openai('MODEL_NOT_FOUND') }, 'MODEL_UNAVAILABLE', 'MODEL_NOT_FOUND'],
    [{ status: 503, body: openai('BACKEND_UNAVAILABLE') }, 'SERVER', 'BACKEND_UNAVAILABLE'],
    [{ status: 503, body: openai('BACKEND_DRAINING') }, 'ROUTER_SWITCHING', 'BACKEND_DRAINING'],
    [{ status: 503, body: openai('MAINTENANCE_MODE') }, 'ROUTER_SWITCHING', 'MAINTENANCE_MODE'],
    [{ status: 400, body: { error: { message: 'Formatted input (101165) plus requested output (32768) and safety reserve (1024) exceeds the 131072-token slot.', type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' } } }, 'CONTEXT_WINDOW_EXCEEDED'],
    [{ status: 502, body: openai('NEW_TRANSIENT_CODE') }, 'SERVER', 'NEW_TRANSIENT_CODE'],
    [{ status: 429, body: openai('RATE_LIMITED') }, 'RATE_LIMIT'],
    [{ status: 408, body: openai('REQUEST_TIMEOUT') }, 'TRANSPORT'],
    [{ status: 422, body: openai('NEW_REQUEST_CODE') }, 'INVALID_REQUEST'],
    [{ status: 400, body: openai('STATEFUL_REQUEST_UNSUPPORTED') }, 'INVALID_REQUEST'],
    [{ status: 503, body: { error: 'string-shaped router error' } }, 'SERVER'],
    [{ inStream: { type: 'response.failed', response: { id: 'resp_wire', status: 'failed', error: { code: 'BACKEND_UNAVAILABLE', message: 'stalled' } } } }, 'SERVER', 'BACKEND_UNAVAILABLE'],
    [{ inStream: { type: 'error', code: 'BACKEND_DRAINING', message: 'draining' } }, 'ROUTER_SWITCHING', 'BACKEND_DRAINING'],
    [{ inStream: { type: 'response.failed', response: { id: 'resp_wire', status: 'failed', error: { code: 'SERVICE_OFFLINE', message: 'offline' } } } }, 'MODEL_UNAVAILABLE', 'SERVICE_OFFLINE'],
  ];
  for (const [fixture, expected, reported] of cases) {
    scenario = fixture;
    reports.length = 0;
    const result = await run();
    const label = JSON.stringify(fixture).slice(0, 120);
    assert.equal(result.error, undefined, `${label}: ${result.error}`);
    assert.equal(result.finish?.reason.kind, 'error', label);
    assert.equal(result.finish.reason.failure.code, expected, `${label}: ${result.finish.reason.failure.message}`);
    if (fixture.status) assert.ok(result.finish.reason.failure.status === undefined || result.finish.reason.failure.status === fixture.status, label);
    if (reported) assert.deepEqual(reports.map(row => [row.provider, row.code]), [[model.provider, reported]], `${label}: discovery hub report`);
    if (expected === 'MODEL_UNAVAILABLE') assert.match(result.finish.reason.failure.message, /Switch this session to another model/);
  }
  console.log('Router error codes classify by error.code before HTTP status, inside and outside streams, and reach discovery.');
} finally {
  delete globalThis[HUB];
  server.closeAllConnections();
  server.close();
}
