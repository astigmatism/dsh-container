import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { capabilitiesDocument, residentModel, unaddressedModel, paired, trio, strata, solo, draining, offlineRow,
  legacySettings, settingsService, DAYTIME_ID, NIGHTTIME_ID, NIGHTTIME_MTP3_ID, TRIAL_ID, UNADDRESSED_ID } from "./fixtures/router-contract.mjs";

const pluginSource = await readFile(new URL("../seed/plugins/dsh-router-model-discovery.js", import.meta.url), "utf8");
const plugin = await import(`data:text/javascript;base64,${Buffer.from(pluginSource).toString("base64")}`);
const {
  ROUTER_PROVIDER, RETIRED_ROUTES, OPT_IN_SERVICES, isOptInService, resolveProviderList,
  synchronizeRouterSettings, applyOperation, routerServices, routerRouteState, validateRouterMetadata,
  residentStatus, residentLabel, residentMessage, residentStateRecord, planRouterProvider,
  dshReasoningEfforts, routerClientName, routerBaseOf, routerName, migrateResidentRoute,
  isBlockingStatus, describeStatus,
} = plugin;

/** The catalog of one document as a route carries it: names, labels and states. */
const catalogOf = (document, options) => routerServices(document, options);
const row = (catalog, service) => catalog.services.find(entry => entry.service === service);
/** One route plan for a catalog, on a route holding nothing a person has set. */
const planOf = (document, { known = [], stored = { baseURL: "http://router.invalid/v1", models: [] }, name = ROUTER_PROVIDER } = {}) =>
  planRouterProvider({ name, catalog: routerServices(document, { known }), stored, clientName: "deepseek-harness/test" });

/** The reserved compatibility alias of §3: a marker, never a service to choose. */
const RESERVED = "local-active";
/** The model IDs a settings tree written before a router's catalog drove the
 * model list carries rows for (see `legacySettings`). Such a name keeps its row,
 * with the state the current document gives it, when the router stops publishing
 * it — §5 asks for a stated failure rather than a model vanishing. */
const RECORDED_NAMES = ["local-active", "qwen3.8-27b-abliterated-q6_k"];
/** §3: the reserved alias is not a service, so a router that answers and does not
 * publish it takes the row away rather than keeping a name no model is behind. */
const KEPT_NAMES = ["qwen3.8-27b-abliterated-q6_k"];

