/** Synthetic LLM Router documents and a fake router for contract tests.
 *
 * Shapes follow llm-router docs/CAPABILITIES.md at d5edba8 and the production
 * document observed read-only on 2026-10-07. Canonical model IDs here are
 * fixture values; Harness must never persist them.
 */
import http from 'node:http';

export const DAYTIME_ID = 'fixture-daytime-27b-q6_k_xl';
export const NIGHTTIME_ID = 'fixture-nighttime-27b-abliterated-q6_k';
export const NIGHTTIME_MTP3_ID = 'fixture-nighttime-27b-abliterated-q6_k-mtp3';

export function reasoning({ unrestricted = true } = {}) {
  const max = unrestricted ? null : 8192;
  const defaultTokens = unrestricted ? null : 1024;
  return {
    supported: true, default: unrestricted ? 'default' : 'medium',
    efforts: { default: 'default', off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' },
    aliases: { none: 'off', minimal: 'low', high: 'xhigh', max: 'xhigh' },
    boolean_true_behavior: { mode: 'map', level: 'default' },
    output_limit_policy: 'reject', absolute_max_output_tokens: max,
    per_effort: Object.fromEntries(['default', 'off', 'low', 'medium', 'xhigh'].map(level => [level,
      { enabled: level !== 'off', default_output_tokens: defaultTokens, max_output_tokens: max }])),
  };
}

/** One `models[]` entry; `metadata` mirrors x_ollama_router schema v2. */
export function residentModel({ service = 'daytime', id = service === 'daytime' ? DAYTIME_ID : NIGHTTIME_ID,
  contextWindow = service === 'daytime' ? 163840 : 98304, slots = 1, vision = service === 'daytime',
  displayName = service === 'daytime' ? 'Qwen3.8 27B Q6_K (160K)' : 'Qwen3.8 27B Abliterated Q6_K (96K)',
  nsfw = service === 'nighttime', available = true, reserve = 1024, unrestricted = true } = {}) {
  const aliases = service === 'daytime' ? ['local-active', 'daytime'] : ['nighttime'];
  const input = vision ? ['text', 'image'] : ['text'];
  const capabilities = vision ? ['completion', 'thinking', 'tools', 'vision'] : ['completion', 'thinking', 'tools'];
  return {
    id, service, display_name: displayName, aliases, available, slots, context_window: contextWindow,
    input_modalities: input, capabilities, nsfw, capability_score: service === 'daytime' ? 68.3 : 64.9,
    metadata: {
      schema_version: 2, alias: false, backend_kind: 'llama_cpp', upstream_model: id, display_name: displayName,
      context_window: contextWindow, total_context_window: contextWindow * slots, context_safety_reserve: reserve,
      active_request_limit: slots, model_context_window: 262144,
      output_policy: unrestricted ? 'unrestricted' : 'bounded',
      max_output_tokens: unrestricted ? null : 8192, default_output_tokens: unrestricted ? null : 1024,
      health: { available, status: available ? 200 : 503 }, aliases, nsfw,
      input_modalities: input, capabilities, reasoning: reasoning({ unrestricted }),
      capability_score: { value: 68.3, version: 1, basis: 'computed' },
      live: available ? { slots, slot_context_window: contextWindow, vision } : null,
      complete: true, warnings: [],
    },
  };
}

let revisionCounter = 0;
/** A complete capabilities document. Revision changes with content. */
export function capabilitiesDocument({ models = [residentModel(), residentModel({ service: 'nighttime' })],
  offline = [], configuration = { id: 'qwen27b-q6k-with-nighttime', exclusive: false },
  accepting = true, draining = !accepting, maintenance = false, schemaVersion = 1, revision } = {}) {
  const ids = Object.fromEntries(models.flatMap(model => [[model.id, model.id], ...model.aliases.map(alias => [alias, model.id])]));
  const document = {
    object: 'router.capabilities', schema_version: schemaVersion, observed_at: '2026-10-07T02:13:28.004Z',
    complete: true, warnings: [],
    router: { name: 'llm-router', version: '0.1.0', accepting_requests: accepting, draining, drain_reason: draining ? 'fixture switch' : null, maintenance },
    configuration, default_model: models[0]?.id ?? null, models, offline_services: offline, ids,
  };
  document.revision = revision ?? `rev-${JSON.stringify(document).length}-${(revisionCounter += 1)}`;
  return document;
}

export const paired = (overrides = {}) => capabilitiesDocument(overrides);
export const solo = (overrides = {}) => capabilitiesDocument({
  models: [residentModel({ contextWindow: 131072, displayName: 'Qwen3.8 Flash-Next (128K)' })],
  offline: [{ model: NIGHTTIME_ID, aliases: ['nighttime'], display_name: 'Qwen3.8 27B Abliterated Q6_K (96K)', role: 'everyday', reason: 'exclusive_configuration' }],
  configuration: { id: 'flash-next-solo-128k', exclusive: true }, ...overrides,
});
export const draining = (base = paired()) => capabilitiesDocument({
  models: base.models.map(model => ({ ...structuredClone(model), available: false })), offline: base.offline_services,
  configuration: base.configuration, accepting: false,
});

/**
 * Fake router: capabilities with ETag/304, a controllable SSE event stream and
 * Responses errors. Every request's X-Client-Name is recorded.
 */
export async function fakeRouter(t, initial = paired()) {
  const state = {
    document: initial, available: true, clientNames: [], capabilityRequests: 0, notModified: 0,
    eventConnections: 0, subscribers: new Set(), refuseEvents: false, responses: [], respond: undefined,
  };
  const server = http.createServer((req, res) => {
    state.clientNames.push(req.headers['x-client-name']);
    if (!state.available) { req.socket.destroy(); return; }
    if (req.url === '/v1/router/capabilities') {
      state.capabilityRequests += 1;
      const etag = `"${state.document.revision}"`;
      if (req.headers['if-none-match'] === etag) { state.notModified += 1; res.writeHead(304, { etag }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json', etag, 'cache-control': 'no-cache' });
      res.end(JSON.stringify(state.document));
      return;
    }
    if (req.url === '/v1/router/events') {
      if (state.refuseEvents) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'TOO_MANY_SUBSCRIBERS', message: 'fixture limit' } }));
        return;
      }
      state.eventConnections += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`retry: 3000\n\nevent: capabilities\nid: ${state.document.revision}\ndata: ${JSON.stringify(state.document)}\n\nevent: load\ndata: {}\n\n`);
      state.subscribers.add(res);
      res.once('close', () => state.subscribers.delete(res));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        state.responses.push({ headers: req.headers, body: JSON.parse(body || '{}') });
        const reply = state.respond?.(JSON.parse(body || '{}')) ?? { status: 503, body: { error: { code: 'BACKEND_UNAVAILABLE', message: 'fixture' } } };
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'MODEL_NOT_FOUND', message: 'fixture route' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return {
    state, root, baseURL: `${root}/v1`,
    /** Replace the document and push it to subscribers, as the router does on every change. */
    publish(document) {
      state.document = document;
      for (const res of state.subscribers) res.write(`event: capabilities\nid: ${document.revision}\ndata: ${JSON.stringify(document)}\n\n`);
    },
    keepalive() { for (const res of state.subscribers) res.write(': keepalive\n\n'); },
    /** Drop every event stream connection (router restart or network blip). */
    disconnect() { for (const res of state.subscribers) res.destroy(); state.subscribers.clear(); },
    unreachable() { state.available = false; this.disconnect(); server.closeAllConnections(); },
    reachable() { state.available = true; },
  };
}

