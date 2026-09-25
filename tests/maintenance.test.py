#!/usr/bin/env python3
"""Synthetic deployment contract, transaction, and recovery tests; no Docker."""
import copy
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from argparse import Namespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from maintenance.common import Failure, LABEL, REPOSITORY, atomic_json
from maintenance.contract import validate_config, validate_manifest, verify_portal
from maintenance.engine import Updater, install_labels, pinned_bases
from maintenance import recovery
from maintenance.qualification import registered_files
from maintenance.install import prepare
from maintenance.engine import fetch_source


class Fixture(unittest.TestCase):
    def setUp(self):
        qualification = patch('maintenance.engine.qualify_application')
        self.qualifier = qualification.start()
        self.addCleanup(qualification.stop)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / 'operational bundle'
        self.root.mkdir()
        (self.root / 'scripts').mkdir()
        self.script = self.root / 'scripts/update-and-restart.sh'
        self.script.write_text('#!/bin/sh\nexit 0\n')
        self.script.chmod(0o700)
        (self.root / 'maintenance').mkdir()
        (self.root / 'maintenance/identity').write_text('old runtime')
        (self.root / 'runner-image').write_text('sha256:' + '1' * 64 + '\n')
        self.data = self.base / 'private state'
        self.data.mkdir(mode=0o700)
        (self.data / 'backend').mkdir(mode=0o700)
        (self.data / 'session').write_text('original session')
        (self.data / 'session').chmod(0o600)
        self.credentials = self.base / 'separate credentials'
        self.credentials.mkdir(mode=0o700)
        (self.credentials / 'auth').write_text('synthetic-$credential')
        (self.credentials / 'auth').chmod(0o600)
        self.manifest = {'schema': 1, 'root': str(self.root), 'project': 'fixture-app',
                         'repository': REPOSITORY, 'branch': 'main', 'mode': 'remote',
                         'revision': 'a' * 40, 'engine_id': 'synthetic-engine',
                         'roles': {'application': 'harness', 'edge': 'gateway'},
                         'user': f'{os.getuid()}:{os.getgid()}', 'portal_url': 'http://portal.test',
                         'state_paths': [str(self.data)], 'input_paths': [str(self.credentials)],
                         'artifact_paths': [], 'source_artifacts': []}
        self.model = {'name': 'fixture-app', 'services': {
            'application': {'image': 'sha256:' + '1' * 64},
            'edge': {'image': 'sha256:' + '2' * 64, 'volumes': [{'type': 'bind',
                'source': str(self.data / 'backend'), 'target': '/run/dsh-backend-auth'}]}}}
        install_labels(self.model, self.manifest, 'sha256:' + '1' * 64)
        self.save()

    def save(self):
        atomic_json(self.root / 'deployment.json', self.manifest)
        atomic_json(self.root / 'compose.json', self.model)

    def candidate(self):
        release = self.root / 'releases/candidate'
        release.mkdir(parents=True)
        for path in ('scripts', 'maintenance'):
            shutil.copytree(self.root / path, release / path)
        (release / 'maintenance/identity').write_text('new runtime')
        (release / 'runner-image').write_text('sha256:' + '3' * 64 + '\n')
        (release / 'start-after-network.sh').write_text('#!/bin/sh\nexit 0\n')
        manifest = copy.deepcopy(self.manifest)
        manifest['revision'] = 'b' * 40
        atomic_json(release / 'deployment.json', manifest)
        model = copy.deepcopy(self.model)
        model['services']['application']['image'] = 'sha256:' + '3' * 64
        atomic_json(release / 'compose.json', model)
        return release


