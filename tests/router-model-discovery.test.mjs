import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { capabilitiesDocument, residentModel, unaddressedModel, paired, trio, strata, solo, draining, offlineRow,
  legacySettings, settingsService, DAYTIME_ID, NIGHTTIME_ID, NIGHTTIME_MTP3_ID, TRIAL_ID, UNADDRESSED_ID } from "./fixtures/router-contract.mjs";

const pluginSource = await readFile(new URL("../seed/plugins/dsh-router-model-discovery.js", import.meta.url), "utf8");
const plugin = await import(`data:text/javascript;base64,${Buffer.from(pluginSource).toString("base64")}`);
const {
  RESIDENT_SERVICES, OPT_IN_SERVICES, OPT_IN_PROVIDERS, isOptInService, serviceLabel, resolveProviderList,
  synchronizeRouterSettings, applyOperation,
  residentStatus, residentLabel, residentMessage, residentStateRecord, planResidentProvider,
  dshReasoningEfforts, validateRouterMetadata, routerClientName, routerBaseOf, migrateResidentRoute,
  isBlockingStatus, describeStatus,
} = plugin;

test("resident routes send the stable service IDs only", () => {
  assert.deepEqual(RESIDENT_SERVICES, { "local-ollama": "daytime", "local-everyday": "nighttime", "local-trial": "trial" });
  assert.doesNotMatch(pluginSource, /qwen3\.8|abliterated|mtp3/i, "the plugin hard-codes no canonical model ID");
});

test("the trial is the opt-in route and is labelled for humans", () => {
  assert.deepEqual(OPT_IN_SERVICES, ["trial"]);
  assert.deepEqual(OPT_IN_PROVIDERS, ["local-trial"]);
  assert.equal(isOptInService("trial"), true);
  assert.equal(isOptInService("daytime"), false);
  assert.equal(isOptInService(undefined), false);
  assert.equal(serviceLabel("trial"), "Trial");
  assert.equal(serviceLabel("nighttime"), "Nighttime");
  assert.equal(serviceLabel("unheard-of"), "unheard-of");
});

test("paired: Daytime and Nighttime are available with the serving model's limits", () => {
  const document = paired();
  const day = residentStatus(document, "daytime");
  const night = residentStatus(document, "nighttime");
  assert.equal(day.status, "available");
  assert.equal(night.status, "available");
  assert.equal(day.served, DAYTIME_ID);
  // Admission: input + output + context_safety_reserve <= context_window (§8).
  assert.equal(day.capabilities.contextWindow, 163840 - 1024);
  assert.equal(night.capabilities.contextWindow, 98304 - 1024);
  assert.equal(day.capabilities.maxConcurrency, 1);
  assert.deepEqual(day.capabilities.input, ["text", "image"]);
  assert.deepEqual(night.capabilities.input, ["text"]);
  assert.equal(residentLabel(night), "Qwen3.8 27B Abliterated Q6_K (96K) · NSFW");
  assert.equal(residentLabel(day), "Qwen3.8 27B Q6_K (160K)");
});

test("solo: Nighttime is offline with the configuration ID; Daytime is unaffected", () => {
  const document = solo();
  const night = residentStatus(document, "nighttime");
  assert.equal(night.status, "offline");
  assert.equal(night.configuration, "flash-next-solo-128k");
  assert.equal(night.reason, "exclusive_configuration");
  assert.equal(residentLabel(night), "Nighttime — offline (flash-next-solo-128k)");
  assert.equal(describeStatus(night), "offline (flash-next-solo-128k)");
  assert.match(residentMessage(night), /offline in router configuration "flash-next-solo-128k".*Switch this session to Daytime/);
  assert.equal(isBlockingStatus(night.status), true);
  assert.equal(residentStatus(document, "daytime").status, "available");
  assert.equal(residentStatus(document, "daytime").capabilities.contextWindow, 131072 - 1024);
});

