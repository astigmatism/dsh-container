import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToolsForModel } from '../src/native-tools.js';

function capabilityLookup(capabilities, counter = { calls: 0 }) {
  return async () => {
    counter.calls += 1;
    return { known: true, capabilities };
  };
}

test('drop policy removes current and legacy native-tool controls without changing messages', async () => {
  const messages = [{ role: 'user', content: 'ordinary chat' }];
  const body = {
    model: 'active:model',
    messages,
    tools: [{ type: 'function', function: { name: 'now' } }],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    functions: [{ name: 'legacy_now' }],
    function_call: 'auto',
    max_tool_calls: 3,
    temperature: 0.25
  };

  const result = await normalizeToolsForModel(
    body,
    'active:model',
    'drop',
    capabilityLookup(['completion'])
  );

  assert.deepEqual(result.body, {
    model: 'active:model',
    messages,
    temperature: 0.25
  });
  assert.equal(result.body.messages, messages);
  assert.equal(result.toolsPresent, true);
  assert.equal(result.toolCount, 2);
  assert.equal(result.toolChoicePresent, true);
  assert.equal(result.toolsSupported, false);
  assert.equal(result.toolsDropped, true);
});

test('tool-capable models preserve every native-tool field exactly', async () => {
  const body = {
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'lookup' } },
    parallel_tool_calls: false,
    max_tool_calls: 1
  };

  const result = await normalizeToolsForModel(body, 'active:model', 'drop', capabilityLookup(['completion', 'tools']));

  assert.equal(result.body, body);
  assert.deepEqual(result.body, body);
  assert.equal(result.toolsSupported, true);
  assert.equal(result.toolsDropped, false);
});

test('requests without tool fields or history do not invoke capability detection', async () => {
  const counter = { calls: 0 };
  const body = { messages: [{ role: 'user', content: 'hello' }], temperature: 0.4 };

  const result = await normalizeToolsForModel(body, 'active:model', 'drop', capabilityLookup(['completion'], counter));

  assert.equal(result.body, body);
  assert.equal(result.toolsPresent, false);
  assert.equal(result.toolsSupported, null);
  assert.equal(counter.calls, 0);
});

test('unsupported tool history is rejected rather than dropped for chat and Responses inputs', async () => {
  const histories = [
    { messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'result' }] },
    { messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] }] },
    { input: [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' }] },
    { input: [{ type: 'function_call_output', call_id: 'call_1', output: 'result' }] }
  ];

  for (const body of histories) {
    await assert.rejects(
      normalizeToolsForModel(body, 'active:model', 'drop', capabilityLookup(['completion'])),
      (error) => error.code === 'UNSUPPORTED_TOOL_HISTORY' && /will not drop or rewrite tool history/.test(error.message)
    );
  }
});

test('passthrough remains the default-compatible behavior while reject is explicit', async () => {
  const body = { tools: [{ type: 'function', function: { name: 'lookup' } }], tool_choice: 'auto' };
  const passthrough = await normalizeToolsForModel(body, 'active:model', 'passthrough', capabilityLookup(['completion']));
  assert.equal(passthrough.body, body);
  assert.equal(passthrough.toolsSupported, false);
  assert.equal(passthrough.toolsDropped, false);

  await assert.rejects(
    normalizeToolsForModel(body, 'active:model', 'reject', capabilityLookup(['completion'])),
    (error) => error.code === 'UNSUPPORTED_TOOLS' && /UNSUPPORTED_TOOLS_POLICY=drop/.test(error.message)
  );
});
