#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_TARGET = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js";
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
    `\t\t/** Persistent, turn-positioned feedback for a terminal failure. */\n\t\tfunction TurnErrorItem({ node, t }) {`,
    `\t\t// ${PATCH_MARKER}: project structured aborted turn reasons through the existing turn-error seat.\n${cancellationPresentation.toString()}\n${cancellationPresentationFromTurnEnd.toString()}\n\t\t/** Persistent, turn-positioned feedback for a terminal failure or cancellation. */\n\t\tfunction TurnErrorItem({ node, t }) {`,
    "cancellation provenance helpers",
  );

  source = replaceOnce(
    source,
    `\t\tfunction TurnErrorItem({ node, t }) {\n\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {`,
    `\t\tfunction TurnErrorItem({ node, t }) {\n\t\t\tconst cancellation = node.cancellation;\n\t\t\tconst detail = cancellation === void 0 ? failureMessage(node.message, node.code, t) : cancellation.detail || (cancellation.detailKey === void 0 ? "" : t(cancellation.detailKey));\n\t\t\tconst dot = cancellation?.severity === "benign" ? (0, react_jsx_runtime.jsx)("span", { "aria-hidden": true }) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {\n\t\t\t\tstate: cancellation?.severity === "warning" ? "warning" : "error",\n\t\t\t\tclassName: MessageItem_module_css_default.turnErrorDot\n\t\t\t});\n\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {`,
    "turn cancellation renderer state",
  );

  source = replaceOnce(
    source,
    `\t\t\t\tchildren: [\n\t\t\t\t\t(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {\n\t\t\t\t\t\tstate: "error",\n\t\t\t\t\t\tclassName: MessageItem_module_css_default.turnErrorDot\n\t\t\t\t\t}),\n\t\t\t\t\t(0, react_jsx_runtime.jsxs)("div", {`,
    `\t\t\t\tchildren: [\n\t\t\t\t\tdot,\n\t\t\t\t\t(0, react_jsx_runtime.jsxs)("div", {`,
    "turn cancellation status dot",
  );

  source = replaceOnce(
    source,
    `\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: MessageItem_module_css_default.turnErrorTitle,\n\t\t\t\t\t\t\tchildren: t("message.turnError")\n\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: MessageItem_module_css_default.turnErrorMessage,\n\t\t\t\t\t\t\tchildren: failureMessage(node.message, node.code, t)\n\t\t\t\t\t\t})]`,
    `\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: cancellation?.severity === "warning" ? MessageItem_module_css_default.maxTokensTitle : MessageItem_module_css_default.turnErrorTitle,\n\t\t\t\t\t\t\tchildren: cancellation === void 0 ? t("message.turnError") : t(cancellation.titleKey)\n\t\t\t\t\t\t}), detail !== "" && (0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: MessageItem_module_css_default.turnErrorMessage,\n\t\t\t\t\t\t\tchildren: detail\n\t\t\t\t\t\t})]`,
    "turn cancellation title and detail",
  );

  source = replaceOnce(
    source,
    `\t\t\t\t\tnode.code !== void 0 && (0, react_jsx_runtime.jsx)("code", {`,
    `\t\t\t\t\tcancellation === void 0 && node.code !== void 0 && (0, react_jsx_runtime.jsx)("code", {`,
    "turn cancellation error code",
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
    `\t\tfunction failureFrom(match) {\n\t\t\tif (match.event.type !== "turn/end" || match.event.data.reason.kind !== "error") return void 0;\n\t\t\tconst failure = match.event.data.reason.error;\n\t\t\tconst display = displayFailure(failure);\n\t\t\treturn {\n\t\t\t\tseq: match.event.seq,\n\t\t\t\ttime: match.event.time,\n\t\t\t\tmessage: display.message,\n\t\t\t\t...display.code === void 0 ? {} : { code: display.code }\n\t\t\t};\n\t\t}`,
    `\t\tfunction failureFrom(match) {\n\t\t\tif (match.event.type !== "turn/end") return void 0;\n\t\t\tif (match.event.data.reason.kind === "aborted") {\n\t\t\t\tconst cancellation = cancellationPresentation(match.event.data.reason.reason);\n\t\t\t\treturn {\n\t\t\t\t\tseq: match.event.seq,\n\t\t\t\t\ttime: match.event.time,\n\t\t\t\t\tmessage: cancellation.detail,\n\t\t\t\t\tcancellation\n\t\t\t\t};\n\t\t\t}\n\t\t\tif (match.event.data.reason.kind !== "error") return void 0;\n\t\t\tconst failure = match.event.data.reason.error;\n\t\t\tconst display = displayFailure(failure);\n\t\t\treturn {\n\t\t\t\tseq: match.event.seq,\n\t\t\t\ttime: match.event.time,\n\t\t\t\tmessage: display.message,\n\t\t\t\t...display.code === void 0 ? {} : { code: display.code }\n\t\t\t};\n\t\t}`,
    "aborted turn projection",
  );

  source = replaceOnce(
    source,
    `\t\t\t\tif (event.type === "turn/end" && event.data.reason.kind === "error") return {`,
    `\t\t\t\tif (event.type === "turn/end" && (event.data.reason.kind === "error" || event.data.reason.kind === "aborted")) return {`,
    "aborted turn match",
  );

  source = replaceOnce(
    source,
    `\t\t\t\t\tmessage: failure.message,\n\t\t\t\t\t...failure.code === void 0 ? {} : { code: failure.code }`,
    `\t\t\t\t\tmessage: failure.message,\n\t\t\t\t\t...failure.code === void 0 ? {} : { code: failure.code },\n\t\t\t\t\t...failure.cancellation === void 0 ? {} : { cancellation: failure.cancellation }`,
    "cancellation node data",
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
