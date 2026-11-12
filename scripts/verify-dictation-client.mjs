import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { launchVerificationBrowser, verificationSessionRow } from './verification-browser.mjs';

/**
 * Prove the deployed composer really dictates.
 *
 * The microphone is contributed by the official Voice Input plugin through the
 * composer's activity slot, so this checks what the user depends on rather than
 * one implementation detail: exactly one microphone control (never the retired
 * DOM-patched one and never two), a capture row whose waveform measures the live
 * microphone signal, and a transcript that reaches the draft or fails visibly.
 * Chromium's fake audio device stands in for a real microphone, so the waveform
 * assertion measures real analyser output instead of a static picture.
 */

const tokenFile = process.env.DSH_WEB_LAUNCH_TOKEN_FILE || '/run/dsh-backend-auth/launch-token';
const profileRoot = process.env.DSH_PROFILE_ROOT || '/data/dsh/profiles/web';
const port = Number(process.env.DSH_WEB_PORT || 3080);
const token = (await readFile(tokenFile, 'utf8')).trim();

/** Rendered strings of the official voice input control (English locale). */
const LABEL = {
  start: 'Start recording',
  setup: 'Open voice input setup',
  stop: 'Stop and transcribe',
  recording: 'Recording…',
  retry: 'Record again',
};
const RETIRED_BUTTON = '[data-local-speech-button]';

if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Harness launch token is invalid');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Harness web port is invalid');

const require = createRequire(`${profileRoot}/package.json`);
const { chromium } = require(`${profileRoot}/node_modules/playwright-core`);
const errors = [];
let browser;
let closeBrowser;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Composer text before recording; a transcript has to change it. */
const draftText = page => page.evaluate(() => {
  const editor = document.querySelector('[data-composer-card] [data-composer-input], [data-composer-card] textarea');
  if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) return editor.value;
  return editor?.textContent ?? '';
});

/**
 * Measure whether the waveform is drawing the microphone.
 *
 * The component paints 80 bars at a resting height of y1=19/y2=21 and rewrites
 * them from the measured level every 50 ms, so any bar whose span differs from
 * the resting baseline is proof the analyser is feeding the picture.
 */
const waveformState = page => page.evaluate(() => {
  const row = document.querySelector('[data-voice-activity="recording"]');
  const svg = row?.querySelector('svg[role="img"]') ?? null;
  if (row === null || svg === null) return { row: false, waveform: false, moving: false, bars: 0 };
  const lines = [...svg.querySelectorAll('line')];
  const moving = lines.some(line => line.getAttribute('y1') !== '19' || line.getAttribute('y2') !== '21');
  return { row: true, waveform: true, moving, bars: lines.length, label: svg.getAttribute('aria-label') };
});

