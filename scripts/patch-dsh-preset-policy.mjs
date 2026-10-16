#!/usr/bin/env node
/** Apply the maintained policy to upstream preset declarations, preserving their tools. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const root = process.env.DSH_RUNTIME_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh';
const require = createRequire(`${root}/package.json`);
const YAML = require('yaml');
const options = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] };
const managed = YAML.parse(fs.readFileSync(process.argv[2] ?? '/opt/dsh-seed/profiles/web/managed/cordis.patch.yml', 'utf8'), options);
const ids = ['compaction-basic', 'command-compact', 'tool-result-pruner'];
const policies = new Map(ids.map(id => [id, managed.find(row => row.id === id)]));
assert.ok([...policies.values()].every(Boolean));
const pkg = `${root}/node_modules/@deepseek-ai/dsh-web-app`;
assert.equal(JSON.parse(fs.readFileSync(`${pkg}/package.json`)).version, '0.2.1-alpha.5');
for (const preset of ['standard', 'ptc', 'cordis', 'minimal']) {
  const file = `${pkg}/presets/${preset}.patch.yml`;
  const document = YAML.parseDocument(fs.readFileSync(file, 'utf8'), options);
  assert.equal(document.errors.length, 0);
  const plugins = document.getIn([0, 'insert', 0, 'config', 'plugins']);
  assert.ok(YAML.isSeq(plugins));
  let group = plugins.items.find(row => row.get('id') === 'compaction');
  if (!group) {
    assert.equal(preset, 'minimal', 'upstream preset lost its compaction group');
    group = document.createNode({ id: 'compaction', name: 'cordis:group', group: true,
      isolate: { compaction: true, toolResultPruner: true }, config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner' },
      ] });
    plugins.add(group);
  }
  for (const id of ids) {
    let row = group.get('config').items.find(row => row.get('id') === id);
    if (!row) {
      // 0.2.1 dropped the pruner from the minimal preset; the maintained
      // policy still ships it in every preset.
      assert.equal(id, 'tool-result-pruner', `${preset} missing ${id}`);
      row = document.createNode({ id, name: '@deepseek-ai/dsh-compaction-tool-result-pruner' });
      group.get('config').items.push(row);
    }
    row.set('disabled', false);
    if (policies.get(id).config) row.set('config', document.createNode(policies.get(id).config));
  }
  document.commentBefore = ' dsh-container-preset-policy-v1: defaults only; persisted user preset overrides apply later.';
  fs.writeFileSync(file, String(document));
}
console.log('Applied compaction/pruning policy to all four native presets; preset selection is unchanged.');
