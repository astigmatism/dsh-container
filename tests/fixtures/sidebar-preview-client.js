// Extracted from dsh-better-sidebar 0.19.1 for adapter regression tests.
// https://github.com/omdsh-dev/DSH-better-sidebar — see sidebar-preview-LICENSE.
		function isAbsolutePath$1(path) {
			return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path);
		}
		function resolveSidebarPath(cwd, path) {
			if (isAbsolutePath$1(path)) return path;
			const base = cwd ?? "";
			if (base === "") return path;
			const separator = base.includes("\\") ? "\\" : "/";
			return `${base.replace(/[\\/]+$/, "")}${separator}${path}`;
		}
		function NativeTabBody(props) {
			const { ctx, store, service, records, descriptorId, useTabInfo } = props;
			const info = useTabInfo();
			const nativeTab = info.tab;
			useRecordVersion(records, nativeTab.id);
			const sessionId = props.sessionIdOf?.(info) ?? props.sessionId;
			const cwd = useSessionCwd(ctx, sessionId);
			const scope = (0, react.useMemo)(() => ({
				sessionId,
				cwd
			}), [sessionId, cwd]);
			const derived = props.paramsOf?.(info);
			const params = derived === void 0 && nativeTab.navigation.params === void 0 ? void 0 : {
				...derived,
				...nativeTab.navigation.params
			};
			const descriptor = service.getTab(descriptorId);
			const view = records.ensure({
				id: nativeTab.id,
				kind: nativeTab.kind,
				title: nativeTab.title,
				params,
				scope,
				mint: () => {
					const state = store.getSnapshot().state;
					if (descriptor?.createTab === void 0 || state === void 0) return void 0;
					const minted = descriptor.createTab(state);
					return minted === null ? void 0 : {
						title: minted.tab.title,
						meta: minted.tab.meta
					};
				}
			});
			(0, react.useEffect)(() => () => {
				records.drop(nativeTab.id);
			}, [records, nativeTab.id]);
			if (descriptor === void 0) return (0, react.createElement)("div", {
				className: sidebar_module_css_default.nativeTabHost,
				"data-dsh-native-tab-host": ""
			}, (0, react.createElement)(OrphanedTab, {
				ctx,
				store,
				scope,
				tab: view.tab,
				visible: nativeTab.visible
			}));
			return (0, react.createElement)(RenderBoundary, { className: sidebar_module_css_default.tabBoundaryError }, (0, react.createElement)("div", {
				className: sidebar_module_css_default.nativeTabHost,
				"data-dsh-native-tab-host": ""
			}, (0, react.createElement)(descriptor.component, {
				ctx,
				store,
				scope,
				tab: view.tab,
				visible: nativeTab.visible,
				expanded: view.expanded,
				revealed: view.revealed,
				onToggleDir: (path) => {
					records.toggleExpanded(nativeTab.id, path);
				},
				onReferenceFile: (path, isDir) => {
					referenceInChat(ctx, sessionId, cwd, path, isDir);
				},
				onOpenDiff: (tab) => {
					service.openTab({
						type: "diff",
						title: tab.title,
						id: tab.id,
						...tab.diff === void 0 ? {} : { diff: tab.diff }
					}, scope);
				},
				onSubagentJump: (childSessionId) => {
					service.openTab({
						type: "subagent",
						meta: { childSessionId }
					}, scope);
				}
			})));
		}
		function builtinViewers() {
			return [
				{
					id: "image",
					title: () => t("viewerImage"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconImageOutline16, { size }),
					exts: [
						"png",
						"jpg",
						"jpeg",
						"gif",
						"webp",
						"svg",
						"bmp",
						"ico",
						"avif"
					],
					fetchStrategy: "mediaUrl",
					component: ({ mediaUrl: url, title }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: sidebar_module_css_default.editorImageWrap,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
							className: sidebar_module_css_default.editorImage,
							src: url,
							alt: title
						})
					})
				},
				{
					id: "pdf",
					title: () => t("viewerPdf"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPdfOutline16, { size }),
					exts: ["pdf"],
					fetchStrategy: "mediaUrl",
					component: ({ scope, path, title }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PdfView, {
						scope,
						path,
						title
					})
				},
				{
					id: "markdown",
					title: () => t("viewerMarkdown"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconMarkdownOutline16, { size }),
					exts: ["md", "markdown"],
					fetchStrategy: "fsRead",
					component: (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LazyTextEditor, { ...props })
				},
				{
					id: "html",
					title: () => t("viewerHtml"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconHtmlOutline16, { size }),
					exts: ["html", "htm"],
					fetchStrategy: "fsRead",
					settings: { toggles: [{
						key: "htmlViewerNoSandbox",
						title: () => t("settingsHtmlSandboxTitle"),
						desc: () => t("settingsHtmlSandboxDesc")
					}, {
						key: "htmlViewerDefaultUnsafe",
						title: () => t("settingsHtmlDefaultUnsafeTitle"),
						desc: () => t("settingsHtmlDefaultUnsafeDesc")
					}] },
					component: (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LazyTextEditor, { ...props })
				},
				{
					id: "code",
					title: () => t("viewerCode"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCodeOutline16, { size }),
					exts: [],
					priority: -100,
					fetchStrategy: "fsRead",
					component: (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LazyTextEditor, { ...props })
				},
				{
					id: "binary-download",
					title: () => t("viewerBinary"),
					icon: (size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDownloadOutline16, { size }),
					exts: [
						"doc",
						"xls",
						"ppt"
					],
					priority: -50,
					fetchStrategy: "binary-download",
					detect: (_path, head) => head.includes(0),
					component: ({ scope, path }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BinaryDownload, {
						scope,
						path
					})
				}
			];
		}

		const FILE_ADDRESS_PREFIX = "dsh-resource://file/";
		/** Component-encode one id or path segment, keeping `:` literal for drive letters. */
		function encodeSegment(segment) {
			return encodeURIComponent(segment).replace(/%3A/gi, ":");
		}
		/** Encode a `/`-separated path segment by segment. */
		function encodePath(path) {
			return path.split("/").map(encodeSegment).join("/");
		}
		/** Whether a decoded first path segment is a Windows drive (`C:`). */
		function isDriveSegment(segment) {
			return segment !== void 0 && /^[A-Za-z]:$/.test(segment);
		}
		/**
		* Build the address of a file read through one session.
		* @param sessionId - the session whose workspace root resolves the path.
		* @param path - absolute or workspace-relative path; backslashes are normalized
		*   to `/`, and leading `./` prefixes are dropped (a leading `/` is KEPT: an
		*   absolute path stays absolute inside the session scope).
		* @returns the `dsh-resource://file/session/<sessionId>/<path>` address.
		*/
		function sessionFileAddress(sessionId, path) {
			const normalized = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
			return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
		}
		/**
		* Read a file address back into its parts without resolving `.` or `..`.
		* Query and fragment suffixes are ignored; encoded path segments are decoded.
		* @param address - a candidate address.
		* @returns the parts, or `undefined` when the string is not a
		*   `dsh-resource://file/` URI in a known scope with a path, or a segment is
		*   not validly encoded.
		*/
		function parseFileAddress(address) {
			try {
				if (!address.startsWith("dsh-resource://file/")) return void 0;
				const end = address.search(/[?#]/);
				const [scope, ...rest] = address.slice(20, end === -1 ? void 0 : end).split("/");
				if (scope === "session") {
					const [id, ...segments] = rest;
					if (id === void 0 || id === "" || segments.length === 0) return void 0;
					return {
						scope,
						sessionId: decodeURIComponent(id),
						path: segments.map(decodeURIComponent).join("/")
					};
				}
				if (scope === "absolute") {
					const unc = rest[0] === "" && rest.length > 1;
					const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent);
					if (segments.length === 0 || segments[0] === "") return void 0;
					if (unc) return {
						scope,
						path: `//${segments.join("/")}`
					};
					return {
						scope,
						path: isDriveSegment(segments[0]) ? segments.join("/") : `/${segments.join("/")}`
					};
				}
				return;
			} catch {
				return;
			}
		}
