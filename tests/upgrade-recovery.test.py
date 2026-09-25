#!/usr/bin/env python3
"""Recovery exercises use real disposable files and a fake Docker boundary."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).resolve().parents[1] / 'scripts/upgrade-recovery.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name)
        self.point = self.project / 'data/upgrade-recovery/test'
        self.point.mkdir(parents=True, mode=0o700)
        self.calls = []
        self.command = patch.object(recovery, 'run', side_effect=self.run_command)
        self.command.start()
        self.addCleanup(self.command.stop)
        for relative in recovery.ROOTS:
            directory = self.project / relative
            directory.mkdir(parents=True)
            (directory / 'preserved').write_bytes(b'old bytes\x00\xff')
            os.chmod(directory / 'preserved', 0o600)
        (self.project / 'data/dsh/link').symlink_to('preserved')
        (self.project / '.env').write_text('PRIVATE_PASSWORD=$literal-value\n')
        os.chmod(self.project / '.env', 0o600)
        recovery.copy_file(self.project / '.env', self.point / '.env')
        recovery.write_json(self.point / 'state.json', {'project': str(self.project), 'stage': 'prepared'})
        self.before = {relative: recovery.inventory(self.project / relative) for relative in (*recovery.ROOTS, '.env')}

    def run_command(self, args):
        self.calls.append(args)
        return ''

    def test_capture_and_restore_complete_data_and_previous_environment(self):
        (self.project / '.env').write_text('HARNESS_IMAGE=new-image\n')
        recovery.capture(self.point)
        self.assertEqual(self.calls[-1][-1], 'stop')
        for relative in recovery.ROOTS:
            (self.project / relative / 'preserved').write_text('migrated v4')
            (self.project / relative / 'new-only').write_text('new')
        recovery.restore(self.point)
        for relative, expected in self.before.items():
            self.assertEqual(recovery.inventory(self.project / relative), expected)
        self.assertEqual((self.point / 'failed-runtime/data/dsh/preserved').read_text(), 'migrated v4')
        self.assertIn('--wait', self.calls[-1])
        self.assertIn('--no-build', self.calls[-1])
        self.assertEqual(recovery.read_state(self.point)['stage'], 'restored')
        recovery.restore(self.point)  # Repeat only waits for old containers; never recopies data.
        self.assertEqual(recovery.inventory(self.point / 'snapshot'), json.loads((self.point / 'manifest.json').read_text()))

    def test_snapshot_failure_starts_original_without_replacing_data(self):
        with patch.object(recovery, 'copy_path', side_effect=OSError('copy failed')):
            with self.assertRaises(OSError):
                recovery.capture(self.point)
        self.assertEqual(recovery.read_state(self.point)['stage'], 'stopping')
        recovery.restore(self.point)
        self.assertEqual(self.calls[-1][-1], 'start')
        for relative, expected in self.before.items():
            self.assertEqual(recovery.inventory(self.project / relative), expected)

    def test_integrity_failure_refuses_to_replace_runtime(self):
        recovery.capture(self.point)
        (self.point / 'snapshot/data/dsh/preserved').write_text('damaged')
        self.calls.clear()
        with self.assertRaisesRegex(RuntimeError, 'integrity'):
            recovery.restore(self.point)
        self.assertEqual(self.calls, [])
        self.assertEqual(recovery.inventory(self.project / 'data/dsh'), self.before['data/dsh'])

    def test_no_space_fails_before_stopping(self):
        with patch.object(recovery.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 0})()):
            with self.assertRaisesRegex(RuntimeError, 'disk space'):
                recovery.capture(self.point)
        self.assertEqual(self.calls, [])
        self.assertEqual(recovery.read_state(self.point)['stage'], 'prepared')

    def test_new_roots_are_retained_but_not_merged_into_old_data(self):
        import shutil
        shutil.rmtree(self.project / 'data/backend-auth')
        recovery.capture(self.point)
        (self.project / 'data/backend-auth').mkdir()
        (self.project / 'data/backend-auth/launch-token').write_text('new-launch-token')
        recovery.restore(self.point)
        self.assertFalse((self.project / 'data/backend-auth').exists())
        self.assertTrue((self.point / 'failed-runtime/data/backend-auth/launch-token').exists())

    def test_prepare_pins_actual_images_and_private_config(self):
        from types import SimpleNamespace
        labels = {'org.opencontainers.image.version': '0.1.6-alpha.1',
                  'com.docker.compose.project': 'deepseek-harness',
                  'com.docker.compose.service': 'harness',
                  'com.docker.compose.project.working_dir': str(self.project)}
        old = {'Config': {'Labels': labels}, 'Image': 'sha256:old-harness'}
        gateway = {'Config': {'Labels': {**labels, 'com.docker.compose.service': 'gateway'}},
                   'Image': 'sha256:old-gateway'}
        spec = {'services': {name: {'image': 'mutable-tag', 'build': '.',
                                   'environment': {'PASSWORD': '$value'}} for name in ('harness', 'gateway')}}
        def command(args):
            self.calls.append(args)
            if args[0] == 'git': return 'services: {}'
            if args[-3:] == ['config', '--format', 'json']: return json.dumps(spec)
            if args[-2:] == ['ps', '-aq']: return 'harness-id gateway-id'
            if args[:2] == ['docker', 'inspect']: return json.dumps([old, gateway])
            return ''
        with patch.object(recovery.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps([old]))), patch.object(recovery, 'run', side_effect=command):
            point = recovery.prepare(self.project.resolve(), 'remote', 'a' * 40)
        saved = json.loads((point / 'compose.json').read_text())
        self.assertNotIn('build', saved['services']['harness'])
        self.assertEqual(saved['services']['gateway']['pull_policy'], 'never')
        self.assertEqual(saved['services']['gateway']['environment']['PASSWORD'], '$$value')
        self.assertEqual((point / 'compose.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(point.stat().st_mode & 0o777, 0o700)
        self.assertTrue(any(command[3:5] == ['sha256:old-harness', saved['services']['harness']['image']]
                            for command in self.calls if command[:3] == ['docker', 'image', 'tag']))
        self.assertFalse(any('stop' in command for command in self.calls))

    def test_config_dollars_are_literal_after_second_compose_read(self):
        self.assertEqual(recovery.escape_compose({'environment': {'PASSWORD': '$a${b}'}}),
                         {'environment': {'PASSWORD': '$$a$${b}'}})


if __name__ == '__main__':
    unittest.main()
