import assert from 'node:assert/strict';
import test from 'node:test';
import { createProvider, LANGUAGES, PROVIDER_ID, transcribe, waveDurationSeconds } from '../plugin/dsh-speech-whisper/provider.js';

/** Silent 16 kHz mono PCM16 audio with the canonical 44-byte header. */
function wave(seconds = 0.5) {
  const bytes = new Uint8Array(44 + Math.round(seconds * 32000));
  new TextEncoder().encodeInto('RIFF', bytes.subarray(0));
  new TextEncoder().encodeInto('WAVE', bytes.subarray(8));
  const view = new DataView(bytes.buffer);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  return bytes;
}

const base = { baseUrl: 'http://voice:9000/v1', model: 'large-v3-turbo', apiKey: 'secret-key' };

/** Recorder for the injected transport, returning one JSON response. */
function server(body = { text: 'hello from whisper' }, status = 200) {
  const calls = [];
  const send = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, send };
}

test('the provider registers as a host-local recognizer with translatable languages', () => {
  const provider = createProvider(base);
  assert.equal(provider.info.id, PROVIDER_ID);
  assert.equal(provider.info.location, 'host-local');
  // Exactly the codes the upstream voice UI can label; anything else renders
  // as a raw code in the language picker.
  assert.deepEqual(provider.info.languages, [...LANGUAGES]);
  assert.deepEqual(LANGUAGES, ['auto', 'en', 'zh', 'yue', 'ja', 'ko', 'es', 'fr', 'de', 'ru', 'pt']);
  assert.deepEqual(provider.preparation.snapshot(), { phase: 'ready' });
  provider.preparation.prepare();
  provider.preparation.subscribe(() => {})();
});

test('an unconfigured recognizer stays registrable and reports why it is not ready', () => {
  // Registered-but-not-ready keeps the configured default provider resolvable
  // and sends the user to the plugin details instead of a transport failure.
  for (const options of [{ ...base, apiKey: '' }, { ...base, baseUrl: '' }]) {
    const state = createProvider(options).preparation.snapshot();
    assert.equal(state.phase, 'failed');
    assert.match(state.message, /not configured/);
  }
});

test('a recording is forwarded as WAV with the configured model and bearer key', async () => {
  const { calls, send } = server({ text: '  turn the lamp on  ' });
  const result = await transcribe({ audio: wave(0.5), language: 'auto' }, { ...base, send });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://voice:9000/v1/audio/transcriptions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-key');

  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  const file = form.get('file');
  assert.ok(file instanceof Blob);
  assert.equal(file.type, 'audio/wav');
  assert.equal(file.size, 44 + 16000);
  assert.equal(form.get('model'), 'large-v3-turbo');
  // `auto` means "let the model detect", which the API expresses by absence.
  assert.equal(form.get('language'), null);

  // Whitespace survives: the composer inserts the transcript verbatim.
  assert.equal(result.text, '  turn the lamp on  ');
  assert.ok(Math.abs(result.audioSeconds - 0.5) < 0.01, `audioSeconds: ${result.audioSeconds}`);
  assert.ok(result.inferenceSeconds >= 0);
});

test('an explicit language is sent and a trailing slash never doubles the path', async () => {
  const { calls, send } = server();
  await transcribe({ audio: wave(), language: 'en' }, { ...base, baseUrl: 'http://voice:9000/v1/', send });
  assert.equal(calls[0].url, 'http://voice:9000/v1/audio/transcriptions');
  assert.equal(calls[0].init.body.get('language'), 'en');
});

test('recognizing silence is a successful empty transcript', async () => {
  const { send } = server({ text: '' });
  const result = await transcribe({ audio: wave(), language: 'auto' }, { ...base, send });
  assert.equal(result.text, '');
});

test('a server failure becomes one short actionable line', async () => {
  const send = async () => new Response('<html>Bad Gateway\n\n\nwith detail</html>', { status: 502 });
  await assert.rejects(
    () => transcribe({ audio: wave(), language: 'auto' }, { ...base, send }),
    error => {
      assert.match(error.message, /Whisper returned 502/);
      assert.match(error.message, /Bad Gateway with detail/);
      assert.ok(error.message.length < 260, `message too long: ${error.message.length}`);
      return true;
    },
  );
});

test('a response the model did not produce fails instead of inserting nothing', async () => {
  await assert.rejects(
    () => transcribe({ audio: wave(), language: 'auto' }, { ...base, send: async () => new Response('<html>proxy</html>', { status: 200 }) }),
    /not JSON/,
  );
  await assert.rejects(
    () => transcribe({ audio: wave(), language: 'auto' }, { ...base, send: async () => new Response('{"utterance":"x"}', { status: 200 }) }),
    /did not contain a transcript/,
  );
});

test('an unreachable service and an unanswered one are reported distinctly', async () => {
  await assert.rejects(
    () => transcribe({ audio: wave(), language: 'auto' }, { ...base, send: async () => { throw new Error('ECONNREFUSED'); } }),
    /Cannot reach Whisper.*ECONNREFUSED/,
  );
  const neverAnswers = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(
    () => transcribe({ audio: wave(), language: 'auto' }, { ...base, timeoutMs: 5, send: neverAnswers }),
    /did not answer in time/,
  );
});

test('cancelling a recording cancels its recognition', async () => {
  const controller = new AbortController();
  controller.abort();
  let sent = 0;
  await assert.rejects(
    () => transcribe({ audio: wave(), language: 'auto' }, { ...base, send: async () => { sent += 1; return new Response('{}'); } }, controller.signal),
    /cancelled/,
  );
  assert.equal(sent, 0);
});

test('configuration problems explain themselves before any request', async () => {
  await assert.rejects(() => transcribe({ audio: wave(), language: 'auto' }, { ...base, baseUrl: '' }), /STT_BASE_URL/);
  await assert.rejects(() => transcribe({ audio: wave(), language: 'auto' }, { ...base, apiKey: '' }), /STT_API_KEY_FILE/);
  await assert.rejects(() => transcribe({ audio: wave(), language: 'auto' }, {}), /STT_BASE_URL/);
  await assert.rejects(() => transcribe({ audio: new Uint8Array(10), language: 'auto' }, base), /empty/);
});

test('the reported duration ignores the header and never goes negative', () => {
  assert.equal(waveDurationSeconds(new Uint8Array(44 + 32000)), 1);
  assert.equal(waveDurationSeconds(new Uint8Array(20)), 0);
});
