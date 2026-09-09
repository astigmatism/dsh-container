#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_CONVERSATION_TARGET = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js";
const DEFAULT_DELIVERABLES_TARGET = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-deliverables/lib/client.js";
const PATCH_MARKER = "dsh-native-file-opening-v1";

function replaceOnce(source, before, after, description) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`cannot patch ${description}: expected source was not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`cannot patch ${description}: expected source was not unique`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

/** True only for the Host's explicit, current native-path-opening capability. */
export function canOpenWorkspacePath(description) {
  return description?.canOpenPath === true;
}

/** Expose an opener only while the rendered Host description explicitly allows it. */
export function exposedWorkspaceFileOpener(description, openFile) {
  return canOpenWorkspacePath(description) ? openFile : undefined;
}

/**
 * Recheck the live Host-description source at invocation time so a callback
 * retained across disconnect cannot issue a stale host.openPath request.
 */
export function guardedWorkspaceFileOpener(hostDescription, openFile) {
  return (...args) => {
    let description;
    try {
      description = hostDescription?.getSnapshot?.();
    } catch {
      return Promise.resolve();
    }
    if (!canOpenWorkspacePath(description)) return Promise.resolve();
    return openFile(...args);
  };
}

/** Apply the capability boundary to the pinned conversation browser bundle. */
export function patchConversationSource(input) {
  if (input.includes(PATCH_MARKER)) return input;
  if (
    input.includes('const FILE_ADDRESS_PREFIX = "dsh-resource://file/";') &&
    input.includes('const url = fileAddressFor(sessionId, cwd, path);') &&
    input.includes('ctx.sidebarRight.openResource(url)')
  ) {
    return `${input}\n// ${PATCH_MARKER}: verified upstream in-app workspace resource opening; no native host dispatch.\n`;
  }
  let source = input;

  source = replaceOnce(
    source,
    `\t\tfunction apply(ctx) {`,
    `\t\t// ${PATCH_MARKER}: native file actions fail closed on the live Host capability.\n${canOpenWorkspacePath.toString()}\n${exposedWorkspaceFileOpener.toString()}\n${guardedWorkspaceFileOpener.toString()}\n\t\tfunction apply(ctx) {`,
    "conversation native-file capability helpers",
  );

  source = replaceOnce(
    source,
    `\t\tfunction ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, fileMentions, t }) {\n\t\t\tconst order = useSession((s) => s.chat.order);`,
    `\t\tfunction ChatView({ useSession, useSessions, useStore, useHostDescription, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, fileMentions, t }) {\n\t\t\tconst hostDescription = useHostDescription((description) => description);\n\t\t\tconst order = useSession((s) => s.chat.order);`,
    "conversation Host-description subscription",
  );

  source = replaceOnce(
    source,
    `\t\t\t}, [openFile, t]);\n\t\t\tconst closeFileOpenError = (0, react.useCallback)(() => {`,
    `\t\t\t}, [openFile, t]);\n\t\t\tconst availableOpenFile = exposedWorkspaceFileOpener(hostDescription, requestOpenFile);\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tif (availableOpenFile !== void 0) return;\n\t\t\t\tfileOpenRequest.current += 1;\n\t\t\t\tsetFileOpenError(null);\n\t\t\t\tsetFileOpenBusy(false);\n\t\t\t}, [availableOpenFile]);\n\t\t\tconst closeFileOpenError = (0, react.useCallback)(() => {`,
    "conversation file-action exposure",
  );

  source = replaceOnce(
    source,
    `\t\t\t\t\t\t\t\topenFile: requestOpenFile,`,
    `\t\t\t\t\t\t\t\topenFile: availableOpenFile,`,
    "conversation chat-node opener",
  );

  source = replaceOnce(
    source,
    `\t\t\tconst sessions = ctx.sessions;\n\t\t\tconst workspaces = ctx.workspaces;\n\t\t\tconst layout = ctx.layout;`,
    `\t\t\tconst sessions = ctx.sessions;\n\t\t\tconst workspaces = ctx.workspaces;\n\t\t\tconst connection = ctx.connection;\n\t\t\tconst layout = ctx.layout;`,
    "conversation connection service",
  );

  source = replaceOnce(
    source,
    `\t\t\t\tinject: (sessionId, actions) => {\n\t\t\t\t\tconst conversation = concreteConversation(ctx);\n\t\t\t\t\tconst scoped = scopedConversation(sessions, sessionId);\n\t\t\t\t\treturn {\n\t\t\t\t\t\topenDetails: (target) => {`,
    `\t\t\t\tinject: (sessionId, actions) => {\n\t\t\t\t\tconst conversation = concreteConversation(ctx);\n\t\t\t\t\tconst scoped = scopedConversation(sessions, sessionId);\n\t\t\t\t\tconst openFile = guardedWorkspaceFileOpener(connection.hostDescription, (path) => {\n\t\t\t\t\t\tconst cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd;\n\t\t\t\t\t\treturn workspaces.openPath((0, _deepseek_ai_dsh_client_runtime_client.resolveWorkspacePath)(cwd, path));\n\t\t\t\t\t});\n\t\t\t\t\treturn {\n\t\t\t\t\t\thooks: { hostDescription: connection.hostDescription },\n\t\t\t\t\t\topenDetails: (target) => {`,
    "conversation guarded open-file injection",
  );

  source = replaceOnce(
    source,
    `\t\t\t\t\t\tfileMentions: (owner) => ctx.get("chatFileMentions")?.forClosing(owner),\n\t\t\t\t\t\topenFile: (path) => {\n\t\t\t\t\t\t\tconst cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd;\n\t\t\t\t\t\t\treturn workspaces.openPath((0, _deepseek_ai_dsh_client_runtime_client.resolveWorkspacePath)(cwd, path));\n\t\t\t\t\t\t},`,
    `\t\t\t\t\t\tfileMentions: (owner) => owner.openFile === void 0 ? void 0 : ctx.get("chatFileMentions")?.forClosing(owner),\n\t\t\t\t\t\topenFile,`,
    "conversation open-file boundary",
  );

  return source;
}

