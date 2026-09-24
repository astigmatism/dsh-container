#!/usr/bin/env python3
"""Canonical content must be restored without rewriting unchanged dependencies."""
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parent.parent / 'scripts/sync-runtime-profile.sh'


class RuntimeProfileSyncTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.seed = self.root / 'seed'
        self.runtime = self.root / 'runtime'
        self.web = self.seed / 'profiles/web'
        self.installed = self.runtime / 'profiles/web'
        (self.web / 'node_modules/tool').mkdir(parents=True)
        (self.seed / '.dsh-plugins').mkdir()
        (self.seed / '.dsh-plugins/local.js').write_text('canonical plugin')
        (self.seed / 'plugin-inventory.txt').write_text('canonical inventory')
        (self.web / 'package.json').write_text('{"version":"one"}')
        tool = self.web / 'node_modules/tool/run.js'
        tool.write_text('canonical executable')
        tool.chmod(0o755)
        (self.web / 'tool-link').symlink_to('node_modules/tool/run.js')
        (self.web / 'dangling-link').symlink_to('not-installed')
        (self.runtime / 'sessions').mkdir(parents=True)
        (self.runtime / 'sessions/saved').write_text('saved conversation')
        (self.runtime / 'settings.yaml').write_text('private settings')

    def run_sync(self, runtime=None, success=True):
        result = subprocess.run(['sh', str(SCRIPT)], env=dict(
            os.environ, DSH_SEED_HOME=str(self.seed), DSH_HOME=str(runtime or self.runtime)),
            capture_output=True, text=True, timeout=30)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual((self.runtime / 'sessions/saved').read_text(), 'saved conversation')
            self.assertEqual((self.runtime / 'settings.yaml').read_text(), 'private settings')
            self.assertFalse(list(self.runtime.rglob('.dsh-sync-*')))
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def test_fresh_install_then_unchanged_restart_preserves_files(self):
        self.run_sync()
        tool = self.installed / 'node_modules/tool/run.js'
        self.assertEqual(tool.read_text(), 'canonical executable')
        self.assertEqual(stat.S_IMODE(tool.stat().st_mode), 0o755)
        self.assertEqual(os.readlink(self.installed / 'tool-link'), 'node_modules/tool/run.js')
        self.assertTrue((self.installed / 'dangling-link').is_symlink())
        before = {p.relative_to(self.runtime): (p.stat().st_ino, p.stat().st_mtime_ns)
                  for p in self.runtime.rglob('*') if p.is_file() and not p.is_symlink()}
        result = self.run_sync()
        after = {p.relative_to(self.runtime): (p.stat().st_ino, p.stat().st_mtime_ns)
                 for p in self.runtime.rglob('*') if p.is_file() and not p.is_symlink()}
        self.assertEqual(before, after)
        self.assertIn('0 files updated, 0 obsolete entries removed', result.stdout)

    def test_writable_profile_survives_sync_and_managed_defaults_are_repaired(self):
        (self.web / 'cordis.patch.yml').write_text('[]\n')
        (self.web / 'managed').mkdir()
        (self.web / 'managed/cordis.patch.yml').write_text('managed defaults')
        self.run_sync()
        user = self.installed / 'cordis.patch.yml'
        preference = '- id: ui-theme\n  config:\n    theme: dark\n'
        user.write_text(preference)
        user.chmod(0o600)
        for _ in range(2):
            (self.installed / 'managed/cordis.patch.yml').write_text('drift')
            self.run_sync()
            self.assertEqual(user.read_text(), preference)
            self.assertEqual(stat.S_IMODE(user.stat().st_mode), 0o600)
            self.assertEqual((self.installed / 'managed/cordis.patch.yml').read_text(), 'managed defaults')

    def test_same_size_same_timestamp_edits_are_repaired(self):
        (self.web / 'unreadable.txt').write_text('canonical data')
        self.run_sync()
        target = self.installed / 'package.json'
        before = target.stat()
        target.write_text('{"version":"bad"}')
        os.utime(target, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(target.stat().st_size, before.st_size)
        (self.installed / 'unreadable.txt').chmod(0o000)
        tool = self.installed / 'node_modules/tool/run.js'
        tool.chmod(0o644)
        (self.installed / 'node_modules/tool').chmod(0o555)
        try:
            self.run_sync()
        finally:
            (self.installed / 'node_modules/tool').chmod(0o755)
        self.assertEqual(target.read_bytes(), (self.web / 'package.json').read_bytes())
        self.assertEqual((self.installed / 'unreadable.txt').read_text(), 'canonical data')
        self.assertEqual(stat.S_IMODE(tool.stat().st_mode), 0o755)

    def test_upgrade_and_obsolete_plugins_preserve_unrelated_profiles(self):
        self.run_sync()
        stable = self.installed / 'node_modules/tool/run.js'
        inode = stable.stat().st_ino
        (self.web / 'package.json').write_text('{"version":"two"}')
        (self.web / 'new.js').write_text('new dependency')
        (self.seed / '.dsh-plugins/local.js').unlink()
        (self.installed / 'obsolete/subdir').mkdir(parents=True)
        (self.installed / 'obsolete/subdir/plugin.js').write_text('obsolete')
        custom = self.runtime / 'profiles/another-profile'
        custom.mkdir()
        (custom / 'settings').write_text('custom profile')
        self.run_sync()
        self.assertEqual(stable.stat().st_ino, inode)
        self.assertEqual((self.installed / 'new.js').read_text(), 'new dependency')
        self.assertFalse((self.installed / 'obsolete').exists())
        self.assertFalse((self.runtime / '.dsh-plugins/local.js').exists())
        self.assertEqual((custom / 'settings').read_text(), 'custom profile')

    def test_conflicting_types_and_external_symlinks_are_replaced_safely(self):
        self.run_sync()
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'saved').write_text('must survive')
        tool = self.installed / 'node_modules/tool'
        (tool / 'run.js').unlink()
        tool.rmdir()
        tool.symlink_to(outside, target_is_directory=True)
        package = self.installed / 'package.json'
        package.unlink()
        package.symlink_to(outside / 'saved')
        link = self.installed / 'tool-link'
        link.unlink()
        link.mkdir()
        (link / 'extra').write_text('remove this conflicting directory')
        (self.installed / 'obsolete-link').symlink_to(outside, target_is_directory=True)
        self.run_sync()
        self.assertFalse(tool.is_symlink())
        self.assertFalse(package.is_symlink())
        self.assertTrue(link.is_symlink())
        self.assertFalse((self.installed / 'obsolete-link').exists())
        self.assertEqual(sorted(p.name for p in outside.iterdir()), ['saved'])
        self.assertEqual((outside / 'saved').read_text(), 'must survive')

    def test_repair_does_not_chmod_external_hard_links(self):
        self.run_sync()
        outside = self.root / 'external-tool'
        outside.write_text('canonical executable')
        outside.chmod(0o600)
        target = self.installed / 'node_modules/tool/run.js'
        target.unlink()
        os.link(outside, target)
        self.run_sync()
        self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o755)
        self.assertNotEqual(outside.stat().st_ino, target.stat().st_ino)

    def test_unsafe_aliases_and_missing_seed_fail_before_user_data_changes(self):
        alias = self.root / 'seed-alias'
        alias.symlink_to(self.seed, target_is_directory=True)
        self.run_sync(runtime=alias, success=False)
        (self.runtime / 'profiles').symlink_to(self.seed / 'profiles', target_is_directory=True)
        self.run_sync(success=False)
        (self.runtime / 'profiles').unlink()
        (self.seed / 'plugin-inventory.txt').unlink()
        self.run_sync(success=False)
        self.assertFalse(self.installed.exists())
        self.assertEqual((self.runtime / 'sessions/saved').read_text(), 'saved conversation')
        self.assertEqual((self.runtime / 'settings.yaml').read_text(), 'private settings')


if __name__ == '__main__':
    unittest.main()
