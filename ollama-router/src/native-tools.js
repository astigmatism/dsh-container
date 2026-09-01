export const UNSUPPORTED_TOOLS_POLICIES = new Set(['passthrough', 'drop', 'reject']);

const TOOL_SCHEMA_FIELDS = ['tools', 'functions'];
const TOOL_CHOICE_FIELDS = ['tool_choice', 'function_call'];
const TOOL_CONTROL_FIELDS = [
  ...TOOL_SCHEMA_FIELDS,
  ...TOOL_CHOICE_FIELDS,
  'parallel_tool_calls',
  'max_tool_calls'
];

export class UnsupportedToolsError extends Error {
  constructor(code, message, param = null) {
    super(message);
    this.name = 'UnsupportedToolsError';
    this.code = code;
    this.statusCode = 400;
    this.param = param;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwnValue(object, key) {
  return Object.hasOwn(object, key) && object[key] !== undefined && object[key] !== null;
}

function messageContainsToolHistory(message) {
  if (!isPlainObject(message)) return false;
  if (message.role === 'tool' || message.role === 'function') return true;
  if (hasOwnValue(message, 'tool_call_id')) return true;
  if (hasOwnValue(message, 'tool_calls')) {
    return !Array.isArray(message.tool_calls) || message.tool_calls.length > 0;
  }
  return hasOwnValue(message, 'function_call');
}

function inputItemContainsToolHistory(item) {
  if (!isPlainObject(item)) return false;
  if (messageContainsToolHistory(item)) return true;
  if (typeof item.type !== 'string') return false;
  return item.type.endsWith('_call') || item.type.endsWith('_call_output');
}

function containsToolHistory(body) {
  if (!isPlainObject(body)) return false;
  if (Array.isArray(body.messages) && body.messages.some(messageContainsToolHistory)) return true;
  return Array.isArray(body.input) && body.input.some(inputItemContainsToolHistory);
}

function fieldCount(body, field) {
  return Array.isArray(body[field]) ? body[field].length : 0;
}

export function inspectNativeTools(body) {
  if (!isPlainObject(body)) {
    return {
      toolsPresent: false,
      toolCount: 0,
      toolChoicePresent: false,
      toolHistoryPresent: false,
      toolRelatedFieldsPresent: false
    };
  }

  const toolsPresent = TOOL_SCHEMA_FIELDS.some((field) => Object.hasOwn(body, field));
  const toolChoicePresent = TOOL_CHOICE_FIELDS.some((field) => Object.hasOwn(body, field));
  const toolHistoryPresent = containsToolHistory(body);
  const toolRelatedFieldsPresent = toolHistoryPresent
    || TOOL_CONTROL_FIELDS.some((field) => Object.hasOwn(body, field));

  return {
    toolsPresent,
    toolCount: TOOL_SCHEMA_FIELDS.reduce((count, field) => count + fieldCount(body, field), 0),
    toolChoicePresent,
    toolHistoryPresent,
    toolRelatedFieldsPresent
  };
}

export function emptyToolPolicy(body, unsupportedToolsPolicy) {
  return {
    body,
    ...inspectNativeTools(body),
    toolsSupported: null,
    toolsDropped: false,
    unsupportedToolsPolicy
  };
}

export async function normalizeToolsForModel(body, model, unsupportedToolsPolicy, capabilityLookup) {
  const inspected = inspectNativeTools(body);
  const unchanged = {
    body,
    ...inspected,
    toolsSupported: null,
    toolsDropped: false,
    unsupportedToolsPolicy
  };

  if (!inspected.toolRelatedFieldsPresent) return unchanged;

  const capabilityResult = await capabilityLookup();
  if (!capabilityResult?.known) return unchanged;

  const toolsSupported = capabilityResult.capabilities.includes('tools');
  if (toolsSupported) return { ...unchanged, toolsSupported: true };

  if (inspected.toolHistoryPresent) {
    throw new UnsupportedToolsError(
      'UNSUPPORTED_TOOL_HISTORY',
      `The active model ${JSON.stringify(model)} does not support tools, but the request contains prior tool-use history. The router will not drop or rewrite tool history; use a tool-capable active model or start a new conversation without tool history.`,
      Array.isArray(body.input) ? 'input' : 'messages'
    );
  }

  if (unsupportedToolsPolicy === 'reject') {
    throw new UnsupportedToolsError(
      'UNSUPPORTED_TOOLS',
      `The active model ${JSON.stringify(model)} does not support tools. Use a tool-capable active model or set UNSUPPORTED_TOOLS_POLICY=drop to continue ordinary chat without native tools.`,
      inspected.toolsPresent ? 'tools' : null
    );
  }

  if (unsupportedToolsPolicy !== 'drop') {
    return { ...unchanged, toolsSupported: false };
  }

  const normalizedBody = { ...body };
  for (const field of TOOL_CONTROL_FIELDS) delete normalizedBody[field];
  return {
    ...unchanged,
    body: normalizedBody,
    toolsSupported: false,
    toolsDropped: true
  };
}