test("one provider route carries the catalog the router publishes", () => {
  assert.equal(ROUTER_PROVIDER, "local-ollama");
  // Routes written by the releases that kept one route per service exist only to
  // rewrite a persisted selection onto the catalog route. The catalog route is
  // not one of them: it survived and serves several models now.
  assert.deepEqual(RETIRED_ROUTES, { "local-everyday": "nighttime", "local-trial": "trial" });
  // The fixed per-service vocabulary is gone: no service list, no written labels.
  assert.equal(plugin.RESIDENT_SERVICES, undefined);
  assert.equal(plugin.SERVICE_LABELS, undefined);
  assert.equal(plugin.serviceLabel, undefined);
  assert.equal(plugin.OPT_IN_PROVIDERS, undefined);
  assert.equal(plugin.planResidentProvider, undefined);
  assert.doesNotMatch(pluginSource, /qwen3\.8|abliterated|mtp3/i, "the plugin hard-codes no canonical model ID");
  assert.doesNotMatch(pluginSource, /SERVICE_LABELS|serviceLabel\(/, "Harness keeps no fixed model names of its own");
});

test("a provider list written for one-route-per-service releases names one catalog route", () => {
  // Every retired route carried the same router base URL, so such a list is read
  // as the single catalog route those releases pointed at; the catalog route is
  // always managed, and a deployment that names a second route gets it too.
  assert.deepEqual(resolveProviderList(undefined), [ROUTER_PROVIDER]);
  assert.deepEqual(resolveProviderList([]), [ROUTER_PROVIDER]);
  assert.deepEqual(resolveProviderList(["local-ollama", "local-everyday"]), [ROUTER_PROVIDER]);
  assert.deepEqual(resolveProviderList([ROUTER_PROVIDER, "local-everyday", "local-trial"]), [ROUTER_PROVIDER]);
  assert.deepEqual(resolveProviderList(["local-everyday", "custom"]), [ROUTER_PROVIDER, "custom"]);
  assert.deepEqual(resolveProviderList(["router-a", "router-b", "router-a"]), [ROUTER_PROVIDER, "router-a", "router-b"]);
  // A name that is not a router route is never dropped from the list, and junk is.
  assert.deepEqual(resolveProviderList(["local-ollama", "", 7, "custom"]), [ROUTER_PROVIDER, "custom"]);
});

test("opt-in is configuration the contract names, and its advice names no other model", () => {
  assert.deepEqual(OPT_IN_SERVICES, ["trial"]);
  assert.equal(isOptInService("trial"), true);
  assert.equal(isOptInService("daytime"), false);
  assert.equal(isOptInService(undefined), false);
  // The list is a setting, so a future opt-in name is a settings edit.
  assert.equal(isOptInService("trial", ["beta"]), false);
  assert.equal(isOptInService("beta", ["beta"]), true);
  assert.equal(isOptInService("beta", "not-a-list"), false);
  const document = capabilitiesDocument({ models: [residentModel(), residentModel({ service: "beta", aliases: ["beta"] })] });
  const catalog = catalogOf(document);
  assert.equal(row(catalog, "beta").optIn, false, "an ordinary name is opt-in only where the settings list says so");
  assert.equal(row(catalogOf(document, { optInServices: ["beta"] }), "beta").optIn, true);
  // Nothing in the advice points a session at another model: it stays or fails.
  const stuck = row(catalogOf(solo(), { known: ["trial"] }), "trial");
  assert.equal(residentMessage(stuck, { optInServices: ["trial"] }).includes("Daytime"), false);
  assert.match(residentMessage(stuck), /opt-in model/);
  assert.match(residentMessage(stuck), /never moves a session off it/);
  assert.match(residentMessage(row(catalogOf(solo(), { known: ["nighttime"] }), "nighttime")),
    /Select another model, or retry when .* returns; Harness reconnects automatically\./);
});

test("paired: the two services the router publishes are offered with the serving model's limits", () => {
  const document = paired();
  const catalog = catalogOf(document);
  assert.deepEqual(catalog.services.map(entry => entry.service), ["daytime", "nighttime"], "one row per published name, in published order");
  assert.equal(catalog.configuration, "qwen27b-q6k-with-nighttime");
  const day = row(catalog, "daytime");
  const night = row(catalog, "nighttime");
  assert.equal(day.status, "available");
  assert.equal(night.status, "available");
  assert.equal(day.served, DAYTIME_ID);
  // Admission: input + output + context_safety_reserve <= context_window (§8).
  assert.equal(day.capabilities.contextWindow, 163840 - 1024);
  assert.equal(night.capabilities.contextWindow, 98304 - 1024);
  assert.equal(day.capabilities.maxConcurrency, 1);
  assert.deepEqual(day.capabilities.input, ["text", "image"]);
  assert.deepEqual(night.capabilities.input, ["text"]);
  // The picker label is what the publisher published, never a canonical ID.
  assert.equal(residentLabel(day), "Qwen3.8 27B Q6_K (160K)");
  assert.equal(residentLabel(night), "Qwen3.8 27B Abliterated Q6_K (96K) · NSFW", "a row the document marks nsfw says so");
  assert.deepEqual(catalog.route, { status: "available", reason: null, configuration: "qwen27b-q6k-with-nighttime" });
});

test("solo: Nighttime is offline with the configuration ID; Daytime is unaffected", () => {
  const document = solo();
  const night = row(catalogOf(document), "nighttime");
  assert.equal(night.status, "offline");
  assert.equal(night.configuration, "flash-next-solo-128k");
  assert.equal(night.reason, "exclusive_configuration");
  // The row reads the display name the router published for the stopped service.
  assert.equal(residentLabel(night), "Qwen3.8 27B Abliterated Q6_K (96K) — offline (flash-next-solo-128k)");
  assert.equal(describeStatus(night), "offline (flash-next-solo-128k)");
  // The advice is generic: it names no other model, because no other model owns it.
  assert.match(residentMessage(night), /offline in router configuration "flash-next-solo-128k".*Select another model, or retry when/);
  assert.equal(isBlockingStatus(night.status), true);
  assert.equal(row(catalogOf(document), "daytime").status, "available");
  assert.equal(row(catalogOf(document), "daytime").capabilities.contextWindow, 131072 - 1024);
});

test("one model answering two service names is two rows a person can tell apart", () => {
  // A configuration runs `daytime` and `nighttime` from one set of weights, which
  // is honest: one model, two names. The catalog lists a row per name, so two rows
  // titled identically are not a warning but a failure — a picker cannot offer two
  // options a person cannot tell apart. Where the publisher titles each name, that
  // title is used verbatim; where it titles nothing, the name a person is choosing
  // is appended, the same way the router qualifies a label it could not pick out of
  // its own list.
  const shared = (aliasTitles) => residentModel({ service: "daytime", contextWindow: 262144,
    displayName: "Qwen3.8 Flash-Next (256K)", aliases: ["local-active", "daytime", "nighttime"], aliasTitles });
  const titled = capabilitiesDocument({ models: [shared({ daytime: "Qwen3.8 Flash-Next (256K) Daytime",
    nighttime: "Qwen3.8 Flash-Next (256K) Nighttime" })] });
  const catalog = catalogOf(titled);
  const day = row(catalog, "daytime");
  const night = row(catalog, "nighttime");
  assert.equal(day.status, "available");
  assert.equal(night.status, "available");
  assert.equal(night.served, day.served, "one model behind both names");
  assert.equal(residentLabel(day), "Qwen3.8 Flash-Next (256K) Daytime", "a declared title is used verbatim");
  assert.equal(residentLabel(night), "Qwen3.8 Flash-Next (256K) Nighttime");
  assert.notEqual(residentLabel(day), residentLabel(night), "a picker lists options a person can tell apart");
  assert.equal(night.capabilities.contextWindow, day.capabilities.contextWindow, "only the title differs; the limits are the model's");
  assert.equal(night.capabilities.maxConcurrency, day.capabilities.maxConcurrency);
  assert.deepEqual(night.aliases, day.aliases, "both names are on offer from the same row");
  // A router that publishes no titles for its names is not broken, merely older
  // than the field: the model's title plus the chosen name labels both rows.
  const untitled = catalogOf(capabilitiesDocument({ models: [shared()] }));
  assert.equal(residentLabel(row(untitled, "daytime")), "Qwen3.8 Flash-Next (256K) (daytime)");
  assert.equal(residentLabel(row(untitled, "nighttime")), "Qwen3.8 Flash-Next (256K) (nighttime)");
  assert.equal(row(untitled, "nighttime").capabilities.contextWindow, 262144 - 1024);
  // Titles are compared the way a renderer reads them, so a collision is caught
  // however the publisher spelled or spaced it, and both rows are separated.
  const doubled = catalogOf(capabilitiesDocument({ models: [shared({ daytime: "Flash-Next Daytime",
    nighttime: " flash-next  daytime " })] }));
  assert.equal(residentLabel(row(doubled, "daytime")), "Flash-Next Daytime (daytime)");
  assert.equal(residentLabel(row(doubled, "nighttime")), " flash-next  daytime  (nighttime)");
  // A title only one name carries is no collision, and stays untouched.
  const qualified = catalogOf(capabilitiesDocument({ models: [residentModel({ displayNameQualified: "Qwen3.8 27B Q6_K (160K) · vision" })] }));
  assert.equal(residentLabel(row(qualified, "daytime")), "Qwen3.8 27B Q6_K (160K) · vision", "the qualified label a picker renders wins over the plain one");
});

test("a title that reads exactly like the name is no title", () => {
  // A publisher may title a name with the name itself, in any spelling or
  // spacing; that publishes no title, and the model's own title is the next fact.
  const document = capabilitiesDocument({ models: [residentModel({ service: "nighttime", nsfw: false,
    displayName: "Qwen3.8 27B Abliterated Q6_K (96K)" })] });
  document.models[0].metadata.alias_display_names = { nighttime: "  Nighttime\t" };
  assert.equal(residentLabel(row(catalogOf(document), "nighttime")), "Qwen3.8 27B Abliterated Q6_K (96K)");
});

test("the reserved alias, a canonical ID and a row with no service name offer nothing", () => {
  const orphan = unaddressedModel();
  assert.equal(orphan.service, orphan.id, "such a row is named by its canonical ID because the router will not invent one");
  assert.deepEqual(orphan.aliases, []);
  const document = trio({ models: [...trio().models, orphan] });
  const catalog = catalogOf(document);
  assert.deepEqual(catalog.services.map(entry => entry.service), ["daytime", "nighttime", "trial"]);
  for (const entry of catalog.services) {
    assert.notEqual(entry.service, RESERVED, "the reserved compatibility alias is not a service (§3)");
    assert.equal(entry.aliases.includes(RESERVED), false, "it is not among the names on offer either");
    assert.notEqual(entry.service, entry.model.id, "a canonical model ID is not a choice");
  }
  // Even when the reserved alias is all a row has, nothing is offered for it.
  const aliasOnly = capabilitiesDocument({ models: [{ ...residentModel(), service: RESERVED, aliases: [RESERVED] }] });
  assert.deepEqual(catalogOf(aliasOnly).services, [], "a conformant client MUST NOT surface a row nobody may send");
  // A row whose service is its canonical ID offers nothing either, whatever it is titled.
  const named = structuredClone(orphan);
  named.display_name = "Strata experiment (uncatalogued)";
  assert.deepEqual(catalogOf(capabilitiesDocument({ models: [named] })).services, []);
  // So none of the three services is served by it, and it is never addressed.
  for (const service of ["daytime", "nighttime", "trial"]) {
    const state = residentStatus(document, service);
    assert.equal(state.status, "available", service);
    assert.notEqual(state.served, UNADDRESSED_ID, service);
  }
});

test("a name the document stops publishing keeps a row and says so", () => {
  const dropped = capabilitiesDocument({ models: [residentModel()], configuration: { id: "solo-no-trial", exclusive: true } });
  const catalog = catalogOf(dropped, { known: ["daytime", "nighttime", "trial"] });
  assert.deepEqual(catalog.services.map(entry => entry.service), ["daytime", "nighttime", "trial"],
    "a recorded name never vanishes from under a session (§5)");
  const night = row(catalog, "nighttime");
  assert.equal(night.status, "unavailable");
  assert.equal(night.reason, "not offered by the router");
  assert.equal(residentLabel(night), "nighttime — unavailable");
  assert.equal(night.served, null, "the document attributes no model to it");
  assert.equal(row(catalog, "daytime").status, "available", "the names still published are judged on their own rows");
  assert.equal(row(catalog, "trial").optIn, true);
  assert.equal(row(catalogOf(dropped), "daytime") !== undefined, true, "a name nothing records and nobody publishes is not invented");
  assert.equal(row(catalogOf(dropped, { known: [] }), "trial"), undefined);
});

test("a stopped service reads its own published name and reason", () => {
  // offline_services rows are the router's own statement about a service this
  // configuration stops: its title and its reason are published facts, and they
  // are what the row says.
  const document = capabilitiesDocument({
    models: [residentModel()],
    offline: [offlineRow("nighttime", { displayName: "Qwen3.8 27B Abliterated (96K) retired", reason: "exclusive_configuration" }),
      offlineRow("trial", { displayName: "trial", reason: "operator_stopped" })],
    configuration: { id: "flash-next-solo-160k", exclusive: true },
  });
  const catalog = catalogOf(document);
  const night = row(catalog, "nighttime");
  assert.equal(night.status, "offline");
  assert.equal(night.reason, "exclusive_configuration");
  assert.equal(residentLabel(night), "Qwen3.8 27B Abliterated (96K) retired — offline (flash-next-solo-160k)");
  const trial = row(catalog, "trial");
  // A stopped row titled with the name it is addressed by publishes no title, so
  // the row names itself rather than repeating the name twice.
  assert.equal(residentLabel(trial), "trial — offline (flash-next-solo-160k)");
  assert.equal(trial.reason, "operator_stopped");
  assert.match(residentMessage(trial), /opt-in model/);
  // A name the active configuration both stops and still lists is stopped: the
  // admission fact is the stronger of the two, and a request would be refused.
  const both = capabilitiesDocument({ models: [residentModel()], offline: [offlineRow("daytime", { displayName: "Qwen3.8 27B Q6_K (160K)" })] });
  assert.equal(row(catalogOf(both), "daytime").status, "offline");
});

test("trio: the opt-in trial is available from its own metadata and text-only", () => {
  const document = trio();
  const trial = row(catalogOf(document), "trial");
  assert.equal(trial.status, "available");
  assert.equal(trial.served, TRIAL_ID);
  assert.equal(trial.optIn, true);
  assert.equal(trial.capabilities.contextWindow, 163840 - 1024);
  assert.equal(trial.capabilities.maxConcurrency, 1);
  assert.deepEqual(trial.capabilities.input, ["text"]);
  // The picker label is the router's own display name, never a canonical ID.
  assert.equal(residentLabel(trial), "Qwen3.8 Flash-Next (Strata trial) (160K)");
  assert.equal(residentStateRecord(trial).label, "Qwen3.8 Flash-Next (Strata trial) (160K)");
  assert.equal(isBlockingStatus(trial.status), false);
  // A third service being served changes nothing about the permanent residents.
  assert.equal(row(catalogOf(document), "daytime").status, "available");
  assert.equal(row(catalogOf(document), "nighttime").status, "available");
});

test("an absent trial service is recorded as its own unavailable state", () => {
  const document = paired();
  const trial = residentStatus(document, "trial");
  assert.equal(trial.status, "unavailable");
  assert.equal(trial.reason, "not offered by the router");
  assert.equal(residentLabel(trial), "trial — unavailable");
  assert.equal(isBlockingStatus(trial.status), true);
  assert.match(residentMessage(trial), /opt-in model/);
  assert.match(residentMessage(trial), /never selects it and never moves a session off it/);
  assert.match(residentMessage(trial), /does not offer it/);
  // The permanent residents keep their own states and advice.
  assert.equal(residentStatus(document, "daytime").status, "available");
  assert.equal(residentStatus(document, "nighttime").status, "available");
  assert.equal(residentMessage(residentStatus(document, "nighttime")), "Qwen3.8 27B Abliterated Q6_K (96K) is available.");
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
  assert.equal(residentLabel(trial), "Qwen3.8 Flash-Next (Strata trial) (160K) — offline (flash-next-solo-160k)");
  assert.equal(describeStatus(trial), "offline (flash-next-solo-160k)");
  assert.equal(residentStatus(document, "daytime").status, "available");
  assert.equal(residentStatus(document, "nighttime").status, "offline");
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
  // The document still attributes the model to the name, so the row keeps the
  // title that model was published with and adds its state.
  assert.equal(residentLabel(residentStatus(unhealthy, "nighttime")), "Qwen3.8 27B Abliterated Q6_K (96K) — unavailable");
  assert.equal(residentStatus(unhealthy, "daytime").status, "available");
  // Metadata a person cannot select a model on is recorded on the row that
  // carries it: no limits can be computed from it, so the row states why.
  for (const damage of [
    { label: "no input modalities", damage: meta => { delete meta.input_modalities; } },
    { label: "no modality Harness can represent", damage: meta => { meta.input_modalities = ["image"]; meta.capabilities = ["completion", "thinking", "tools", "vision"]; } },
    { label: "no reasoning capability at all", damage: meta => { delete meta.reasoning; } },
    { label: "no selectable reasoning effort", damage: meta => { meta.reasoning.efforts = {}; meta.reasoning.aliases = {}; meta.reasoning.per_effort = {}; } },
  ]) {
    const night = residentModel({ service: "nighttime" });
    damage.damage(night.metadata);
    const document = paired({ models: [residentModel(), night] });
    const state = residentStatus(document, "nighttime");
    assert.equal(state.status, "incomplete", `${damage.label}: ${state.reason}`);
    assert.equal(residentLabel(state), "Qwen3.8 27B Abliterated Q6_K (96K) — incomplete metadata", damage.label);
    assert.equal(residentStatus(document, "daytime").status, "available", damage.label);
  }
  // The metadata rules of the contract are each a reason the publisher
  // contradicted its own document, and every one of them is a stated reason
  // rather than a note: warnings are carried verbatim, incomplete metadata is
  // refused, and a schema this Harness was not written for cannot be selected on.
  for (const damage of [
    { label: "warnings", damage: meta => { meta.warnings = ["BACKEND_SLOT_COUNT_MISMATCH"]; }, reason: /BACKEND_SLOT_COUNT_MISMATCH/ },
    { label: "incomplete", damage: meta => { meta.complete = false; }, reason: /incomplete/ },
    { label: "schema version", damage: meta => { meta.schema_version = 3; }, reason: /schema v2/ },
    { label: "reasoning default", damage: meta => { meta.reasoning.default = "unsupported"; }, reason: /reasoning default/ },
    { label: "safety reserve", damage: meta => { meta.context_safety_reserve = -1; }, reason: /context_safety_reserve/ },
    { label: "vision without modalities", damage: meta => { meta.input_modalities = ["text", "image"]; }, reason: /input capabilities/ },
    { label: "output limits", damage: meta => { meta.max_output_tokens = 0; }, reason: /output limits/ },
  ]) {
    const meta = residentModel({ service: "nighttime" }).metadata;
    damage.damage(meta);
    assert.throws(() => validateRouterMetadata(meta), damage.reason, damage.label);
  }
  const warned = residentModel({ service: "nighttime" });
  warned.metadata.warnings = ["BACKEND_VISION_MISMATCH"];
  assert.throws(() => validateRouterMetadata(warned.metadata), /BACKEND_VISION_MISMATCH/);
  // §6: a publisher that warns about the metadata it published for a model has
  // not finished making it selectable, so the row carries the warning verbatim
  // instead of offering a model whose limits are in question.
  const warnedState = residentStatus(paired({ models: [residentModel(), warned] }), "nighttime");
  assert.equal(warnedState.status, "incomplete");
  assert.match(warnedState.reason, /BACKEND_VISION_MISMATCH/);
});

test("draining or maintenance: every model waits, none is blocked, nothing falls back", () => {
  for (const document of [draining(), capabilitiesDocument({ accepting: false, draining: false, maintenance: true }), draining(solo())]) {
    const catalog = catalogOf(document, { known: ["daytime", "nighttime", "trial"] });
    // One route, every service of it waiting, including a name this document
    // stopped publishing: a switching router answers nothing.
    assert.deepEqual(catalog.services.map(entry => [entry.service, entry.status]),
      [["daytime", "switching"], ["nighttime", "switching"], ["trial", "switching"]]);
    for (const service of ["daytime", "nighttime", "trial"]) {
      const state = residentStatus(document, service);
      assert.equal(state.status, "switching", service);
      assert.equal(isBlockingStatus(state.status), false);
      assert.match(residentLabel(state), /router switching configuration$/);
    }
    assert.equal(catalog.route.status, "switching");
    assert.equal(catalog.route.configuration, document.configuration.id);
  }
  assert.equal(residentStatus(capabilitiesDocument({ accepting: false, draining: false, maintenance: true }), "daytime").reason, "maintenance");
  // Limits a person can still read: a drain keeps the row's last limits, marked stale.
  const drained = planOf(draining(), { known: ["nighttime"],
    stored: { baseURL: "http://router.invalid/v1", models: [{ id: "nighttime", name: "Qwen3.8 27B Abliterated Q6_K (96K)",
      contextWindow: 98304 - 1024, maxTokens: null, input: ["text"] }] } });
  assert.equal(drained.residentUnavailable, false, "a draining router makes requests wait rather than fail");
  assert.equal(drained.residentState.status, "switching");
  assert.equal(drained.residentStates.nighttime.limits, "stale");
  const drainedRow = drained.models.find(model => model.id === "nighttime");
  assert.equal(drainedRow.contextWindow, 98304 - 1024);
  assert.equal(residentStatus(draining(), "nighttime").served, NIGHTTIME_ID, "the model behind the name is still attributed");
  assert.equal(drainedRow.name, "Qwen3.8 27B Abliterated Q6_K (96K)", "a known model keeps its title through a drain");
});

test("router unreachable: every recorded model is unavailable with a recoverable message", () => {
  const catalog = catalogOf(null, { known: ["daytime", "nighttime", "trial"] });
  assert.deepEqual(catalog.services.map(entry => [entry.service, entry.status, entry.reason]),
    [["daytime", "unavailable", "router unreachable"], ["nighttime", "unavailable", "router unreachable"],
      ["trial", "unavailable", "router unreachable"]]);
  assert.deepEqual(catalog.route, { status: "unavailable", reason: "router unreachable", configuration: null });
  assert.equal(catalog.configuration, null);
  for (const service of ["daytime", "nighttime", "trial"]) {
    const state = residentStatus(null, service);
    assert.equal(state.status, "unavailable");
    assert.equal(state.reason, "router unreachable");
    assert.match(residentMessage(state), /router is unreachable/);
    assert.match(residentMessage(state), /Harness reconnects automatically|never moves a session off it/);
  }
  // The router names itself, so an unreachable router keeps the name it had.
  const named = planOf(null, { stored: { baseURL: "http://router.invalid/v1", displayName: "llm-router", models: [] } });
  assert.equal(named.displayName, "llm-router");
  assert.equal(named.residentUnavailable, true, "the route itself is what is not answering");
  // Nothing recorded and nothing readable offers nothing at all.
  assert.deepEqual(catalogOf(null).services, []);
});

test("a document that cannot be read holds the whole route; one bad name holds only itself", () => {
  for (const broken of [
    { object: "router.capabilities" },
    { object: "router.capabilities", models: [], router: {} },
    { object: "router.capabilities", models: [], router: { accepting_requests: true }, offline_services: "not-a-list" },
  ]) {
    const route = routerRouteState(broken);
    assert.equal(route.status, "incomplete");
    const catalog = catalogOf(broken, { known: ["daytime"] });
    assert.ok(catalog.problem, catalog.problem);
    assert.deepEqual(catalog.services, [], "nothing can be said about a document that cannot be read");
    const planned = planRouterProvider({ name: ROUTER_PROVIDER, catalog, stored: { baseURL: "http://router.invalid/v1", models: [] },
      clientName: "deepseek-harness/test" });
    assert.equal(planned.residentUnavailable, true);
    assert.equal(planned.residentState.status, "incomplete");
    assert.equal(planned.residentState.reason, catalog.problem);
    assert.deepEqual(planned.models, []);
    assert.equal(residentStatus(broken, "daytime").status, "incomplete");
    assert.equal(residentStatus(broken, "daytime").reason, catalog.problem);
  }
  // A name two rows answer is that name's problem, not the route's.
  const twice = paired({ models: [residentModel(), residentModel({ id: "other", service: "daytime" })] });
  const state = residentStatus(twice, "daytime");
  assert.equal(state.status, "incomplete");
  assert.match(state.reason, /ambiguous router service "daytime"/);
  const planned = planOf(twice, { known: ["daytime"] });
  assert.equal(planned.residentUnavailable, false, "route-level availability is decided by the route");
  assert.equal(planned.residentStates.daytime.status, "incomplete");
  // A disappeared ID with no offline entry is a configuration change.
  assert.equal(residentStatus(paired({ models: [residentModel()] }), "nighttime").reason, "not offered by the router");
});

test("a model the catalog gives no service ID is never offered, addressed, or persisted (1.2 §3, §4)", async () => {
  const orphan = unaddressedModel();
  const document = trio({ models: [...trio().models, orphan] });
  // The picker offers the published names whatever the catalog also publishes:
  // a row nobody addressed cannot appear, cannot be planned into a route, and is
  // never written to settings.
  const state = structuredClone(legacySettings("http://router.invalid/v1"));
  const { errors } = await synchronizeRouterSettings(settingsService(state, [], applyOperation), { document });
  assert.deepEqual(errors.map(error => [error.provider, error.error.message]), []);
  assert.deepEqual(Object.keys(state["llm-pi-ai"].providers).sort(), ["custom", ROUTER_PROVIDER],
    "the one-route-per-service routes are retired once the catalog route lists their service");
  const ids = state["llm-pi-ai"].providers[ROUTER_PROVIDER].models.map(model => model.id);
  assert.deepEqual(ids.slice(0, 3), ["daytime", "nighttime", "trial"], "the published names first, in published order");
  assert.deepEqual(ids.slice(3), KEPT_NAMES,
    "then the names this router does not offer; the alias the settings carried is not a service (1.2 §3)");
  assert.equal(JSON.stringify(state).includes(UNADDRESSED_ID), false, "settings record a model nobody may send");
  assert.equal(state["agent-default-model"].model, "daytime");
});

test("CATALOG_HAS_NO_SERVICE_ID holds every recorded model and is never a Harness failure (1.2 §4)", async () => {
  const document = capabilitiesDocument({
    models: [unaddressedModel(), unaddressedModel({ id: "fixture-strata-preview-uncatalogued", displayName: "Strata preview (uncatalogued)" })],
    complete: false, warnings: ["CATALOG_HAS_NO_SERVICE_ID"],
  });
  const catalog = catalogOf(document, { known: ["daytime", "nighttime", "trial"] });
  assert.deepEqual(catalog.services.map(entry => entry.service), ["daytime", "nighttime", "trial"]);
  for (const service of ["daytime", "nighttime", "trial"]) {
    const state = row(catalog, service);
    assert.equal(state.status, "unavailable", service);
    assert.equal(state.reason, "not offered by the router", service);
    assert.equal(state.served, null, service);
    // Never another name, and never the router's default model either.
    assert.doesNotMatch(JSON.stringify(residentStateRecord(state)), /fixture-|strata/i, service);
  }
  assert.equal(row(catalog, "trial").optIn, true);
  assert.match(residentMessage(row(catalog, "trial")), /opt-in model/);
  const state = structuredClone(legacySettings("http://router.invalid/v1"));
  const { errors } = await synchronizeRouterSettings(settingsService(state, [], applyOperation), { document });
  assert.deepEqual(errors.map(error => [error.provider, error.error.message]), [],
    "a router that publishes nothing addressable is not a failed update");
  const route = state["llm-pi-ai"].providers[ROUTER_PROVIDER];
  // Availability is route-level: this router answers and admits, so the route is
  // not down — every name it carries states its own reason instead.
  assert.equal(route.residentState.status, "available");
  assert.equal(route.residentUnavailable, false);
  assert.deepEqual(route.models.map(model => model.id), KEPT_NAMES,
    "the alias the settings carried is dropped, not recorded as a name the router does not offer (1.2 §3)");
  assert.deepEqual(route.residentState.services.map(entry => [entry.service, entry.status]),
    [["qwen3.8-27b-abliterated-q6_k", "unavailable"]]);
  assert.match(route.residentStates["qwen3.8-27b-abliterated-q6_k"].message, /does not offer it/);
  assert.doesNotMatch(JSON.stringify(route), /fixture-|strata/i, "a name nobody may send is never written");
  assert.notEqual(state["agent-default-model"].model, "trial");
});

test("MODEL_HAS_NO_SERVICE_ID is the publisher's own reason, recorded as a reason and not a note (1.2 §4)", () => {
  const warned = residentModel({ service: "nighttime" });
  warned.metadata.warnings = ["MODEL_HAS_NO_SERVICE_ID"];
  warned.metadata.complete = false;
  // The metadata rules refuse such a row with the publisher's own warning carried
  // verbatim: it is a reason the row cannot be selected on, and no second field
  // exists for router advice.
  assert.throws(() => validateRouterMetadata(warned.metadata), /MODEL_HAS_NO_SERVICE_ID/);
  assert.throws(() => validateRouterMetadata({ ...warned.metadata, warnings: ["BACKEND_VISION_MISMATCH"] }), /BACKEND_VISION_MISMATCH/);
  // A row whose metadata cannot be read at all is that same state on its own name.
  const unreadable = residentModel({ service: "nighttime" });
  unreadable.metadata.warnings = ["MODEL_HAS_NO_SERVICE_ID"];
  delete unreadable.metadata.reasoning;
  const document = paired({ models: [residentModel(), unreadable] });
  const state = residentStatus(document, "nighttime");
  assert.equal(state.status, "incomplete");
  assert.equal(residentLabel(state), "Qwen3.8 27B Abliterated Q6_K (96K) — incomplete metadata");
  const record = residentStateRecord(state);
  assert.deepEqual(Object.keys(record).sort(),
    ["configuration", "label", "limits", "message", "nsfw", "reason", "service", "status"]);
  assert.equal(record.reason, state.reason, "the recorded reason is the one the router gave, not a paraphrase");
  assert.ok(record.message.includes(state.reason), record.message);
  assert.equal(residentStatus(document, "daytime").status, "available", "the other model is judged on its own row");
});

test("every row a person may send is a name the router publishes (1.2 §3)", async () => {
  // An omitted `model` is answered by the default of the active configuration,
  // which 1.2 does not promise is any particular service. Harness therefore sends
  // the name it was given, and the rows it writes are exactly the ones the
  // catalog offers — including the recorded names it must keep stating.
  for (const document of [paired(), trio(), strata(), solo(), draining(), null]) {
    const state = structuredClone(legacySettings("http://router.invalid/v1"));
    const settings = settingsService(state, [], applyOperation);
    const { errors } = await synchronizeRouterSettings(settings, { document });
    assert.deepEqual(errors.map(error => [error.provider, error.error.message]), []);
    const catalog = routerServices(document, { known: RECORDED_NAMES });
    // The names the document itself states — published rows and stopped services.
    const published = document ? routerServices(document, { known: [] }).services.map(entry => entry.service) : [];
    const models = state["llm-pi-ai"].providers[ROUTER_PROVIDER].models;
    assert.deepEqual(models.map(model => model.id), catalog.services.map(entry => entry.service),
      `${document?.configuration?.id ?? "no router"}: the route offers what the router publishes, then the names it must keep stating`);
    for (const model of models) assert.ok(nonEmpty(model.id), "a row configures an empty model ID");
    assert.deepEqual(models.map(model => model.id).filter(id => !published.includes(id)),
      document === null ? RECORDED_NAMES.filter(id => id !== RESERVED) : KEPT_NAMES,
      document === null
        // A router that is not answering contradicts nothing, so every recorded
        // name keeps a row — except the reserved alias, which is not a name a
        // person may send (§3), reachable or not.
        ? "a router that is not answering keeps a row for every recorded service"
        : "only names this Harness already carries a row for are added to what the router states");
    for (const name of published) {
      assert.notEqual(name, RESERVED, "the reserved compatibility alias is never a row a person may send");
      assert.doesNotMatch(name, /fixture-|qwen3\.8/, "a canonical model ID is never a row a person may send");
    }
    assert.doesNotMatch(models.map(model => model.id).join(","), /fixture-/, "settings address no canonical model ID");
  }
});

const nonEmpty = value => typeof value === "string" && value.length > 0;

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

test("limits come from the serving model, and slots are counted per model, not per name", () => {
  const first = paired({ models: [residentModel(), residentModel({ service: "nighttime", contextWindow: 131072 })] });
  const second = paired({ models: [residentModel(), residentModel({ service: "nighttime", contextWindow: 98304, slots: 2 })] });
  const stored = { api: "openai-responses", baseURL: "http://router.invalid/v1", reasoning: "medium",
    models: [{ id: "nighttime", name: "old", custom: "kept" }] };
  const one = planRouterProvider({ name: ROUTER_PROVIDER, catalog: catalogOf(first), stored, clientName: "deepseek-harness/test" });
  const two = planRouterProvider({ name: ROUTER_PROVIDER, catalog: catalogOf(second), stored: one, clientName: "deepseek-harness/test" });
  assert.equal(one.models.find(model => model.id === "nighttime").contextWindow, 131072 - 1024);
  assert.equal(two.models.find(model => model.id === "nighttime").contextWindow, 98304 - 1024);
  assert.equal(one.maxConcurrency, 2, "one route, the slots of every model it offers");
  assert.equal(two.maxConcurrency, 3);
  assert.equal(two.models.find(model => model.id === "nighttime").custom, "kept");
  assert.equal(two.residentStates.nighttime.limits, "current");
  // Two names of one model share that model's slots: the route is limited as a
  // whole, and the router's own queue per model stays the authority (§8).
  const shared = capabilitiesDocument({ models: [residentModel({ slots: 4, aliases: ["local-active", "daytime", "nighttime"] }),
    residentModel({ service: "trial", slots: 2 })] });
  const catalog = catalogOf(shared);
  assert.deepEqual(catalog.services.map(entry => [entry.service, entry.served, entry.capabilities.maxConcurrency]),
    [["daytime", DAYTIME_ID, 4], ["nighttime", DAYTIME_ID, 4], ["trial", TRIAL_ID, 2]]);
  assert.equal(planRouterProvider({ name: ROUTER_PROVIDER, catalog, stored: { baseURL: "http://router.invalid/v1" },
    clientName: "deepseek-harness/test" }).maxConcurrency, 6, "4 + 2, not 4 + 4 + 2");
});

test("while a model is unavailable its last limits are kept and marked stale", () => {
  const stored = { baseURL: "http://router.invalid/v1", models: [{ id: "nighttime" }] };
  const available = planOf(paired(), { known: ["nighttime"], stored });
  const offline = planOf(solo(), { known: ["nighttime"], stored: available });
  assert.equal(offline.models.find(model => model.id === "nighttime").contextWindow,
    available.models.find(model => model.id === "nighttime").contextWindow);
  assert.deepEqual(offline.models.find(model => model.id === "nighttime").reasoningEfforts,
    available.models.find(model => model.id === "nighttime").reasoningEfforts);
  assert.equal(offline.residentUnavailable, false, "the route answers; only this model cannot serve");
  assert.equal(offline.residentStates.nighttime.limits, "stale");
  assert.equal(offline.residentStates.nighttime.status, "offline");
  assert.deepEqual(offline.residentState.services.find(entry => entry.service === "nighttime"), { service: "nighttime", status: "offline" });
  const switching = planOf(draining(), { known: ["nighttime"], stored: available });
  assert.equal(switching.residentUnavailable, false, "a draining router makes requests wait rather than fail");
  assert.equal(switching.residentStates.nighttime.limits, "stale");
});

test("the route is named by its router; a row with no model behind it names itself", () => {
  const offered = capabilitiesDocument({ models: [residentModel(), residentModel({ service: "trial" })] });
  const stored = { baseURL: "http://router.invalid/v1", apiKeyEnv: "KEEP",
    models: [{ id: "trial", name: "Qwen3.8 Flash-Next (Strata trial) (160K)" }] };
  const first = planOf(offered, { known: ["trial"], stored });
  assert.equal(first.displayName, "llm-router", "the route is named for the router it talks to, not for one of its models");
  assert.equal(routerName(offered, "http://router.invalid/v1"), first.displayName,
    "the name the route carries is the name the verifier titles it with");
  assert.equal(first.models.find(model => model.id === "trial").name, "Qwen3.8 Flash-Next (Strata trial) (160K)",
    "a name a model answers keeps the title that model was published with");

  // A configuration that drops a name leaves no row, alias and no offline entry
  // for it. A remembered title describes a configuration that may no longer exist
  // and reads as a model on offer, so the row names itself and its state.
  const dropped = capabilitiesDocument({ models: [residentModel()], configuration: { id: "solo-no-trial", exclusive: true } });
  const state = residentStatus(dropped, "trial");
  assert.equal(state.status, "unavailable");
  assert.equal(state.reason, "not offered by the router");
  const gone = planOf(dropped, { known: ["trial"], stored: first });
  const droppedRow = gone.models.find(model => model.id === "trial");
  assert.equal(droppedRow.name, "trial — unavailable", "the row names itself, not a model the router no longer offers");
  assert.equal(gone.residentStates.trial.label, "trial — unavailable");
  assert.equal(gone.residentStates.trial.limits, "stale", "its last limits are still kept, marked stale");
  assert.match(gone.residentStates.trial.message, /current configuration does not offer it/);
  assert.equal(gone.displayName, "llm-router", "the header never named a model in the first place");

  // Offline names no model either; a draining router still attributes one, and the
  // remembered title belongs to it.
  const known = { baseURL: "http://router.invalid/v1", models: [{ id: "nighttime", name: "Qwen3.8 27B Abliterated Q6_K (96K)" }] };
  assert.equal(planOf(solo(), { known: ["nighttime"], stored: known }).models.find(model => model.id === "nighttime").name,
    "Qwen3.8 27B Abliterated Q6_K (96K) — offline (flash-next-solo-128k)");
  assert.equal(residentStatus(draining(), "nighttime").served, NIGHTTIME_ID);
  assert.equal(planOf(draining(), { known: ["nighttime"], stored: known }).models.find(model => model.id === "nighttime").name,
    "Qwen3.8 27B Abliterated Q6_K (96K)", "the model behind a draining name is known");

  // The title returns with the model, without anything else about the row being lost.
  const back = planOf(offered, { known: ["trial"], stored: gone });
  const restored = back.models.find(model => model.id === "trial");
  assert.equal(restored.name, "Qwen3.8 Flash-Next (Strata trial) (160K)");
  assert.equal(restored.contextWindow, 163840 - 1024);
  assert.equal(back.apiKeyEnv, "KEEP");

  // A router that publishes no name of its own is named by where it answers; an
  // unreachable one keeps the name it had, because nothing new can be read.
  const nameless = capabilitiesDocument({ models: [residentModel()] });
  delete nameless.router.name;
  assert.equal(planOf(nameless, { stored: { baseURL: "http://ai-router:11434/v1", models: [] } }).displayName, "ai-router");
  // A router that answers without naming itself is named by where it answers, and
  // the verifier holds it to that; only a router that is not answering at all has
  // no name to be titled with, and then the route keeps the one it had.
  assert.equal(routerName(nameless, "http://ai-router:11434/v1"), "ai-router");
  assert.equal(routerName(null, "http://ai-router:11434/v1"), undefined);
  assert.equal(planOf(null, { stored: { baseURL: "http://ai-router:11434/v1", displayName: "llm-router", models: [] } }).displayName,
    "llm-router");
  assert.throws(() => planRouterProvider({ name: ROUTER_PROVIDER, catalog: catalogOf(nameless), stored: null, resolved: null,
    clientName: "deepseek-harness/test" }), /without stored or resolved settings/);
});

test("planning preserves preferences, credential references and identity", () => {
  const stored = { api: "openai-responses", apiKeyEnv: "KEEP", baseURL: "http://router/v1", reasoning: "low",
    headers: { "x-client-name": "stale", Other: "kept" }, retryPolicy: { mode: "normal", maxRetries: 2 },
    models: [{ id: "daytime", name: "Daytime (128K)", custom: "kept" },
      { id: "qwen3.8-27b-abliterated-q6_k", name: "Nighttime (128K)", contextWindow: 131072 }] };
  const next = planOf(paired(), { known: ["qwen3.8-27b-abliterated-q6_k"], stored });
  assert.deepEqual(next.models.map(model => model.id), ["daytime", "nighttime", "qwen3.8-27b-abliterated-q6_k"],
    "a name nothing serves keeps its row, and its limits are all anyone has for it");
  assert.equal(next.models[0].custom, "kept");
  assert.equal(next.apiKeyEnv, "KEEP");
  assert.equal(next.reasoning, "low");
  assert.deepEqual(next.retryPolicy, stored.retryPolicy);
  assert.deepEqual(next.headers, { Other: "kept", "X-Client-Name": "deepseek-harness/test" });
  const remembered = next.models.find(model => model.id === "qwen3.8-27b-abliterated-q6_k");
  assert.equal(remembered.name, "qwen3.8-27b-abliterated-q6_k — unavailable",
    "a remembered title describes a model this router no longer offers, so the row names itself");
  assert.equal(remembered.contextWindow, 131072, "its limits stay, which is all the settings hold for it");
  assert.equal(next.residentStates["qwen3.8-27b-abliterated-q6_k"].limits, "stale");
  assert.doesNotMatch(JSON.stringify(next), /fixture-|mtp3/);
  // A route written from nothing inherits nothing it was not given.
  const provisioned = planOf(solo(), { stored: { baseURL: "http://router/v1" } });
  assert.deepEqual(provisioned.models.map(model => model.id), ["daytime", "nighttime"]);
  assert.equal(provisioned.models[1].contextWindow, undefined, "an offline name is given no invented limits");
  assert.equal(provisioned.reasoning, "medium", "a route that can reason gets the default selector level");
});

test("old session and default routes migrate onto the catalog route", () => {
  // The retired routes each carried one service, so a selection written with one
  // of them names that service of the single catalog route.
  assert.deepEqual(migrateResidentRoute({ provider: "local-everyday", model: "qwen3.8-27b-abliterated-q6_k" }),
    { provider: "local-ollama", model: "nighttime" });
  assert.deepEqual(migrateResidentRoute({ provider: "local-trial" }), { provider: "local-ollama", model: "trial" });
  assert.deepEqual(migrateResidentRoute({ provider: "local-trial", model: "trial", reasoningEffort: "high" }),
    { provider: "local-ollama", model: "trial", reasoningEffort: "high" });
  // The catalog route survived the change, so one route legitimately serves several
  // models now and a selection onto it is left exactly as it was — the same object,
  // whichever model it names.
  for (const model of ["daytime", "nighttime", "trial", RESERVED, "qwen3.8-27b-abliterated-q6_k"]) {
    const selection = { provider: "local-ollama", model, reasoningEffort: "high" };
    assert.equal(migrateResidentRoute(selection), selection, `local-ollama/${model} was rewritten`);
  }
  const external = { provider: "amazon-bedrock", model: "anthropic.fixture" };
  assert.equal(migrateResidentRoute(external), external);
  assert.equal(migrateResidentRoute(undefined), undefined);
  assert.equal(migrateResidentRoute(null), null);
});

test("no migration case ever makes the opt-in service the default", async () => {
  const catalog = { api: "openai-responses", apiKeyEnv: "KEEP", baseURL: "http://router.invalid/v1", reasoning: "medium",
    models: [{ id: "daytime", name: "Qwen3.8 27B Q6_K (160K)", contextWindow: 130048, maxTokens: null, input: ["text", "image"] },
      { id: "nighttime", name: "Qwen3.8 27B Abliterated Q6_K (96K)", contextWindow: 97280, maxTokens: null, input: ["text"] }] };
  const settings = selection => ({ "agent-default-model": selection, "llm-pi-ai": { providers: { [ROUTER_PROVIDER]: structuredClone(catalog) } } });
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
    assert.equal(selection.provider, ROUTER_PROVIDER, `${testCase.label}: the default left the catalog route`);
    assert.notEqual(selection.model, "trial", `${testCase.label}: the default moved onto the opt-in model`);
    // Every service the document states is a row that says why it cannot serve —
    // held, never unknown.
    const route = state["llm-pi-ai"].providers[ROUTER_PROVIDER];
    for (const entry of route.residentState.services) {
      assert.equal(["available", "offline", "unavailable", "incomplete", "switching"].includes(entry.status), true, testCase.label);
      const record = route.residentStates[entry.service];
      assert.equal(record.service, entry.service, `${testCase.label}: ${entry.service}`);
      assert.equal(record.status, entry.status, `${testCase.label}: ${entry.service}`);
      assert.equal(route.residentUnavailable, entry.status === "incomplete" || route.residentState.status !== "available", testCase.label);
    }
  }
});

