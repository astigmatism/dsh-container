#!/usr/bin/env node
/**
 * OpenAI-compatible transcription fixture for image qualification.
 *
 * The deployment's real recognizer is faster-whisper on the voice host; the
 * qualification harness has no voice host, so the profile is booted with
 * `STT_BASE_URL` pointed here. That makes the fixture load-bearing in two
 * directions: it holds the recognizer's contract to a measurable standard (the
 * upload has to be multipart WAV carrying the configured model and the mounted
 * key), and it lets the round-trip verifier watch a synthetic microphone become
 * composer text, then fail visibly when the service goes away.
 *
 * State is read and steered over HTTP because the process that needs it (the
 * browser verifier) is a different one from the process that answers recognition.
 * `fail` makes the recognizer unavailable forever; `failOnce` makes exactly the
 * next N attempts unavailable, which is how a verifier proves a client re-sends
 * the same recording instead of asking the user to dictate it again. `sizes`
 * reports the byte length of every upload, so a re-sent take is distinguishable
 * from a new one.
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const port = Number(flag('port', '3979'));
const keyFile = flag('key-file', '');
const stateDir = flag('state-dir', '');
const model = process.env.STT_MODEL ?? 'synthetic-whisper';
const transcript = 'Synthetic microphone round trip succeeded.';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('fixture port is invalid');

const key = keyFile ? (await readFile(keyFile, 'utf8')).trim() : '';
const state = {
  received: 0,
  rejected: 0,
  fail: false,
  // Number of upcoming recognition attempts to reject before answering again:
  // the shape of a cold recognizer or a one-off network blip, which the client
  // is expected to survive by re-sending the same recording.
  failOnce: 0,
  lastBytes: 0,
  lastModel: '',
  lastLanguage: '',
  lastAuthorized: false,
  lastError: '',
  // Byte length of every upload, so a verifier can tell a re-sent take from a
  // freshly recorded one.
  sizes: [],
};
// Counters only: which attempts the verifier wants rejected is its own
// instruction, so a reset never clears it.
const clear = () => Object.assign(state, {
  received: 0, rejected: 0, lastBytes: 0, lastModel: '', lastLanguage: '',
  lastAuthorized: false, lastError: '', sizes: [],
});
const persist = async () => {
  if (stateDir === '') return;
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify(state), { mode: 0o600 });
};

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/__state') {
    if (request.method === 'POST') {
      const body = await new Promise(resolve => {
        let raw = '';
        request.on('data', chunk => { raw += chunk; });
        request.on('end', () => resolve(raw));
      });
      const wanted = JSON.parse(body || '{}');
      if (typeof wanted.fail === 'boolean') state.fail = wanted.fail;
      if (Number.isInteger(wanted.failOnce) && wanted.failOnce >= 0) state.failOnce = wanted.failOnce;
      if (wanted.reset === true) clear();
      await persist();
      return json(response, 200, state);
    }
    return json(response, 200, state);
  }

  if (url.pathname !== '/v1/audio/transcriptions' || request.method !== 'POST') {
    return json(response, 404, { error: { message: `synthetic speech service has no route ${url.pathname}` } });
  }

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const authorized = request.headers.authorization === `Bearer ${key}`;
  const text = body.toString('latin1');
  const failures = [];
  if (!authorized) failures.push(`synthetic speech key missing (got ${JSON.stringify(request.headers.authorization ?? null)})`);
  if (!/^multipart\/form-data;/.test(request.headers['content-type'] ?? '')) failures.push('multipart upload expected');
  if (body.length <= 500) failures.push(`real microphone audio expected, received ${body.length} bytes`);
  if (state.fail || state.failOnce > 0) {
    // A recognizer that answers again on the next attempt: only an unchanged
    // recording proves the client re-sent the take instead of asking for a new one.
    state.failOnce = Math.max(0, state.failOnce - 1);
    failures.push('unavailable');
  }
  state.lastBytes = body.length;
  state.lastAuthorized = authorized;
  state.sizes.push(body.length);
  // The provider sends `model` and omits `language` for automatic detection;
  // a real server rejects anything else, so a wrong shape must fail here too.
  state.lastModel = /name="model"\r\n\r\n([^\r]*)/.exec(text)?.[1] ?? '';
  state.lastLanguage = /name="language"\r\n\r\n([^\r]*)/.exec(text)?.[1] ?? '';

  if (failures.length > 0) {
    state.rejected += 1;
    state.lastError = failures.join('; ');
    await persist();
    // A wrong upload is the client's bug (400); an unavailable recognizer is the
    // service's, which is the failure a re-send can legitimately fix.
    const contract = failures.some(failure => failure !== 'unavailable');
    return json(response, contract ? 400 : 503, { error: { message: `Synthetic STT unavailable: ${state.lastError}` } });
  }

  state.received += 1;
  state.lastError = '';
  await persist();
  return json(response, 200, { text: transcript, language: 'en' });
});

await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
if (stateDir !== '') await persist();
console.log(`Synthetic speech service listening on 127.0.0.1:${port} as model ${model}`);
