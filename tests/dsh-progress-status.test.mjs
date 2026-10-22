import assert from 'node:assert/strict';
import test from 'node:test';
import { currentStep, patchSource, verifyHookScope } from '../scripts/patch-dsh-progress-status.mjs';

const MARKER = 'dsh-step-progress-status-v1';

/**
 * Minimal stand-in for the pinned dsh-client-ui-chat client bundle. The
 * memoized ChatFlow component owns the `useChatNode` prop and renders the
 * running status; ChatView is the outer view slot where that identifier is
 * undefined and throws on every render.
 */
const bundle = ({ marker = false, hookInChatView = false } = {}) => [
  '\tfunction RunningStatus({ startTime, t }) {',
  marker ? `\t\t// ${MARKER}` : '',
  '\t\tconst label = startTime === void 0 ? t("chat.deepDiving") : t("chat.deepDivingFor", { duration: formatRunDuration(Math.max(1e3, now - startTime), t).map((part) => part.text).join("") });',
  '\t\treturn label;',
  '\t}',
  '\tfunction ChatView({ useChat, useProjection, t }) {',
  '\t\tconst turnOutline = useProjection("turnOutline");',
  hookInChatView ? '\t\tconst runningStep = useChatNode(latestTurnAnchor ?? "", node => node);' : '',
  '\t\treturn ChatFlowProp;',
  '\t}',
  '\tfunction ChatFlow({ entries, useChat, useChatNode, t }) {',
  '\t\t\tconst runningStartTime = useChatNode(useChat((snapshot) => snapshot.navigation.items().at(-1)?.anchorKey) ?? "", (node) => {',
  '\t\t\t\treturn node;',
  '\t\t\t});',
  '\t\t\treturn t("chat.deepDiving", { startTime: runningStartTime, });',
  '\t}',
  '',
].join('\n');

/** The hook placed in ChatFlow, as the pinned patch leaves it. */
const correctlyAnchored = () => bundle({ marker: true }).replace(
  '\t\t\tconst runningStartTime = useChatNode(',
  '\t\t\tconst runningStep = useChatNode(useChat((snapshot) => snapshot), (node) => node);\n'
  + '\t\t\tconst runningStartTime = useChatNode(',
);

test('progress uses the current open turn and its durable step start after reload', () => {
  const timeline = { turns: new Map([
    [1, { status: 'closed', steps: [{ step: 99, start: { time: 1 }, status: 'closed' }] }],
    [2, { status: 'open', steps: [{ step: 3, start: { time: 1000 }, status: 'open' }] }],
  ]) };
  assert.deepEqual(currentStep(timeline), { number: 3, startedAt: 1000, status: 'open' });
  assert.equal(currentStep({ turns: new Map() }), null);
});

test('progress patch fails closed on changed upstream markup', () => {
  assert.throws(() => patchSource('different upstream'), /source drift/);
});

test('progress patch keeps the step hook inside the component that owns useChatNode', () => {
  const patched = patchSource(bundle());
  assert.match(patched, /const runningStep = useChatNode\(/);
  assert.match(patched, /rawStep: runningStep,/);
  assert.doesNotThrow(() => verifyHookScope(patched));
  const hookOffset = patched.indexOf('const runningStep = useChatNode(');
  assert.ok(hookOffset > patched.indexOf('function ChatFlow('), 'the hook must land in ChatFlow');
  assert.equal(patched.indexOf('const runningStep = useChatNode(', hookOffset + 1), -1, 'one hook only');
});

test('progress patch rejects a hook a release moved into the view slot', () => {
  const misAnchored = bundle({ marker: true, hookInChatView: true });
  assert.throws(() => verifyHookScope(misAnchored), /anchored in ChatView\(\), which has no useChatNode prop/);
  assert.throws(() => patchSource(misAnchored), /must be anchored inside ChatFlow/);
});

test('progress patch rejects a property that reads the hook outside ChatFlow', () => {
  const misplacedUse = correctlyAnchored().replace(
    '\t\treturn ChatFlowProp;',
    '\t\treturn t("chat.deepDiving", { startTime: runningStartTime, rawStep: runningStep, });',
  );
  assert.throws(() => verifyHookScope(misplacedUse), /rawStep property was anchored in ChatView\(\)/);
});
