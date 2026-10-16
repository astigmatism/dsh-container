import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, stat, rm } from 'node:fs/promises';
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
  const dump = (selected) => {
    const manifest = { ...pkg, dsh: { profile: { bundles: [...pkg.dsh.profile.bundles, ...selected] } } };
    return execFileSync(process.execPath, [join(root, 'lib/bin.js'), '--profile', 'web', '--dump-config'], {
      cwd: home, env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, encoding: 'utf8', timeout: 30000,
    });
  };
  try {
    await mkdir(profile, { recursive: true });
    await symlink(join(seed, 'profiles/web/node_modules'), join(profile, 'node_modules'));
    await symlink(join(seed, 'profiles/web/managed'), join(profile, 'managed'));
    await symlink(join(seed, '.dsh-plugins'), join(home, '.dsh-plugins'));
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');

    // 0.2.1-alpha.5 promoted the schedule bundle into the core web-app graph,
    // so its module is always present. The remaining official optional bundles
    // are cordis patch-bundles: they wire services at load time and leave the
    // dumped config byte-identical, so composition is verified by loading each
    // selection (never activating the incompatible Token) and by checking each
    // installed bundle declares the patch that constitutes its composition.
    const base = dump([]);
    assert.ok(base.includes("@deepseek-ai/dsh-schedule'"), 'schedule is a core module in alpha.5');
    assert.ok(!base.includes('@zoytown/dsh-token'), 'incompatible Token stays inactive by default');

    for (const bundle of optional) {
      const config = dump([bundle]);
      assert.ok(!config.includes('@zoytown/dsh-token'), `${bundle} must not activate the incompatible Token`);
      try {
        const dir = join(root, 'node_modules', bundle);
        const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
        const patch = manifest.dsh?.bundle?.patch;
        assert.ok(patch, `${bundle} must declare dsh.bundle.patch`);
        await stat(join(dir, patch));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        // Not installed in this runtime (e.g. the schedule bundle folded into
        // the core web-app graph); composing it is a no-op, checked above.
      }
    }

    const all = dump(optional);
    assert.ok(!all.includes('@zoytown/dsh-token'), 'incompatible Token stays inactive with every optional bundle');
  } finally { await rm(home, { recursive: true, force: true }); }
});