class ContractTests(Fixture):
    def test_valid_custom_service_names_and_separate_state(self):
        validate_manifest(self.manifest, self.root)
        self.assertEqual(validate_config(self.model, self.root)[0], 'application')

    def test_disabled_missing_and_conflicting_advertisers(self):
        for kind in ('disabled', 'missing', 'second'):
            with self.subTest(kind=kind):
                model = copy.deepcopy(self.model)
                if kind == 'disabled':
                    model['services']['application']['labels'][LABEL + 'enabled'] = 'false'
                elif kind == 'missing':
                    model['services']['application']['labels'] = {}
                else:
                    model['services']['edge']['labels'] = model['services']['application']['labels'].copy()
                with self.assertRaises(Failure): validate_config(model, self.root)

    def test_unsafe_missing_nonexecutable_and_symlink_scripts(self):
        for value in ('../outside', '/absolute', 'absent', 'scripts\\escape'):
            model = copy.deepcopy(self.model)
            model['services']['application']['labels'][LABEL + 'script'] = value
            with self.subTest(value=value), self.assertRaises(Failure): validate_config(model, self.root)
        self.script.chmod(0o600)
        with self.assertRaises(Failure): validate_config(self.model, self.root)
        self.script.unlink()
        self.script.symlink_to('/bin/sh')
        with self.assertRaises(Failure): validate_config(self.model, self.root)

    def test_manifest_rejects_foreign_root_source_and_overlapping_state(self):
        for key, value in [('root', str(self.base)), ('repository', 'https://example.test/repo'),
                           ('state_paths', [str(self.data), str(self.data / 'session')]),
                           ('state_paths', [str(self.base)]), ('roles', {'application': 'harness'})]:
            manifest = dict(self.manifest, **{key: value})
            with self.subTest(key=key), self.assertRaises(Failure): validate_manifest(manifest, self.root)

    def test_portal_requires_exact_project_container_and_capability(self):
        row = {'project': 'fixture-app', 'id': 'a' * 12, 'update': {'available': True, 'project': 'fixture-app'}}
        with patch('maintenance.contract.portal_services', return_value=[row]):
            verify_portal('http://portal.test', 'fixture-app', 'a' * 64)
        for change in ({'update': None}, {'project': 'other'}, {'id': 'b' * 12}):
            with patch('maintenance.contract.portal_services', return_value=[dict(row, **change)]), self.assertRaises(Failure):
                verify_portal('http://portal.test', 'fixture-app', 'a' * 64)

    def test_future_compose_must_be_registered(self):
        (self.root / 'config').mkdir()
        atomic_json(self.root / 'config/deployment-profiles.json', {'schema': 1, 'profiles': {'portable': ['compose.yaml']}, 'separate_projects': ['speech/']})
        (self.root / 'compose.yaml').write_text('services:\n  harness: {}\n')
        (self.root / 'new-target.yaml').write_text('services:\n  harness: {}\n')
        with patch('maintenance.qualification.run', return_value='compose.yaml\nnew-target.yaml\n'), self.assertRaises(Failure):
            registered_files(self.root)
        with patch('maintenance.qualification.run', return_value='compose.yaml\nspeech/compose.yaml\n'):
            registered_files(self.root)

    def test_source_bases_are_pinned(self):
        source = Path(__file__).resolve().parents[1]
        pinned_bases(source)
        (self.root / 'ollama-router').mkdir()
        (self.root / 'Dockerfile').write_text('FROM node:latest\n')
        (self.root / 'ollama-router/Dockerfile').write_text('FROM node:latest\n')
        with self.assertRaises(Failure): pinned_bases(self.root)


