import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const enabled = process.env.DSH_TEST_HARNESS === '1';
test('official optional bundles compose when selected and stay absent otherwise', { skip: !enabled }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-bundles-'));
  const seed = process.env.DSH_SEED_HOME || '/opt/dsh-seed';
  const root = process.env.DSH_RUNTIME_ROOT || '/usr/local/lib/node_modules/@deepseek-ai/dsh';
  const profile = join(home, 'profiles/web');
  const pkg = JSON.parse(await readFile(join(seed, 'profiles/web/package.json'), 'utf8'));
  const optional = pkg.dshContainer.optionalBundles;
  const modules = ['dsh-experimental-agent-team', 'dsh-experimental-speech-to-text', 'dsh-experimental-auto-review', 'dsh-schedule'];
  try {
    await mkdir(profile, { recursive: true });
    await symlink(join(seed, 'profiles/web/node_modules'), join(profile, 'node_modules'));
    await symlink(join(seed, 'profiles/web/managed'), join(profile, 'managed'));
    await symlink(join(seed, '.dsh-plugins'), join(home, '.dsh-plugins'));
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
    for (const selected of [[], ...optional.map(bundle => [bundle]), optional]) {
      const manifest = { ...pkg, dsh: { profile: { bundles: [...pkg.dsh.profile.bundles, ...selected] } } };
      await writeFile(join(profile, 'package.json'), JSON.stringify(manifest));
      const config = execFileSync(process.execPath, [join(root, 'lib/bin.js'), '--profile', 'web', '--dump-config'], {
        cwd: home, env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, encoding: 'utf8', timeout: 30000,
      });
      for (const [i, module] of modules.entries()) assert.equal(config.includes(`@deepseek-ai/${module}'`) || config.includes(`@deepseek-ai/${module}\n`), selected.includes(optional[i]), module);
      assert.ok(!config.includes('@zoytown/dsh-token'), 'incompatible Token stays inactive');
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
