/** Availability is descriptive in catalogs and enforced at the dispatch boundary.
 *
 * The router-model-discovery plugin records each resident's state in its
 * provider settings (`residentUnavailable` and `residentState`). This patch
 * shows exactly one state per model, fails dispatch at once for offline,
 * unavailable or incomplete models without consuming retries, lets a switching
 * router make requests wait, and accepts pre-service-ID model IDs of a
 * resident route during migration (docs/llm-router-contract.md §3, §5, §7).
 *
 * v4 puts that state on each model instead of on the route. A router publishes
 * a catalog, so one route carries every service that router offers and each
 * model row answers to its own entry in `residentStates`: a blocked model fails
 * dispatch at once and leaves `routableProviders`, while the route is blocked
 * only when its router cannot answer at all. `residentState` keeps the
 * route-level facts — the router's admission state, its configuration, the
 * services it currently offers, and the service that answers the document's own
 * default model, which is what a stale selection falls back to.
 *
 * v3 added the opt-in `modelPicker.availableOnly` picker filter, read from the
 * harness settings document (the profile patch, then the pre-0.2 settings
 * file). The flag rides the `modelCatalog` result as `availableOnly`; the
 * server catalog keeps reporting every model, and only the picker view
 * changes: with the filter on, the list holds models with
 * `available !== false` — a route draining a router switch is not offered
 * either — empty provider groups drop out, and a list with nothing to show
 * renders one status line. Default off: no setting, no file, or a value that
 * is not exactly `true` leaves the current picker untouched.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const marker = 'dsh-resident-availability-v4';
// One marker per revision of this script: every hunk family stamps `marker`, so
// a file carrying only an older one was written by an older release of this
// script. Such a tree is left as it was built (the hunks below are anchored on
// pristine source) and reported, because a stale runtime is a build problem.
const previousMarkers = ['dsh-resident-availability-v3', 'dsh-resident-availability-v2'];
const patchedAlready = (source) => source.includes(marker) || previousMarkers.some((value) => source.includes(value));
function replace(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error(`Resident availability source drift: ${before.slice(0, 100)}`);
  }
  return source.replace(before, after);
}
let yamlParseFn;
function parseYamlSettings(text) {
  // The installed Harness tree hoists the `yaml` package; resolve it lazily so
  // importing this script never requires the installation to exist.
  yamlParseFn ??= createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')('yaml').parse;
  return yamlParseFn(text);
}
/**
* Resolve the opt-in `modelPicker.availableOnly` picker filter from the
* harness settings document — the same surface the resident state is
* persisted to: the live profile patch, then the pre-0.2 settings file.
* The first readable document decides; a missing, unreadable or unparsable
* document leaves the filter off, as does every value but an exact `true`.
* @param env - environment for the profile and home directories.
* @param readText - read one candidate file (utf8).
* @param parseText - parse one settings document (YAML).
* @returns whether the picker offers only available models.
*/
export async function modelPickerAvailableOnly(env = process.env, readText = (file) => readFile(file, 'utf8'), parseText = parseYamlSettings) {
  const candidates = [];
  const profileDir = env.DSH_PROFILE_DIR;
  if (typeof profileDir === 'string' && profileDir.length > 0) candidates.push(join(profileDir, 'cordis.patch.yml'));
  const home = env.DSH_HOME;
  if (typeof home === 'string' && home.length > 0) candidates.push(join(home, 'profiles', 'web', 'cordis.patch.yml'), join(home, 'settings.yaml'));
  for (const file of candidates) {
    let text;
    try {
      text = await readText(file);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      return false;
    }
    let document;
    try {
      document = parseText(text);
    } catch (error) {
      return false;
    }
    if (Array.isArray(document)) return document.some((entry) => entry?.id === 'modelPicker' && entry?.config?.availableOnly === true);
    return document?.modelPicker?.availableOnly === true;
  }
  return false;
}
export function patchAdapter(input) {
  if (patchedAlready(input)) return input;
  let s = input;
  // Settings forms project only declared fields; declare the discovery-owned state.
  s = replace(s, '\tmaxConcurrency: z.number().step(1).min(1),', '\tresidentUnavailable: z.boolean(),\n\tresidentState: z.any(),\n\tresidentStates: z.any(),\n\tmaxConcurrency: z.number().step(1).min(1),');
  s = replace(s, '\tproviderInfo(provider) {', `\t// ${marker}
\tassertResidentAvailable(provider, model) {
\t\tconst snapshot = this.current();
\t\tconst profile = this.profileOf(snapshot, provider);
\t\tconst id = this.residentModelId(snapshot, profile, provider, model);
\t\tif (!this.residentModelBlocked(profile, id)) return;
\t\tconst message = [this.residentModelState(profile, id)?.message, profile.residentState?.message].find(value => typeof value === 'string' && value.length > 0);
\t\tthrow new LlmError(message ?? 'The selected router model is unavailable. Select another model.', 'MODEL_UNAVAILABLE');
\t}
\t/** A route is blocked only when its router answers nothing; a model is blocked on its own state (§4, §5). */
\tresidentModelBlocked(profile, model) {
\t\tif (profile?.residentUnavailable === true) return true;
\t\tconst status = this.residentModelState(profile, model)?.status;
\t\treturn status === 'offline' || status === 'unavailable' || status === 'incomplete';
\t}
\t/** The state discovery recorded for one model of this route. */
\tresidentModelState(profile, model) {
\t\tconst states = profile?.residentStates;
\t\tif (states === null || typeof states !== 'object') return undefined;
\t\tconst state = states[model];
\t\treturn state !== null && typeof state === 'object' ? state : undefined;
\t}
\tresidentName(profile, model, name) {
\t\tconst state = this.residentModelState(profile, model);
\t\tconst label = typeof state?.label === 'string' && state.label.length > 0 ? state.label : undefined;
\t\tif (label === undefined || (profile?.residentUnavailable !== true && state?.status === 'available')) return name;
\t\treturn label;
\t}
\t/**
\t * A selection written before a catalog drove the model list names a model this
\t * route no longer configures. The document states which service answers its own
\t * default model, so that service serves the request rather than the dispatch
\t * failing on a name the runtime retired.
\t */
\tresidentModelId(snapshot, profile, provider, model) {
\t\tif (snapshot.models.getModel(provider, model) !== void 0) return model;
\t\tconst fallback = profile?.residentState?.default;
\t\treturn typeof fallback === 'string' && snapshot.models.getModel(provider, fallback) !== void 0 ? fallback : model;
\t}
\tproviderInfo(provider) {`);
  s = replace(s, '\tmodelOf(snapshot, provider, model) {\n\t\tconst profile = this.profileOf(snapshot, provider);', '\tmodelOf(snapshot, provider, model) {\n\t\tconst profile = this.profileOf(snapshot, provider);\n\t\tmodel = this.residentModelId(snapshot, profile, provider, model);');
  s = replace(s, '\t\t\t\tname: model.name,\n\t\t\t\tinputModalities: [...model.input]', '\t\t\t\tname: this.residentName(snapshot.profiles.get(provider), model.id, model.name),\n\t\t\t\tavailable: !this.residentModelBlocked(snapshot.profiles.get(provider), model.id),\n\t\t\t\t...(this.residentModelBlocked(snapshot.profiles.get(provider), model.id) ? {} : { inputModalities: [...model.input] })');
  s = replace(s, '\t\tconst resolvedModel = this.modelOf(snapshot, provider, model);', '\t\tconst resolvedModel = this.modelOf(snapshot, provider, model);\n\t\tif (this.residentModelBlocked(profile, resolvedModel.id ?? model)) return { provider, id: model, name: this.residentName(profile, resolvedModel.id ?? model, resolvedModel.name) };');
  s = replace(s, 'const configuredMaxTokens = profile.configuredMaxTokens.get(model);', 'const configuredMaxTokens = profile.configuredMaxTokens.get(resolvedModel.id ?? model);');
  s = replace(s, '\t\t\tname: resolvedModel.name,', '\t\t\tname: this.residentName(profile, resolvedModel.id ?? model, resolvedModel.name),');
  s = replace(s, '\tprepareCall(provider, model, _signal) {\n\t\tconst snapshot = this.current();', '\tprepareCall(provider, model, _signal) {\n\t\tthis.assertResidentAvailable(provider, model);\n\t\tconst snapshot = this.current();');
  s = replace(s, '\t\t\tconst profile = this.profileOf(snapshot, options.provider);', '\t\t\tthis.assertResidentAvailable(options.provider, options.model);\n\t\t\tconst profile = this.profileOf(snapshot, options.provider);');
  s = replace(s, '\t\t\t\treleaseConcurrency = await this.concurrency.acquire(profile, upstream);', '\t\t\t\treleaseConcurrency = await this.concurrency.acquire(profile, upstream);\n\t\t\t\tthis.assertResidentAvailable(options.provider, options.model);');
  return s;
}
/** Contract §7: wait 2 → 30 s while the router drains or is in maintenance. */
export const ROUTER_SWITCHING_POLICY = Object.freeze({ mode: 'always', initialDelayMs: 2000, maxDelayMs: 30000, jitterRatio: 0 });
export function routerSwitchingDelay(retry) {
  return Math.min(ROUTER_SWITCHING_POLICY.initialDelayMs * 2 ** Math.min(Math.max(retry - 1, 0), 16), ROUTER_SWITCHING_POLICY.maxDelayMs);
}
export function patchRetry(input) {
  if (patchedAlready(input)) return input;
  return replace(input, 'async function recover({ agent, turn, step, provider, failure, retryPolicy: policy, signal }, next) {', `async function recover({ agent, turn, step, provider, failure, retryPolicy: policy, signal }, next) {
        // ${marker}: an unavailable selection is terminal, even under always-retry.
        if (failure.code === 'MODEL_UNAVAILABLE') return;
        // ${marker}: a draining router is waited out on its own chain, without
        // consuming the provider's retry budget. Every attempt prepares the call
        // again, so a model that went offline in the new configuration fails then.
        if (failure.code === 'ROUTER_SWITCHING') {
            const switching = ${JSON.stringify(ROUTER_SWITCHING_POLICY)};
            const switchingKey = JSON.stringify(['router-switching', switching.initialDelayMs, switching.maxDelayMs]);
            const prior = ctx.sessionProjections.stateOf(agent.session, "llmRetry")[retryStateKey(provider, switchingKey)];
            const attempt = (prior?.retry ?? 0) + 1;
            const delay = Math.min(switching.initialDelayMs * 2 ** Math.min(attempt - 1, 16), switching.maxDelayMs);
            return backoff(agent, turn, step, failure, provider, switching, switchingKey, attempt, prior?.retryId ?? RetryId(randomUUID()), delay, signal);
        }`);
}
export function patchRegistry(input) {
  if (patchedAlready(input) || input.includes('dsh-resident-availability-v1')) return input;
  return replace(input, '\t\t\t\t\tname: model.name,', `\t\t\t\t\tname: model.name,
\t\t\t\t\t// ${marker}: preserve descriptive availability through the registry.
\t\t\t\t\t...(model.available === false ? { available: false } : {}),`);
}
export function patchCatalog(input) {
  // A tree carrying an earlier revision of this patch is left as it was built:
  // production installs patch a pristine runtime, where each hunk applies once.
  if (patchedAlready(input)) return input;
  let s = input;
  {
    s = replace(s, 'async function buildModelCatalog(ctx, defaultSelection', `// ${marker}\nasync function buildModelCatalog(ctx, defaultSelection`);
    s = replace(s, '\t\t\t\tconst resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);', '\t\t\t\tif (model.available === false) return { id: model.id, name: model.name, available: false };\n\t\t\t\tconst resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);');
    s = replace(s, 'routableProviders: groups.map((group) => group.id)', 'routableProviders: groups.filter(group => group.models.some(model => model.available !== false)).map((group) => group.id)');
    s = replace(s, 'return models.some((model) => model.id === selection.model);', 'return models.some((model) => model.id === selection.model && model.available !== false);');
  }
  // v3: the flag rides the catalog result; the server keeps reporting every
  // model, the client decides the view. The settings document is the same
  // surface the resident state is persisted to, read here because the
  // standalone section is not a registered settings entry.
  if (s.includes('import { mkdir } from "node:fs/promises";')) {
    s = replace(s, 'import { mkdir } from "node:fs/promises";', 'import { mkdir, readFile } from "node:fs/promises";\nimport { parse as parseYamlSettings } from "yaml";');
  }
  if (s.includes('import { isAbsolute, resolve } from "node:path";')) {
    s = replace(s, 'import { isAbsolute, resolve } from "node:path";', 'import { isAbsolute, join, resolve } from "node:path";');
  }
  s = replace(s, 'async function buildModelCatalog(ctx, defaultSelection = ctx.agentDefaultModel.currentSelection()) {', `${modelPickerAvailableOnly.toString()}\nasync function buildModelCatalog(ctx, defaultSelection = ctx.agentDefaultModel.currentSelection()) {`);
  s = replace(s, '\tconst providers = ctx.llm.listProviders();', '\tconst availableOnly = await modelPickerAvailableOnly();\n\tconst providers = ctx.llm.listProviders();');
  s = replace(s, '\t\tgroups,\n\t\tfailures: catalog.flatMap((item) => item.kind === "failure" ? [item.failure] : [])', '\t\tgroups,\n\t\tavailableOnly,\n\t\tfailures: catalog.flatMap((item) => item.kind === "failure" ? [item.failure] : [])');
  return s;
}
export function patchCatalogCodec(input) {
  if (patchedAlready(input)) return input;
  // Only the modelCatalog result's model descriptor, never arbitrary names.
  const start = input.indexOf('const _deepseek_ai_dsh_api_session_controller_session_modelCatalog_result$schema =');
  const end = input.indexOf('let _deepseek_ai_dsh_api_session_controller_session_openWorkspacePath', start);
  if (start < 0 || end < 0) throw new Error('Resident availability source drift: model catalog codec');
  let section = input.slice(start, end);
  // Generated-codec dialects: bundled ("models": array(object({), plain
  // ('models': z.array(z.object({) and remotes ("models": zod.z.array(zod.z.object({).
  const modelsLine = section.match(/^([ \t]*)("|')models\2: (?:(?:zod\.z|z)\.)?array\((?:(?:zod\.z|z)\.)?object\(\{$/m);
  if (modelsLine === undefined) throw new Error('Resident availability source drift: model catalog codec descriptor');
  const prefix = section.includes('zod.z.array') ? 'zod.z.' : section.includes('z.array') ? 'z.' : '';
  const availableDecl = `${modelsLine[1]}${modelsLine[2]}available${modelsLine[2]}: ${prefix}boolean().optional(),`;
  // Each hunk applies once: an older release may already carry the field.
  if (!section.includes(`${modelsLine[2]}available${modelsLine[2]}: ${prefix}boolean().optional(),`)) {
    section = replace(section, modelsLine[0], modelsLine[0] + '\n' + availableDecl);
  }
  const routableLine = section.match(/^([ \t]*)("|')routableProviders\2: (?:(?:zod\.z|z)\.)?array\((?:(?:zod\.z|z)\.)?string\(\)\)\.readonly\(\)(?:\.describe\(.*\))?,\s*$/m);
  if (routableLine === undefined) throw new Error('Resident availability source drift: routableProviders codec');
  const availableOnlyDecl = `${routableLine[1]}${routableLine[2]}availableOnly${routableLine[2]}: ${prefix}boolean().optional(),`;
  if (!section.includes(`${routableLine[2]}availableOnly${routableLine[2]}: ${prefix}boolean().optional(),`)) {
    section = replace(section, routableLine[0], availableOnlyDecl + '\n' + routableLine[0]);
  }
  return input.slice(0, start) + '// ' + marker + '\n' + section + input.slice(end);
}
export function patchClient(input) {
  if (patchedAlready(input)) return input;
  let s = input;
  {
    s = replace(s, 'var ModelCatalogDirectory = class {', `// ${marker}\n\t\tvar ModelCatalogDirectory = class {`);
    // Opening a picker re-reads the catalog; discovery pushes every state change
    // through settings/document-updated, so no client-side polling is needed.
    s = replace(s, 'await this.catalog.load();', 'this.catalog.invalidate();\n\t\t\t\tawait this.catalog.load();');
    s = replace(s, 'group.models.some((model) => model.id === selection.model)', 'group.models.some((model) => model.id === selection.model && model.available !== false)');
    s = replace(s, 'title: model.name,\n\t\t\t\t\t\t\t\t\t\t\t\t\tdisabled: busy,', 'title: model.name,\n\t\t\t\t\t\t\t\t\t\t\t\t\tdisabled: busy || model.available === false,');
    s = replace(s, 'const choose = (selection) => {', `const choose = (selection) => {
                if (!choices.some(choice => choice.selection.provider === selection.provider && choice.selection.model === selection.model && choice.model.available !== false)) return;`);
    s = replace(s, 'for (const model of group.models) this.reasoning.set(', 'for (const model of group.models) if (model.available !== false) this.reasoning.set(');
    s = replace(s, 'if (rowId(group.id, model.id) !== id) continue;', 'if (rowId(group.id, model.id) !== id || model.available === false) continue;');
  }
  // v3: the opt-in availableOnly filter, transported on the catalog result.
  // The raw groups keep every model; only this view changes.
  s = replace(s, 'routable: null,\n\t\t\t\t\t\tgroups: catalog.value?.groups ?? [],', 'routable: null,\n\t\t\t\t\t\tavailableOnly: catalog.value?.availableOnly === true,\n\t\t\t\t\t\tgroups: catalog.value?.groups ?? [],');
  s = replace(s, 'routable,\n\t\t\t\t\tgroups: catalog.value.groups,', 'routable,\n\t\t\t\t\tavailableOnly: catalog.value.availableOnly === true,\n\t\t\t\t\tgroups: catalog.value.groups,');
  s = replace(s, 'const groups = (0, react.useMemo)(() => orderModelProviders(state.groups).map((group) => ({', 'const groups = (0, react.useMemo)(() => orderModelProviders(state.availableOnly === true ? state.groups.map((group) => ({ ...group, models: group.models.filter(availableOnlyModel) })).filter((group) => group.models.length > 0) : state.groups).map((group) => ({');
  s = replace(s, '})), [state.groups, accountProviderName]);', '})), [state.groups, state.availableOnly, accountProviderName]);');
  s = replace(s, '\t\t/** Dictionary namespace owned by this plugin. */', `\t\t/** Resident-state suffix the discovery plugin writes into a row name while a router switch drains. */
\t\tconst ROUTER_SWITCHING_SUFFIX = ' — router switching configuration';
\t\t/** Whether one catalog row stays in the availableOnly picker view. */
\t\tfunction availableOnlyModel(model) {
\t\t\treturn model.available !== false && !(typeof model.name === 'string' && model.name.endsWith(ROUTER_SWITCHING_SUFFIX));
\t\t}
\t\t/** Whether any raw catalog row reports a router switch in progress. */
\t\tfunction routerSwitchingActive(groups) {
\t\t\treturn groups.some((group) => group.models.some((model) => typeof model.name === 'string' && model.name.endsWith(ROUTER_SWITCHING_SUFFIX)));
\t\t}
\t\t/** Dictionary namespace owned by this plugin. */`);
  s = replace(s, 'children: t(choices.length === 0 ? "empty.models" : "search.empty")', 'children: state.availableOnly === true && choices.length === 0 && routerSwitchingActive(state.groups) ? t("status.waitingRouter") : t(choices.length === 0 ? "empty.models" : "search.empty")');
  s = replace(s, '\t\t\t"empty.models": "暂无可用模型",', '\t\t\t"empty.models": "暂无可用模型",\n\t\t\t"status.waitingRouter": "正在等待路由器切换…",');
  s = replace(s, '\t\t\t"empty.models": "No models available.",', '\t\t\t"empty.models": "No models available.",\n\t\t\t"status.waitingRouter": "Waiting on the router…",');
  return s;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--profile-registry') {
    const file = process.argv[3] + '/dsh-llm/lib/index.js';
    await writeFile(file, patchRegistry(await readFile(file, 'utf8')));
  } else {
  const root = process.argv[2] ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
  // A tree that already carries an earlier revision is left as it was built, which
  // for this release means it does not yet know about per-model state. That is a
  // build problem, not something to discover at runtime.
  const stale = [];
  for (const [file, patch] of [
    ['dsh-llm-pi-ai/lib/index.js', patchAdapter],
    ['dsh-llm/lib/index.js', patchRegistry],
    ['dsh-llm-retry/lib/index.js', patchRetry],
    ['dsh-api-session-controller/lib/index.js', patchCatalog],
    ['dsh-client-ui-model-selection/lib/client.js', patchClient],
    ['dsh-api-session-controller/lib/typert.host.js', patchCatalogCodec],
    ['dsh-api-session-controller/lib/typert.remote-client.js', patchCatalogCodec],
    ['dsh-api-remotes/lib/client.js', patchCatalogCodec],
  ]) {
    const path = `${root}/${file}`;
    const source = await readFile(path, 'utf8');
    const patched = patch(source);
    if (patched === source && previousMarkers.some(value => source.includes(value))) stale.push(file);
    await writeFile(path, patched);
  }
  if (stale.length > 0) {
    console.error(`dsh-resident-availability: left ${stale.join(', ')} at an earlier revision; `
      + `${marker} patches a pristine runtime, so build the image from one`);
    process.exitCode = 23;
  }
}
}
