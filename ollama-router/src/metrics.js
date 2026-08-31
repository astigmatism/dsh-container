function increment(map, key, amount = 1) {
  const safeKey = key || 'unknown';
  map[safeKey] = (map[safeKey] || 0) + amount;
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue / 100 * sorted.length) - 1));
  return sorted[index];
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export class Metrics {
  constructor(sampleLimit = 2000) {
    this.sampleLimit = sampleLimit;
    this.startedAt = new Date().toISOString();
    this.totalRequests = 0;
    this.allowedRequests = 0;
    this.rejectedRequests = 0;
    this.keepAliveNormalizations = 0;
    this.upstreamErrors = 0;
    this.byEndpoint = {};
    this.byModel = {};
    this.byClient = {};
    this.byStatus = {};
    this.latencyMsSamples = [];
    this.streamingDurationMsSamples = [];
    this.evalTokensPerSecondSamples = [];
    this.promptTokensPerSecondSamples = [];
    this.promptTokens = 0;
    this.outputTokens = 0;
    this.totalDurationNs = 0;
    this.evalDurationNs = 0;
    this.promptEvalDurationNs = 0;
  }

  recordRequest(record) {
    this.totalRequests += 1;
    if (record.allowed) this.allowedRequests += 1;
    if (record.rejected) this.rejectedRequests += 1;
    if (record.keepAliveNormalized) this.keepAliveNormalizations += 1;
    if (record.upstreamError) this.upstreamErrors += 1;
    increment(this.byEndpoint, `${record.method || 'UNKNOWN'} ${record.endpoint || 'unknown'}`);
    increment(this.byModel, record.requestedModel || record.activeModel || 'none');
    increment(this.byClient, record.clientIdentity || record.sourceIp || 'unknown');
    increment(this.byStatus, String(record.responseStatus || record.status || 'unknown'));
    if (Number.isFinite(record.latencyMs)) this.#pushSample(this.latencyMsSamples, record.latencyMs);
    if (record.streaming && Number.isFinite(record.latencyMs)) this.#pushSample(this.streamingDurationMsSamples, record.latencyMs);

    const usage = record.usage;
    if (usage && typeof usage === 'object') {
      if (Number.isFinite(usage.prompt_eval_count)) this.promptTokens += usage.prompt_eval_count;
      if (Number.isFinite(usage.eval_count)) this.outputTokens += usage.eval_count;
      if (Number.isFinite(usage.total_duration)) this.totalDurationNs += usage.total_duration;
      if (Number.isFinite(usage.eval_duration)) this.evalDurationNs += usage.eval_duration;
      if (Number.isFinite(usage.prompt_eval_duration)) this.promptEvalDurationNs += usage.prompt_eval_duration;
      if (Number.isFinite(usage.eval_tokens_per_second)) this.#pushSample(this.evalTokensPerSecondSamples, usage.eval_tokens_per_second);
      if (Number.isFinite(usage.prompt_tokens_per_second)) this.#pushSample(this.promptTokensPerSecondSamples, usage.prompt_tokens_per_second);
    }
  }

  rebuild(records) {
    const fresh = new Metrics(this.sampleLimit);
    fresh.startedAt = this.startedAt;
    for (const record of records) fresh.recordRequest(record);
    Object.assign(this, fresh);
  }

  snapshot() {
    return {
      startedAt: this.startedAt,
      totalRequests: this.totalRequests,
      allowedRequests: this.allowedRequests,
      rejectedRequests: this.rejectedRequests,
      keepAliveNormalizations: this.keepAliveNormalizations,
      upstreamErrors: this.upstreamErrors,
      byEndpoint: this.byEndpoint,
      byModel: this.byModel,
      byClient: this.byClient,
      byStatus: this.byStatus,
      latencyMs: {
        avg: average(this.latencyMsSamples),
        p50: percentile(this.latencyMsSamples, 50),
        p95: percentile(this.latencyMsSamples, 95),
        p99: percentile(this.latencyMsSamples, 99),
        samples: this.latencyMsSamples.length
      },
      streamingDurationMs: {
        avg: average(this.streamingDurationMsSamples),
        p50: percentile(this.streamingDurationMsSamples, 50),
        p95: percentile(this.streamingDurationMsSamples, 95),
        samples: this.streamingDurationMsSamples.length
      },
      tokens: {
        prompt: this.promptTokens,
        output: this.outputTokens
      },
      durationsNs: {
        total: this.totalDurationNs,
        eval: this.evalDurationNs,
        promptEval: this.promptEvalDurationNs
      },
      throughput: {
        evalTokensPerSecondAvg: average(this.evalTokensPerSecondSamples),
        promptTokensPerSecondAvg: average(this.promptTokensPerSecondSamples),
        evalSamples: this.evalTokensPerSecondSamples.length,
        promptSamples: this.promptTokensPerSecondSamples.length
      }
    };
  }

  #pushSample(list, value) {
    list.push(value);
    if (list.length > this.sampleLimit) list.splice(0, list.length - this.sampleLimit);
  }
}
