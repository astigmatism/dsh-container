#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_TARGET = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js";
const PATCH_MARKER = "dsh-cancellation-presentation-v1";

function replaceOnce(source, before, after, description) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`cannot patch ${description}: expected source was not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`cannot patch ${description}: expected source was not unique`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

/** Convert one structured turn cancellation cause into stable, display-safe UI data. */
export function cancellationPresentation(reason) {
  function safeDetail(value) {
    if (typeof value === "string") return value.trim();
    if (value instanceof Error && value.message.trim() !== "") return value.message.trim();
    if (value !== null && typeof value === "object") {
      for (const key of ["message", "reason", "detail"]) {
        if (typeof value[key] === "string" && value[key].trim() !== "") return value[key].trim();
      }
      try {
        const encoded = JSON.stringify(value);
        if (encoded !== undefined && encoded !== "{}") return encoded;
      } catch {}
      return "Structured cancellation data was unavailable";
    }
    return value === undefined || value === null ? "" : String(value);
  }

  switch (reason?.kind) {
    case "user":
      return { severity: "benign", titleKey: "message.cancellation.user", detail: "" };
    case "hook": {
      const detail = safeDetail(reason.reason);
      return {
        severity: "warning",
        titleKey: "message.cancellation.hook",
        detail,
        ...(detail === "" ? { detailKey: "message.cancellation.hookHint" } : {}),
      };
    }
    case "parent":
      return {
        severity: "warning",
        titleKey: "message.cancellation.parent",
        detail: "",
        detailKey: "message.cancellation.parentHint",
      };
    case "disposed":
      return {
        severity: "error",
        titleKey: "message.cancellation.lifecycle",
        detail: "",
        detailKey: "message.cancellation.lifecycleHint",
      };
    case "legacy":
      return {
        severity: "error",
        titleKey: "message.cancellation.unknown",
        detail: "",
        detailKey: "message.cancellation.unknownHint",
      };
    default: {
      const detail = safeDetail(reason);
      return {
        severity: "error",
        titleKey: "message.cancellation.unknown",
        detail,
        ...(detail === "" ? { detailKey: "message.cancellation.unknownHint" } : {}),
      };
    }
  }
}

/** Project the durable turn/end envelope that the browser receives from persistence. */
export function cancellationPresentationFromTurnEnd(event) {
  if (event?.type !== "turn/end" || event?.data?.reason?.kind !== "aborted") return undefined;
  return {
    kind: "turn-cancellation",
    visible: true,
    turn: event.data.turn,
    seq: event.seq,
    time: event.time,
    ...cancellationPresentation(event.data.reason.reason),
  };
}

/** Apply the pinned DSH browser cancellation patch, failing loudly on upstream drift. */
export function patchSource(input) {
  if (input.includes(PATCH_MARKER)) return input;
  let source = input;

  source = replaceOnce(
    source,
    `\t\tfunction lastStep$1(context) {`,
    `\t\t// ${PATCH_MARKER}: project structured aborted turn reasons into visible Chat nodes.\n${cancellationPresentation.toString()}\n${cancellationPresentationFromTurnEnd.toString()}\n\t\tfunction lastStep$1(context) {`,
    "cancellation provenance helpers",
  );

  source = replaceOnce(
    source,
    `\t\t/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */\n\t\tfunction TurnMaxTokensItem({ t }) {`,
    `\t\t/** Persistent provenance for every explicitly aborted turn. */\n\t\tfunction TurnCancellationItem({ node, t }) {\n\t\t\tconst detail = node.detail || (node.detailKey === void 0 ? "" : t(node.detailKey));\n\t\t\tconst dot = node.severity === "benign" ? (0, react_jsx_runtime.jsx)("span", { "aria-hidden": true }) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {\n\t\t\t\tstate: node.severity === "error" ? "error" : "warning",\n\t\t\t\tclassName: MessageItem_module_css_default.turnErrorDot\n\t\t\t});\n\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\tclassName: MessageItem_module_css_default.turnErrorRow,\n\t\t\t\trole: "status",\n\t\t\t\tchildren: [dot, (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\t\tclassName: MessageItem_module_css_default.turnErrorCopy,\n\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\tclassName: node.severity === "error" ? MessageItem_module_css_default.turnErrorTitle : node.severity === "warning" ? MessageItem_module_css_default.maxTokensTitle : MessageItem_module_css_default.turnErrorMessage,\n\t\t\t\t\t\tchildren: t(node.titleKey)\n\t\t\t\t\t}), detail !== "" && (0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\tclassName: MessageItem_module_css_default.turnErrorMessage,\n\t\t\t\t\t\tchildren: detail\n\t\t\t\t\t})]\n\t\t\t\t})]\n\t\t\t});\n\t\t}\n\t\t/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */\n\t\tfunction TurnMaxTokensItem({ t }) {`,
    "turn cancellation renderer",
  );

  source = replaceOnce(
    source,
    `\t\t/** Max-tokens turn-end notice keyed Chat renderer. */\n\t\tconst TurnMaxTokensNodeView =`,
    `\t\t/** Aborted turn provenance keyed Chat renderer. */\n\t\tconst TurnCancellationNodeView = (0, react.memo)(function TurnCancellationNodeView({ node, t }) {\n\t\t\treturn (0, react_jsx_runtime.jsx)(TurnCancellationItem, {\n\t\t\t\tnode: node.data,\n\t\t\t\tt\n\t\t\t});\n\t\t});\n\t\t/** Max-tokens turn-end notice keyed Chat renderer. */\n\t\tconst TurnMaxTokensNodeView =`,
    "turn cancellation node view",
  );

  source = replaceOnce(
    source,
    `\t\t\t"message.stopped": "已停止",`,
    `\t\t\t"message.stopped": "已停止",\n\t\t\t"message.cancellation.user": "已由用户停止",\n\t\t\t"message.cancellation.hook": "已由安全检查停止",\n\t\t\t"message.cancellation.hookHint": "安全检查在没有提供原因的情况下停止了本轮。",\n\t\t\t"message.cancellation.parent": "随父任务停止",\n\t\t\t"message.cancellation.parentHint": "父任务结束时停止了本轮。",\n\t\t\t"message.cancellation.lifecycle": "任务意外中断",\n\t\t\t"message.cancellation.lifecycleHint": "会话或传输生命周期在本轮完成前结束。",\n\t\t\t"message.cancellation.unknown": "任务已中断",\n\t\t\t"message.cancellation.unknownHint": "本轮在没有可用取消来源的情况下结束。",`,
    "Chinese cancellation locale",
  );

  source = replaceOnce(
    source,
    `\t\t\t"message.stopped": "Stopped",`,
    `\t\t\t"message.stopped": "Stopped",\n\t\t\t"message.cancellation.user": "Stopped by user",\n\t\t\t"message.cancellation.hook": "Stopped by safety hook",\n\t\t\t"message.cancellation.hookHint": "A safety hook stopped this turn without providing a reason.",\n\t\t\t"message.cancellation.parent": "Stopped with parent task",\n\t\t\t"message.cancellation.parentHint": "The parent task ended this turn.",\n\t\t\t"message.cancellation.lifecycle": "Task interrupted unexpectedly",\n\t\t\t"message.cancellation.lifecycleHint": "The session or transport lifecycle ended before this turn completed.",\n\t\t\t"message.cancellation.unknown": "Task interrupted",\n\t\t\t"message.cancellation.unknownHint": "This turn ended without usable cancellation provenance.",`,
    "English cancellation locale",
  );

  source = replaceOnce(
    source,
    `\t\t\t\tcase "turn-error":\n\t\t\t\tcase "turn-max-tokens":`,
    `\t\t\t\tcase "turn-error":\n\t\t\t\tcase "turn-cancellation":\n\t\t\t\tcase "turn-max-tokens":`,
    "legacy Chat contribution dispatch",
  );

  source = replaceOnce(
    source,
    `\t\t//#endregion\n\t\t//#region lib/types/client/conversation-nodes/turn-max-tokens.js`,
    `\t\t//#endregion\n\t\t//#region dsh-container/cancellation-provenance.js\n\t\t/** Notice Definition for an aborted turn, including restored persisted events. */\n\t\tconst turnCancellationDefinition = {\n\t\t\tkind: "turn-cancellation",\n\t\t\ttarget: "chat",\n\t\t\tmatch: (event) => {\n\t\t\t\tif (event.type === "turn/end" && event.data.reason.kind === "aborted") return {\n\t\t\t\t\tid: String(event.data.turn),\n\t\t\t\t\trole: "start"\n\t\t\t\t};\n\t\t\t\treturn null;\n\t\t\t},\n\t\t\tstart: (_context, match) => {\n\t\t\t\tconst state = cancellationPresentationFromTurnEnd(match.event);\n\t\t\t\tif (state === void 0) throw new Error("turn-cancellation start requires an aborted turn/end");\n\t\t\t\treturn state;\n\t\t\t},\n\t\t\tupdate: (context) => context.state,\n\t\t\tbuildViewNode: (context) => {\n\t\t\t\tconst state = context.state;\n\t\t\t\tif (state === void 0) return null;\n\t\t\t\treturn chatNode(context, "turn-cancellation", state.seq, state, { visibility: state.visible ? "visible" : "hidden" });\n\t\t\t}\n\t\t};\n\t\tfunction registerTurnCancellationConversationNode(ctx) {\n\t\t\tctx.conversationEvents.register(turnCancellationDefinition);\n\t\t}\n\t\t//#endregion\n\t\t//#region lib/types/client/conversation-nodes/turn-max-tokens.js`,
    "turn cancellation conversation node",
  );

  source = replaceOnce(
    source,
    `\t\t\tregisterTurnErrorConversationNode(ctx);\n\t\t\tregisterTurnMaxTokensConversationNode(ctx);`,
    `\t\t\tregisterTurnErrorConversationNode(ctx);\n\t\t\tregisterTurnCancellationConversationNode(ctx);\n\t\t\tregisterTurnMaxTokensConversationNode(ctx);`,
    "turn cancellation definition registration",
  );

  source = replaceOnce(
    source,
    `\t\t\tctx.slots.inject("conversation.chat.node", () => ctx.slots.register({\n\t\t\t\tname: "conversation.chat.node",\n\t\t\t\tkey: "turn-max-tokens",`,
    `\t\t\tctx.slots.inject("conversation.chat.node", () => ctx.slots.register({\n\t\t\t\tname: "conversation.chat.node",\n\t\t\t\tkey: "turn-cancellation",\n\t\t\t\tlocale: NS\n\t\t\t}, TurnCancellationNodeView));\n\t\t\tctx.slots.inject("conversation.chat.node", () => ctx.slots.register({\n\t\t\t\tname: "conversation.chat.node",\n\t\t\t\tkey: "turn-max-tokens",`,
    "turn cancellation view registration",
  );

  return source;
}

async function main() {
  const target = process.argv[2] ?? DEFAULT_TARGET;
  const before = await readFile(target, "utf8");
  const after = patchSource(before);
  if (after !== before) await writeFile(target, after);
  if (!after.includes(PATCH_MARKER)) throw new Error("DSH cancellation presentation patch did not apply");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
