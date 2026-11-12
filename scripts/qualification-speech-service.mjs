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
  lastBytes: 0,
  lastModel: '',
  lastLanguage: '',
  lastAuthorized: false,
  lastError: '',
};
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
      if (wanted.reset === true) Object.assign(state, { received: 0, rejected: 0, lastBytes: 0, lastError: '' });
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
  if (state.fail) failures.push('unavailable');
  state.lastBytes = body.length;
  state.lastAuthorized = authorized;
  // The provider sends `model` and omits `language` for automatic detection;
  // a real server rejects anything else, so a wrong shape must fail here too.
  state.lastModel = /name="model"\r\n\r\n([^\r]*)/.exec(text)?.[1] ?? '';
  state.lastLanguage = /name="language"\r\n\r\n([^\r]*)/.exec(text)?.[1] ?? '';

  if (failures.length > 0) {
    state.rejected += 1;
    state.lastError = failures.join('; ');
    await persist();
    return json(response, state.fail ? 503 : 400, { error: { message: `Synthetic STT unavailable: ${state.lastError}` } });
  }

  state.received += 1;
  state.lastError = '';
  await persist();
  return json(response, 200, { text: transcript, language: 'en' });
});

await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
if (stateDir !== '') await persist();
console.log(`Synthetic speech service listening on 127.0.0.1:${port} as model ${model}`);