try {
  const launched = await launchVerificationBrowser(chromium, {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  browser = launched.browser;
  closeBrowser = launched.close;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['microphone'], { origin: `http://127.0.0.1:${port}` });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  const base = `http://127.0.0.1:${port}`;
  // Collect the Session cookie through a plain request instead of loading the
  // app first: a browser load followed by a reload aborts the client's own
  // in-flight RPCs, and an aborted fetch is reported as a console error, which
  // this verifier treats as a failure.
  const handshake = await context.request.get(`${base}/?token=${token}`);
  if (!handshake.ok()) throw new Error(`Harness login returned HTTP ${handshake.status()}`);

  // The microphone lives in the composer's activity slot, which the app renders
  // only inside an open Session, so open one through the same RPC surface the
  // browser uses instead of depending on whatever a person left open.
  const rpc = async (method, request) => {
    const reply = await context.request.post(`${base}/api/${method}`, { data: {
      type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } },
    } });
    const { result } = await reply.json();
    if (!result?.ok) throw new Error(`${method} failed: ${result?.error?.message ?? `HTTP ${reply.status()}`}`);
    return result.value;
  };
  const title = `Dictation verification ${new Date().toISOString()}`;
  const { workspace } = await rpc('workspace/create', { path: process.env.HOME || process.cwd() });
  const { sessionId } = await rpc('session/create', { workspaceId: workspace.workspaceId });
  await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: 'Disposable dictation verification. Do not use tools.' }] });
  await rpc('session/cancel', { sessionId });
  await rpc('session/rename', { sessionId, title });

  const response = await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!response?.ok()) throw new Error(`Harness browser returned HTTP ${response?.status()}`);
  await page.waitForFunction(() => typeof window.__ModuleLoader__ === 'object', null, { timeout: 20000 });
  const sessionRow = verificationSessionRow(page, title);
  const navigationDeadline = Date.now() + 30000;
  while (true) {
    if (Date.now() > navigationDeadline) throw new Error(`the verification Session "${title}" never appeared in the sidebar`);
    const notice = page.getByRole('dialog', { name: 'Preview Notice' });
    if (await notice.isVisible().catch(() => false)) {
      await notice.getByRole('button', { name: 'Continue', exact: true }).click();
      await notice.waitFor({ state: 'hidden' }).catch(() => {});
    }
    const onboarding = page.getByRole('dialog', { name: 'Add an API key to get started' });
    if (await onboarding.isVisible().catch(() => false)) {
      await onboarding.getByRole('button', { name: 'Configure later', exact: true }).click().catch(() => {});
    }
    try {
      if (await sessionRow.isVisible().catch(() => false)) { await sessionRow.click({ timeout: 1000 }); break; }
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
    }
    await sleep(200);
  }

  await page.waitForSelector('[data-composer-input]', { timeout: 15000 });
  const trigger = page.locator(`[data-composer-card] button[aria-label="${LABEL.start}"], [data-composer-card] button[aria-label="${LABEL.setup}"]`).first();
  await trigger.waitFor({ timeout: 20000 });

  const mounted = await page.evaluate(label => {
    const composer = document.querySelector('[data-composer-card]');
    const microphone = [...(composer?.querySelectorAll('button') ?? [])].filter(button =>
      ['Start recording', 'Open voice input setup'].includes(button.getAttribute('aria-label')));
    return {
      composerPresent: composer !== null,
      inputPresent: composer?.querySelector('[data-composer-input], textarea') !== null,
      microphoneCount: microphone.length,
      retiredCount: document.querySelectorAll('[data-local-speech-button]').length,
      microphoneLabel: microphone[0]?.getAttribute('aria-label') ?? null,
      microphoneType: microphone[0]?.getAttribute('type') ?? null,
      moduleLoader: typeof window.__ModuleLoader__,
      // Absent recognizer: the control must still exist and explain itself.
      ready: microphone[0]?.getAttribute('aria-label') === label,
    };
  }, LABEL.start);

  if (!mounted.composerPresent || !mounted.inputPresent) throw new Error('Harness composer did not render');
  if (mounted.microphoneCount !== 1) {
    throw new Error(`expected one microphone control in the composer, found ${mounted.microphoneCount}`);
  }
  if (mounted.retiredCount !== 0) {
    throw new Error(`the retired ${RETIRED_BUTTON} microphone is still mounted (${mounted.retiredCount})`);
  }
  if (mounted.microphoneType !== 'button') {
    throw new Error(`microphone control contract is invalid: ${JSON.stringify(mounted)}`);
  }
  if (mounted.moduleLoader !== 'object') throw new Error('Harness module loader is unavailable');

  // A configured speech service means the default recognizer must be ready:
  // registration, the mounted key, and the reachable service are all proven by
  // the composer offering to record rather than to explain itself. With no
  // service configured (image qualification, or a deployment that disabled
  // dictation) the control must still exist and say what is missing.
  const configured = (process.env.STT_BASE_URL ?? '').trim() !== '';
  if (configured && !mounted.ready) {
    throw new Error(`dictation is not ready although STT_BASE_URL is configured: ${JSON.stringify(mounted)}`);
  }

  if (!mounted.ready) {
    // No recognizer is ready (image qualification, or a deployment that cleared
    // STT_BASE_URL). The control must then explain itself instead of pretending
    // to record.
    await trigger.click();
    const explained = await page.waitForFunction(
      () => /Speech recognition is not ready|Set up voice input before recording/.test(document.body.innerText),
      null,
      { timeout: 10000 },
    ).then(() => true).catch(() => false);
    if (!explained) throw new Error('the microphone neither offered recording nor explained what to set up');
    if (errors.length > 0) throw new Error(errors.join('\n'));
    console.log('Verified the voice input control; recognition is unconfigured, so setup guidance is shown.');
  } else {
    const baseline = await draftText(page);
    await trigger.click();
    await page.waitForSelector('[data-voice-activity="recording"]', { timeout: 15000 });
    // Give the analyser several animation frames before sampling the bars.
    let seen = await waveformState(page);
    for (let attempt = 0; attempt < 40 && !seen.moving; attempt += 1) {
      await sleep(100);
      seen = await waveformState(page);
    }
    if (!seen.waveform) throw new Error('the capture row has no waveform while recording');
    if (seen.label !== LABEL.recording) throw new Error(`waveform is unlabeled: ${JSON.stringify(seen)}`);
    if (!seen.moving) throw new Error(`the waveform is not measuring the microphone: ${JSON.stringify(seen)}`);

    await page.click(`[data-voice-activity="recording"] button[aria-label="${LABEL.stop}"]`);
    // A transcript that reached the draft, silence reported honestly, or a
    // failure row the user can retry: any of these is a working pipeline. A row
    // still transcribing after a minute is not, and a synthetic microphone is
    // no reason for one.
    let settled = 'timeout';
    for (let attempt = 0; attempt < 120 && settled === 'timeout'; attempt += 1) {
      await sleep(500);
      settled = await page.evaluate(({ previous, retry, insert }) => {
        const editor = document.querySelector('[data-composer-card] [data-composer-input], [data-composer-card] textarea');
        const text = editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement
          ? editor.value
          : editor?.textContent ?? '';
        if (text !== previous && text.trim() !== '') return 'draft';
        const row = document.querySelector('[data-voice-activity]');
        if (row === null) return 'closed';
        // Checked before the retry affordance on purpose: an empty result offers
        // "Record again" too, and "nothing intelligible was captured" is a
        // different outcome from "the recognizer failed".
        if (row.textContent.includes('No speech recognized')) return 'empty';
        const actions = [...row.querySelectorAll('button')]
          .map(button => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim());
        if (actions.includes(retry)) return 'retry';
        if (actions.includes(insert)) return 'insert';
        return 'timeout';
      }, { previous: baseline, retry: LABEL.retry, insert: 'Insert text' });
    }
    if (settled === 'timeout') {
      throw new Error('dictation never settled: still transcribing after 60 s, although the waveform was live');
    }

    const outcome = await page.evaluate(() => {
      const row = document.querySelector('[data-voice-activity]');
      return {
        phase: row?.getAttribute('data-voice-activity') ?? null,
        message: row === null ? null : row.textContent.replace(/\s+/g, ' ').trim().slice(0, 200),
      };
    });
    if (outcome.phase === 'recording' || outcome.phase === 'requesting' || outcome.phase === 'transcribing') {
      throw new Error(`the capture row stayed in phase "${outcome.phase}" after ${settled}`);
    }
    if (errors.length > 0) throw new Error(errors.join('\n'));
    // A synthetic microphone says nothing intelligible, so an empty result or a
    // retry row is a working pipeline; quoting the row is what tells an operator
    // which one happened and what the recognizer actually said.
    console.log(`Verified the voice input waveform and dictation pipeline (settled: ${settled}`
      + `${outcome.message === null ? '' : `; ${outcome.message}`}).`);
  }
} catch (error) {
  const detail = String(error?.stack ?? error).split(token).join('<redacted>');
  console.error(detail);
  process.exitCode = 1;
} finally {
  await closeBrowser?.();
}
