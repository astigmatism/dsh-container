import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pluginSource = await readFile(new URL("../seed/plugins/dsh-router-model-discovery.js", import.meta.url), "utf8");
const {
  apply,
  capabilityOps,
  dshReasoningEfforts,
  provisionProviderOps,
  routerMetadataOf,
} = await import(`data:text/javascript;base64,${Buffer.from(pluginSource).toString("base64")}`);

function entry(overrides = {}) {
  return {
    id: "local-active",
    x_ollama_router: {
      schema_version: 2,
      complete: true,
      warnings: [],
      capabilities: ["completion", "thinking"],
      context_window: 131072,
      max_output_tokens: 16384,
      active_request_limit: 2,
      input_modalities: ["text"],
      reasoning: {
        supported: true,
        efforts: { off: "none", low: "low", medium: "medium", xhigh: "xhigh" },
        aliases: { none: "off", minimal: "low", high: "xhigh", max: "xhigh" },
        default: "medium",
        boolean_true_behavior: { mode: "reject" },
        output_limit_policy: "cap",
        absolute_max_output_tokens: 16384,
        per_effort: {
          off: { enabled: false, default_output_tokens: 512, max_output_tokens: 4096 },
          low: { enabled: true, default_output_tokens: 1536, max_output_tokens: 1536 },
          medium: { enabled: true, default_output_tokens: 3072, max_output_tokens: 3072 },
          xhigh: { enabled: true, default_output_tokens: 16384, max_output_tokens: 16384 },
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
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "xhigh",
    xhigh: "xhigh",
    max: "xhigh",
  });
});

test("represents a definitive non-reasoning marker without model-name inference", () => {
  const candidate = entry();
  candidate.x_ollama_router.reasoning.supported = false;
  candidate.x_ollama_router.capabilities = ["completion"];
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

test("rejects invalid capacity and reasoning defaults before mutating settings", () => {
  const noConcurrency = entry({ active_request_limit: 0 });
  assert.throws(() => routerMetadataOf(noConcurrency), /active_request_limit/);

  const inconsistentOutput = entry({ max_output_tokens: 32768 });
  assert.throws(() => routerMetadataOf(inconsistentOutput), /inconsistent output limits/);

  const invalidDefault = entry();
  invalidDefault.x_ollama_router.reasoning.default = "ultra";
  assert.throws(() => routerMetadataOf(invalidDefault), /reasoning default is not supported/);
});

test("contract synchronization corrects context, output, concurrency, and capabilities", () => {
  const settings = {
    providers: {
      local: {
        cacheRetention: "none",
        maxConcurrency: 4,
        reasoning: "off",
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
  assert.deepEqual(ops.map((op) => op.path.at(-1)), ["maxConcurrency", "models"]);
  assert.equal(ops[0].value, 2);
  assert.equal(ops[1].value[0].maxTokens, 16384);
  assert.equal(ops[1].value[0].contextWindow, 131072);
  assert.deepEqual(ops[1].value[0].input, ["text"]);
  assert.equal("compat" in ops[1].value[0], false);
  assert.equal(settings.providers.local.models[0].maxTokens, 32768);
  assert.equal(settings.providers.local.cacheRetention, "none");
});

test("capability synchronization is a no-op once metadata is current", () => {
  const settings = {
    providers: {
      local: {
        maxConcurrency: 2,
        reasoning: "medium",
        models: [{
          id: "local-active",
          contextWindow: 131072,
          maxTokens: 16384,
          input: ["text"],
          reasoningEfforts: {
            off: "none",
            minimal: "low",
            low: "low",
            medium: "medium",
            high: "xhigh",
            xhigh: "xhigh",
            max: "xhigh",
          },
        }],
      },
    },
  };
  assert.deepEqual(capabilityOps(settings, "local", "local-active", routerMetadataOf(entry())), []);
});

test("new Nighttime profile is provisioned from an existing 128K runtime provider", () => {
  const settings = {
    providers: {
      "local-ollama": {
        displayName: "Local Router (128K context)",
        api: "openai-responses",
        baseURL: "http://ai-router:11434/v1",
        maxConcurrency: 2,
        reasoning: "medium",
        models: [{
          id: "local-active",
          name: "Local Active Model (128K context)",
          contextWindow: 131072,
          maxTokens: 32768,
          input: ["text", "image"],
        }],
      },
    },
  };
  const ops = provisionProviderOps(settings, "local-everyday", "qwen3.8-27b-abliterated-q6_k");
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0].path, ["providers", "local-everyday"]);
  assert.equal(ops[0].value.displayName, "Nighttime (128K)");
  assert.equal(ops[0].value.baseURL, "http://ai-router:11434/v1");
  assert.equal(ops[0].value.maxConcurrency, 1);
  assert.equal(ops[0].value.reasoning, "medium");
  assert.equal(ops[0].value.models[0].name, "Nighttime (128K)");
  assert.equal(ops[0].value.models[0].contextWindow, 131072);
  assert.equal(settings.providers["local-everyday"], undefined);
});

test("profile provisioning avoids materializing resolved schema defaults", () => {
  const stored = {
    providers: {
      "local-ollama": {
        api: "openai-responses",
        baseURL: "http://ai-router:11434/v1",
        models: [{ id: "local-active", contextWindow: 131072, maxTokens: 32768 }],
      },
    },
  };
  const resolved = structuredClone(stored);
  Object.assign(resolved.providers["local-ollama"], {
    modelOverrides: {},
    headers: {},
    defaultContextWindow: 262144,
    maxRequestImageBytes: 20971520,
  });
  const [operation] = provisionProviderOps(
    resolved,
    "local-everyday",
    "qwen3.8-27b-abliterated-q6_k",
    stored,
  );
  assert.equal(operation.value.contextWindow, undefined);
  assert.equal(operation.value.modelOverrides, undefined);
  assert.equal(operation.value.headers, undefined);
  assert.equal(operation.value.maxRequestImageBytes, undefined);
  assert.equal(operation.value.models[0].contextWindow, 131072);
});

test("resident profiles take labels and capacities from discovery while retaining deliberate effort", () => {
  for (const [provider, model, context, label] of [
    ["local-ollama", "local-active", 131072, "Daytime (128K)"],
    ["local-ollama", "local-active", 147456, "Daytime (144K)"],
    ["local-ollama", "local-active", 163840, "Daytime (160K)"],
    ["local-everyday", "qwen3.8-27b-abliterated-q6_k", 131072, "Nighttime (128K)"],
  ]) {
    const settings = {providers: {[provider]: {displayName: "old", maxConcurrency: 2, reasoning: "off", models: [{id:model,name:"old",contextWindow:262144,maxTokens:32768}]}}};
    const metadata = routerMetadataOf(entry({display_name:label,context_window:context,active_request_limit:1}));
    const ops = capabilityOps(settings, provider, model, metadata);
    assert.deepEqual(ops.map(op => op.path.at(-1)), ["displayName","maxConcurrency","models"]);
    assert.equal(ops[0].value,label);
    assert.equal(ops[1].value,1);
    assert.equal(ops[2].value[0].id,model);
    assert.equal(ops[2].value[0].name,label);
    assert.equal(ops[2].value[0].contextWindow,context);
    assert.equal(settings.providers[provider].reasoning,"off");
  }
});

test("plugin activates without a hard settings injection and synchronizes immediately", async () => {
  const previousFetch = globalThis.fetch;
  const settings = {
    providers: {
      "local-ollama": {
        baseURL: "http://router.example/v1",
        displayName: "Local Ollama (128k)",
        maxConcurrency: 1,
        reasoning: "off",
        models: [{
          id: "local-active",
          name: "Local active model (128k)",
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
  globalThis.fetch = async () => new Response(JSON.stringify({data:[entry()]}), {
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
    assert.deepEqual(ops.map((op) => op.path.at(-1)), ["displayName", "maxConcurrency", "models"]);
    assert.equal(ops[0].value, "Daytime (160K)");
    assert.equal(ops[1].value, 2);
    assert.equal(ops[2].value[0].name, "Daytime (160K)");
    assert.equal(ops[2].value[0].maxTokens, 16384);
  } finally {
    dispose?.();
    globalThis.fetch = previousFetch;
  }
});
