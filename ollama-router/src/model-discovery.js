import { createHash } from 'node:crypto';
import { readActiveModel } from './active-model.js';
import {
  parseDefaultThink,
  thinkLevelToReasoningEffort,
  validateReasoningCapabilities
} from './reasoning.js';
import { upstreamJson } from './upstream.js';

const CANONICAL_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export class ModelDiscoveryError extends Error {
  constructor(statusCode, code, message, param = 'model', type = 'server_error') {
    super(message);
    this.name = 'ModelDiscoveryError';
    this.statusCode = statusCode;
    this.code = code;
    this.param = param;
    this.type = type;
  }
}

export function modelDiscoveryErrorPayload(error) {
  return {
    error: {
      message: error.message,
      type: error.type,
      param: error.param,
      code: error.code
    }
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;
}

function markerRevisionKey(activeModel) {
  const raw = typeof activeModel.raw === 'string'
    ? activeModel.raw
    : JSON.stringify(activeModel.raw ?? null);
  const rawDigest = createHash('sha256').update(raw).digest('hex');
  return [
    activeModel.model,
    activeModel.revision ?? '',
    activeModel.file_mtime_ms ?? activeModel.file_mtime ?? '',
    activeModel.updated_at ?? '',
    rawDigest
  ].join('\u0000');
}

function createdTimestamp(activeModel, fallbackEpochMs) {
  const updatedEpochMs = typeof activeModel.updated_at === 'string' ? Date.parse(activeModel.updated_at) : Number.NaN;
  const epochMs = Number.isFinite(updatedEpochMs)
    ? updatedEpochMs
    : (Number.isFinite(activeModel.file_mtime_ms) ? activeModel.file_mtime_ms : fallbackEpochMs);
  return Math.floor(epochMs / 1000);
}

function matchingLoadedModel(psBody, activeModel) {
  const models = Array.isArray(psBody?.models) ? psBody.models : [];
  return models.find((model) => model?.name === activeModel || model?.model === activeModel) || null;
}

function loadedContextWindow(loadedModel) {
  if (!loadedModel) return null;
  for (const value of [
    loadedModel.context_length,
    loadedModel.context,
    loadedModel.num_ctx,
    loadedModel.numCtx
  ]) {
    const context = positiveInteger(value);
    if (context !== null) return context;
  }
  return null;
}

function modelContextWindow(showBody) {
  const modelInfo = isPlainObject(showBody?.model_info) ? showBody.model_info : null;
  if (!modelInfo) return null;

  const architectureNames = [
    modelInfo['general.architecture'],
    showBody?.details?.family,
    ...(Array.isArray(showBody?.details?.families) ? showBody.details.families : [])
  ].filter((value) => typeof value === 'string' && value.trim());

  for (const architecture of architectureNames) {
    const context = positiveInteger(modelInfo[`${architecture}.context_length`]);
    if (context !== null) return context;
  }

  const candidates = Object.entries(modelInfo)
    .filter(([key]) => key === 'context_length' || key.endsWith('.context_length'))
    .map(([, value]) => positiveInteger(value))
    .filter((value) => value !== null);
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : null;
}

function normalizeCapabilities(showBody) {
  if (!Array.isArray(showBody?.capabilities)) return null;
  return [...new Set(showBody.capabilities
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().toLowerCase()))];
}

function normalizeModalities(activeModel, capabilities) {
  if (!Array.isArray(activeModel.input_modalities) && capabilities === null) return null;
  const modalities = new Set(Array.isArray(activeModel.input_modalities) ? activeModel.input_modalities : []);
  if (capabilities?.includes('completion')) modalities.add('text');
  if (capabilities?.includes('vision')) modalities.add('image');
  return [...modalities].sort((left, right) => {
    const priority = { text: 0, image: 1 };
    return (priority[left] ?? 2) - (priority[right] ?? 2) || left.localeCompare(right);
  });
}

function normalizeReasoningDefault(activeModel, validated, warnings) {
  if (!activeModel.default_think_configured) return null;
  try {
    const parsed = parseDefaultThink(activeModel.default_think);
    if (typeof parsed === 'string' && !validated) {
      if (!warnings.includes('INVALID_REASONING_CAPABILITIES')) {
        warnings.push('MISSING_REASONING_CAPABILITIES');
      }
      return null;
    }
    return thinkLevelToReasoningEffort(parsed) ?? null;
  } catch {
    warnings.push('INVALID_ACTIVE_MODEL_THINK_DEFAULT');
    return null;
  }
}

function reasoningMetadata(activeModel, capabilities, warnings) {
  let validated = null;
  try {
    validated = validateReasoningCapabilities(activeModel);
  } catch {
    warnings.push('INVALID_REASONING_CAPABILITIES');
  }

  const ollamaThinking = capabilities === null ? null : capabilities.includes('thinking');
  if (validated && ollamaThinking === false) warnings.push('OLLAMA_THINKING_CAPABILITY_MISMATCH');

  const efforts = { off: 'none' };
  if (validated) {
    for (const effort of CANONICAL_REASONING_EFFORTS) efforts[effort] = effort;
  }

  return {
    supported: ollamaThinking === false ? false : (validated ? true : null),
    efforts,
    upstream_levels: validated ? [...validated.supported_think_levels] : null,
    effort_map: validated ? { ...validated.reasoning_effort_map } : null,
    default: normalizeReasoningDefault(activeModel, validated, warnings)
  };
}

function entryEtag(entry) {
  const digest = createHash('sha256').update(JSON.stringify(entry)).digest('base64url');
  return `"${digest}"`;
}

export function ifNoneMatchMatches(header, etag) {
  if (typeof header !== 'string' || !header.trim()) return false;
  return header.split(',').some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, '');
    return normalized === '*' || normalized === etag;
  });
}

