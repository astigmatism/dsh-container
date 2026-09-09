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
		/** Persistent, turn-positioned feedback for a terminal failure. */
		function TurnErrorItem({ node, t }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: MessageItem_module_css_default.turnErrorRow,
				role: "status",
				children: [
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
						state: "error",
						className: MessageItem_module_css_default.turnErrorDot
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: MessageItem_module_css_default.turnErrorCopy,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: MessageItem_module_css_default.turnErrorTitle,
							children: t("message.turnError")
						}), (0, react_jsx_runtime.jsx)("span", {
							className: MessageItem_module_css_default.turnErrorMessage,
							children: failureMessage(node.message, node.code, t)
						})]
					}),
					node.code !== void 0 && (0, react_jsx_runtime.jsx)("code", {
						className: MessageItem_module_css_default.turnErrorCode,
						children: node.code
					})
				]
			});
		}
			"message.stopped": "已停止",
			"message.stopped": "Stopped",
		function lastStep$1(context) {
		}
		function failureFrom(match) {
			if (match.event.type !== "turn/end" || match.event.data.reason.kind !== "error") return void 0;
			const failure = match.event.data.reason.error;
			const display = displayFailure(failure);
			return {
				seq: match.event.seq,
				time: match.event.time,
				message: display.message,
				...display.code === void 0 ? {} : { code: display.code }
			};
		}
		const turnErrorDefinition = {
			match: (event) => {
				if (event.type === "turn/end" && event.data.reason.kind === "error") return {
					id: String(event.data.turn),
					role: "update"
				};
			},
			buildViewNode: (context) => {
				const failure = state.failure;
				const node = {
					kind: "turn-error",
					seq: failure.seq,
					time: failure.time,
					turn: state.turn,
					step: lastStep$1(context),
					message: failure.message,
					...failure.code === void 0 ? {} : { code: failure.code }
				};
			}
		};
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
  const reason = "semantic-no-progress: guard=duplicate_read_repeated. No implementation occurred. Safe counts: continuations=12; consecutive_read_only=16.";
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
  assert.match(patched, /reason\.kind === "aborted"/);
  assert.match(patched, /cancellation: failure\.cancellation/);
  assert.match(patched, /const cancellation = node\.cancellation/);
  assert.match(patched, /"message\.cancellation\.user": "Stopped by user"/);
  assert.match(patched, /"message\.cancellation\.lifecycleHint": "The session or transport lifecycle/);
  assert.match(patched, /const interruptedAssistant = true/);
  assert.match(patched, /hasInterruptionEvidence\(blocks\)/);
  assert.equal(patchSource(patched), patched, "patch is idempotent");
});
