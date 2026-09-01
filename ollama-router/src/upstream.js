import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { extractUsageFromOllamaObject } from './stream-parser.js';
import { isThinkingEnabled, normalizeThinkValue, validateReasoningCapabilities } from './reasoning.js';

function responseHeaders(message) {
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    headers.append(message.rawHeaders[index], message.rawHeaders[index + 1]);
  }
  return headers;
}

function requestWithNodeTransport(url, options = {}) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  const method = options.method || 'GET';
  const headers = new Headers(options.headers);
  if (options.body !== undefined && options.body !== null && !headers.has('content-length')) {
    headers.set('content-length', String(Buffer.byteLength(options.body)));
  }

  return new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method,
      headers: Object.fromEntries(headers.entries()),
      signal: options.signal
    }, (message) => {
      const status = message.statusCode || 500;
      const hasBody = method !== 'HEAD' && ![101, 204, 205, 304].includes(status);
      const body = hasBody ? Readable.toWeb(message) : null;
      if (!hasBody) message.resume();
      resolve(new Response(body, {
        status,
        statusText: message.statusMessage || '',
        headers: responseHeaders(message)
      }));
    });

    request.once('error', reject);
    if (options.body !== undefined && options.body !== null) request.write(options.body);
    request.end();
  });
}

export async function upstreamFetch(config, pathname, options = {}) {
  const timeoutMs = options.timeoutMs ?? config.upstreamTimeoutMs;
  const controller = options.signal ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const { timeoutMs: _timeoutMs, signal: suppliedSignal, ...requestOptions } = options;
  try {
    const url = `${config.upstreamUrl}${pathname}`;
    return await requestWithNodeTransport(url, {
      ...requestOptions,
      signal: suppliedSignal || controller.signal
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function upstreamJson(config, pathname, { method = 'GET', body = undefined, timeoutMs = undefined, headers = {} } = {}) {
  const response = await upstreamFetch(config, pathname, {
    method,
    timeoutMs,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: json,
    text,
    usage: extractUsageFromOllamaObject(json)
  };
}

export async function checkUpstream(config) {
  const started = Date.now();
  try {
    const version = await upstreamJson(config, '/api/version', { timeoutMs: 5000 });
    return {
      ok: version.ok,
      status: version.status,
      latencyMs: Date.now() - started,
      version: version.body,
      error: version.ok ? null : version.text
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - started,
      version: null,
      error: error.message
    };
  }
}

export async function getOllamaPs(config) {
  try {
    const result = await upstreamJson(config, '/api/ps', { timeoutMs: 10000 });
    return result.body;
  } catch (error) {
    return { error: error.message, models: [] };
  }
}

export async function getModelCapabilities(config, model) {
  if (!model) return { known: false, capabilities: [] };

  let result;
  try {
    result = await upstreamJson(config, '/api/show', {
      method: 'POST',
      body: { model },
      timeoutMs: Math.min(config.upstreamTimeoutMs, 10000)
    });
  } catch {
    return { known: false, capabilities: [] };
  }

  if (!result.ok || !Array.isArray(result.body?.capabilities)) {
    return { known: false, capabilities: [] };
  }
  return { known: true, capabilities: [...result.body.capabilities] };
}

export function createModelCapabilityLookup(config, model) {
  let lookupPromise = null;
  return () => {
    if (!lookupPromise) lookupPromise = getModelCapabilities(config, model);
    return lookupPromise;
  };
}

export async function normalizeThinkForModel(config, model, body, reasoningProfile = null, capabilityLookup = null) {
  const incomingThink = body?.think;
  const validatedCapabilities = validateReasoningCapabilities(reasoningProfile);
  // Ollama exposes binary thinking support through /api/show even when the
  // deployment has no safe string-level map. In that case, translate any
  // enabled effort to boolean true and let the binary capability check below
  // either forward it or remove it. Explicit malformed profiles still fail so
  // operator configuration errors are not silently ignored.
  const mappedThink = normalizeThinkValue(incomingThink, validatedCapabilities, { fallbackToBoolean: true });
  const usedBooleanFallback = validatedCapabilities === null
    && typeof incomingThink === 'string'
    && isThinkingEnabled(mappedThink);
  const thinkMapped = mappedThink !== incomingThink;
  const mappedBody = thinkMapped ? { ...body, think: mappedThink } : body;
  const unchanged = {
    body: mappedBody,
    incomingThink,
    forwardedThink: mappedThink,
    thinkMapped,
    thinkDropped: false,
    thinkNormalized: thinkMapped,
    thinkingSupported: null
  };

  if (!model || !body || typeof body !== 'object' || Array.isArray(body) || !isThinkingEnabled(mappedThink)) {
    return unchanged;
  }

  const lookup = capabilityLookup || createModelCapabilityLookup(config, model);
  const capabilityResult = await lookup();
  if (!capabilityResult.known && !usedBooleanFallback) return unchanged;
  if (capabilityResult.capabilities.includes('thinking')) {
    return { ...unchanged, thinkingSupported: true };
  }

  const normalizedBody = { ...body };
  delete normalizedBody.think;
  return {
    body: normalizedBody,
    incomingThink,
    forwardedThink: undefined,
    thinkMapped,
    thinkDropped: true,
    thinkNormalized: true,
    thinkingSupported: capabilityResult.known ? false : null
  };
}

export function activeModelLoadedState(psBody, activeModel) {
  const models = Array.isArray(psBody?.models) ? psBody.models : [];
  const match = models.find((model) => model?.name === activeModel || model?.model === activeModel);
  return {
    loaded: Boolean(match),
    until: match?.expires_at || match?.until || null,
    raw: match || null
  };
}
