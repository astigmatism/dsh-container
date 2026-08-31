import http from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { loadConfig, publicConfig } from './config.js';
import { readActiveModel } from './active-model.js';
import { JsonlStore } from './fs-store.js';
import { Metrics } from './metrics.js';
import { evaluateProxyPolicy, isLikelyStreamingRequest, MODEL_BODY_ROUTES, routeKey } from './policy.js';
import { handleResponsesRequest, isResponsesPath } from './responses-api.js';
import { NdjsonUsageCollector, extractUsageFromOllamaObject } from './stream-parser.js';
import { getGpuTelemetry } from './telemetry.js';
import {
  activeModelLoadedState,
  checkUpstream,
  getOllamaPs,
  normalizeThinkForModel,
  upstreamFetch,
  upstreamJson
} from './upstream.js';
import { resolveDefaultThink, thinkLevelToReasoningEffort } from './reasoning.js';
import {
  copyUpstreamHeaders,
  filterRequestHeaders,
  getClientIdentity,
  getClientIp,
  hasAdminAuth,
  methodAllowsBody,
  parseJsonBuffer,
  readRequestBody,
  requireAdmin,
  sendJson,
  sendText,
  serveStaticFile,
  summarizeBody
} from './http-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_ROOT = path.resolve(__dirname, '..', 'public');

function nowIso() {
  return new Date().toISOString();
}

function createBaseRecord(request, pathname) {
  return {
    id: randomUUID(),
    ts: nowIso(),
    method: request.method,
    endpoint: pathname,
    clientIdentity: getClientIdentity(request),
    sourceIp: getClientIp(request),
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null
  };
}

async function persistRequest(store, metrics, record) {
  metrics.recordRequest(record);
  try {
    await store.appendRequest(record);
  } catch (error) {
    console.error('failed to persist request record', error);
  }
}

async function persistEvent(store, event) {
  try {
    return await store.appendEvent(event);
  } catch (error) {
    console.error('failed to persist event record', error);
    return null;
  }
}

function errorPayload(code, message, details = undefined) {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details })
    }
  };
}

async function handleHealth(response, context) {
  const [activeModel, upstream] = await Promise.all([
    readActiveModel(context.config),
    checkUpstream(context.config)
  ]);
  sendJson(response, upstream.ok ? 200 : 503, {
    ok: upstream.ok,
    router: {
      appName: context.config.appName,
      version: context.config.version,
      maintenanceMode: context.state.maintenanceMode,
      startedAt: context.state.startedAt
    },
    upstream,
    activeModel
  });
}

async function buildSummary(context) {
  const [activeModel, upstream, ps, gpu] = await Promise.all([
    readActiveModel(context.config),
    checkUpstream(context.config),
    getOllamaPs(context.config),
    getGpuTelemetry(context.config)
  ]);
  const activeLoadedState = activeModel.model ? activeModelLoadedState(ps, activeModel.model) : { loaded: false, until: null, raw: null };
  const recentRequests = context.store.recentRequests(100);
  const recentRejectsOrErrors = recentRequests
    .filter((record) => record?.rejected || record?.upstreamError || Number(record?.responseStatus || record?.status || 0) >= 400)
    .slice(0, 10);
  const recentErrorEvents = context.store.recentEvents(100)
    .filter((event) => /reject|error|fail/i.test(String(event?.type || '')))
    .slice(0, 10);
  return {
    generatedAt: nowIso(),
    router: {
      appName: context.config.appName,
      version: context.config.version,
      startedAt: context.state.startedAt,
      maintenanceMode: context.state.maintenanceMode,
      uptimeSeconds: Math.round(process.uptime()),
      api: {
        host: context.config.host,
        port: context.config.port
      },
      admin: {
        enabled: context.config.adminEnabled,
        bindHost: context.config.adminBindHost,
        port: context.config.adminPort,
        authRequired: false
      }
    },
    config: publicConfig(context.config),
    activeModel,
    upstream,
    ollamaPs: ps,
    activeLoadedState,
    gpu,
    metrics: context.metrics.snapshot(),
    recentRejectsOrErrors,
    recentErrorEvents,
    logs: context.store.paths()
  };
}