/** Settings written by releases that predate service IDs. */
export function legacySettings(baseURL) {
  return {
    'agent-default-model': { provider: 'local-ollama-256k', model: 'local-active', reasoningEffort: 'off', custom: 'retain' },
    'custom-setting': { preserved: true },
    'llm-pi-ai': { providers: {
      'local-ollama': { api: 'openai-responses', apiKeyEnv: 'UNCHANGED_CREDENTIAL_REFERENCE', baseURL, reasoning: 'medium', maxConcurrency: 2,
        retryPolicy: { mode: 'normal', maxRetries: 2, retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TRANSPORT'] },
        models: [{ id: 'local-active', name: 'Legacy', contextWindow: 262144, maxTokens: 32768, input: ['text', 'image'], custom: 'retain' }] },
      'local-everyday': { api: 'openai-responses', apiKeyEnv: 'UNCHANGED_CREDENTIAL_REFERENCE', baseURL, reasoning: 'medium', maxConcurrency: 1,
        models: [{ id: 'qwen3.8-27b-abliterated-q6_k', name: 'Nighttime (128K)', contextWindow: 131072, maxTokens: null, input: ['text'] }] },
      'local-ollama-256k': { baseURL, models: [{ id: 'local-active' }] },
      custom: { baseURL: 'https://unrelated.invalid', reasoning: 'low', models: [{ id: 'custom' }] },
    } },
  };
}

/** In-memory settings service with the 0.2 describe()/mutate() surface. */
export function settingsService(state, mutations = [], applyOperation) {
  return {
    // Like the real service, every read is a fresh projection.
    describe: () => Object.entries(state).map(([ns, value]) => ({ ns, value: structuredClone(value), user: structuredClone(value) })),
    mutate: async (namespace, ops) => {
      mutations.push({ namespace, ops: structuredClone(ops) });
      state[namespace] ??= {};
      for (const op of ops) applyOperation(state[namespace], op);
    },
  };
}
