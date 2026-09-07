import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  exposedWorkspaceFileOpener,
  guardedWorkspaceFileOpener,
  patchConversationSource,
  patchDeliverablesSource,
} from "../scripts/patch-dsh-native-file-opening.mjs";

const conversationFixture = `
		function ChatView({ useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt, fileMentions, t }) {
			const order = useSession((s) => s.chat.order);
			const fileOpenRequest = (0, react.useRef)(0);
			const requestOpenFile = (0, react.useCallback)((path) => {
				openFile(path).then(() => {});
			}, [openFile, t]);
			const closeFileOpenError = (0, react.useCallback)(() => {});
			return order.map((nodeKey) => (0, react_jsx_runtime.jsx)(ChatNodeSeat, {
								openFile: requestOpenFile,
			}, nodeKey));
		}
		function apply(ctx) {
			const sessions = ctx.sessions;
			const workspaces = ctx.workspaces;
			const layout = ctx.layout;
			slots.register({
				name: "conversation.view",
				inject: (sessionId, actions) => {
					const conversation = concreteConversation(ctx);
					const scoped = scopedConversation(sessions, sessionId);
					return {
						openDetails: (target) => {
							actions.select(target);
						},
						fileMentions: (owner) => ctx.get("chatFileMentions")?.forClosing(owner),
						openFile: (path) => {
							const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd;
							return workspaces.openPath((0, _deepseek_ai_dsh_client_runtime_client.resolveWorkspacePath)(cwd, path));
						},
					};
				}
			}, ChatView);
		}
`;

const deliverablesFixture = `
		function ProducedFiles({ matched: paths, openFile, isLoopback, useHostDescription, t }) {
			const hostCanOpenPath = useHostDescription((description) => description?.canOpenPath === true);
			const canOpenPath = isLoopback && hostCanOpenPath;
			const shown = paths;
			const hidden = 1;
			return (0, react_jsx_runtime.jsxs)("div", {
				children: [(0, react_jsx_runtime.jsxs)("div", {
						children: [shown.map((path) => (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: ProducedFiles_module_css_default.file,
							title: path,
							"aria-label": t("produced.open", { name: path }),
							onClick: () => {
								openFile(path);
							},
							children: basename(path)
						}, path)), hidden > 0 && (0, react_jsx_runtime.jsx)("span", {})]
					}),
					hidden > 0 && canOpenPath && (0, react_jsx_runtime.jsx)("button", {
						onClick: () => openFile(".")
					})]
			});
		}
`;

function source(initialDescription) {
  let current = initialDescription;
  return {
    getSnapshot: () => current,
    set: (next) => {
      current = next;
    },
  };
}

test("canOpenPath true exposes a native action and preserves cwd-relative resolution", async () => {
  const hostDescription = source({ canOpenPath: true });
  const opened = [];
  const cwd = "/workspace/project/docs";
  const guarded = guardedWorkspaceFileOpener(hostDescription, (candidate) => {
    opened.push(path.resolve(cwd, candidate));
    return Promise.resolve();
  });
  const action = exposedWorkspaceFileOpener(hostDescription.getSnapshot(), guarded);

  assert.equal(typeof action, "function");
  await action("../README.md");
  assert.deepEqual(opened, ["/workspace/project/README.md"]);
});

test("canOpenPath false exposes no native-open action", () => {
  assert.equal(exposedWorkspaceFileOpener({ canOpenPath: false }, () => {}), undefined);
});

test("missing and unknown Host capabilities fail closed", () => {
  for (const description of [undefined, null, {}, { canOpenPath: "true" }]) {
    assert.equal(exposedWorkspaceFileOpener(description, () => {}), undefined);
  }
});

test("an opener retained across disconnect cannot issue a stale native-open call", async () => {
  const hostDescription = source({ canOpenPath: true });
  let calls = 0;
  const guarded = guardedWorkspaceFileOpener(hostDescription, () => {
    calls += 1;
    return Promise.resolve();
  });
  const formerlyExposed = exposedWorkspaceFileOpener(hostDescription.getSnapshot(), guarded);
  assert.equal(typeof formerlyExposed, "function");

  hostDescription.set(undefined);
  await formerlyExposed("report.md");
  assert.equal(calls, 0);
  assert.equal(exposedWorkspaceFileOpener(hostDescription.getSnapshot(), guarded), undefined);
});

test("production patches gate Markdown, produced-file, and folder affordances and are idempotent", () => {
  const conversation = patchConversationSource(conversationFixture);
  const deliverables = patchDeliverablesSource(deliverablesFixture);

  assert.match(conversation, /dsh-native-file-opening-v1/);
  assert.match(conversation, /useHostDescription\(\(description\) => description\)/);
  assert.match(conversation, /openFile: availableOpenFile/);
  assert.match(conversation, /owner\.openFile === void 0 \? void 0/);
  assert.match(conversation, /resolveWorkspacePath\)\(cwd, path\)/);
  assert.match(conversation, /guardedWorkspaceFileOpener\(connection\.hostDescription/);
  assert.match(deliverables, /canOpenPath \? .*"button"/s);
  assert.match(deliverables, /: .*"span".*children: path/s);
  assert.match(deliverables, /hidden > 0 && isLoopback && canOpenPath/);
  assert.equal(patchConversationSource(conversation), conversation, "conversation patch is idempotent");
  assert.equal(patchDeliverablesSource(deliverables), deliverables, "deliverables patch is idempotent");
});

test("upstream anchor drift fails with a clear diagnostic", () => {
  const driftedConversation = conversationFixture.replace("openFile: requestOpenFile,", "openFile: renamedOpenFile,");
  assert.throws(
    () => patchConversationSource(driftedConversation),
    /cannot patch conversation chat-node opener: expected source was not found/,
  );

  const driftedDeliverables = deliverablesFixture.replace("const canOpenPath = isLoopback && hostCanOpenPath;", "const canOpenPath = hostCanOpenPath;");
  assert.throws(
    () => patchDeliverablesSource(driftedDeliverables),
    /cannot patch deliverables Host capability: expected source was not found/,
  );
});