test("one model answering two services is two options, not one option written twice", () => {
  // A solo configuration runs `daytime` and `nighttime` from one set of weights, which is honest:
  // one model, two names. The picker lists a row per service, so a row titled by the model gives the
  // human two rows reading identically — and the deployment's own gate addresses picker rows
  // strictly, so "Qwen3.8 Flash-Next (256K)" twice is not a warning but a failure. The router
  // publishes a title for each name it declares, and that title is what separates the rows.
  const shared = { ...residentModel({ service: "daytime" }), aliases: ["local-active", "daytime", "nighttime"] };
  shared.metadata.aliases = shared.aliases;
  shared.metadata.alias_display_names = { "local-active": "local-active", daytime: "daytime", nighttime: "nighttime" };
  const document = capabilitiesDocument({ models: [shared] });
  const day = residentStatus(document, "daytime");
  const night = residentStatus(document, "nighttime");
  assert.equal(day.status, "available");
  assert.equal(night.status, "available");
  assert.equal(night.served, day.served, "one model behind both names");
  assert.equal(residentLabel(day), "daytime");
  assert.equal(residentLabel(night), "nighttime");
  assert.notEqual(residentLabel(day), residentLabel(night), "a picker lists options a person can tell apart");
  assert.equal(residentStatus(document, "daytime").capabilities.contextWindow,
    residentStatus(document, "nighttime").capabilities.contextWindow, "only the title differs; the limits are the model\'s");
  // A router that publishes no titles for its names is not broken, merely older than the field: the
  // model's title labels both rows exactly as it did before, and nothing else moves.
  delete shared.metadata.alias_display_names;
  assert.equal(residentLabel(residentStatus(document, "nighttime")), "Qwen3.8 27B Q6_K (160K)");
});

test("trio: the opt-in trial is available from its own metadata and text-only", () => {
  const document = trio();
  const trial = residentStatus(document, "trial");
  assert.equal(trial.status, "available");
  assert.equal(trial.served, TRIAL_ID);
  assert.equal(trial.capabilities.contextWindow, 163840 - 1024);
  assert.equal(trial.capabilities.maxConcurrency, 1);
  assert.deepEqual(trial.capabilities.input, ["text"]);
  // The picker label is the router's own display name, never a canonical ID.
  assert.equal(residentLabel(trial), "Qwen3.8 Flash-Next (Strata trial) (160K)");
  assert.equal(residentStateRecord(trial).label, "Qwen3.8 Flash-Next (Strata trial) (160K)");
  assert.equal(isBlockingStatus(trial.status), false);
  // A third service being served changes nothing about the permanent residents.
  assert.equal(residentStatus(document, "daytime").status, "available");
  assert.equal(residentStatus(document, "nighttime").status, "available");
});

test("an absent trial service is recorded as its own unavailable state", () => {
  const document = paired();
  const trial = residentStatus(document, "trial");
  assert.equal(trial.status, "unavailable");
  assert.equal(trial.reason, "not offered by the router");
  assert.equal(residentLabel(trial), "Trial — unavailable");
  assert.equal(isBlockingStatus(trial.status), true);
  assert.match(residentMessage(trial), /opt-in model/);
  assert.match(residentMessage(trial), /never selects it and never moves a session off it/);
  assert.match(residentMessage(trial), /does not offer it/);
  // The permanent residents keep their own states and advice.
  assert.equal(residentStatus(document, "daytime").status, "available");
  assert.equal(residentStatus(document, "nighttime").status, "available");
  assert.equal(residentMessage(residentStatus(document, "nighttime")), "Nighttime is available.");
});

test("a trial stopped by the active configuration is offline with that configuration ID", () => {
  const document = capabilitiesDocument({
    models: [residentModel()],
    offline: [offlineRow("nighttime"), offlineRow("trial")],
    configuration: { id: "flash-next-solo-160k", exclusive: true },
  });
  const trial = residentStatus(document, "trial");
  assert.equal(trial.status, "offline");
  assert.equal(trial.configuration, "flash-next-solo-160k");
  assert.equal(residentLabel(trial), "Trial — offline (flash-next-solo-160k)");
  assert.equal(describeStatus(trial), "offline (flash-next-solo-160k)");
  assert.equal(residentStatus(document, "daytime").status, "available");
  assert.equal(residentStatus(document, "nighttime").status, "offline");
});

