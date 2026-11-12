// Verbatim excerpt of @deepseek-ai/dsh-experimental-client-ui-voice-input
// 0.2.2-rc.1 lib/client.js (MIT; license alongside): the VoiceInput component
// from `disposeRecording` through the end of `start`, and the settings device
// preview's visibility handler. Whitespace is untouched so the patch anchors
// in scripts/patch-dsh-voice-background.mjs are exercised against real bytes.
/* eslint-disable */
		async function disposeRecording(capture) {
			try {
				await capture.dispose();
			} catch (_error) {}
		}
		/** Render a compact microphone or an expanded capture, transcription, or retry row. */
		function VoiceInput({ sessionId, inputActions, locked, onActiveChange, createRecording, transcribe, openSettings, useSpeechReadiness, usePluginNavigation, t }) {
			const readiness = useSpeechReadiness((value) => value), catalog = readiness.catalog;
			const navigable = usePluginNavigation((present) => present);
			const provider = catalog?.providers.find((item) => item.id === catalog.selection.providerId);
			const usable = readiness.connected && (provider?.preparation.phase === "ready" || provider?.preparation.phase === "standby" || provider?.preparation.phase === "waking");
			const [phase, setPhase] = (0, react.useState)("idle"), [message, setMessage] = (0, react.useState)(""), [pending, setPending] = (0, react.useState)("");
			const [setupOpen, setSetupOpen] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (usable) setSetupOpen(false);
			}, [usable]);
			const current = (0, react.useRef)(), generation = (0, react.useRef)(0);
			const expanded = phase !== "idle";
			(0, react.useLayoutEffect)(() => {
				onActiveChange(expanded);
				return () => {
					onActiveChange(false);
				};
			}, [expanded, onActiveChange]);
			const cancel = () => {
				generation.current++;
				const active = current.current;
				current.current = void 0;
				if (active) {
					clearTimeout(active.timer);
					active.abort.abort();
					disposeRecording(active.capture);
				}
				setPending("");
				setMessage("");
				setPhase("idle");
				setSetupOpen(false);
			};
			(0, react.useEffect)(() => {
				setPending("");
				setMessage("");
				setPhase("idle");
				setSetupOpen(false);
				const blur = () => {
					if (current.current?.phase === "recording") cancel();
				};
				const visibility = () => {
					if (document.hidden && current.current && current.current.phase !== "transcribing") cancel();
				};
				const escape = (event) => {
					if (event.key === "Escape" && current.current) {
						event.preventDefault();
						cancel();
					}
				};
				window.addEventListener("blur", blur);
				document.addEventListener("visibilitychange", visibility);
				document.addEventListener("keydown", escape);
				return () => {
					window.removeEventListener("blur", blur);
					document.removeEventListener("visibilitychange", visibility);
					document.removeEventListener("keydown", escape);
					generation.current++;
					const active = current.current;
					current.current = void 0;
					if (active) {
						clearTimeout(active.timer);
						active.abort.abort();
						disposeRecording(active.capture);
					}
				};
			}, [sessionId]);
			const feedback = (text) => {
				setMessage(text);
				setPhase("feedback");
			};
			const finish = async () => {
				const active = current.current;
				if (!active || active.phase !== "recording") return;
				active.phase = "transcribing";
				const run = generation.current;
				clearTimeout(active.timer);
				setPhase("transcribing");
				try {
					const audio = await active.capture.stop(active.maxDurationSeconds);
					if (run !== generation.current) return;
					if (audio.byteLength > active.maxAudioBytes) {
						feedback(t("tooLarge"));
						return;
					}
					const result = await transcribe({
						audioBase64: audioBase64(audio),
						...active.selection
					}, active.abort.signal);
					if (run !== generation.current) return;
					if (!result.ok) {
						feedback(t("failed", { message: result.error.message }));
						return;
					}
					if (result.value.text === "") {
						feedback(t("empty"));
						return;
					}
					if (!inputActions.insertText(result.value.text, active.span)) {
						setPending(result.value.text);
						feedback(t("conflict"));
						return;
					}
					setPhase("idle");
				} catch (failure) {
					await disposeRecording(active.capture);
					if (run === generation.current) feedback(failureText(failure, t));
				} finally {
					if (run === generation.current) current.current = void 0;
				}
			};
			const start = async () => {
				if (!catalog || !usable || locked || current.current) return;
				const run = ++generation.current;
				const active = {
					capture: createRecording(),
					abort: new AbortController(),
					span: inputActions.captureInsertion(),
					selection: catalog.selection,
					maxDurationSeconds: catalog.maxDurationSeconds,
					maxAudioBytes: catalog.maxAudioBytes,
					phase: "requesting"
				};
				current.current = active;
				setMessage("");
				setPending("");
				setPhase("requesting");
				try {
					await active.capture.start((failure) => {
						if (run !== generation.current || current.current !== active || active.phase === "transcribing") return;
						current.current = void 0;
						clearTimeout(active.timer);
						active.abort.abort();
						feedback(failureText(failure, t));
					});
					if (run !== generation.current || current.current !== active) return;
					active.phase = "recording";
					setPhase("recording");
					active.timer = setTimeout(() => {
						finish();
					}, active.maxDurationSeconds * 1e3);
				} catch (failure) {
					await disposeRecording(active.capture);
					if (run === generation.current) {
						current.current = void 0;
						feedback(failureText(failure, t));
					}
				}
			};
			if (!expanded) return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {

// --- settings device preview (verbatim excerpt) ---
							setPreview(void 0);
							setError(void 0);
						} else if (!document.hidden && !capture) acquire();
					} catch (failure) {
						if (request === enumeration) fail(failure);
					}
				};
				const changed = () => {
					refresh();
				};
				const hidden = () => {
					if (document.hidden) {
						release();
						setPreview(void 0);
					} else changed();
				};
				media?.addEventListener("devicechange", changed, { signal: lifetime.signal });
				document.addEventListener("visibilitychange", hidden, { signal: lifetime.signal });
				changed();
				return () => {
					lifetime.abort();
