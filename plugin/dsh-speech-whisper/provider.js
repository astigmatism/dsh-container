/**
 * Whisper recognizer for the DSH speech service.
 *
 * One `SpeechProvider` registration that forwards a recording to an
 * OpenAI-compatible `/audio/transcriptions` endpoint (faster-whisper on the
 * home voice host) and returns the transcript. Nothing here imports Cordis, so
 * the transport is unit-testable with an injected `fetch`.
 *
 * Audio arrives as the canonical recording the browser produced: a 16 kHz
 * mono PCM16 WAV validated by the Host (`validateWave`), so it is forwarded
 * unchanged rather than re-encoded.
 *
 * Error policy: plain `Error` with a short actionable message. The speech
 * Remote wraps it as `speech/transcription-failed` and the composer shows it
 * inline next to a "Record again" control.
 */

/** Registered identity; referenced by the profile default provider. */
export const PROVIDER_ID = 'whisper-lan';
/** Picker label shown by the composer and the plugin details. */
export const PROVIDER_NAME = 'Whisper (home voice host)';
/**
 * Language hints offered to the user: exactly the codes the upstream voice UI
 * translates, so every option in the picker carries a real label. Whisper
 * accepts all of them; `auto` means the request omits `language` entirely and
 * the model detects speech language itself.
 */
export const LANGUAGES = Object.freeze([
  'auto',
  'en',
  'zh',
  'yue',
  'ja',
  'ko',
  'es',
  'fr',
  'de',
  'ru',
  'pt',
]);
/** Canonical 16 kHz mono PCM16 payload rate, used for the reported duration. */
export const WAVE_BYTES_PER_SECOND = 32000;
/** WAV header length produced by the browser encoder and asserted by the Host. */
const WAVE_HEADER_BYTES = 44;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Collapse a server body into one short line safe for a UI failure row. */
function summarize(body, limit = 180) {
  const flat = String(body).replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Duration of one canonical recording.
 * @param bytes - complete WAV file, header included.
 * @returns seconds of payload audio, never negative.
 */
export function waveDurationSeconds(bytes) {
  const length = bytes?.byteLength ?? bytes?.length ?? 0;
  return Math.max(0, length - WAVE_HEADER_BYTES) / WAVE_BYTES_PER_SECOND;
}

/**
 * Recognize one recording.
 * @param input - `{ audio: Uint8Array (16 kHz mono PCM16 WAV), language }`.
 * @param options - `{ baseUrl, model, apiKey, timeoutMs, fetch }`.
 * @param signal - caller cancellation.
 * @returns final text with measured audio and inference durations.
 */
export async function transcribe(input, options, signal) {
  const { model, timeoutMs = 120_000, send = globalThis.fetch } = options;
  const baseUrl = text(options.baseUrl);
  const apiKey = text(options.apiKey);
  const audio = input?.audio;
  if (signal?.aborted) throw new Error('Transcription was cancelled');
  if (!(audio instanceof Uint8Array) || audio.length <= WAVE_HEADER_BYTES) {
    throw new Error('The recording was empty');
  }
  if (baseUrl === '') throw new Error('Set STT_BASE_URL to enable Whisper dictation');
  if (apiKey === '') throw new Error('Set STT_API_KEY_FILE to enable Whisper dictation');

  const language = text(input.language);
  const form = new FormData();
  // The name and type are what the server keys its container sniffing on.
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'dictation.wav');
  form.append('model', model);
  // A language the server has never seen (including 'auto') is worse omitted:
  // faster-whisper detects the spoken language when the field is absent.
  if (language !== '' && language !== 'auto') form.append('language', language);

  const signals = [signal].filter(Boolean);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  const combined = signals.length === 0 ? undefined : AbortSignal.any(signals);

  const startedAt = Date.now();
  let response;
  try {
    response = await send(`${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      body: form,
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('Transcription was cancelled');
    if (combined?.aborted) throw new Error('Whisper did not answer in time');
    throw new Error(`Cannot reach Whisper: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await response.text();
  if (signal?.aborted || combined?.aborted) throw new Error('Transcription was cancelled');
  if (!response.ok) {
    throw new Error(`Whisper returned ${response.status}${summarize(body) ? `: ${summarize(body)}` : ''}`);
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`Whisper response was not JSON: ${summarize(body)}`);
  }
  if (typeof payload?.text !== 'string') {
    throw new Error('Whisper response did not contain a transcript');
  }
  return {
    // An empty string is a successful recognition of silence; the UI says so.
    text: payload.text,
    audioSeconds: waveDurationSeconds(audio),
    inferenceSeconds: Math.max(0, (Date.now() - startedAt) / 1000),
  };
}

/**
 * Build the registrable recognizer.
 * @param options - `{ baseUrl, model, apiKey, timeoutMs, providerId, displayName, send }`.
 * @returns one `SpeechProvider`, always registrable even when unconfigured.
 */
export function createProvider(options) {
  const configured = text(options.baseUrl) !== '' && text(options.apiKey) !== '';
  const unconfigured = 'Whisper is not configured: set STT_BASE_URL and mount the STT key';
  const reason = configured ? '' : unconfigured;
  return {
    info: {
      id: text(options.providerId) || PROVIDER_ID,
      name: text(options.displayName) || PROVIDER_NAME,
      // LAN service, but not the browser's own machine: the wording here only
      // selects the "audio leaves this host" hint shown by the plugin details.
      location: 'host-local',
      languages: LANGUAGES,
    },
    // Preparation is what the composer consults before recording. Reporting a
    // failed phase keeps an unconfigured deployment honest (the UI opens its
    // "recognition is not ready" dialog) while still leaving the local
    // SenseVoice provider selectable, and it keeps the configured default
    // provider id resolvable instead of throwing "provider is unavailable".
    preparation: {
      snapshot: () => (configured ? { phase: 'ready' } : { phase: 'failed', message: reason }),
      subscribe: () => () => {},
      prepare: () => {},
      cancel: async () => {},
    },
    transcribe: (input, signal) => transcribe(input, options, signal),
  };
}
