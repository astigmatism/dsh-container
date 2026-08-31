const USAGE_KEYS = [
  'total_duration',
  'load_duration',
  'prompt_eval_count',
  'prompt_eval_duration',
  'eval_count',
  'eval_duration'
];

export function extractUsageFromOllamaObject(value) {
  if (!value || typeof value !== 'object') return null;
  const hasUsage = USAGE_KEYS.some((key) => Number.isFinite(value[key]));
  if (!hasUsage) return null;
  const usage = {};
  for (const key of USAGE_KEYS) {
    if (Number.isFinite(value[key])) usage[key] = value[key];
  }
  if (Number.isFinite(usage.eval_count) && Number.isFinite(usage.eval_duration) && usage.eval_duration > 0) {
    usage.eval_tokens_per_second = usage.eval_count / usage.eval_duration * 1_000_000_000;
  }
  if (Number.isFinite(usage.prompt_eval_count) && Number.isFinite(usage.prompt_eval_duration) && usage.prompt_eval_duration > 0) {
    usage.prompt_tokens_per_second = usage.prompt_eval_count / usage.prompt_eval_duration * 1_000_000_000;
  }
  return usage;
}

export class NdjsonUsageCollector {
  constructor() {
    this.decoder = new TextDecoder();
    this.buffer = '';
    this.chunks = 0;
    this.bytes = 0;
    this.lastObject = null;
    this.usage = null;
    this.parseErrors = 0;
  }

  observe(chunk) {
    if (!chunk) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.chunks += 1;
    this.bytes += buffer.length;
    this.buffer += this.decoder.decode(buffer, { stream: true });
    this.#drain(false);
  }

  finish() {
    this.buffer += this.decoder.decode();
    this.#drain(true);
    return {
      chunks: this.chunks,
      bytes: this.bytes,
      usage: this.usage,
      lastObject: this.lastObject,
      parseErrors: this.parseErrors
    };
  }

  #drain(final) {
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = final ? '' : lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        this.lastObject = parsed;
        if (parsed.done === true) {
          const usage = extractUsageFromOllamaObject(parsed);
          if (usage) this.usage = usage;
        }
      } catch {
        this.parseErrors += 1;
      }
    }
    if (final && this.buffer.trim()) {
      try {
        const parsed = JSON.parse(this.buffer.trim());
        this.lastObject = parsed;
        if (parsed.done === true) {
          const usage = extractUsageFromOllamaObject(parsed);
          if (usage) this.usage = usage;
        }
      } catch {
        this.parseErrors += 1;
      }
      this.buffer = '';
    }
  }
}
