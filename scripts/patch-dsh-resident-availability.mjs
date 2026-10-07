/** Availability is descriptive in catalogs and enforced at the dispatch boundary.
 *
 * The router-model-discovery plugin records each resident's state in its
 * provider settings (`residentUnavailable` and `residentState`). This patch
 * shows exactly one state per model, fails dispatch at once for offline,
 * unavailable or incomplete models without consuming retries, lets a switching
 * router make requests wait, and accepts pre-service-ID model IDs of a
 * resident route during migration (docs/llm-router-contract.md §3, §5, §7).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const marker = 'dsh-resident-availability-v2';
function replace(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error(`Resident availability source drift: ${before.slice(0, 100)}`);
  }
  return source.replace(before, after);
}
export function patchAdapter(input) {
  if (input.includes(marker)) return input;
  let s = input;
  // Settings forms project only declared fields; declare the discovery-owned state.
  s = replace(s, '\tmaxConcurrency: z.number().step(1).min(1),', '\tresidentUnavailable: z.boolean(),\n\tresidentState: z.any(),\n\tmaxConcurrency: z.number().step(1).min(1),');
  s = replace(s, '\tproviderInfo(provider) {', `\t// ${marker}
\tassertResidentAvailable(provider, model) {
\t\tconst profile = this.profileOf(this.current(), provider);
\t\tif (profile.residentUnavailable === true) {
\t\t\tconst message = profile.residentState?.message;
\t\t\tthrow new LlmError(typeof message === 'string' && message.length > 0 ? message : 'Nighttime is unavailable: the router does not offer it. Select another model or wait for Nighttime to return.', 'MODEL_UNAVAILABLE');
\t\t}
\t}
\tresidentName(profile, name) {
\t\tconst label = profile?.residentState?.label;
\t\tif (profile?.residentUnavailable === true) return typeof label === 'string' && label.length > 0 ? label : 'Nighttime — unavailable';
\t\treturn typeof label === 'string' && label.length > 0 && profile.residentState.status !== 'available' ? label : name;
\t}
\tresidentModelId(snapshot, profile, provider, model) {
\t\tconst service = profile?.residentState?.service;
\t\tif (typeof service !== 'string' || model === service || snapshot.models.getModel(provider, model) !== void 0) return model;
\t\treturn snapshot.models.getModel(provider, service) !== void 0 ? service : model;
\t}
\tproviderInfo(provider) {`);
  s = replace(s, '\tmodelOf(snapshot, provider, model) {\n\t\tconst profile = this.profileOf(snapshot, provider);', '\tmodelOf(snapshot, provider, model) {\n\t\tconst profile = this.profileOf(snapshot, provider);\n\t\tmodel = this.residentModelId(snapshot, profile, provider, model);');
  s = replace(s, '\t\t\t\tname: model.name,\n\t\t\t\tinputModalities: [...model.input]', '\t\t\t\tname: this.residentName(snapshot.profiles.get(provider), model.name),\n\t\t\t\tavailable: snapshot.profiles.get(provider).residentUnavailable !== true,\n\t\t\t\t...(snapshot.profiles.get(provider).residentUnavailable ? {} : { inputModalities: [...model.input] })');
  s = replace(s, '\t\tconst resolvedModel = this.modelOf(snapshot, provider, model);', '\t\tconst resolvedModel = this.modelOf(snapshot, provider, model);\n\t\tif (profile.residentUnavailable === true) return { provider, id: model, name: this.residentName(profile, resolvedModel.name) };');
  s = replace(s, 'const configuredMaxTokens = profile.configuredMaxTokens.get(model);', 'const configuredMaxTokens = profile.configuredMaxTokens.get(resolvedModel.id ?? model);');
  s = replace(s, '\t\t\tname: resolvedModel.name,', '\t\t\tname: this.residentName(profile, resolvedModel.name),');
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
  if (input.includes(marker)) return input;
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
  if (input.includes(marker) || input.includes('dsh-resident-availability-v1')) return input;
  return replace(input, '\t\t\t\t\tname: model.name,', `\t\t\t\t\tname: model.name,
\t\t\t\t\t// ${marker}: preserve descriptive availability through the registry.
\t\t\t\t\t...(model.available === false ? { available: false } : {}),`);
}
export function patchCatalog(input) {
  if (input.includes(marker)) return input;
  let s = replace(input, 'async function buildModelCatalog(ctx, defaultSelection', `// ${marker}\nasync function buildModelCatalog(ctx, defaultSelection`);
  s = replace(s, '\t\t\t\tconst resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);', '\t\t\t\tif (model.available === false) return { id: model.id, name: model.name, available: false };\n\t\t\t\tconst resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);');
  s = replace(s, 'routableProviders: groups.map((group) => group.id)', 'routableProviders: groups.filter(group => group.models.some(model => model.available !== false)).map((group) => group.id)');
  s = replace(s, 'return models.some((model) => model.id === selection.model);', 'return models.some((model) => model.id === selection.model && model.available !== false);');
  return s;
}
export function patchCatalogCodec(input) {
  const codecMarker = 'dsh-resident-availability-v1-codec';
  if (input.includes(codecMarker)) return input;
  // Only the modelCatalog result's model descriptor, never arbitrary names.
  const start = input.indexOf('const _deepseek_ai_dsh_api_session_controller_session_modelCatalog_result$schema =');
  const end = input.indexOf('let _deepseek_ai_dsh_api_session_controller_session_openWorkspacePath', start);
  if (start < 0 || end < 0) throw new Error('Resident availability source drift: model catalog codec');
  let section = input.slice(start, end);
  const bundled = section.includes('"models": array(object({');
  const before = bundled ? '"models": array(object({' : "'models': z.array(z.object({";
  section = replace(section, before, before + (bundled ? '\n"available": boolean().optional(),' : "\n'available': z.boolean().optional(),"));
  return input.slice(0, start) + '// ' + codecMarker + '\n' + section + input.slice(end);
}
export function patchClient(input) {
  if (input.includes(marker)) return input;
  let s = replace(input, 'var ModelCatalogDirectory = class {', `// ${marker}\n\t\tvar ModelCatalogDirectory = class {`);
  // Opening a picker re-reads the catalog; discovery pushes every state change
  // through settings/document-updated, so no client-side polling is needed.
  s = replace(s, 'await this.catalog.load();', 'this.catalog.invalidate();\n\t\t\t\tawait this.catalog.load();');
  s = replace(s, 'group.models.some((model) => model.id === selection.model)', 'group.models.some((model) => model.id === selection.model && model.available !== false)');
  s = replace(s, 'title: model.name,\n\t\t\t\t\t\t\t\t\t\t\t\t\tdisabled: busy,', 'title: model.name,\n\t\t\t\t\t\t\t\t\t\t\t\t\tdisabled: busy || model.available === false,');
  s = replace(s, 'const choose = (selection) => {', `const choose = (selection) => {
                if (!choices.some(choice => choice.selection.provider === selection.provider && choice.selection.model === selection.model && choice.model.available !== false)) return;`);
  s = replace(s, 'for (const model of group.models) this.reasoning.set(', 'for (const model of group.models) if (model.available !== false) this.reasoning.set(');
  s = replace(s, 'if (rowId(group.id, model.id) !== id) continue;', 'if (rowId(group.id, model.id) !== id || model.available === false) continue;');
  return s;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--profile-registry') {
    const file = process.argv[3] + '/dsh-llm/lib/index.js';
    await writeFile(file, patchRegistry(await readFile(file, 'utf8')));
  } else {
  const root = process.argv[2] ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
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
    await writeFile(path, patch(await readFile(path, 'utf8')));
  }
}
}