test("a served row that does not name the trial service is never addressed through it", () => {
  const document = capabilitiesDocument({
    models: [residentModel(), residentModel({ service: "unaddressed-experiment", id: UNADDRESSED_ID, aliases: [],
      displayName: "Uncatalogued experiment" })],
  });
  const state = residentStatus(document, "trial");
  assert.equal(state.status, "unavailable");
  assert.equal(state.served, undefined);
  assert.equal(state.reason, "not offered by the router");
  // Planning must not point the route at the unaddressed canonical model, and
  // must not borrow Daytime's limits or image modality for the opt-in route.
  const escape = pattern => pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const route = planResidentProvider({ name: "local-trial", state, stored: null, resolved: null,
    daytime: { apiKeyEnv: "FIXTURE_KEY", baseURL: "http://router.invalid/v1", maxConcurrency: 3,
      models: [{ id: "daytime", name: "Daytime (128K)", contextWindow: 130048, input: ["text", "image"] }] } });
  assert.deepEqual(route.models.map(model => model.id), ["trial"]);
  assert.equal(route.models[0].contextWindow, undefined);
  assert.equal(route.models[0].input, undefined);
  assert.equal(route.residentUnavailable, true);
  assert.doesNotMatch(JSON.stringify(route), new RegExp(escape(UNADDRESSED_ID)));
});

test("a configuration serving only the trial leaves the permanent residents unusable, never silently switched", () => {
  const document = strata();
  assert.equal(residentStatus(document, "trial").status, "available");
  assert.equal(residentStatus(document, "daytime").status, "unavailable");
  assert.equal(residentStatus(document, "daytime").reason, "not offered by the router");
  assert.equal(residentStatus(document, "nighttime").status, "offline");
});

test("Nighttime unhealthy or incomplete is recorded on its own and never blocks Daytime", () => {
  const unhealthy = paired({ models: [residentModel(), residentModel({ service: "nighttime", available: false })] });
  assert.equal(residentStatus(unhealthy, "nighttime").status, "unavailable");
  assert.equal(residentStatus(unhealthy, "nighttime").reason, "backend unavailable");
  assert.equal(residentLabel(residentStatus(unhealthy, "nighttime")), "Nighttime — unavailable");
  assert.equal(residentStatus(unhealthy, "daytime").status, "available");
  for (const damage of [
    meta => { meta.warnings = ["BACKEND_SLOT_COUNT_MISMATCH"]; },
    meta => { meta.complete = false; },
    meta => { meta.schema_version = 3; },
    meta => { meta.reasoning.default = "unsupported"; },
    meta => { meta.context_safety_reserve = -1; },
    meta => { meta.capabilities = ["completion"]; },
  ]) {
    const night = residentModel({ service: "nighttime" });
    damage(night.metadata);
    const document = paired({ models: [residentModel(), night] });
    const state = residentStatus(document, "nighttime");
    assert.equal(state.status, "incomplete", state.reason);
    assert.equal(residentLabel(state), "Nighttime — incomplete metadata");
    assert.equal(residentStatus(document, "daytime").status, "available");
  }
  const warned = residentModel({ service: "nighttime" });
  warned.metadata.warnings = ["BACKEND_VISION_MISMATCH"];
  assert.match(residentStatus(paired({ models: [residentModel(), warned] }), "nighttime").reason, /BACKEND_VISION_MISMATCH/);
  const mismatch = residentModel({ service: "nighttime" });
  mismatch.slots = 2;
  assert.equal(residentStatus(paired({ models: [residentModel(), mismatch] }), "nighttime").status, "incomplete");
});

test("draining or maintenance: every model waits, none is blocked, nothing falls back", () => {
  for (const document of [draining(), capabilitiesDocument({ accepting: false, draining: false, maintenance: true }), draining(solo())]) {
    for (const service of ["daytime", "nighttime", "trial"]) {
      const state = residentStatus(document, service);
      assert.equal(state.status, "switching", service);
      assert.equal(isBlockingStatus(state.status), false);
      assert.match(residentLabel(state), /router switching configuration$/);
    }
  }
  assert.equal(residentStatus(capabilitiesDocument({ accepting: false, draining: false, maintenance: true }), "daytime").reason, "maintenance");
});

