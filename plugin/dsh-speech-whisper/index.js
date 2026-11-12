/**
 * Host half of the Whisper speech provider.
 *
 * Registers `provider.js` with the DSH speech service so the official Voice
 * Input composer control can recognize audio through the home voice host. All
 * deployment values come from the environment, which is how the container
 * already configures the gateway's `/local-stt` proxy: `STT_BASE_URL`,
 * `STT_MODEL`, `STT_API_KEY_FILE`, `STT_TIMEOUT_MS`. Keeping one source of
 * truth means this plugin has no Config schema and nothing to keep in step in
 * the profile patch.
 */

import { readFileSync } from 'node:fs';
import { createProvider, PROVIDER_ID } from './provider.js';

export const name = 'speech-whisper';
export const inject = ['speechToText'];

function environment(name, fallback) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/** Read one mounted secret without ever logging its contents. */
function readSecret(path) {
  if (typeof path !== 'string' || path === '') return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function positiveInteger(name, fallback) {
  const value = Number.parseInt(environment(name, ''), 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Register the recognizer. Registration is owned by the fiber, so disabling the
 * bundle or reloading the profile withdraws the provider cleanly.
 * @param ctx - Host registry with the speech service injected.
 */
export function apply(ctx) {
  const provider = createProvider({
    providerId: PROVIDER_ID,
    baseUrl: environment('STT_BASE_URL', ''),
    model: environment('STT_MODEL', 'large-v3-turbo'),
    apiKey: readSecret(environment('STT_API_KEY_FILE', '')),
    timeoutMs: positiveInteger('STT_TIMEOUT_MS', 120_000),
  });
  ctx.effect(() => {
    const unregister = ctx.speechToText.register(provider);
    return async () => {
      await unregister();
    };
  });
}
