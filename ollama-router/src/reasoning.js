export const OLLAMA_THINK_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export const RESPONSES_REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]);

const MAPPED_REASONING_EFFORTS = [...RESPONSES_REASONING_EFFORTS].filter((effort) => effort !== 'none');

export class ReasoningProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReasoningProfileError';
    this.code = code;
    this.statusCode = 503;
  }
}

export class ReasoningRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReasoningRequestError';
    this.code = 'INVALID_THINK_VALUE';
    this.statusCode = 400;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateReasoningCapabilities(profile, { required = false } = {}) {
  const hasLevels = isPlainObject(profile)
    && Object.hasOwn(profile, 'supported_think_levels')
    && profile.supported_think_levels !== null
    && profile.supported_think_levels !== undefined;
  const hasMap = isPlainObject(profile)
    && Object.hasOwn(profile, 'reasoning_effort_map')
    && profile.reasoning_effort_map !== null
    && profile.reasoning_effort_map !== undefined;
  const configured = profile?.reasoning_capabilities_configured === true || hasLevels || hasMap;

  if (!configured) {
    if (required) {
      throw new ReasoningProfileError(
        'MISSING_REASONING_CAPABILITIES',
        'The active model profile must define supported_think_levels and reasoning_effort_map before string reasoning levels can be forwarded.'
      );
    }
    return null;
  }
  if (!hasLevels || !hasMap) {
    throw new ReasoningProfileError(
      'INVALID_REASONING_CAPABILITIES',
      'The active model profile must define both supported_think_levels and reasoning_effort_map.'
    );
  }

  const levels = profile.supported_think_levels;
  if (!Array.isArray(levels) || levels.length === 0) {
    throw new ReasoningProfileError(
      'INVALID_REASONING_CAPABILITIES',
      'supported_think_levels must be a non-empty array of supported Ollama string levels.'
    );
  }
  const uniqueLevels = new Set();
  for (const level of levels) {
    if (typeof level !== 'string' || level !== level.trim().toLowerCase() || !OLLAMA_THINK_LEVELS.has(level)) {
      throw new ReasoningProfileError(
        'INVALID_REASONING_CAPABILITIES',
        `Unsupported supported_think_levels entry: ${String(level)}.`
      );
    }
    if (uniqueLevels.has(level)) {
      throw new ReasoningProfileError(
        'INVALID_REASONING_CAPABILITIES',
        `Duplicate supported_think_levels entry: ${level}.`
      );
    }
    uniqueLevels.add(level);
  }

  const effortMap = profile.reasoning_effort_map;
  if (!isPlainObject(effortMap)) {
    throw new ReasoningProfileError(
      'INVALID_REASONING_CAPABILITIES',
      'reasoning_effort_map must be an object.'
    );
  }
  for (const key of Object.keys(effortMap)) {
    if (!MAPPED_REASONING_EFFORTS.includes(key)) {
      throw new ReasoningProfileError(
        'INVALID_REASONING_CAPABILITIES',
        `Unsupported reasoning_effort_map key: ${key}.`
      );
    }
  }
  for (const effort of MAPPED_REASONING_EFFORTS) {
    const target = effortMap[effort];
    if (target !== true && (typeof target !== 'string' || !uniqueLevels.has(target))) {
      throw new ReasoningProfileError(
        'INVALID_REASONING_CAPABILITIES',
        `reasoning_effort_map.${effort} must be true or name a level in supported_think_levels.`
      );
    }
  }

  return {
    supported_think_levels: [...levels],
    reasoning_effort_map: { ...effortMap }
  };
}

export function isThinkingEnabled(value) {
  return value === true || OLLAMA_THINK_LEVELS.has(value);
}

export function reasoningEffortToThink(effort, capabilities) {
  if (!RESPONSES_REASONING_EFFORTS.has(effort)) return undefined;
  if (effort === 'none') return false;
  const validated = validateReasoningCapabilities(capabilities, { required: true });
  return validated.reasoning_effort_map[effort];
}

export function normalizeThinkValue(value, capabilities) {
  if (value === undefined || typeof value === 'boolean') return value;
  if (typeof value !== 'string') {
    throw new ReasoningRequestError('think must be a boolean or a supported reasoning effort string.');
  }
  const normalized = value.trim().toLowerCase();
  if (!RESPONSES_REASONING_EFFORTS.has(normalized)) {
    throw new ReasoningRequestError(`Unsupported think value: ${String(value)}.`);
  }
  return reasoningEffortToThink(normalized, capabilities);
}

export function thinkLevelToReasoningEffort(value) {
  if (value === true) return 'high';
  if (value === false) return 'none';
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (RESPONSES_REASONING_EFFORTS.has(normalized)) return normalized;
  return undefined;
}

export function parseDefaultThink(value, { allowModelDefault = true } = {}) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') {
    throw new TypeError('thinking default must be true, false, a reasoning effort, or model-default.');
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false' || normalized === 'none') return false;
  if (RESPONSES_REASONING_EFFORTS.has(normalized)) return normalized;
  if (allowModelDefault && ['auto', 'model', 'model-default', 'unset'].includes(normalized)) return undefined;
  throw new TypeError('thinking default must be true, false, none, minimal, low, medium, high, xhigh, max, or model-default.');
}

export function resolveDefaultThink(activeModelInfo, config, fallback = undefined) {
  if (activeModelInfo?.default_think_configured) {
    return parseDefaultThink(activeModelInfo.default_think);
  }
  if (config?.defaultThinkConfigured) return config.defaultThink;
  return fallback;
}