class RecoveryTests(Fixture):
    def point(self):
        point = self.root / 'recovery/test'
        point.mkdir(parents=True)
        return point

    def test_full_restoration_preserves_permissions_and_retains_failed_state(self):
        point = self.point()
        before = recovery.inventory(self.data)
        recovery.capture(point, [self.data, self.credentials])
        (self.data / 'session').write_text('new storage format')
        (self.credentials / 'auth').write_text('changed credential')
        recovery.restore(point)
        self.assertEqual(before, recovery.inventory(self.data))
        self.assertEqual((self.credentials / 'auth').read_text(), 'synthetic-$credential')
        self.assertTrue(list(self.base.glob('.*.failed-*')))
        recovery.restore(point)  # idempotent after interruption/completion

    def test_corrupt_snapshot_never_replaces_live_data(self):
        point = self.point()
        recovery.capture(point, [self.data])
        (point / 'snapshot/0/session').write_text('corrupted')
        with self.assertRaises(Failure): recovery.restore(point)
        self.assertEqual((self.data / 'session').read_text(), 'original session')

    def test_missing_original_is_restored_to_absence(self):
        point = self.point()
        missing = self.base / 'newly-generated'
        recovery.capture(point, [missing])
        missing.write_text('new')
        recovery.restore(point)
        self.assertFalse(missing.exists())

    def test_insufficient_space_and_symlink_roots_fail(self):
        point = self.point()
        with patch('maintenance.recovery.shutil.disk_usage', return_value=shutil._ntuple_diskusage(100, 99, 1)), self.assertRaises(Failure):
            recovery.check_space(point, [self.data])
        link = self.base / 'symlink'
        link.symlink_to(self.data)
        with self.assertRaises(Failure): recovery.capture(point, [link])

    def test_unchanged_inputs_keep_their_inode_and_timestamp(self):
        point = self.point()
        before = (self.credentials / 'auth').stat()
        recovery.capture(point, [self.credentials / 'auth'])
        recovery.restore(point)
        after = (self.credentials / 'auth').stat()
        self.assertEqual((before.st_ino, before.st_mtime_ns), (after.st_ino, after.st_mtime_ns))


class AdoptionTests(Fixture):
    def setUp(self):
        super().setUp()
        self.source = self.base / 'reviewed source'
        (self.source / 'scripts').mkdir(parents=True)
        shutil.copy2(self.script, self.source / 'scripts/update-and-restart.sh')
        self.compose = self.source / 'custom.yaml'
        self.compose.write_text('services: {}\n')
        self.env = self.source / 'private.env'
        self.env.write_text('DSH_DEPLOYMENT_MODE=external\nSERVICE_PORTAL_URL=http://portal.test\nPRIVATE=preserve-me\n')
        self.model['services']['application']['user'] = self.manifest['user']
        self.model['services']['application']['volumes'] = [{'type': 'bind', 'source': str(self.data), 'target': '/data/dsh'}]
        self.model['services']['edge']['volumes'] = [{'type': 'bind', 'source': str(self.credentials), 'target': '/data/gateway'}]
        self.args = Namespace(project_directory=self.source, deployment_dir=self.base / 'new operations',
            compose_file=[str(self.compose)], env_file=str(self.env), mode=None, portal_url='',
            role=['application=harness', 'edge=gateway'], state_path=[], external_path=[],
            adopt=True, dry_run=True, boot_unit=None)
        self.commands = []

    def command(self, args, **kwargs):
        self.commands.append(args)
        if 'config' in args: return json.dumps(self.model)
        if 'info' in args: return 'fixture-engine\n'
        if 'rev-parse' in args: return 'a'*40+'\n'
        if 'ps' in args: return ''
        raise AssertionError(args)

    def prepare(self):
        with patch('maintenance.install.run', side_effect=self.command), patch('maintenance.install.portal_services'):
            prepare(self.args, self.source)

    def test_custom_adoption_dry_run_keeps_every_byte_and_preserves_mode(self):
        before = recovery.inventory(self.base)
        self.prepare()
        self.assertEqual(before, recovery.inventory(self.base))
        self.assertEqual(self.args.mode, 'external')
        self.assertEqual(self.args.portal_url, 'http://portal.test')
        self.assertFalse(self.args.deployment_dir.exists())
        self.assertFalse(any('up' in c or 'build' in c or 'fetch' in c for c in self.commands))

    def test_ordinary_install_cannot_disable_the_contract(self):
        self.args.adopt = False
        self.model['services']['application']['labels'][LABEL+'enabled'] = 'false'
        with self.assertRaisesRegex(Failure, 'enabled'): self.prepare()

    def test_adoption_repairs_disabled_contract_without_touching_original(self):
        self.model['services']['application']['labels'][LABEL+'enabled'] = 'false'
        self.prepare()
        self.assertEqual(self.model['services']['application']['labels'][LABEL+'enabled'], 'false')

    def test_ambiguous_writable_mount_requires_classification(self):
        workspace = self.base / 'workspace'
        workspace.mkdir()
        self.model['services']['application']['volumes'].append({'type': 'bind', 'source': str(workspace), 'target': '/custom'})
        with self.assertRaisesRegex(Failure, 'Classify'): self.prepare()
        self.args.external_path = [str(workspace)]
        self.prepare()

    def test_conflicting_mode_and_role_are_rejected_without_writes(self):
        self.args.mode = 'managed'
        with self.assertRaisesRegex(Failure, 'conflicts'): self.prepare()
        self.args.mode = None
        self.args.role = ['application=harness']
        with self.assertRaisesRegex(Failure, 'unambiguous'): self.prepare()


