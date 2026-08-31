import path from 'node:path';
import { parseDefaultThink } from './reasoning.js';

function envString(env, key, fallback) {
  const value = env[key];
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return String(value).trim();
}

function envInt(env, key, fallback, minimum = undefined) {
  const raw = envString(env, key, String(fallback));
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) return fallback;
  if (minimum !== undefined && value < minimum) return minimum;
  return value;
}

function envBool(env, key, fallback = false) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function envCsv(env, key, fallback = []) {
  const raw = envString(env, key, '');
  if (!raw) return [...fallback];
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

export function parseKeepAlive(value) {
  if (value === undefined || value === null || value === '') return -1;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  return text;
}

export function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

export function loadConfig(env = process.env) {
  const dataDir = envString(env, 'DATA_DIR', '/app/data');
  const adminToken = envString(env, 'ADMIN_TOKEN', '');
  const defaultThinkRaw = envString(env, 'DEFAULT_THINK', '');
  const defaultThinkConfigured = Boolean(defaultThinkRaw);
  return Object.freeze({
    appName: 'local-ai-ollama-router',
    version: envString(env, 'ROUTER_VERSION', '0.1.0'),
    nodeEnv: envString(env, 'NODE_ENV', 'production'),
    host: envString(env, 'HOST', '0.0.0.0'),
    port: envInt(env, 'PORT', 11434, 1),
    adminEnabled: envBool(env, 'ADMIN_ENABLED', true),
    adminBindHost: envString(env, 'ADMIN_BIND_HOST', '0.0.0.0'),
    adminPort: envInt(env, 'ADMIN_PORT', 11435, 1),
    upstreamUrl: normalizeBaseUrl(envString(env, 'OLLAMA_UPSTREAM_URL', 'http://ollama:11434')),
    upstreamTimeoutMs: envInt(env, 'OLLAMA_UPSTREAM_TIMEOUT_MS', 900000, 1000),
    responsesContextShift: envBool(env, 'RESPONSES_CONTEXT_SHIFT', false),
    activeModelFile: envString(env, 'ACTIVE_MODEL_FILE', '/app/runtime/active-model.json'),
    activeModelFallback: envString(env, 'ACTIVE_MODEL', ''),
    modelPolicyMode: envString(env, 'MODEL_POLICY_MODE', 'active-only'),
    allowedModels: envCsv(env, 'ALLOWED_MODELS', []),
    rewriteRequestedModelToActive: envBool(env, 'REWRITE_REQUESTED_MODEL_TO_ACTIVE', false),
    forcedKeepAlive: parseKeepAlive(envString(env, 'FORCE_KEEP_ALIVE', '-1')),
    defaultThinkConfigured,
    defaultThink: defaultThinkConfigured ? parseDefaultThink(defaultThinkRaw) : undefined,
    protectedModelEndpoints: envCsv(env, 'PROTECTED_MODEL_ENDPOINTS', ['/api/chat', '/api/generate', '/api/embed', '/api/embeddings']),
    useActiveModelWhenMissing: envBool(env, 'USE_ACTIVE_MODEL_WHEN_MISSING', false),
    allowModelManagement: envBool(env, 'ALLOW_MODEL_MANAGEMENT', false),
    adminToken,
    adminSessionHeader: envString(env, 'ADMIN_SESSION_HEADER', 'X-Admin-Token'),
    dataDir,
    requestLogPath: path.join(dataDir, 'requests.jsonl'),
    eventLogPath: path.join(dataDir, 'events.jsonl'),
    requestHistoryLimit: envInt(env, 'REQUEST_HISTORY_LIMIT', 500, 1),
    eventHistoryLimit: envInt(env, 'EVENT_HISTORY_LIMIT', 500, 1),
    maxBodyBytes: envInt(env, 'MAX_BODY_BYTES', 0, 0),
    promptLogging: envString(env, 'PROMPT_LOGGING', 'metadata'),
    enableNvidiaSmi: envBool(env, 'ENABLE_NVIDIA_SMI', false),
    nvidiaSmiBin: envString(env, 'NVIDIA_SMI_BIN', 'nvidia-smi'),
    gpuTelemetryTimeoutMs: envInt(env, 'GPU_TELEMETRY_TIMEOUT_MS', 2500, 100),
    modelsDirInContainer: envString(env, 'MODELS_DIR_IN_CONTAINER', '/models')
  });
}

export function publicConfig(config) {
  return {
    appName: config.appName,
    version: config.version,
    nodeEnv: config.nodeEnv,
    host: config.host,
    port: config.port,
    adminEnabled: config.adminEnabled,
    adminBindHost: config.adminBindHost,
    adminPort: config.adminPort,
    adminPortalAuthRequired: false,
    legacyAdminApiAuthEnabled: Boolean(config.adminToken),
    upstreamUrl: config.upstreamUrl,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    responsesContextShift: config.responsesContextShift,
    activeModelFile: config.activeModelFile,
    hasActiveModelFallback: Boolean(config.activeModelFallback),
    modelPolicyMode: config.modelPolicyMode,
    allowedModels: config.allowedModels,
    rewriteRequestedModelToActive: config.rewriteRequestedModelToActive,
    forcedKeepAlive: config.forcedKeepAlive,
    defaultThinkConfigured: config.defaultThinkConfigured,
    defaultThink: config.defaultThink ?? null,
    protectedModelEndpoints: config.protectedModelEndpoints,
    useActiveModelWhenMissing: config.useActiveModelWhenMissing,
    allowModelManagement: config.allowModelManagement,
    adminAuthEnabled: Boolean(config.adminToken),
    dataDir: config.dataDir,
    requestHistoryLimit: config.requestHistoryLimit,
    eventHistoryLimit: config.eventHistoryLimit,
    maxBodyBytes: config.maxBodyBytes,
    promptLogging: config.promptLogging,
    enableNvidiaSmi: config.enableNvidiaSmi,
    modelsDirInContainer: config.modelsDirInContainer
  };
}
