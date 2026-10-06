/** Availability is descriptive in catalogs and enforced at the dispatch boundary. */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const marker = 'dsh-resident-availability-v1';
function replace(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error(`Resident availability source drift: ${before.slice(0, 100)}`);
  }
  return source.replace(before, after);
}
export function patchAdapter(input) {
  if (input.includes(marker)) return input;
  let s = input;
  s = replace(s, '\tmaxConcurrency: z.number().step(1).min(1),', '\tresidentUnavailable: z.boolean(),\n\tmaxConcurrency: z.number().step(1).min(1),');
  s = replace(s, '\tproviderInfo(provider) {', `\t// ${marker}
\tassertResidentAvailable(provider, model) {
\t\tif (this.profileOf(this.current(), provider).residentUnavailable === true) {
\t\t\tthrow new LlmError('Nighttime is unavailable: the router does not advertise ' + model + '. Select another model or wait for Nighttime to return.', 'MODEL_UNAVAILABLE');
\t\t}
\t}
\tproviderInfo(provider) {`);
  s = replace(s, '\t\t\t\tname: model.name,\n\t\t\t\tinputModalities: [...model.input]', '\t\t\t\tname: snapshot.profiles.get(provider).residentUnavailable ? "Nighttime — unavailable" : model.name,\n\t\t\t\tavailable: snapshot.profiles.get(provider).residentUnavailable !== true,\n\t\t\t\t...(snapshot.profiles.get(provider).residentUnavailable ? {} : { inputModalities: [...model.input] })');
  s = replace(s, '\t\tconst resolvedModel = this.modelOf(snapshot, provider, model);', '\t\tconst resolvedModel = this.modelOf(snapshot, provider, model);\n\t\tif (profile.residentUnavailable === true) return { provider, id: model, name: "Nighttime — unavailable" };');
  s = replace(s, '\tprepareCall(provider, model, _signal) {\n\t\tconst snapshot = this.current();', '\tprepareCall(provider, model, _signal) {\n\t\tthis.assertResidentAvailable(provider, model);\n\t\tconst snapshot = this.current();');
  s = replace(s, '\t\t\tconst profile = this.profileOf(snapshot, options.provider);', '\t\t\tthis.assertResidentAvailable(options.provider, options.model);\n\t\t\tconst profile = this.profileOf(snapshot, options.provider);');
  s = replace(s, '\t\t\t\treleaseConcurrency = await this.concurrency.acquire(profile, upstream);', '\t\t\t\treleaseConcurrency = await this.concurrency.acquire(profile, upstream);\n\t\t\t\tthis.assertResidentAvailable(options.provider, options.model);');
  return s;
}
export function patchRegistry(input) {
  if (input.includes(marker)) return input;
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
export function patchClient(input) {
  if (input.includes(marker)) return input;
  let s = replace(input, 'var ModelCatalogDirectory = class {', `// ${marker}\n\t\tvar ModelCatalogDirectory = class {`);
  s = replace(s, 'await this.catalog.load();', 'this.catalog.invalidate();\n\t\t\t\tawait this.catalog.load();');
  s = replace(s, 'this.catalog = new ModelCatalogDirectory(ctx);', `this.catalog = new ModelCatalogDirectory(ctx);
\t\t\t\tconst residentTimer = setInterval(() => { if (!this.catalog.inflight) this.catalog.refresh(); }, 30000);
\t\t\t\tctx.effect(() => () => clearInterval(residentTimer));`);
  s = replace(s, 'group.models.some((model) => model.id === selection.model)', 'group.models.some((model) => model.id === selection.model && model.available !== false)');
  s = replace(s, 'title: model.name,\n\t\t\t\t\t\t\t\t\t\t\t\t\tdisabled: busy,', 'title: model.name,\n\t\t\t\t\t\t\t\t\t\t\t\t\tdisabled: busy || model.available === false,');
  s = replace(s, 'if (rowId(group.id, model.id) !== id) continue;', 'if (rowId(group.id, model.id) !== id || model.available === false) continue;');
  return s;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
  for (const [file, patch] of [
    ['dsh-llm-pi-ai/lib/index.js', patchAdapter],
    ['dsh-llm/lib/index.js', patchRegistry],
    ['dsh-api-session-controller/lib/index.js', patchCatalog],
    ['dsh-client-ui-model-selection/lib/client.js', patchClient],
  ]) {
    const path = `${root}/${file}`;
    await writeFile(path, patch(await readFile(path, 'utf8')));
  }
}