test("the route's default is the service the document calls its default", () => {
  const three = trio();
  assert.equal(planOf(three).residentState.default, "daytime", "the document's default_model is a published row");
  const trialLeads = capabilitiesDocument({ models: [residentModel({ service: "trial" }), residentModel(), residentModel({ service: "nighttime" })] });
  const catalog = catalogOf(trialLeads);
  const planned = planRouterProvider({ name: ROUTER_PROVIDER, catalog, stored: { baseURL: "http://router.invalid/v1" },
    clientName: "deepseek-harness/test" });
  assert.equal(trialLeads.default_model, TRIAL_ID);
  assert.equal(planned.residentState.default, "trial", "a request that names no model goes where the router itself points");
  assert.deepEqual(planned.residentState.services.map(entry => entry.service), ["trial", "daytime", "nighttime"]);
  // A default the document does not list falls back to what can serve, then to the
  // first row: never to a name the router does not have.
  const drifted = capabilitiesDocument({ models: [residentModel(), residentModel({ service: "nighttime" })] });
  drifted.default_model = NIGHTTIME_MTP3_ID;
  assert.equal(planOf(drifted).residentState.default, "daytime");
  const nothing = capabilitiesDocument({ models: [residentModel({ available: false })] });
  assert.equal(planOf(nothing).residentState.default, "daytime");
});