test("router unreachable: every resident model is unavailable with a recoverable message", () => {
  for (const service of ["daytime", "nighttime", "trial"]) {
    const state = residentStatus(null, service);
    assert.equal(state.status, "unavailable");
    assert.equal(state.reason, "router unreachable");
    assert.match(residentMessage(state), /router is unreachable/);
  }
});

test("an existing deployment gains the opt-in route without a settings edit", () => {
  assert.deepEqual(resolveProviderList(undefined), ["local-ollama", "local-everyday", "local-trial"]);
  assert.deepEqual(resolveProviderList([]), ["local-ollama", "local-everyday", "local-trial"]);
  // The pre-trial list is upgraded in memory; the deployment keeps working as-is.
  assert.deepEqual(resolveProviderList(["local-ollama", "local-everyday"]), ["local-ollama", "local-everyday", "local-trial"]);
  // A deliberate subset, or a list that already names the trial, is obeyed exactly.
  assert.deepEqual(resolveProviderList(["local-ollama"]), ["local-ollama"]);
  assert.deepEqual(resolveProviderList(["local-trial"]), ["local-trial"]);
  assert.deepEqual(resolveProviderList(["local-ollama", "local-trial"]), ["local-ollama", "local-trial"]);
  assert.deepEqual(resolveProviderList(["local-ollama", "local-everyday", "local-trial"]), ["local-ollama", "local-everyday", "local-trial"]);
  // An unrelated provider is never managed, and nothing selects the trial by itself.
  assert.deepEqual(resolveProviderList(["local-ollama", "custom"]), ["local-ollama"]);
});

test("a disappeared ID without an offline entry, an invalid document, and an ambiguous service", () => {
  assert.equal(residentStatus(paired({ models: [residentModel()] }), "nighttime").reason, "not offered by the router");
  assert.equal(residentStatus({ object: "router.capabilities" }, "daytime").status, "incomplete");
  const twice = paired({ models: [residentModel(), residentModel({ id: "other", service: "daytime" })] });
  assert.equal(residentStatus(twice, "daytime").status, "incomplete");
});

test("a model the catalog gives no service ID is never offered, addressed, or persisted (1.2 §3, §4)", async () => {
  const orphan = unaddressedModel();
  assert.equal(orphan.service, orphan.id, "such a row is named by its canonical ID because the router will not invent one");
  assert.deepEqual(orphan.aliases, []);
  const document = trio({ models: [...trio().models, orphan] });
  for (const service of ["daytime", "nighttime", "trial"]) {
    const state = residentStatus(document, service);
    assert.equal(state.status, "available", service);
    assert.notEqual(state.served, UNADDRESSED_ID, service);
  }
  // The picker offers the three residents whatever the catalog also publishes:
  // a row nobody addressed cannot appear, cannot be planned into a route, and is
  // never written to settings.
  const state = structuredClone(legacySettings("http://router.invalid/v1"));
  const { errors } = await synchronizeRouterSettings(settingsService(state, [], applyOperation), { document });
  assert.deepEqual(errors.map(error => [error.provider, error.error.message]), []);
  assert.deepEqual(Object.keys(state["llm-pi-ai"].providers).sort(), ["custom", "local-everyday", "local-ollama", "local-trial"]);
  assert.equal(JSON.stringify(state).includes(UNADDRESSED_ID), false, "settings record a model nobody may send");
  assert.equal(state["agent-default-model"].model, "daytime");
});

