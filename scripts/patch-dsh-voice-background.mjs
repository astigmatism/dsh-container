#!/usr/bin/env node
/**
 * Keep dictation alive when the browser loses focus, and never lose a take.
 *
 * The official voice input bundle recorded through `MediaRecorder` bound to the
 * raw microphone stream, which Chromium keeps feeding while the tab is hidden or
 * the window minimized. It then threw that recording away the moment the page
 * lost focus: a `blur` listener cancelled any live take and a `visibilitychange`
 * listener cancelled everything that was not already transcribing. Clicking
 * away to a reference document — the normal way to dictate while reading
 * something — therefore discarded every chunk captured up to that click, with no
 * transcript and no error. This patch removes that self-inflicted cancellation:
 * only Escape, Stop, a Session switch or the page unloading may end a take, and
 * unloading now warns instead of discarding silently.
 *
 * A take could also die at recognition. `finish()` sent the recording once, and
 * any failure — a cold recognizer, a dropped speech Remote, a 503 from the voice
 * host — discarded the audio and offered only "Record again", which asks a
 * person who dictated a whole paragraph to say it again. The patch adds a bounded
 * re-send of the same take before the failure is surfaced.
 *
 * Deliberately unchanged: the settings device preview releases its *preview*
 * microphone when the tab hides, which is a different capture with nothing at
 * stake; and the 300 s ceiling the Host advertises, which still truncates a
 * recording that runs long.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const marker = 'dsh-voice-background-recording-v1';

export const DEFAULT_TARGET =
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-client-ui-voice-input/lib/client.js';

const TAB = '\t';

/** Handlers that discard a recording on focus loss. Both must disappear. */
const handlers = [
  `${TAB.repeat(4)}const blur = () => {`,
  `${TAB.repeat(5)}if (current.current?.phase === "recording") cancel();`,
  `${TAB.repeat(4)}};`,
  `${TAB.repeat(4)}const visibility = () => {`,
  `${TAB.repeat(5)}if (document.hidden && current.current && current.current.phase !== "transcribing") cancel();`,
  `${TAB.repeat(4)}};`,
].join('\n') + '\n';

/** What replaces them: one guard for the only loss the page can still cause. */
const guard = [
  `// ${marker}: a live take survives blur and a hidden tab — the recorder is`,
  `${TAB.repeat(4)}// fed by the browser's media pipeline, so nothing about capturing`,
  `${TAB.repeat(4)}// depends on the page having focus. Only Escape, Stop, a Session`,
  `${TAB.repeat(4)}// switch or the page unloading may end it, and unloading warns`,
  `${TAB.repeat(4)}// instead of discarding the take silently.`,
  `${TAB.repeat(4)}const warn = (event) => {`,
  `${TAB.repeat(5)}if (current.current?.phase === "recording") event.preventDefault();`,
  `${TAB.repeat(4)}};`,
].join('\n') + '\n';

const addListeners = `${TAB.repeat(4)}window.addEventListener("blur", blur);\n${TAB.repeat(4)}document.addEventListener("visibilitychange", visibility);\n`;
const removeListeners = `${TAB.repeat(5)}window.removeEventListener("blur", blur);\n${TAB.repeat(5)}document.removeEventListener("visibilitychange", visibility);\n`;

const transcribeCall = `${TAB.repeat(5)}const result = await transcribe({\n${TAB.repeat(6)}audioBase64: audioBase64(audio),\n${TAB.repeat(6)}...active.selection\n${TAB.repeat(5)}}, active.abort.signal);\n`;

const disposeAnchor = `${TAB.repeat(2)}async function disposeRecording(capture) {`;

const T2 = TAB.repeat(2);
const T3 = TAB.repeat(3);
const T4 = TAB.repeat(4);
const T5 = TAB.repeat(5);
const T6 = TAB.repeat(6);

/**
 * Recognize one recording, re-sending the same take on a failure. The retry
 * delays are a parameter so a test can exercise the whole path without waiting;
 * the bundle calls it with the pinned defaults. An aborted recording stops
 * retrying immediately and hands back its last result, which the caller's
 * generation check discards.
 */