test("a second router's catalog is discovered without a Harness release", async () => {
  const daisy = capabilitiesDocument({ models: [residentModel({ service: "daisy", aliases: ["daisy"], id: "fixture-daisy-9b",
    displayName: "Daisy 9B (32K)", contextWindow: 32768, slots: 3, vision: false, nsfw: false })],
  configuration: { id: "daisy-9b", exclusive: false } });
  assert.deepEqual(catalogOf(daisy).services.map(entry => [entry.service, residentLabel(entry)]), [["daisy", "Daisy 9B (32K)"]],
    "a service the runtime adds is a row on the next revision");
  assert.deepEqual(resolveProviderList([ROUTER_PROVIDER, "second-router"]), [ROUTER_PROVIDER, "second-router"]);
  const state = structuredClone(legacySettings("http://router.invalid/v1"));
  state["llm-pi-ai"].providers["second-router"] = { api: "openai-responses", baseURL: "http://second.invalid:11434/v1",
    models: [{ id: "daytime", name: "Daytime (128K)" }] };
  const { errors } = await synchronizeRouterSettings(settingsService(state, [], applyOperation), {
    providers: [ROUTER_PROVIDER, "second-router"], document: baseURL => (baseURL.includes("second.invalid") ? paired() : daisy) });
  assert.deepEqual(errors.map(error => [error.provider, error.error.message]), []);
  const route = state["llm-pi-ai"].providers[ROUTER_PROVIDER];
  const second = state["llm-pi-ai"].providers["second-router"];
  // Each route is written from its own router's document, in that document's order.
  assert.equal(route.models[0].id, "daisy");
  assert.equal(route.models[0].name, "Daisy 9B (32K)");
  assert.equal(route.residentState.configuration, "daisy-9b");
  assert.deepEqual(second.models.slice(0, 2).map(model => model.id), ["daytime", "nighttime"]);
  assert.equal(second.residentState.configuration, "qwen27b-q6k-with-nighttime");
  assert.equal(second.models[1].name, "Qwen3.8 27B Abliterated Q6_K (96K) · NSFW");
  // Each route answers for its own router: a model of the other router is not
  // offered here as a name that went missing, because this router never said
  // anything about it.
  assert.equal(second.models.find(model => model.id === "daisy"), undefined,
    "another router's model is not this route's business");
  assert.equal(second.residentStates.daisy, undefined);
  assert.deepEqual(route.models.map(model => model.id).filter(id => RECORDED_NAMES.includes(id)), KEPT_NAMES);
  // Slots are the ones that router publishes for the distinct models it offers.
  assert.equal(route.maxConcurrency, 3);
  assert.equal(second.maxConcurrency, 2);
  assert.deepEqual(Object.keys(state["llm-pi-ai"].providers).sort(), ["custom", ROUTER_PROVIDER, "second-router"]);
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

test("the plugin migrates session routes, owns its timers, and takes its opt-in list from settings", async () => {
  const listeners = [];
  let dispose;
  const settings = { describe: () => [{ ns: "llm-pi-ai", value: { providers: {} }, user: { providers: {} } }], mutate: async () => {} };
  plugin.apply({
    on: (name, listener, options) => listeners.push({ name, listener, options }),
    inject: (services, callback) => {
      assert.deepEqual(services, ["settings"]);
      callback({ settings, logger: { info() {}, warn() {} }, effect: (callback) => { dispose = callback(); } });
    },
  }, { providers: ["local-ollama", "local-everyday"], pollIntervalMs: 60_000, optInServices: ["beta"] });
  try {
    assert.equal(listeners[0].name, "agent/request");
    assert.equal(listeners[0].options.prepend, true);
    // A route written by a one-route-per-service release is rewritten to the
    // catalog route and the service that route answers with that name.
    assert.deepEqual(await listeners[0].listener({}, async () => ({ provider: "local-everyday", model: "qwen3.8-27b-abliterated-q6_k" })),
      { provider: "local-ollama", model: "nighttime" });
    assert.deepEqual(await listeners[0].listener({}, async () => ({ provider: "local-ollama", model: "nighttime" })),
      { provider: "local-ollama", model: "nighttime" }, "a selection onto the surviving route is left alone");
    assert.equal(typeof globalThis[Symbol.for("dsh-container.router-contract.v1")]?.report, "function");
  } finally { dispose?.(); }
  assert.equal(globalThis[Symbol.for("dsh-container.router-contract.v1")], undefined);
});