test("CATALOG_HAS_NO_SERVICE_ID holds every resident and is never a Harness failure (1.2 §4)", async () => {
  const document = capabilitiesDocument({
    models: [unaddressedModel(), unaddressedModel({ id: "fixture-strata-preview-uncatalogued", displayName: "Strata preview (uncatalogued)" })],
    complete: false, warnings: ["CATALOG_HAS_NO_SERVICE_ID"],
  });
  for (const service of ["daytime", "nighttime", "trial"]) {
    const state = residentStatus(document, service);
    assert.equal(state.status, "unavailable", service);
    assert.equal(state.reason, "not offered by the router", service);
    assert.equal(state.served, undefined, service);
    // Never another name, and never the router's default model either.
    assert.doesNotMatch(JSON.stringify(residentStateRecord(state)), /fixture-|strata/i, service);
  }
  const state = structuredClone(legacySettings("http://router.invalid/v1"));
  const { errors } = await synchronizeRouterSettings(settingsService(state, [], applyOperation), { document });
  assert.deepEqual(errors.map(error => [error.provider, error.error.message]), [],
    "a router that publishes nothing addressable is not a failed update");
  for (const name of ["local-ollama", "local-everyday", "local-trial"]) {
    const provider = state["llm-pi-ai"].providers[name];
    assert.equal(provider.residentUnavailable, true, name);
    assert.equal(provider.residentState.reason, "not offered by the router", name);
  }
  assert.notEqual(state["agent-default-model"].provider, "local-trial");
});

test("MODEL_HAS_NO_SERVICE_ID reaches a resident as its own recorded reason, not as a note (1.2 §4)", () => {
  const row = residentModel({ service: "nighttime" });
  row.metadata.warnings = ["MODEL_HAS_NO_SERVICE_ID"];
  row.metadata.complete = false;
  const document = paired({ models: [residentModel(), row] });
  const state = residentStatus(document, "nighttime");
  assert.equal(state.status, "incomplete");
  assert.match(state.reason, /MODEL_HAS_NO_SERVICE_ID/);
  assert.equal(residentLabel(state), "Nighttime — incomplete metadata");
  // The warning is carried verbatim in the recorded reason; no new field is
  // invented for it, so there is no second channel for router advice.
  const record = residentStateRecord(state);
  assert.deepEqual(Object.keys(record).sort(),
    ["configuration", "label", "limits", "message", "nsfw", "reason", "service", "status"]);
  assert.match(record.message, /MODEL_HAS_NO_SERVICE_ID/);
  assert.equal(residentStatus(document, "daytime").status, "available", "the other resident is judged on its own row");
});

test("every resident request names its model; none relies on the router's default (1.2 §3)", async () => {
  // An omitted `model` is answered by the default of the active configuration,
  // which 1.2 does not promise is `daytime` — while the trial configuration is
  // selected it is the trial. Harness therefore always sends an ID, so the case
  // never arises: exactly one model row per resident route, named by its service ID.
  for (const document of [paired(), trio(), strata(), solo(), draining(), null]) {
    const state = structuredClone(legacySettings("http://router.invalid/v1"));
    await synchronizeRouterSettings(settingsService(state, [], applyOperation), { document });
    for (const [name, service] of Object.entries(RESIDENT_SERVICES)) {
      const models = state["llm-pi-ai"].providers[name].models;
      assert.deepEqual(models.map(model => model.id), [service], `${name} with ${document?.configuration?.id ?? "no router"}`);
      assert.ok(models[0].id.length > 0, `${name} configures an empty model ID`);
    }
  }
});

test("a new canonical ID behind nighttime (MTP3) stays available; the ID is information only", () => {
  const before = residentStatus(paired(), "nighttime");
  const after = residentStatus(paired({ models: [residentModel(), residentModel({ service: "nighttime", id: NIGHTTIME_MTP3_ID })] }), "nighttime");
  assert.equal(before.status, "available");
  assert.equal(after.status, "available");
  assert.equal(before.served, NIGHTTIME_ID);
  assert.equal(after.served, NIGHTTIME_MTP3_ID);
  const record = JSON.stringify(residentStateRecord(after));
  assert.doesNotMatch(record, /fixture-/);
});

test("limits are recomputed from the serving model after a context change", () => {
  const first = residentStatus(paired({ models: [residentModel(), residentModel({ service: "nighttime", contextWindow: 131072 })] }), "nighttime");
  const second = residentStatus(paired({ models: [residentModel(), residentModel({ service: "nighttime", contextWindow: 98304, slots: 2 })] }), "nighttime");
  const stored = { api: "openai-responses", baseURL: "http://router/v1", reasoning: "medium", models: [{ id: "nighttime", name: "old", custom: "kept" }] };
  const one = planResidentProvider({ name: "local-everyday", state: first, stored, clientName: "deepseek-harness/test" });
  const two = planResidentProvider({ name: "local-everyday", state: second, stored: one, clientName: "deepseek-harness/test" });
  assert.equal(one.models[0].contextWindow, 131072 - 1024);
  assert.equal(two.models[0].contextWindow, 98304 - 1024);
  assert.equal(one.maxConcurrency, 1);
  assert.equal(two.maxConcurrency, 2);
  assert.equal(two.models[0].custom, "kept");
  assert.equal(two.residentState.limits, "current");
});

