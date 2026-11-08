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
  // The container renders in a browser, so a workspace file has to open in the
  // Harness sidebar instead of through the Host. 0.2.2-rc.1 made that the
  // upstream behaviour: `openFile` resolves a `dsh-resource://file/` address and
  // hands it to `sidebarRight.openResource`, and the conversation bundle no
  // longer holds a `workspaces.openPath` dispatch at all. Prove both halves, so
  // a release that reintroduces a Host dispatch fails the image build rather
  // than quietly offering an action this deployment cannot serve.
  if (
    input.includes('const FILE_ADDRESS_PREFIX = "dsh-resource://file/";') &&
    input.includes('ctx.sidebarRight.openResource(url)') &&
    !input.includes('workspaces.openPath(')
  ) {
    return `${input}\n// ${PATCH_MARKER}: verified upstream in-app workspace resource opening; no native host dispatch.\n`;
  }
  throw new Error(
    'conversation bundle dispatches workspace paths to the Host again: re-qualify the native-file capability gate '
    + '(the 0.2.2-rc.1 in-app open path is `sidebarRight.openResource`, and no `workspaces.openPath` call may remain)',
  );
}

/** Make produced-file and folder affordances obey the same Host capability. */
export function patchDeliverablesSource(input) {
  if (input.includes(PATCH_MARKER)) return input;
  // 0.2.1-alpha.5 rewrote Deliverables around server-reported Host desktop
  // metadata (/api/present.host): open affordances follow the Host's own
  // desktop availability and there is no browser-side loopback heuristic
  // left to gate, so this is verification-only.
  if (input.includes('PRESENT_HOST_ROUTE') && !input.includes('isLoopback')) {
    return `${input}\n// ${PATCH_MARKER}: verified Deliverables gates open actions on server-reported Host desktop metadata.\n`;
  }
  if (input.includes('function producedFileMentions(paths, openFile, label)') &&
      input.includes('producedFileMentions([...new Set([...paths ?? [], ...presented.map((file) => file.path)])], owner.openFile,') &&
      input.includes('openFile(path);')) {
    return `${input}\n// ${PATCH_MARKER}: verified produced-file actions use the chat resource opener.\n`;
  }
  // Upstream shapes whose produced-file chips call the chat view's in-app
  // resource opener (sidebar preview) instead of dispatching to a native host.
  // 0.2.0-rc.2's redesign keeps that behavior while dropping the
  // isLoopback/useHostDescription parameters, so it is marker-only here.
  if (
    input.includes('function ProducedFiles({ matched: paths, openFile, t })') &&
    input.includes('openFile(path);') &&
    (input.includes('producedFileMentions(paths, owner.openFile') ||
      input.includes('function producedFileMentions(paths, openFile, label)') ||
      (input.includes('if (file === void 0) owner.openFile(path);') && input.includes('else opener.open(sessionId, file.seq, file.index);')))
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