export class ActiveModelDiscovery {
  constructor(config, options = {}) {
    this.config = config;
    this.readActiveModel = options.readActiveModel || readActiveModel;
    this.upstreamJson = options.upstreamJson || upstreamJson;
    this.now = options.now || (() => Date.now());
    this.startedAtMs = this.now();
    this.currentKey = null;
    this.generation = 0;
    this.cached = null;
    this.pending = null;
  }

  invalidate() {
    this.currentKey = null;
    this.generation += 1;
    this.cached = null;
    this.pending = null;
  }

  async get(activeModelOverride = null) {
    const activeModel = activeModelOverride || await this.readActiveModel(this.config);
    if (!activeModel?.model) {
      this.invalidate();
      throw new ModelDiscoveryError(
        503,
        'NO_ACTIVE_MODEL',
        'No active model marker is available.',
        'model',
        'server_error'
      );
    }

    const key = markerRevisionKey(activeModel);
    if (key !== this.currentKey) {
      this.currentKey = key;
      this.generation += 1;
      this.cached = null;
      this.pending = null;
    }

    if (this.cached?.key === key && this.cached.expiresAt > this.now()) {
      return { ...this.cached.value, refreshed: false };
    }
    if (this.pending?.key === key) return this.pending.promise;

    const generation = this.generation;
    const promise = this.refresh(activeModel, key, generation);
    this.pending = { key, promise };
    try {
      return await promise;
    } catch (error) {
      if (this.pending?.promise === promise) this.pending = null;
      throw error;
    }
  }

  async refresh(activeModel, key, generation) {
    const [ps, show] = await Promise.all([
      this.readUpstreamPs(),
      this.readUpstreamShow(activeModel.model)
    ]);
    const warnings = [...(activeModel.metadata_warnings || [])];
    if (activeModel.loadedFrom !== 'file') warnings.push('ACTIVE_MODEL_MARKER_UNAVAILABLE');
    const updatedAt = normalizeTimestamp(activeModel.updated_at);
    if (activeModel.updated_at && !updatedAt) warnings.push('INVALID_MARKER_UPDATED_AT');
    if (ps.warning) warnings.push(ps.warning);
    if (show.warning) warnings.push(show.warning);

    const capabilities = show.available ? normalizeCapabilities(show.body) : null;
    if (show.available && capabilities === null) warnings.push('OLLAMA_SHOW_CAPABILITIES_UNAVAILABLE');
    const loadedModel = ps.available ? matchingLoadedModel(ps.body, activeModel.model) : null;
    const loadedContext = loadedContextWindow(loadedModel);
    const architecturalContext = show.available ? modelContextWindow(show.body) : null;
    const uniqueWarnings = [...new Set(warnings)];

    const entry = {
      id: this.config.routerModelAlias,
      object: 'model',
      created: createdTimestamp(activeModel, this.startedAtMs),
      owned_by: this.config.appName,
      x_ollama_router: {
        schema_version: 1,
        alias: true,
        upstream_model: activeModel.model,
        profile: activeModel.profile || null,
        updated_at: updatedAt,
        context_window: loadedContext ?? activeModel.context_length ?? architecturalContext,
        model_context_window: architecturalContext,
        max_output_tokens: activeModel.max_output_tokens ?? null,
        input_modalities: normalizeModalities(activeModel, capabilities),
        capabilities,
        reasoning: reasoningMetadata(activeModel, capabilities, uniqueWarnings),
        sources: {
          active_model_marker: activeModel.loadedFrom === 'file',
          ollama_ps: ps.available,
          ollama_show: show.available
        },
        complete: uniqueWarnings.length === 0,
        warnings: uniqueWarnings
      }
    };
    const value = { entry, etag: entryEtag(entry) };

    const latestActiveModel = await this.readActiveModel(this.config);
    const latestKey = latestActiveModel?.model ? markerRevisionKey(latestActiveModel) : null;
    if (generation !== this.generation || key !== this.currentKey || latestKey !== key) {
      if (latestKey !== this.currentKey) {
        this.currentKey = latestKey;
        this.generation += 1;
        this.cached = null;
        this.pending = null;
      }
      return this.get(latestActiveModel);
    }

    this.cached = {
      key,
      expiresAt: this.now() + this.config.routerModelMetadataTtlMs,
      value
    };
    if (this.pending?.key === key) this.pending = null;
    return { ...value, refreshed: true };
  }

  async readUpstreamPs() {
    try {
      const result = await this.upstreamJson(this.config, '/api/ps', {
        timeoutMs: Math.min(this.config.upstreamTimeoutMs, 10000)
      });
      if (!result.ok) return { available: false, body: null, warning: 'OLLAMA_PS_UNAVAILABLE' };
      if (!isPlainObject(result.body) || !Array.isArray(result.body.models)) {
        return { available: false, body: null, warning: 'OLLAMA_PS_INVALID_RESPONSE' };
      }
      return { available: true, body: result.body, warning: null };
    } catch {
      return { available: false, body: null, warning: 'OLLAMA_PS_UNAVAILABLE' };
    }
  }

  async readUpstreamShow(model) {
    try {
      const result = await this.upstreamJson(this.config, '/api/show', {
        method: 'POST',
        body: { model },
        timeoutMs: Math.min(this.config.upstreamTimeoutMs, 10000)
      });
      if (!result.ok) return { available: false, body: null, warning: 'OLLAMA_SHOW_UNAVAILABLE' };
      if (!isPlainObject(result.body)) {
        return { available: false, body: null, warning: 'OLLAMA_SHOW_INVALID_RESPONSE' };
      }
      return { available: true, body: result.body, warning: null };
    } catch {
      return { available: false, body: null, warning: 'OLLAMA_SHOW_UNAVAILABLE' };
    }
  }
}
