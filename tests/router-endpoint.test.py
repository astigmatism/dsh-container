#!/usr/bin/env python3
"""The active LLM router is one environment setting that the updater re-derives.

These tests are the regression gate for the migration flaw they describe: on a
remote-direct deployment an edit of the deployment's router setting had no
effect, because the update forwarded the mapping already baked into the
materialized model. Here the same edit, and nothing else, moves the consumer —
and moves it back. No Docker and no live router: the candidate is built with the
Docker calls replaced at their boundaries, so the real candidate path runs.
"""
import copy
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from maintenance import router
from maintenance.common import Failure, REPOSITORY, atomic_json
from maintenance.contract import configuration_bindings
from maintenance.engine import Updater, install_labels, verify_router

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
OLD_ROUTER, NEW_ROUTER, THIRD_ROUTER = '192.168.1.4', '192.168.1.23', '192.168.1.77'


def source_release(source):
    """Populate a fetched-release directory the way the real fetch would.

    Only Docker is replaced: the release contents, the packaged maintenance
    runtime and the updater script are the real ones, so what the candidate
    model is validated against is what an update would deploy.
    """
    shutil.copytree(REPOSITORY_ROOT / 'maintenance', source / 'maintenance',
                    ignore=shutil.ignore_patterns('__pycache__'))
    (source / 'scripts').mkdir(parents=True)
    for relative in ('scripts/update-and-restart.sh', 'scripts/verify-router-contract.mjs'):
        shutil.copy2(REPOSITORY_ROOT / relative, source / relative)
    (source / 'seed' / 'plugins').mkdir(parents=True)
    shutil.copy2(REPOSITORY_ROOT / 'seed/plugins/dsh-router-model-discovery.js',
                 source / 'seed/plugins/dsh-router-model-discovery.js')
    return 'c' * 40