async function handleAdminApi(request, response, pathname, context, { requireAuth = true } = {}) {
  if (requireAuth && !requireAdmin(request, response, context.config)) return;

  if (request.method === 'GET' && pathname === '/admin/api/summary') {
    sendJson(response, 200, await buildSummary(context));
    return;
  }

  if (request.method === 'GET' && pathname === '/admin/api/requests') {
    sendJson(response, 200, {
      requests: context.store.recentRequests(Number(new URL(request.url, 'http://router.local').searchParams.get('limit')) || context.config.requestHistoryLimit)
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/admin/api/events') {
    sendJson(response, 200, {
      events: context.store.recentEvents(Number(new URL(request.url, 'http://router.local').searchParams.get('limit')) || context.config.eventHistoryLimit)
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/admin/api/config') {
    sendJson(response, 200, publicConfig(context.config));
    return;
  }

  if (request.method === 'GET' && pathname === '/admin/api/metrics') {
    sendJson(response, 200, context.metrics.snapshot());
    return;
  }

  if (request.method === 'POST' && pathname === '/admin/api/reload-config') {
    const activeModel = await readActiveModel(context.config);
    await persistEvent(context.store, { type: 'active_model_marker_reloaded', activeModel });
    sendJson(response, 200, { ok: true, activeModel });
    return;
  }

  if (request.method === 'POST' && pathname === '/admin/api/maintenance') {
    let body = {};
    try {
      body = parseJsonBuffer(await readRequestBody(request, context.config.maxBodyBytes)) || {};
    } catch (error) {
      sendJson(response, error.statusCode || 400, errorPayload('INVALID_JSON_BODY', error.message));
      return;
    }
    context.state.maintenanceMode = Boolean(body.enabled);
    await persistEvent(context.store, { type: 'maintenance_mode_changed', enabled: context.state.maintenanceMode });
    sendJson(response, 200, { ok: true, maintenanceMode: context.state.maintenanceMode });
    return;
  }

  if (request.method === 'POST' && pathname === '/admin/api/prewarm') {
    const activeModel = await readActiveModel(context.config);
    if (!activeModel.model) {
      sendJson(response, 503, errorPayload('NO_ACTIVE_MODEL', 'Cannot prewarm because no active model marker is available.'));
      return;
    }
    const body = {
      model: activeModel.model,
      prompt: '',
      stream: false,
      keep_alive: context.config.forcedKeepAlive
    };
    const started = Date.now();
    try {
      const result = await upstreamJson(context.config, '/api/generate', { method: 'POST', body, timeoutMs: context.config.upstreamTimeoutMs });
      await persistEvent(context.store, {
        type: 'prewarm_triggered',
        model: activeModel.model,
        status: result.status,
        latencyMs: Date.now() - started,
        ok: result.ok
      });
      sendJson(response, result.ok ? 200 : result.status, {
        ok: result.ok,
        model: activeModel.model,
        status: result.status,
        upstream: result.body
      });
    } catch (error) {
      await persistEvent(context.store, { type: 'prewarm_failed', model: activeModel.model, error: error.message });
      sendJson(response, 502, errorPayload('UPSTREAM_ERROR', error.message));
    }
    return;
  }

  if (request.method === 'POST' && pathname === '/admin/api/test-chat') {
    const activeModel = await readActiveModel(context.config);
    if (!activeModel.model) {
      sendJson(response, 503, errorPayload('NO_ACTIVE_MODEL', 'Cannot run a test chat because no active model marker is available.'));
      return;
    }
    let body = {};
    try {
      body = parseJsonBuffer(await readRequestBody(request, context.config.maxBodyBytes)) || {};
    } catch (error) {
      sendJson(response, error.statusCode || 400, errorPayload('INVALID_JSON_BODY', error.message));
      return;
    }
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : 'Reply with a one sentence health check.';
    const started = Date.now();
    try {
      const result = await upstreamJson(context.config, '/api/chat', {
        method: 'POST',
        timeoutMs: context.config.upstreamTimeoutMs,
        body: {
          model: activeModel.model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          keep_alive: context.config.forcedKeepAlive
        }
      });
      await persistEvent(context.store, {
        type: 'admin_test_chat',
        model: activeModel.model,
        status: result.status,
        latencyMs: Date.now() - started,
        ok: result.ok
      });
      sendJson(response, result.ok ? 200 : result.status, {
        ok: result.ok,
        status: result.status,
        model: activeModel.model,
        upstream: result.body,
        usage: result.usage
      });
    } catch (error) {
      await persistEvent(context.store, { type: 'admin_test_chat_failed', model: activeModel.model, error: error.message });
      sendJson(response, 502, errorPayload('UPSTREAM_ERROR', error.message));
    }
    return;
  }

  sendJson(response, 404, errorPayload('ADMIN_ROUTE_NOT_FOUND', 'Admin API route not found.'));
}

async function rejectProxyRequest(response, context, record, status, code, message, extra = {}) {
  const finalRecord = {
    ...record,
    ...extra,
    allowed: false,
    rejected: true,
    responseStatus: status,
    status,
    errorCode: code,
    errorSummary: message,
    latencyMs: Date.now() - record.startedEpochMs
  };
  await persistRequest(context.store, context.metrics, finalRecord);
  await persistEvent(context.store, {
    type: 'request_rejected',
    code,
    message,
    endpoint: record.endpoint,
    method: record.method,
    requestedModel: extra.requestedModel,
    forwardedModel: extra.forwardedModel,
    activeModel: extra.activeModel,
    modelRewritten: Boolean(extra.modelRewritten),
    clientIdentity: record.clientIdentity,
    sourceIp: record.sourceIp
  });
  sendJson(response, status, errorPayload(code, message));
}

async function handleProxy(request, response, url, context) {
  const pathname = url.pathname;
  const recordBase = {
    ...createBaseRecord(request, pathname),
    query: url.search || '',
    startedEpochMs: Date.now()
  };

  let incomingBody = null;
  let rawBody = null;
  if (methodAllowsBody(request.method)) {
    try {
      rawBody = await readRequestBody(request, context.config.maxBodyBytes);
      incomingBody = parseJsonBuffer(rawBody);
    } catch (error) {
      await rejectProxyRequest(response, context, recordBase, error.statusCode || 400, 'INVALID_JSON_BODY', error.message);
      return;
    }
  }

  const activeModel = await readActiveModel(context.config);
  const isModelBodyRoute = MODEL_BODY_ROUTES.has(routeKey(request.method, pathname));
  if (context.state.maintenanceMode && isModelBodyRoute) {
    await rejectProxyRequest(response, context, recordBase, 503, 'MAINTENANCE_MODE', 'Router maintenance mode is enabled.', {
      activeModel: activeModel.model,
      requestedModel: incomingBody?.model || null,
      bodySummary: summarizeBody(incomingBody, context.config.promptLogging)
    });
    return;
  }

  const policy = evaluateProxyPolicy({
    method: request.method,
    pathname,
    body: incomingBody,
    activeModelInfo: activeModel,
    config: context.config,
    isAdmin: hasAdminAuth(request, context.config)
  });

  let thinkPolicy = {
    body: policy.sanitizedBody,
    incomingThink: policy.sanitizedBody?.think,
    forwardedThink: policy.sanitizedBody?.think,
    thinkMapped: false,
    thinkDropped: false,
    thinkNormalized: false,
    thinkingSupported: null
  };
  let sanitizedBody = thinkPolicy.body;

  const commonRecord = {
    ...recordBase,
    activeModel: policy.activeModel,
    requestedModel: policy.requestedModel,
    forwardedModel: policy.forwardedModel,
    modelRewritten: Boolean(policy.modelRewritten),
    incomingKeepAlive: policy.incomingKeepAlive,
    forwardedKeepAlive: policy.forwardedKeepAlive,
    keepAliveNormalized: Boolean(policy.keepAliveNormalized),
    incomingThink: thinkPolicy.incomingThink,
    forwardedThink: undefined,
    incomingReasoningEffort: thinkLevelToReasoningEffort(policy.sanitizedBody?.think) ?? null,
    thinkMapped: thinkPolicy.thinkMapped,
    thinkDropped: thinkPolicy.thinkDropped,
    thinkNormalized: thinkPolicy.thinkNormalized,
    thinkingSupported: thinkPolicy.thinkingSupported,
    reasoningEffort: thinkLevelToReasoningEffort(thinkPolicy.forwardedThink ?? thinkPolicy.incomingThink),
    streaming: isLikelyStreamingRequest(pathname, sanitizedBody),
    bodySummary: summarizeBody(incomingBody, context.config.promptLogging)
  };

  if (!policy.allowed) {
    await rejectProxyRequest(response, context, commonRecord, policy.status || 403, policy.code, policy.message, {
      activeModel: policy.activeModel,
      requestedModel: policy.requestedModel,
      forwardedModel: policy.forwardedModel,
      modelRewritten: Boolean(policy.modelRewritten),
      incomingKeepAlive: policy.incomingKeepAlive,
      forwardedKeepAlive: policy.forwardedKeepAlive
    });
    return;
  }

  if (['/api/chat', '/api/generate'].includes(pathname)) {
    let bodyWithThinkDefault = policy.sanitizedBody;
    const canApplyThinkDefault = bodyWithThinkDefault
      && typeof bodyWithThinkDefault === 'object'
      && !Array.isArray(bodyWithThinkDefault)
      && !Object.hasOwn(bodyWithThinkDefault, 'think');
    try {
      if (canApplyThinkDefault) {
        let defaultThink;
        defaultThink = resolveDefaultThink(activeModel, context.config);
        if (defaultThink !== undefined) bodyWithThinkDefault = { ...bodyWithThinkDefault, think: defaultThink };
      }
      thinkPolicy = await normalizeThinkForModel(
        context.config,
        policy.forwardedModel,
        bodyWithThinkDefault,
        policy.forwardedModel === activeModel.model ? activeModel : null
      );
    } catch (error) {
      await rejectProxyRequest(
        response,
        context,
        commonRecord,
        error.statusCode || 503,
        error.code || 'INVALID_ACTIVE_MODEL_THINK_DEFAULT',
        error.message,
        {
          activeModel: policy.activeModel,
          requestedModel: policy.requestedModel,
          forwardedModel: policy.forwardedModel
        }
      );
      return;
    }
    sanitizedBody = thinkPolicy.body;
    Object.assign(commonRecord, {
      incomingThink: thinkPolicy.incomingThink,
      forwardedThink: thinkPolicy.forwardedThink,
      thinkMapped: thinkPolicy.thinkMapped,
      thinkDropped: thinkPolicy.thinkDropped,
      thinkNormalized: thinkPolicy.thinkNormalized,
      thinkingSupported: thinkPolicy.thinkingSupported,
      reasoningEffort: thinkLevelToReasoningEffort(thinkPolicy.forwardedThink ?? thinkPolicy.incomingThink),
      streaming: isLikelyStreamingRequest(pathname, sanitizedBody)
    });
  }

  if (policy.modelRewritten) {
    await persistEvent(context.store, {
      type: 'model_rewritten_to_active',
      endpoint: pathname,
      method: request.method,
      requestedModel: policy.requestedModel,
      forwardedModel: policy.forwardedModel,
      activeModel: policy.activeModel,
      clientIdentity: commonRecord.clientIdentity,
      sourceIp: commonRecord.sourceIp
    });
  }

  if (policy.keepAliveNormalized) {
    await persistEvent(context.store, {
      type: 'keep_alive_normalized',
      endpoint: pathname,
      method: request.method,
      model: policy.forwardedModel || policy.requestedModel,
      requestedModel: policy.requestedModel,
      modelRewritten: Boolean(policy.modelRewritten),
      incomingKeepAlive: policy.incomingKeepAlive,
      forwardedKeepAlive: policy.forwardedKeepAlive,
      clientIdentity: commonRecord.clientIdentity,
      sourceIp: commonRecord.sourceIp
    });
  }

  if (thinkPolicy.thinkDropped) {
    await persistEvent(context.store, {
      type: 'unsupported_thinking_dropped',
      endpoint: pathname,
      method: request.method,
      model: policy.forwardedModel,
      incomingThink: thinkPolicy.incomingThink,
      clientIdentity: commonRecord.clientIdentity,
      sourceIp: commonRecord.sourceIp
    });
  }

  if (thinkPolicy.thinkMapped && !thinkPolicy.thinkDropped) {
    await persistEvent(context.store, {
      type: 'think_level_mapped',
      endpoint: pathname,
      method: request.method,
      model: policy.forwardedModel,
      incomingReasoningEffort: commonRecord.incomingReasoningEffort,
      incomingThink: thinkPolicy.incomingThink,
      forwardedThink: thinkPolicy.forwardedThink,
      clientIdentity: commonRecord.clientIdentity,
      sourceIp: commonRecord.sourceIp
    });
  }

  const upstreamPath = `${pathname}${url.search || ''}`;
  const started = Date.now();
  let upstreamResponse;
  try {
    const hasBody = methodAllowsBody(request.method) && sanitizedBody !== null;
    upstreamResponse = await upstreamFetch(context.config, upstreamPath, {
      method: request.method,
      headers: filterRequestHeaders(
        request.headers,
        hasBody ? { 'content-type': 'application/json' } : {}
      ),
      body: hasBody ? JSON.stringify(sanitizedBody) : undefined
    });
  } catch (error) {
    const status = error.name === 'AbortError' ? 504 : 502;
    const finalRecord = {
      ...commonRecord,
      allowed: true,
      rejected: false,
      responseStatus: status,
      status,
      upstreamError: true,
      errorSummary: error.message,
      latencyMs: Date.now() - started
    };
    await persistRequest(context.store, context.metrics, finalRecord);
    await persistEvent(context.store, { type: 'upstream_request_failed', endpoint: pathname, error: error.message });
    sendJson(response, status, errorPayload('UPSTREAM_REQUEST_FAILED', error.message));
    return;
  }

  const streaming = commonRecord.streaming && upstreamResponse.body;
  let usage = null;
  let responseBytes = 0;
  let parseErrors = 0;

  try {
    if (streaming) {
      const collector = new NdjsonUsageCollector();
      copyUpstreamHeaders(upstreamResponse.headers, response, true);
      response.writeHead(upstreamResponse.status);
      const reader = upstreamResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buffer = Buffer.from(value);
        responseBytes += buffer.length;
        collector.observe(buffer);
        if (!response.write(buffer)) await once(response, 'drain');
      }
      const collected = collector.finish();
      usage = collected.usage;
      parseErrors = collected.parseErrors;
      response.end();
    } else {
      const arrayBuffer = await upstreamResponse.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      responseBytes = buffer.length;
      const contentType = upstreamResponse.headers.get('content-type') || '';
      if (contentType.includes('application/json') && buffer.length) {
        try {
          usage = extractUsageFromOllamaObject(JSON.parse(buffer.toString('utf8')));
        } catch {
          parseErrors = 1;
        }
      }
      copyUpstreamHeaders(upstreamResponse.headers, response, false);
      response.setHeader('content-length', buffer.length);
      response.writeHead(upstreamResponse.status);
      response.end(buffer);
    }
  } catch (error) {
    await persistEvent(context.store, { type: 'proxy_stream_failed', endpoint: pathname, error: error.message });
    if (!response.headersSent) {
      sendJson(response, 502, errorPayload('PROXY_STREAM_FAILED', error.message));
    } else {
      response.destroy(error);
    }
  } finally {
    const finalRecord = {
      ...commonRecord,
      allowed: true,
      rejected: false,
      responseStatus: upstreamResponse.status,
      status: upstreamResponse.status,
      upstreamError: !upstreamResponse.ok,
      latencyMs: Date.now() - started,
      responseBytes,
      usage,
      streamParseErrors: parseErrors
    };
    await persistRequest(context.store, context.metrics, finalRecord);
  }
}

async function handleResponses(request, response, url, context) {
  const recordBase = {
    ...createBaseRecord(request, url.pathname),
    query: url.search || '',
    startedEpochMs: Date.now()
  };
  const outcome = await handleResponsesRequest(request, response, url.pathname, context);
  const record = {
    ...recordBase,
    ...outcome,
    latencyMs: Date.now() - recordBase.startedEpochMs
  };
  await persistRequest(context.store, context.metrics, record);

  if (outcome.rejected) {
    await persistEvent(context.store, {
      type: 'responses_request_rejected',
      code: outcome.errorCode,
      message: outcome.errorSummary,
      endpoint: url.pathname,
      requestedModel: outcome.requestedModel,
      activeModel: outcome.activeModel,
      clientIdentity: record.clientIdentity,
      sourceIp: record.sourceIp
    });
  } else if (outcome.upstreamError) {
    await persistEvent(context.store, {
      type: 'responses_upstream_failed',
      code: outcome.errorCode,
      message: outcome.errorSummary,
      endpoint: url.pathname,
      model: outcome.forwardedModel,
      clientIdentity: record.clientIdentity,
      sourceIp: record.sourceIp
    });
  }

  if (outcome.modelRewritten) {
    await persistEvent(context.store, {
      type: 'model_rewritten_to_active',
      endpoint: url.pathname,
      method: request.method,
      requestedModel: outcome.requestedModel,
      forwardedModel: outcome.forwardedModel,
      activeModel: outcome.activeModel,
      clientIdentity: record.clientIdentity,
      sourceIp: record.sourceIp
    });
  }

  if (outcome.thinkDropped) {
    await persistEvent(context.store, {
      type: 'unsupported_thinking_dropped',
      endpoint: url.pathname,
      method: request.method,
      model: outcome.forwardedModel,
      incomingThink: outcome.incomingThink,
      clientIdentity: record.clientIdentity,
      sourceIp: record.sourceIp
    });
  }

  if (outcome.thinkMapped && !outcome.thinkDropped) {
    await persistEvent(context.store, {
      type: 'think_level_mapped',
      endpoint: url.pathname,
      method: request.method,
      model: outcome.forwardedModel,
      incomingReasoningEffort: outcome.incomingReasoningEffort,
      incomingThink: outcome.incomingThink,
      forwardedThink: outcome.forwardedThink,
      clientIdentity: record.clientIdentity,
      sourceIp: record.sourceIp
    });
  }
}

function sendRedirect(response, location) {
  response.writeHead(302, {
    location,
    'cache-control': 'no-store'
  });
  response.end();
}

function hostnameFromRequest(request, fallbackHost = '127.0.0.1') {
  const hostHeader = typeof request.headers.host === 'string' ? request.headers.host : '';
  if (!hostHeader) return fallbackHost;
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    if (end !== -1) return hostHeader.slice(0, end + 1);
  }
  return hostHeader.split(':')[0] || fallbackHost;
}

function adminRedirectLocation(request, url, config) {
  const host = hostnameFromRequest(request, config.adminBindHost || config.host || '127.0.0.1');
  return `http://${host}:${config.adminPort}${url.pathname}${url.search || ''}`;
}

async function serveAdminDashboardAsset(response, pathname) {
  const relativePath = pathname === '/' || pathname === '/admin' || pathname === '/admin/'
    ? 'index.html'
    : pathname.slice('/admin/'.length);
  await serveStaticFile(response, PUBLIC_ROOT, relativePath || 'index.html');
}

async function handleAdminRequest(request, response, context) {
  const url = new URL(request.url || '/', 'http://router-admin.local');
  const pathname = url.pathname;

  try {
    if (request.method === 'GET' && pathname === '/health') {
      await handleHealth(response, context);
      return;
    }

    if (pathname.startsWith('/admin/api/')) {
      await handleAdminApi(request, response, pathname, context, { requireAuth: false });
      return;
    }

    if (request.method === 'GET' && (pathname === '/' || pathname === '/admin' || pathname.startsWith('/admin/'))) {
      await serveAdminDashboardAsset(response, pathname);
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(response, 404, errorPayload('API_NOT_ON_ADMIN_PORT', 'The Ollama-compatible API is served on the router API port, not the admin portal port.'));
      return;
    }

    sendJson(response, 404, errorPayload('NOT_FOUND', 'Admin portal route not found.'));
  } catch (error) {
    console.error('unhandled admin request error', error);
    if (!response.headersSent) {
      sendJson(response, 500, errorPayload('INTERNAL_ERROR', error.message));
    } else {
      response.destroy(error);
    }
  }
}

async function handleRequest(request, response, context) {
  const url = new URL(request.url || '/', 'http://router.local');
  const pathname = url.pathname;

  try {
    if (request.method === 'GET' && pathname === '/') {
      sendText(response, 200, 'Ollama is running\n', { 'x-ollama-router': 'local-ai-ollama-router' });
      return;
    }

    if (request.method === 'GET' && pathname === '/health') {
      await handleHealth(response, context);
      return;
    }

    if (pathname.startsWith('/admin/api/')) {
      await handleAdminApi(request, response, pathname, context, { requireAuth: true });
      return;
    }

    if (request.method === 'GET' && (pathname === '/admin' || pathname.startsWith('/admin/'))) {
      if (context.config.adminEnabled) {
        sendRedirect(response, adminRedirectLocation(request, url, context.config));
      } else {
        sendJson(response, 404, errorPayload('ADMIN_PORT_DISABLED', 'The separate admin portal listener is disabled.'));
      }
      return;
    }

    if (isResponsesPath(pathname)) {
      await handleResponses(request, response, url, context);
      return;
    }

    if (pathname.startsWith('/api/')) {
      await handleProxy(request, response, url, context);
      return;
    }

    sendJson(response, 404, errorPayload('NOT_FOUND', 'Route not found.'));
  } catch (error) {
    console.error('unhandled request error', error);
    if (!response.headersSent) {
      sendJson(response, 500, errorPayload('INTERNAL_ERROR', error.message));
    } else {
      response.destroy(error);
    }
  }
}

export async function createRouterServer(config = loadConfig()) {
  const store = new JsonlStore(config);
  await store.init();
  const metrics = new Metrics();
  metrics.rebuild(store.requests);
  const context = {
    config,
    store,
    metrics,
    state: {
      startedAt: nowIso(),
      maintenanceMode: false
    }
  };

  await persistEvent(store, {
    type: 'router_startup',
    version: config.version,
    upstreamUrl: config.upstreamUrl,
    modelPolicyMode: config.modelPolicyMode,
    rewriteRequestedModelToActive: config.rewriteRequestedModelToActive,
    protectedModelEndpoints: config.protectedModelEndpoints
  });

  const activeRequests = new Set();
  const trackRequest = (requestPromise) => {
    activeRequests.add(requestPromise);
    const finished = () => activeRequests.delete(requestPromise);
    void requestPromise.then(finished, finished);
  };
  const waitForIdle = async () => {
    while (activeRequests.size) await Promise.allSettled([...activeRequests]);
  };
  const server = http.createServer((request, response) => {
    trackRequest(handleRequest(request, response, context));
  });
  const adminServer = config.adminEnabled
    ? http.createServer((request, response) => {
      trackRequest(handleAdminRequest(request, response, context));
    })
    : null;
  return { server, adminServer, context, waitForIdle };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const { server, adminServer } = await createRouterServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`${config.appName} ${config.version} API listening on http://${config.host}:${config.port}`);
    console.log(`Upstream Ollama: ${config.upstreamUrl}`);
    console.log(`Active model marker: ${config.activeModelFile}`);
  });

  if (adminServer) {
    adminServer.listen(config.adminPort, config.adminBindHost, () => {
      console.log(`${config.appName} ${config.version} admin portal listening on http://${config.adminBindHost}:${config.adminPort}`);
      console.log('Admin portal authentication: disabled by design for trusted local/LAN use');
    });
  } else {
    console.log('Admin portal listener disabled by ADMIN_ENABLED=false');
  }

  const shutdown = (signal) => {
    console.log(`Received ${signal}; shutting down.`);
    let remaining = adminServer ? 2 : 1;
    const done = () => {
      remaining -= 1;
      if (remaining <= 0) process.exit(0);
    };
    server.close(done);
    if (adminServer) adminServer.close(done);
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
