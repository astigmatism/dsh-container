import assert from "node:assert/strict";
import test from "node:test";

import {
  cancellationPresentation,
  cancellationPresentationFromTurnEnd,
  patchSource,
} from "../scripts/patch-dsh-cancellation-presentation.mjs";

const sourceFixture = `
function assistantProjection() {
	const interruptedAssistant = true;
	return hasInterruptionEvidence(blocks) ? interruptedAssistant : undefined;
}
		/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */
		function TurnMaxTokensItem({ t }) {
		}
		/** Max-tokens turn-end notice keyed Chat renderer. */
		const TurnMaxTokensNodeView = null;
			"message.stopped": "已停止",
			"message.stopped": "Stopped",
				case "turn-error":
				case "turn-max-tokens":
		function lastStep$1(context) {
		}
		function registerTurnErrorConversationNode(ctx) {
		}
		//#endregion
		//#region lib/types/client/conversation-nodes/turn-max-tokens.js
		function registerConversationNodes(ctx) {
			registerTurnErrorConversationNode(ctx);
			registerTurnMaxTokensConversationNode(ctx);
		}
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "turn-max-tokens",
`;

test("explicit user Stop remains a benign visible outcome", () => {
  assert.deepEqual(cancellationPresentation({ kind: "user" }), {
    severity: "benign",
    titleKey: "message.cancellation.user",
    detail: "",
  });
});

test("loop-detector hook cancellation retains its concise structured reason", () => {
  assert.deepEqual(
    cancellationPresentation({ kind: "hook", reason: "loop-detected: periodic repeat: period=29" }),
    {
      severity: "warning",
      titleKey: "message.cancellation.hook",
      detail: "loop-detected: periodic repeat: period=29",
    },
  );
});

test("semantic-progress cancellation remains distinct from literal repetition", () => {
  const reason = "semantic-no-progress: guard=read_only_hard_limit. No implementation occurred. Safe counts: continuations=8; consecutive_read_only=8.";
  assert.deepEqual(cancellationPresentation({ kind: "hook", reason }), {
    severity: "warning",
    titleKey: "message.cancellation.hook",
    detail: reason,
  });
  assert.doesNotMatch(reason, /^loop-detected:/);
});

test("transport and lifecycle cancellation is distinguishable from user Stop", () => {
  const lifecycle = cancellationPresentation({ kind: "disposed" });
  assert.equal(lifecycle.severity, "error");
  assert.equal(lifecycle.titleKey, "message.cancellation.lifecycle");
  assert.equal(lifecycle.detailKey, "message.cancellation.lifecycleHint");
  assert.notDeepEqual(lifecycle, cancellationPresentation({ kind: "user" }));

  const legacy = cancellationPresentation({ kind: "legacy" });
  assert.equal(legacy.titleKey, "message.cancellation.unknown");
  assert.equal(legacy.detailKey, "message.cancellation.unknownHint");
});

test("parent cancellation has its own provenance", () => {
  const projected = cancellationPresentation({ kind: "parent" });
  assert.equal(projected.severity, "warning");
  assert.equal(projected.titleKey, "message.cancellation.parent");
  assert.equal(projected.detailKey, "message.cancellation.parentHint");
});

test("structured cancellation data never renders as object coercion", () => {
  assert.equal(
    cancellationPresentation({ kind: "hook", reason: { code: "LOOP", period: 29 } }).detail,
    '{"code":"LOOP","period":29}',
  );
  assert.equal(cancellationPresentation({ kind: "hook", reason: { message: "semantic loop" } }).detail, "semantic loop");
  assert.doesNotMatch(cancellationPresentation({ unexpected: { nested: true } }).detail, /\[object Object\]/);
});

test("persisted aborted turn/end reason projects to a visible UI node", () => {
  const persistedEvent = {
    seq: 5359,
    time: 1788673411000,
    type: "turn/end",
    data: {
      turn: 42,
      reason: {
        kind: "aborted",
        reason: { kind: "hook", reason: "loop-detected: periodic repeat: period=29" },
      },
    },
  };

  assert.deepEqual(cancellationPresentationFromTurnEnd(persistedEvent), {
    kind: "turn-cancellation",
    visible: true,
    turn: 42,
    seq: 5359,
    time: 1788673411000,
    severity: "warning",
    titleKey: "message.cancellation.hook",
    detail: "loop-detected: periodic repeat: period=29",
  });
  assert.equal(
    cancellationPresentationFromTurnEnd({ ...persistedEvent, data: { ...persistedEvent.data, reason: { kind: "completed" } } }),
    undefined,
  );
});

test("production patch registers visible aborted-turn projection and preserves partial-output logic", () => {
  const patched = patchSource(sourceFixture);
  assert.match(patched, /dsh-cancellation-presentation-v1/);
  assert.match(patched, /kind: "turn-cancellation"/);
  assert.match(patched, /registerTurnCancellationConversationNode\(ctx\)/);
  assert.match(patched, /key: "turn-cancellation"/);
  assert.match(patched, /"message\.cancellation\.user": "Stopped by user"/);
  assert.match(patched, /"message\.cancellation\.lifecycleHint": "The session or transport lifecycle/);
  assert.match(patched, /const interruptedAssistant = true/);
  assert.match(patched, /hasInterruptionEvidence\(blocks\)/);
  assert.equal(patchSource(patched), patched, "patch is idempotent");
});
