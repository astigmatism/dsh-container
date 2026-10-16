// Extracted from dsh-better-sidebar 0.26.1 for adapter regression tests.
// https://github.com/omdsh-dev/DSH-better-sidebar — see sidebar-preview-LICENSE.
		const FILE_ADDRESS_PREFIX = "dsh-resource://file/";

		function isAbsolutePath$1(path) {
			return path === "~" || path.startsWith("~/") || path.startsWith("~\\") || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path);
		}

		function resolveSidebarPath(cwd, path) {
			if (isAbsolutePath$1(path)) return path;
			const base = cwd ?? "";
			if (base === "") return path;
			const separator = base.includes("\\") ? "\\" : "/";
			return `${base.replace(/[\\/]+$/, "")}${separator}${path}`;
		}

		function encodeSegment(segment) {
			return encodeURIComponent(segment).replace(/%3A/gi, ":");
		}

		function encodePath(path) {
			return path.split("/").map(encodeSegment).join("/");
		}

		function isDriveSegment(segment) {
			return segment !== void 0 && /^[A-Za-z]:$/.test(segment);
		}

		function sessionFileAddress(sessionId, path) {
			const normalized = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
			return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
		}

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

		function NativeTabBody(props) {
			const { ctx, store, service, records, descriptorId, useTabInfo } = props;
			const info = useTabInfo();
			const nativeTab = info.tab;
			const seatSessionId = props.sessionId;
			const scopeSessionId = props.sessionIdOf?.(info) ?? seatSessionId;
			useRecordVersion(records, seatSessionId, nativeTab.id);
			const cwd = useSessionRoot(ctx, scopeSessionId, { visible: nativeTab.visible });
			const scope = (0, react.useMemo)(() => ({
				sessionId: scopeSessionId,
				cwd
			}), [scopeSessionId, cwd]);
			const derived = props.paramsOf?.(info);
			const params = derived === void 0 && nativeTab.navigation.params === void 0 ? void 0 : {
				...derived,
				...nativeTab.navigation.params
			};
			const descriptor = service.getTab(descriptorId);
			const view = records.ensure({
				sessionId: seatSessionId,
				id: nativeTab.id,
				kind: nativeTab.kind,
				title: nativeTab.title,
				params,
				scope,
				revision: nativeTab.navigation.revision,
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
					records.toggleExpanded(seatSessionId, nativeTab.id, path);
				},
				onReferenceFile: (path, isDir) => {
					referenceInChat(ctx, scopeSessionId, path, isDir);
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

		/**
		* Extensions DSH's own previews own, and this plugin therefore refuses.
		*
		* DSH 0.1.7 grew a real document-preview package (host-side Office→PDF
		* conversion, a worker-backed spreadsheet table, image/PDF zoom viewports and
		* per-directory auto-refresh) for exactly these formats, while the plugin's
		* equivalents are read-only fallbacks. The plugin keeps what the built-in does
		* NOT do: Markdown through its own renderer, HTML through its sandboxed route
		* with the `htmlViewerNoSandbox` safety valve, and — through the `code`
		* catch-all — a genuinely EDITABLE CodeMirror buffer for every text file.
		*
		* Refusing here is what hands the address over: `canOpen` returning false
		* leaves the built-in `text` type (the `fallback` band) as the only claimant.
		*
		* The list is exactly the set the host renders — nothing more. Nine extensions
		* that the host has NO renderer for (`xlsb xlt xltx xltm ots dot dotx avif`)
		* used to be refused here too, and refusing them turned "the plugin shows a
		* download panel" into "the host shows 'preview is not available for this file
		* type yet'" — a dead end. They are claimed again, so the `code` catch-all
		* takes them to the binary download pane. `fods` stays refused on purpose: the
		* host's plain-text fallback renders flat ODS XML, which beats a download.
		* `tests/native-surface.spec.ts` pins both directions of this boundary.
		*/