export const retryHelper = [
  `${T2}/**`,
  ` ${T2}* ${marker}: recognize one recording through the Host speech Remote,`,
  ` ${T2}* re-sending the same take when a transport blip or a cold recognizer`,
  ` ${T2}* answers a failure, so a failed attempt never costs the dictation.`,
  ` ${T2}* @param delays - backoff in milliseconds before each additional attempt.`,
  ` ${T2}* @returns the first successful result, or the last failure after the retries.`,
  ` ${T2}*/`,
  `${T2}async function transcribeWithRetry(transcribe, payload, signal, delays = [2000, 5000]) {`,
  `${T3}let result = { ok: false, error: new Error("Speech recognition returned nothing") };`,
  `${T3}for (let attempt = 0; ; attempt++) {`,
  `${T4}try {`,
  `${T5}result = await transcribe(payload, signal);`,
  `${T4}} catch (failure) {`,
  `${T5}result = { ok: false, error: failure instanceof Error ? failure : new Error(String(failure)) };`,
  `${T4}}`,
  `${T4}if (result.ok || attempt === delays.length || signal.aborted) return result;`,
  `${T4}await new Promise((resolve) => {`,
  `${T5}const timer = setTimeout(resolve, delays[attempt]);`,
  `${T5}signal.addEventListener("abort", () => {`,
  `${T6}clearTimeout(timer);`,
  `${T6}resolve();`,
  `${T5}}, { once: true });`,
  `${T4}});`,
  `${T4}if (signal.aborted) return result;`,
  `${T3}}`,
  `${T2}}`,
  '',
  '',
].join('\n');

function replace(input, before, after, what) {
  const first = input.indexOf(before);
  if (first === -1 || first !== input.lastIndexOf(before)) {
    throw new Error(`Pinned voice input source drift: ${what}`);
  }
  return input.slice(0, first) + after + input.slice(first + before.length);
}

export function patchSource(input) {
  if (input.includes(marker)) return input;
  let source = input;
  source = replace(source, handlers, guard, 'the blur and visibility cancellation of a live recording');
  source = replace(source, addListeners, `${TAB.repeat(4)}window.addEventListener("beforeunload", warn);\n`, 'the blur and visibility listener registration');
  source = replace(source, removeListeners, `${TAB.repeat(5)}window.removeEventListener("beforeunload", warn);\n`, 'the blur and visibility listener cleanup');
  source = replace(
    source,
    transcribeCall,
    transcribeCall.replace('await transcribe({', 'await transcribeWithRetry(transcribe, {'),
    'the single-attempt recognition call',
  );
  return replace(source, disposeAnchor, `${retryHelper}${disposeAnchor}`, 'the recording release helper');
}

export function isPatched(source) {
  return source.includes(marker)
    && !source.includes('const blur = () => {')
    && !source.includes('const visibility = () => {')
    && source.includes('await transcribeWithRetry(transcribe, {')
    && source.includes('async function transcribeWithRetry(');
}

/**
 * The settings device preview keeps releasing its own preview microphone while
 * the tab is hidden; that capture holds nothing a user could lose, so the patch
 * must not reach for it. Pinned here so an upstream change to that handler is
 * noticed rather than silently absorbed.
 */
export function verifyPreviewUntouched(source) {
  const preview = `${TAB.repeat(4)}const hidden = () => {\n${TAB.repeat(5)}if (document.hidden) {`;
  if (!source.includes(preview)) {
    throw new Error(`Voice background patch verification failed: the settings preview's visibility handler moved; re-read ${DEFAULT_TARGET}`);
  }
  return source;
}

/** The pinned package identity, read beside the file being patched. */
async function verifyManifest(target) {
  const manifestPath = resolve(target, '..', '..', 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.name !== '@deepseek-ai/dsh-experimental-client-ui-voice-input') {
    throw new Error(`Voice background patch target is not the voice input client: ${manifestPath}`);
  }
  if (manifest.version !== '0.2.2-rc.1') {
    throw new Error(`Voice background patch is pinned to 0.2.2-rc.1, found ${manifest.version}; re-verify the anchors`);
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const check = args[0] === '--check';
  const target = resolve((check ? args[1] : args[0]) ?? DEFAULT_TARGET);
  const before = await readFile(target, 'utf8');
  if (check) {
    await verifyManifest(target);
    if (!isPatched(before)) throw new Error(`Voice background recording patch is missing from ${target}`);
    verifyPreviewUntouched(before);
    console.log(`Verified ${marker} in ${target}.`);
  } else {
    await verifyManifest(target);
    const after = patchSource(before);
    verifyPreviewUntouched(after);
    if (after !== before) await writeFile(target, after);
    console.log(`${after === before ? 'Already patched' : 'Patched'}: ${target}`);
  }
}