test("while a model is unavailable its last limits are kept and marked stale", () => {
  const available = planResidentProvider({ name: "local-everyday", state: residentStatus(paired(), "nighttime"),
    stored: { baseURL: "http://router/v1", models: [{ id: "nighttime" }] }, clientName: "deepseek-harness/test" });
  const offline = planResidentProvider({ name: "local-everyday", state: residentStatus(solo(), "nighttime"), stored: available, clientName: "deepseek-harness/test" });
  assert.equal(offline.models[0].contextWindow, available.models[0].contextWindow);
  assert.deepEqual(offline.models[0].reasoningEfforts, available.models[0].reasoningEfforts);
  assert.equal(offline.residentUnavailable, true);
  assert.equal(offline.residentState.limits, "stale");
  assert.equal(offline.residentState.status, "offline");
  const switching = planResidentProvider({ name: "local-everyday", state: residentStatus(draining(), "nighttime"), stored: available, clientName: "deepseek-harness/test" });
  assert.equal(switching.residentUnavailable, false, "a draining router makes requests wait rather than fail");
  assert.equal(switching.residentState.limits, "stale");
});

test("a route with no model behind it is named after itself, not after a remembered model", () => {
  const storedRoute = { baseURL: "http://router/v1", models: [{ id: "trial" }] };
  const offered = capabilitiesDocument({ models: [residentModel(), residentModel({ service: "trial" })] });
  const stored = planResidentProvider({ name: "local-trial", state: residentStatus(offered, "trial"),
    stored: storedRoute, clientName: "deepseek-harness/test" });
  assert.equal(stored.displayName, "Qwen3.8 Flash-Next (Strata trial) (160K)", "while it is offered the route is named by its model");
  assert.equal(stored.models[0].name, "Qwen3.8 Flash-Next (Strata trial) (160K)");

  // A configuration that drops the alias leaves no model, alias and offline entry for
  // it. The remembered title describes a model this router no longer offers, so a
  // picker section headed by it reads as a model on offer.
  const dropped = capabilitiesDocument({ models: [residentModel()], configuration: { id: "solo-no-trial", exclusive: true } });
  const state = residentStatus(dropped, "trial");
  assert.equal(state.status, "unavailable");
  assert.equal(state.reason, "not offered by the router");
  const gone = planResidentProvider({ name: "local-trial", state, stored, clientName: "deepseek-harness/test" });
  assert.equal(gone.displayName, "Trial", "the header names the route, not a model the router does not offer");
  assert.equal(gone.models[0].name, "Trial");
  assert.equal(gone.residentState.label, "Trial — unavailable");
  assert.equal(gone.residentState.limits, "stale", "its last limits are still kept, marked stale");
  assert.match(gone.residentState.message, /current configuration does not offer it/);

  // Offline names no model either. A draining router still attributes one, and keeps
  // the title it belongs to.
  const known = { baseURL: "http://router/v1", displayName: "Qwen3.8 27B Abliterated Q6_K (96K)",
    models: [{ id: "nighttime", name: "Qwen3.8 27B Abliterated Q6_K (96K)" }] };
  const offline = planResidentProvider({ name: "local-everyday", state: residentStatus(solo(), "nighttime"),
    stored: known, clientName: "deepseek-harness/test" });
  assert.equal(offline.displayName, "Nighttime");
  assert.equal(residentStatus(draining(), "nighttime").served, NIGHTTIME_ID);
  const switching = planResidentProvider({ name: "local-everyday", state: residentStatus(draining(), "nighttime"),
    stored: known, clientName: "deepseek-harness/test" });
  assert.equal(switching.displayName, "Qwen3.8 27B Abliterated Q6_K (96K)", "the model behind a draining route is known");

  // The title returns with the model, without anything else about the route being lost.
  const back = planResidentProvider({ name: "local-trial", state: residentStatus(offered, "trial"),
    stored: gone, clientName: "deepseek-harness/test" });
  assert.equal(back.displayName, "Qwen3.8 Flash-Next (Strata trial) (160K)");
  assert.equal(back.models[0].name, "Qwen3.8 Flash-Next (Strata trial) (160K)");
  assert.equal(back.models[0].contextWindow, 163840 - 1024);
});

