import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pluginSource = await readFile(new URL("../seed/plugins/dsh-router-model-discovery.js", import.meta.url), "utf8");
const {
  apply,
  capabilityOps,
  dshReasoningEfforts,
  routerMetadataOf,
} = await import(`data:text/javascript;base64,${Buffer.from(pluginSource).toString("base64")}`);

function entry(overrides = {}) {
  return {
    id: "local-active",
    x_ollama_router: {
      schema_version: 2,
      complete: true,
      context_window: 131072,
      input_modalities: ["text"],
      reasoning: {
        supported: true,
        efforts: { off: "none", low: "low", medium: "medium", high: "high", max: "max" },
        aliases: { none: "off", minimal: "low", xhigh: "max" },
        default: "off",
        boolean_true_behavior: { mode: "reject" },
        output_limit_policy: "cap",
        absolute_max_output_tokens: 16384,
        per_effort: {
          off: { enabled: false, default_output_tokens: 512, max_output_tokens: 4096 },
          low: { enabled: true, default_output_tokens: 1536, max_output_tokens: 1536 },
          medium: { enabled: true, default_output_tokens: 3072, max_output_tokens: 3072 },
          high: { enabled: true, default_output_tokens: 9216, max_output_tokens: 9216 },
          max: { enabled: true, default_output_tokens: 16384, max_output_tokens: 16384 },
        },
      },
      ...overrides,
    },
  };
}

test("consumes the complete router reasoning vocabulary and aliases", () => {
  const metadata = routerMetadataOf(entry());
  assert.deepEqual(dshReasoningEfforts(metadata.reasoning), {
    off: "none",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });
});

test("represents a definitive non-reasoning marker without model-name inference", () => {
  const candidate = entry();
  candidate.x_ollama_router.reasoning.supported = false;
  candidate.x_ollama_router.reasoning.efforts = {};
  candidate.x_ollama_router.reasoning.aliases = {};
  candidate.x_ollama_router.reasoning.per_effort = {};
  const metadata = routerMetadataOf(candidate);
  assert.equal(dshReasoningEfforts(metadata.reasoning), false);
});

test("rejects incomplete discovery metadata rather than persisting guesses", () => {
  const candidate = entry();
  candidate.x_ollama_router.complete = false;
  assert.throws(() => routerMetadataOf(candidate), /complete schema-v2/);
});

test("capability synchronization never changes maxTokens or contextWindow", () => {
  const settings = {
    providers: {
      local: {
        models: [{
          id: "local-active",
          contextWindow: 262144,
          maxTokens: 32768,
          input: ["text", "image"],
          reasoningEfforts: { off: "none", max: "max" },
        }],
      },
    },
  };
  const storedSettings = {
    providers: {
      local: {
        models: [{
          id: "local-active",
          contextWindow: 262144,
          maxTokens: 32768,
          input: ["text", "image"],
          reasoningEfforts: { off: "none", max: "max" },
        }],
      },
    },
  };
  const ops = capabilityOps(settings, "local", "local-active", routerMetadataOf(entry()), storedSettings);
  assert.deepEqual(ops.map((op) => op.path.at(-1)), ["models"]);
  assert.equal(ops.some((op) => op.path.includes("maxTokens")), false);
  assert.equal(ops.some((op) => op.path.includes("contextWindow")), false);
  assert.equal(ops[0].value[0].maxTokens, 32768);
  assert.equal(ops[0].value[0].contextWindow, 262144);
  assert.deepEqual(ops[0].value[0].input, ["text"]);
  assert.equal("compat" in ops[0].value[0], false);
  assert.equal(settings.providers.local.models[0].maxTokens, 32768);
});

test("capability synchronization is a no-op once metadata is current", () => {
  const settings = {
    providers: {
      local: {
        models: [{
          id: "local-active",
          input: ["text"],
          reasoningEfforts: {
            off: "none",
            minimal: "minimal",
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: "max",
          },
        }],
      },
    },
  };
  assert.deepEqual(capabilityOps(settings, "local", "local-active", routerMetadataOf(entry())), []);
});

test("plugin activates without a hard settings injection and synchronizes immediately", async () => {
  const previousFetch = globalThis.fetch;
  const settings = {
    providers: {
      "local-ollama": {
        baseURL: "http://router.example/v1",
        models: [{
          id: "local-active",
          contextWindow: 131072,
          maxTokens: 32768,
          input: ["text", "image"],
          reasoningEfforts: { off: "none", max: "max" },
        }],
      },
    },
  };
  let dispose;
  let resolveMutation;
  const mutation = new Promise((resolve) => {
    resolveMutation = resolve;
  });
  const settingsService = {
    get: () => settings,
    describe: () => [{ ns: "llm-pi-ai", user: settings }],
    mutate: async (_namespace, ops) => resolveMutation(ops),
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [entry()] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    const scopedContext = {
      settings: settingsService,
      effect: (callback) => {
        dispose = callback();
      },
      logger: { info() {}, warn() {} },
    };
    apply({
      inject: (services, callback) => {
        assert.deepEqual(services, ["settings"]);
        callback(scopedContext);
      },
    }, {
      providers: ["local-ollama"],
      model: "local-active",
      pollIntervalMs: 60_000,
    });
    const ops = await mutation;
    assert.deepEqual(ops.map((op) => op.path.at(-1)), ["models"]);
    assert.equal(ops[0].value[0].maxTokens, 32768);
  } finally {
    dispose?.();
    globalThis.fetch = previousFetch;
  }
});