/** Make produced-file and folder affordances obey the same Host capability. */
export function patchDeliverablesSource(input) {
  if (input.includes(PATCH_MARKER)) return input;
  if (
    input.includes('function ProducedFiles({ matched: paths, openFile, t })') &&
    input.includes('openFile(path);') &&
    input.includes('producedFileMentions(paths, owner.openFile')
  ) {
    return `${input}\n// ${PATCH_MARKER}: verified produced-file actions use the chat resource opener.\n`;
  }
  let source = input;

  source = replaceOnce(
    source,
    `\t\t\tconst hostCanOpenPath = useHostDescription((description) => description?.canOpenPath === true);\n\t\t\tconst canOpenPath = isLoopback && hostCanOpenPath;`,
    `\t\t\t// ${PATCH_MARKER}: file chips and folder actions share the explicit Host capability.\n\t\t\tconst hostCanOpenPath = useHostDescription((description) => description?.canOpenPath === true);\n\t\t\tconst canOpenPath = hostCanOpenPath;`,
    "deliverables Host capability",
  );

  source = replaceOnce(
    source,
    `\t\t\t\t\t\tchildren: [shown.map((path) => (0, react_jsx_runtime.jsx)("button", {\n\t\t\t\t\t\t\ttype: "button",\n\t\t\t\t\t\t\tclassName: ProducedFiles_module_css_default.file,\n\t\t\t\t\t\t\ttitle: path,\n\t\t\t\t\t\t\t"aria-label": t("produced.open", { name: path }),\n\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\topenFile(path);\n\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\tchildren: basename(path)\n\t\t\t\t\t\t}, path)), hidden > 0 &&`,
    `\t\t\t\t\t\tchildren: [shown.map((path) => canOpenPath ? (0, react_jsx_runtime.jsx)("button", {\n\t\t\t\t\t\t\ttype: "button",\n\t\t\t\t\t\t\tclassName: ProducedFiles_module_css_default.file,\n\t\t\t\t\t\t\ttitle: path,\n\t\t\t\t\t\t\t"aria-label": t("produced.open", { name: path }),\n\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\topenFile(path);\n\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\tchildren: basename(path)\n\t\t\t\t\t\t}, path) : (0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: ProducedFiles_module_css_default.more,\n\t\t\t\t\t\t\ttitle: path,\n\t\t\t\t\t\t\tchildren: path\n\t\t\t\t\t\t}, path)), hidden > 0 &&`,
    "deliverables file affordances",
  );

  source = replaceOnce(
    source,
    `\t\t\t\t\thidden > 0 && canOpenPath && (0, react_jsx_runtime.jsx)("button", {`,
    `\t\t\t\t\thidden > 0 && isLoopback && canOpenPath && (0, react_jsx_runtime.jsx)("button", {`,
    "deliverables folder affordance",
  );

  return source;
}

async function main() {
  const conversationTarget = process.argv[2] ?? DEFAULT_CONVERSATION_TARGET;
  const deliverablesTarget = process.argv[3] ?? DEFAULT_DELIVERABLES_TARGET;
  const conversationBefore = await readFile(conversationTarget, "utf8");
  const deliverablesBefore = await readFile(deliverablesTarget, "utf8");
  const conversationAfter = patchConversationSource(conversationBefore);
  const deliverablesAfter = patchDeliverablesSource(deliverablesBefore);

  if (!conversationAfter.includes(PATCH_MARKER)) throw new Error("DSH conversation native-file patch did not apply");
  if (!deliverablesAfter.includes(PATCH_MARKER)) throw new Error("DSH deliverables native-file patch did not apply");
  if (conversationAfter !== conversationBefore) await writeFile(conversationTarget, conversationAfter);
  if (deliverablesAfter !== deliverablesBefore) await writeFile(deliverablesTarget, deliverablesAfter);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