test("planning migrates old IDs, preserves preferences and identifies the client", () => {
  const stored = { api: "openai-responses", apiKeyEnv: "KEEP", baseURL: "http://router/v1", reasoning: "low",
    headers: { "x-client-name": "stale", Other: "kept" }, retryPolicy: { mode: "normal", maxRetries: 2 },
    models: [{ id: "qwen3.8-27b-abliterated-q6_k", name: "Nighttime (128K)", custom: "kept" }] };
  const next = planResidentProvider({ name: "local-everyday", state: residentStatus(paired(), "nighttime"), stored, clientName: "deepseek-harness/host-7" });
  assert.deepEqual(next.models.map(row => row.id), ["nighttime"]);
  assert.equal(next.models[0].custom, "kept");
  assert.equal(next.apiKeyEnv, "KEEP");
  assert.equal(next.reasoning, "low");
  assert.deepEqual(next.retryPolicy, stored.retryPolicy);
  assert.deepEqual(next.headers, { Other: "kept", "X-Client-Name": "deepseek-harness/host-7" });
  assert.doesNotMatch(JSON.stringify(next), /qwen3\.8|fixture-/);
  const provisioned = planResidentProvider({ name: "local-everyday", state: residentStatus(solo(), "nighttime"),
    daytime: { baseURL: "http://router/v1", apiKeyEnv: "KEEP", reasoning: "medium", models: [{ id: "daytime", contextWindow: 163840 }] },
    clientName: "deepseek-harness/host-7" });
  assert.deepEqual(provisioned.models, [{ id: "nighttime", name: "Nighttime" }], "a new Nighttime route inherits no Daytime limits");
  assert.equal(provisioned.residentUnavailable, true);
});

test("old session and default routes migrate to service IDs", () => {
  assert.deepEqual(migrateResidentRoute({ provider: "local-ollama", model: "local-active", reasoningEffort: "high" }),
    { provider: "local-ollama", model: "daytime", reasoningEffort: "high" });
  assert.deepEqual(migrateResidentRoute({ provider: "local-everyday", model: "qwen3.8-27b-abliterated-q6_k" }),
    { provider: "local-everyday", model: "nighttime" });
  const external = { provider: "amazon-bedrock", model: "anthropic.fixture" };
  assert.equal(migrateResidentRoute(external), external);
  const current = { provider: "local-ollama", model: "daytime" };
  assert.equal(migrateResidentRoute(current), current);
});