class SourceTests(unittest.TestCase):
    def test_resolve_main_once_then_fetch_that_exact_commit(self):
        calls = []
        def command(args, **kwargs):
            calls.append(args)
            if 'ls-remote' in args: return 'c'*40+'\trefs/heads/main\n'
            if 'rev-parse' in args: return 'c'*40+'\n'
            return ''
        with patch('maintenance.engine.run', side_effect=command):
            self.assertEqual(fetch_source(Path('/tmp/synthetic-source')), 'c'*40)
        self.assertEqual(sum('ls-remote' in c for c in calls), 1)
        fetch = next(c for c in calls if 'fetch' in c)
        self.assertEqual(fetch[-1], 'c'*40)
        self.assertFalse(any('merge' in c or 'reset' in c for c in calls))

    def test_source_failure_never_attempts_checkout(self):
        with patch('maintenance.engine.run', return_value='not a revision') as command, self.assertRaises(Failure):
            fetch_source(Path('/tmp/synthetic-source'))
        self.assertEqual(command.call_count, 1)


class TransactionTests(Fixture):
    def test_failed_candidate_acceptance_does_not_stop_production(self):
        updater, release = Updater(self.root), self.candidate()
        self.qualifier.side_effect = Failure('isolated inference failed')
        with patch.object(updater, 'old_model', return_value=(self.model, True)), \
             patch('maintenance.engine.run') as command, self.assertRaisesRegex(Failure, 'isolated inference'):
            updater.cutover(release)
        command.assert_not_called()
        self.assertFalse((self.root / 'transaction.json').exists())
        self.assertEqual((self.data / 'session').read_text(), 'original session')

    def test_gateway_is_gated_through_validation_then_published_without_restart(self):
        updater, release = Updater(self.root), self.candidate()
        gate = self.data / 'backend/.deployment-maintenance'
        calls = []
        def command(args, **kwargs):
            calls.append(args)
            if 'up' in args:
                self.assertTrue(gate.exists(), 'Candidate accepted writes before validation')
        def verify(*args, **kwargs):
            self.assertTrue(gate.exists())
        with patch.object(updater, 'old_model', return_value=(self.model, True)), \
             patch('maintenance.engine.run', side_effect=command), patch('maintenance.engine.probe_release', side_effect=verify):
            updater.cutover(release)
        self.assertFalse(gate.exists())
        self.assertEqual(sum('up' in command for command in calls), 1)
        self.assertEqual(json.loads((self.root / 'maintenance-status.json').read_text())['state'], 'ok')

    def test_dry_run_is_immutable_and_does_not_build(self):
        updater = Updater(self.root)
        before = recovery.inventory(self.base)
        with patch('maintenance.engine.validate_engine'), patch('maintenance.engine.validate_containers'), \
             patch('maintenance.engine.portal_services'), patch('maintenance.engine.run') as command, \
             patch('maintenance.engine.inspect', return_value={'Config': {'Labels': {'io.dsh.maintenance.schema': '1'}}}), \
             patch.object(updater, 'build_candidate') as build:
            updater.update(True)
        self.assertEqual(before, recovery.inventory(self.base))
        build.assert_not_called()
        self.assertEqual(command.call_count, 1)
        self.assertEqual(command.call_args.args[0][-2:], ['config', '--quiet'])

    def test_concurrent_update_is_rejected(self):
        with (self.root / '.maintenance.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(Failure, 'Another maintenance'):
                Updater(self.root).update()

    def test_build_failure_never_stops_services(self):
        updater = Updater(self.root)
        with patch.object(updater, 'preflight'), patch.object(updater, 'build_candidate', side_effect=Failure('build failed')), \
             patch('maintenance.engine.run') as command, self.assertRaises(Failure):
            updater.update()
        command.assert_not_called()
        self.assertEqual((self.data / 'session').read_text(), 'original session')

    def test_failed_cutover_restores_entire_generation(self):
        legacy = self.base / 'update-and-restart.sh'
        legacy.write_text('#!/bin/sh\nexec python3 maintain.py\n')
        self.manifest['legacy_entrypoint'] = str(legacy)
        self.manifest['artifact_paths'].append(str(legacy))
        self.save()
        updater, release = Updater(self.root), self.candidate()
        calls = []
        def command(args, **kwargs):
            calls.append(args)
            if 'up' in args and str(self.root / 'compose.json') in args:
                (self.data / 'session').write_text('migrated')
                (self.credentials / 'auth').write_text('changed')
        def verify(manifest, model, root, **kwargs):
            if kwargs.get('portal', True): raise Failure('Portal capability missing')
        with patch.object(updater, 'old_model', return_value=(self.model, True)), \
             patch('maintenance.engine.run', side_effect=command), patch('maintenance.engine.validate_engine'), \
             patch('maintenance.engine.containers', return_value=[]), \
             patch('maintenance.engine.probe_release', side_effect=verify), self.assertRaises(Failure):
            updater.cutover(release)
        self.assertEqual((self.data / 'session').read_text(), 'original session')
        self.assertEqual((self.credentials / 'auth').read_text(), 'synthetic-$credential')
        self.assertEqual((self.root / 'maintenance/identity').read_text(), 'old runtime')
        self.assertEqual(legacy.read_text(), '#!/bin/sh\nexec python3 maintain.py\n')
        self.assertEqual(json.loads((self.root / 'deployment.json').read_text())['revision'], 'a' * 40)
        self.assertEqual(json.loads((self.root / 'maintenance-status.json').read_text())['recovery'], 'succeeded')
        self.assertFalse((self.root / 'transaction.json').exists())
        self.assertTrue(any('--force-recreate' in call and 'previous-compose.json' in ' '.join(map(str, call)) for call in calls))

    def test_snapshot_failure_cannot_reach_candidate_start(self):
        updater, release = Updater(self.root), self.candidate()
        with patch.object(updater, 'old_model', return_value=(self.model, True)), \
             patch('maintenance.engine.run') as command, patch('maintenance.engine.validate_engine'), \
             patch('maintenance.engine.containers', return_value=[]), \
             patch('maintenance.engine.probe_release'), patch('maintenance.engine.recovery.capture', side_effect=Failure('copy failed')), \
             self.assertRaises(Failure):
            updater.cutover(release)
        for call in command.call_args_list:
            if 'up' in call.args[0]:
                self.assertIn('previous-compose.json', ' '.join(map(str, call.args[0])))

    def test_failed_recovery_keeps_journal_and_snapshot(self):
        updater, release = Updater(self.root), self.candidate()
        with patch.object(updater, 'old_model', return_value=(self.model, True)), \
             patch('maintenance.engine.run'), patch('maintenance.engine.validate_engine'), \
             patch('maintenance.engine.containers', return_value=[]), \
             patch('maintenance.engine.probe_release', side_effect=Failure('verification failed')), \
             self.assertRaisesRegex(Failure, 'recovery incomplete'):
            updater.cutover(release)
        self.assertTrue((self.root / 'transaction.json').exists())
        self.assertEqual(json.loads((self.root / 'maintenance-status.json').read_text())['recovery'], 'failed')


if __name__ == '__main__':
    unittest.main()