class Deployment(unittest.TestCase):
    """A private deployment: `.env` above an operational bundle, checkout-free."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        self.deployment = base / 'deployment'
        self.root = self.deployment / 'data/operations'
        self.root.mkdir(parents=True)
        (self.root / 'scripts').mkdir()
        script = self.root / 'scripts/update-and-restart.sh'
        script.write_text('#!/bin/sh\nexit 0\n')
        script.chmod(0o700)
        (self.root / 'maintenance').mkdir()
        (self.root / 'runner-image').write_text('sha256:' + '1' * 64 + '\n')
        self.state = base / 'private state'
        self.state.mkdir(mode=0o700)
        self.credentials = base / 'separate credentials'
        self.credentials.mkdir(mode=0o700)
        # The value the deployment was installed with; the materialized model
        # carries it as a baked extra host, which is the state under test.
        self.env = self.deployment / '.env'
        self.write_env(OLD_ROUTER)
        self.manifest = {'schema': 1, 'root': str(self.root), 'project': 'fixture-harness',
                         'repository': REPOSITORY, 'branch': 'main', 'mode': 'remote',
                         'revision': 'a' * 40, 'engine_id': 'synthetic-engine',
                         'roles': {'harness': 'harness', 'gateway': 'gateway'},
                         'user': f'{os.getuid()}:{os.getgid()}', 'portal_url': 'http://portal.test',
                         'state_paths': [str(self.state)], 'input_paths': [str(self.credentials)],
                         'artifact_paths': [], 'source_artifacts': []}
        self.model = {'name': 'fixture-harness', 'services': {
            'harness': {'image': 'sha256:' + '1' * 64, 'user': self.manifest['user'],
                        'extra_hosts': [f'{router.CANONICAL_NAME}={OLD_ROUTER}']},
            'gateway': {'image': 'sha256:' + '2' * 64}}}
        install_labels(self.model, self.manifest, 'sha256:' + '1' * 64)
        self.manifest['images'] = {service: config['image'] for service, config in self.model['services'].items()}
        self.manifest['bindings'] = configuration_bindings(self.model)
        self.save()

    def write_env(self, value, admin=None, extra=True):
        lines = ['# private deployment settings', f'HARNESS_AUTH_PASSWORD=not-a-secret-{OLD_ROUTER}']
        if value is not None:
            lines.append(f'{router.SETTING}={value}')
        if admin is not None:
            lines.append(f'{router.ADMIN_SETTING}={admin}')
        if extra:
            lines.append('HARNESS_HTTPS_PORT=3443')
        self.env.write_text('\n'.join(lines) + '\n')

    def save(self):
        atomic_json(self.root / 'deployment.json', self.manifest)
        atomic_json(self.root / 'compose.json', self.model)

    def materialized_mapping(self, model):
        return router.deployed_mapping(model, self.manifest)

    def build(self):
        """Run the real candidate build with only the Docker calls replaced."""
        updater = Updater(self.root)
        images = {'harness': 'sha256:' + '3' * 64, 'gateway': 'sha256:' + '4' * 64}
        with patch('maintenance.engine.fetch_source', side_effect=source_release), \
             patch('maintenance.engine.pinned_bases'), \
             patch('maintenance.engine.qualify_runner'), \
             patch('maintenance.engine.run', return_value='') as command, \
             patch('maintenance.engine.inspect', side_effect=lambda kind, identity: {'Id': images['harness']}):
            release = updater.build_candidate()
            calls = command.call_count
        self.assertGreater(calls, 0, 'the candidate build must still issue its Docker work')
        return release, json.loads((release / 'compose.json').read_text()), \
            json.loads((release / 'deployment.json').read_text()), updater


class ActiveRouterTests(Deployment):
    def test_the_updater_re_derives_the_router_from_the_setting(self):
        """The supported migration: edit one setting, update, consumer follows."""
        self.write_env(NEW_ROUTER)
        release, model, manifest, _ = self.build()
        self.assertEqual(self.materialized_mapping(model), f'{router.CANONICAL_NAME}={NEW_ROUTER}')
        # Nothing in the candidate still names the router it came from.
        self.assertNotIn(OLD_ROUTER, json.dumps(model))
        self.assertEqual(json.loads((release / router.RECORD).read_text())['address'], NEW_ROUTER)
        self.assertEqual(manifest['router']['setting'], NEW_ROUTER)
        # The record of the decision reaches the operational directory at cutover.
        self.assertFalse((self.root / router.RECORD).exists())

    def test_a_stale_baked_mapping_is_never_carried_forward(self):
        """The reported flaw: on a remote-direct box the old mapping survived updates."""
        for _ in range(3):
            _, model, _, _ = self.build()
        self.assertEqual(self.materialized_mapping(model), f'{router.CANONICAL_NAME}={OLD_ROUTER}')
        self.write_env(NEW_ROUTER)
        _, moved, _, _ = self.build()
        self.assertEqual(self.materialized_mapping(moved), f'{router.CANONICAL_NAME}={NEW_ROUTER}')

    def test_flipping_back_is_the_same_action(self):
        self.write_env(NEW_ROUTER)
        _, forward, _, _ = self.build()
        self.write_env(THIRD_ROUTER)
        _, aside, _, _ = self.build()
        self.write_env(NEW_ROUTER)
        _, back, _, _ = self.build()
        self.assertEqual(self.materialized_mapping(aside), f'{router.CANONICAL_NAME}={THIRD_ROUTER}')
        self.assertEqual(self.materialized_mapping(back), f'{router.CANONICAL_NAME}={NEW_ROUTER}')
        # Rolling back an update restores the previous generation's mapping too.
        self.write_env(OLD_ROUTER)
        _, reverted, _, _ = self.build()
        self.assertEqual(self.materialized_mapping(reverted), f'{router.CANONICAL_NAME}={OLD_ROUTER}')

    def test_the_source_and_previous_router_are_reported(self):
        self.write_env(NEW_ROUTER)
        _, _, _, updater = self.build()
        _, fact = router.plan(self.model, self.manifest, self.root)
        described = router.describe(fact)
        self.assertIn(str(self.env), described)
        self.assertIn(f'{router.CANONICAL_NAME}={OLD_ROUTER}', described)
        self.assertIn(f'{router.CANONICAL_NAME} -> {NEW_ROUTER}', described)

    def test_a_url_and_an_admin_base_are_accepted(self):
        self.write_env(f'http://{NEW_ROUTER}:11434/v1', admin=f'http://{NEW_ROUTER}:11435')
        _, model, _, _ = self.build()
        self.assertEqual(self.materialized_mapping(model), f'{router.CANONICAL_NAME}={NEW_ROUTER}')
        _, fact = router.plan(self.model, self.manifest, self.root)
        self.assertEqual(fact['api_base'], f'http://{NEW_ROUTER}:11434/v1')
        self.assertEqual(fact['api_container_base'], f'http://{router.CANONICAL_NAME}:11434/v1')
        self.assertEqual(fact['admin_base'], f'http://{NEW_ROUTER}:{router.ADMIN_PORT}')

    def test_every_accepted_spelling_names_the_same_router(self):
        for value in (NEW_ROUTER, f'{NEW_ROUTER}:11434', f'http://{NEW_ROUTER}', f'http://{NEW_ROUTER}:11434',
                      f'http://{NEW_ROUTER}/v1', f'http://{NEW_ROUTER}:11434/v1/', f'  {NEW_ROUTER}  '):
            with self.subTest(value=value):
                self.assertEqual(router.parse_endpoint(value)['address'], NEW_ROUTER)

    def test_an_endpoint_the_container_cannot_reach_fails_closed(self):
        for value, reason in (('https://router.test:11434', 'http'),
                              (f'{NEW_ROUTER}:11435', 'port'),
                              ('127.0.0.1', 'itself'),
                              ('0.0.0.0', 'itself'),
                              ('router-does-not-exist.invalid', 'resolve'),
                              ('http://user@router.test/v1', 'credentials'),
                              (f'http://{NEW_ROUTER}:11434/v1/chat/completions', 'base')):
            with self.subTest(value=value), self.assertRaises(Failure) as caught:
                router.parse_endpoint(value)
            self.assertIn(reason, str(caught.exception))

    def test_a_rejected_setting_never_reaches_the_deployment(self):
        self.write_env(NEW_ROUTER)
        before = self.env.read_text()
        with self.assertRaises(Failure):
            router.configure(self.root, self.manifest, 'https://router.test:11434')
        self.assertEqual(self.env.read_text(), before)

    def test_a_missing_setting_keeps_the_deployed_mapping(self):
        self.write_env(None)
        _, model, _, _ = self.build()
        self.assertEqual(self.materialized_mapping(model), f'{router.CANONICAL_NAME}={OLD_ROUTER}')
        _, fact = router.plan(self.model, self.manifest, self.root)
        self.assertEqual(fact['status'], 'undeclared')
        self.assertIn('is not declared', router.describe(fact))

    def test_the_alias_is_replaced_without_losing_other_extra_hosts(self):
        model = copy.deepcopy(self.model)
        model['services']['harness']['extra_hosts'] = [f'{router.CANONICAL_NAME}:{OLD_ROUTER}',
                                                       'speech-host:192.168.1.22']
        self.write_env(NEW_ROUTER)
        mapping, _ = router.plan(model, self.manifest, self.root)
        self.assertEqual(mapping, [f'{router.CANONICAL_NAME}={NEW_ROUTER}', 'speech-host:192.168.1.22'])

    def test_the_mode_decides_when_the_setting_does_not_apply(self):
        for mode in ('external', 'managed'):
            with self.subTest(mode=mode):
                manifest = copy.deepcopy(self.manifest)
                manifest['mode'] = mode
                model = copy.deepcopy(self.model)
                model['services']['harness']['extra_hosts'] = [f'{router.CANONICAL_NAME}={OLD_ROUTER}']
                mapping, fact = router.plan(model, manifest, self.root)
                self.assertEqual(mapping, [])
                self.assertEqual(fact['status'], 'mode-resolved')
                self.assertIn(mode, router.describe(fact))

    def test_the_deployment_file_is_authoritative_over_the_adoption_copy(self):
        imported = self.root / 'config-inputs'
        imported.mkdir()
        shutil.copyfile(self.env, imported / '1-.env')
        self.write_env(NEW_ROUTER)
        value, source, drift = router.select_setting(self.root, self.manifest)
        self.assertEqual((value, source), (NEW_ROUTER, str(self.env)))
        _, fact = router.plan(self.model, self.manifest, self.root)
        self.assertEqual(len(fact['drift']), 1)
        self.assertIn('config-inputs', fact['drift'][0])
        # The updater prints this sentence about every drifted file, so an edit
        # to a file the operator believed was authoritative is never ignored.
        self.assertIn('lower-priority file declares another value',
                      'Router note: a lower-priority file declares another value — ' + fact['drift'][0])

    def test_the_report_changes_nothing(self):
        before = (self.root / 'compose.json').read_bytes()
        fact = Updater(self.root).report_router()
        self.assertEqual((self.root / 'compose.json').read_bytes(), before)
        self.assertEqual(fact['setting'], OLD_ROUTER)
        self.assertFalse((self.root / router.RECORD).exists())


class ConfigureTests(Deployment):
    def test_configure_writes_the_one_setting_in_place(self):
        change = router.configure(self.root, self.manifest, f'http://{NEW_ROUTER}:11434/v1',
                                  admin=f'http://{NEW_ROUTER}:{router.ADMIN_PORT}')
        self.assertEqual(change['file'], str(self.env))
        self.assertEqual(change['previous'], OLD_ROUTER)
        self.assertEqual(change['endpoint']['address'], NEW_ROUTER)
        lines = self.env.read_text().splitlines()
        self.assertEqual(f'{router.SETTING}=http://{NEW_ROUTER}:11434/v1', lines[2])
        self.assertEqual(lines[1], f'HARNESS_AUTH_PASSWORD=not-a-secret-{OLD_ROUTER}')
        self.assertIn(f'HARNESS_HTTPS_PORT=3443', lines)
        self.assertEqual(router.read_setting(self.env, router.ADMIN_SETTING),
                         f'http://{NEW_ROUTER}:{router.ADMIN_PORT}')
        # And the next update applies exactly what was written.
        _, model, _, _ = self.build()
        self.assertEqual(self.materialized_mapping(model), f'{router.CANONICAL_NAME}={NEW_ROUTER}')

    def test_moving_back_is_the_same_call_with_the_reported_value(self):
        change = router.configure(self.root, self.manifest, NEW_ROUTER)
        router.configure(self.root, self.manifest, change['previous'])
        _, model, _, _ = self.build()
        self.assertEqual(self.materialized_mapping(model), f'{router.CANONICAL_NAME}={OLD_ROUTER}')

    def test_an_undeclared_setting_gets_an_operational_record(self):
        self.env.unlink()
        change = router.configure(self.root, self.manifest, NEW_ROUTER)
        self.assertEqual(Path(change['file']), self.root / 'env')
        _, model, _, _ = self.build()
        self.assertEqual(self.materialized_mapping(model), f'{router.CANONICAL_NAME}={NEW_ROUTER}')

    def test_a_probe_requires_the_new_router_to_answer(self):
        fact = router.parse_endpoint(OLD_ROUTER)
        with patch('urllib.request.urlopen', side_effect=OSError('no route')) as answer, \
             self.assertRaises(Failure):
            router.probe(fact, 'fixture')
        self.assertEqual(answer.call_count, 2)
        with patch('urllib.request.urlopen') as answer:
            answer.return_value.__enter__ = lambda response: response
            answer.return_value.status = 200
            self.assertTrue(router.probe(fact, 'fixture')['reachable'])
        route = answer.call_args_list[0].args[0].full_url
        self.assertEqual(route, f'http://{OLD_ROUTER}:11434/v1/router/capabilities')
        self.assertEqual(answer.call_args_list[0].args[0].get_header('X-client-name'), 'deepseek-harness/fixture')

    def test_verification_checks_the_running_container_and_not_just_the_model(self):
        _, _, manifest, _ = self.build()
        fact = manifest['router']
        running = lambda address: {'harness': {'HostConfig': {'ExtraHosts': [f'ai-router={address}']}}}
        verify_router(manifest, running(fact['address']))
        # Docker reports the alias in its own spelling, and that is what an
        # inspection returns.
        verify_router(manifest, {'harness': {'HostConfig': {'ExtraHosts': [f'ai-router:{fact["address"]}',
                                                                          'other=10.0.0.1']}}})
        with self.assertRaises(Failure):
            verify_router(manifest, running(OLD_ROUTER if fact['address'] != OLD_ROUTER else NEW_ROUTER))
        # A generation recorded before this decision existed is verified as it was.
        verify_router({**manifest, 'router': None}, running(OLD_ROUTER))

    def test_the_source_still_renders_the_alias_from_the_setting(self):
        compose = (REPOSITORY_ROOT / 'compose.yaml').read_text()
        self.assertIn(f'"ai-router:${{{router.SETTING}', compose)
        self.assertEqual(f'{router.CANONICAL_NAME}={NEW_ROUTER}',
                         f'{router.CANONICAL_NAME}={router.parse_endpoint(NEW_ROUTER)["address"]}')


if __name__ == '__main__':
    unittest.main(verbosity=2)