test("no migration case ever makes the opt-in route the default", async () => {
  const resident = (id, name, input) => ({ api: "openai-responses", apiKeyEnv: "KEEP", baseURL: "http://router.invalid/v1",
    reasoning: "medium", models: [{ id, name, contextWindow: 130048, maxTokens: null, input }] });
  const settings = selection => ({
    "agent-default-model": selection,
    "llm-pi-ai": { providers: {
      "local-ollama": resident("daytime", "Daytime (128K)", ["text", "image"]),
      "local-everyday": resident("nighttime", "Nighttime (128K)", ["text"]),
      "local-trial": resident("trial", "Trial (128K)", ["text"]),
    } },
  });
  const cases = [
    { label: "fresh install", state: settings({ provider: "local-ollama", model: "daytime", reasoningEffort: "medium" }), document: trio() },
    { label: "the router does not offer the trial", state: settings({ provider: "local-ollama", model: "daytime" }), document: paired() },
    { label: "only the trial serves, and the default sits on Daytime", state: settings({ provider: "local-ollama", model: "daytime" }), document: strata() },
    { label: "the default sits on a stopped Nighttime", state: settings({ provider: "local-everyday", model: "nighttime" }), document: solo() },
    { label: "the router is unreachable", state: settings({ provider: "local-everyday", model: "nighttime" }), document: null },
    { label: "settings written before service IDs existed", state: legacySettings("http://router.invalid/v1"), document: trio() },
  ];
  for (const testCase of cases) {
    const state = structuredClone(testCase.state);
    const { errors } = await synchronizeRouterSettings(settingsService(state, [], applyOperation), { document: testCase.document });
    assert.deepEqual(errors.map(error => [error.provider, error.error.message]), [], testCase.label);
    const selection = state["agent-default-model"];
    assert.notEqual(selection.provider, "local-trial", `${testCase.label}: the default moved onto the opt-in route`);
    assert.notEqual(selection.model, "trial", `${testCase.label}: the default moved onto the opt-in model`);
    // The route still exists and states why it cannot serve — held, never unknown.
    const trial = state["llm-pi-ai"].providers["local-trial"];
    assert.equal(trial.models[0].id, "trial", testCase.label);
    assert.equal(["available", "offline", "unavailable", "incomplete"].includes(trial.residentState.status), true, testCase.label);
    assert.equal(trial.residentUnavailable, trial.residentState.status !== "available", testCase.label);
    assert.equal(trial.residentState.service, "trial", testCase.label);
  }
});

test("X-Client-Name: deepseek-harness/<instance> from setting, environment, then hostname", () => {
  assert.equal(routerClientName({ instance: "192.168.1.7", env: {} }), "deepseek-harness/192.168.1.7");
  assert.equal(routerClientName({ env: { HARNESS_CLIENT_INSTANCE: "lab box" } }), "deepseek-harness/lab-box");
  assert.match(routerClientName({ env: {} }), /^deepseek-harness\/[A-Za-z0-9._:@-]+$/);
  assert.equal(routerBaseOf("http://ai-router:11434/v1/"), "http://ai-router:11434");
  assert.throws(() => routerBaseOf("http://user:secret@router/v1"), /without embedded credentials/);
});

test("router reasoning vocabulary maps to Harness selector levels", () => {
  const metadata = validateRouterMetadata(residentModel().metadata);
  assert.deepEqual(dshReasoningEfforts(metadata.reasoning), {
    off: "none", minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: "xhigh",
  });
  const none = residentModel().metadata;
  Object.assign(none, { capabilities: ["completion", "tools", "vision"] });
  none.reasoning = { ...none.reasoning, supported: false, efforts: {}, aliases: {}, per_effort: {} };
  assert.equal(dshReasoningEfforts(validateRouterMetadata(none).reasoning), false);
  const bounded = residentModel({ unrestricted: false }).metadata;
  assert.equal(validateRouterMetadata(bounded).max_output_tokens, 8192);
  bounded.reasoning.per_effort.medium.default_output_tokens = 9000;
  assert.throws(() => validateRouterMetadata(bounded), /invalid limits/);
});

test("the plugin registers the session-route waterfall and owns its timers", async () => {
  const listeners = [];
  let dispose;
  const settings = { describe: () => [{ ns: "llm-pi-ai", value: { providers: {} }, user: { providers: {} } }], mutate: async () => {} };
  plugin.apply({
    on: (name, listener, options) => listeners.push({ name, listener, options }),
    inject: (services, callback) => {
      assert.deepEqual(services, ["settings"]);
      callback({ settings, logger: { info() {}, warn() {} }, effect: (callback) => { dispose = callback(); } });
    },
  }, { providers: ["local-ollama", "local-everyday"], pollIntervalMs: 60_000 });
  try {
    assert.equal(listeners[0].name, "agent/request");
    assert.equal(listeners[0].options.prepend, true);
    assert.deepEqual(await listeners[0].listener({}, async () => ({ provider: "local-everyday", model: "qwen3.8-27b-abliterated-q6_k" })),
      { provider: "local-everyday", model: "nighttime" });
    assert.equal(typeof globalThis[Symbol.for("dsh-container.router-contract.v1")]?.report, "function");
  } finally { dispose?.(); }
  assert.equal(globalThis[Symbol.for("dsh-container.router-contract.v1")], undefined);
});
