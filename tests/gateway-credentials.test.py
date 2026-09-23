import importlib.util
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('gateway_credentials', ROOT / 'scripts/gateway-credentials.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CredentialsTests(unittest.TestCase):
    def test_initialize_preserves_other_settings_and_does_not_rotate(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / '.env'
            path.write_text('# Keep me\nOTHER=value\nHARNESS_AUTH_USERNAME=\nHARNESS_AUTH_PASSWORD=\n')
            with patch.object(module, 'inspect_gateway', return_value=None):
                self.assertTrue(module.initialize(path, 'operator'))
            first = path.read_bytes()
            self.assertIn(b'OTHER=value', first)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse(module.initialize(path, 'someone-else'))
            self.assertEqual(first, path.read_bytes())

    def test_eight_characters_and_compose_literal_roundtrip(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / '.env'
            path.write_text('OTHER=preserved\n')
            compose = Path(root) / 'compose.yaml'
            compose.write_text('services:\n  probe:\n    image: busybox:1.37\n    network_mode: none\n    environment:\n      USERNAME: "${HARNESS_AUTH_USERNAME}"\n      PASSWORD: "${HARNESS_AUTH_PASSWORD}"\n')
            env = {k: v for k, v in os.environ.items() if not k.startswith('HARNESS_AUTH_')}
            for value in ['abcdefgh', ' space $HOME ${OTHER} \\ "quote" \' apostrophe ', 'endswith\\', 'triple$$$dollars']:
                module.set_credentials(path, 'operator', value)
                self.assertEqual(module.read_values(path)['HARNESS_AUTH_PASSWORD'], value)
                actual = subprocess.check_output(['docker', 'compose', '--env-file', str(path), '-f', str(compose), 'run', '--rm', '-T', '--no-deps', 'probe', '/bin/printenv', 'PASSWORD'], env=env, text=True).removesuffix('\n')
                self.assertEqual(actual, value)


    def test_invalid_or_ambiguous_values_leave_file_untouched(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / '.env'
            path.write_text('OTHER=preserved\n')
            before = path.read_bytes()
            for username, password in [('', 'long-enough'), ('bad:name', 'long-enough'), ('valid', 'short'), ('valid', 'long\ninvalid')]:
                with self.assertRaises(ValueError):
                    module.set_credentials(path, username, password)
                self.assertEqual(before, path.read_bytes())

    def gateway(self, root, username='operator', password='test-only-password'):
        data = root / 'data/gateway'
        data.mkdir(parents=True, exist_ok=True)
        salt = 'ab' * 16
        (data / 'auth.json').write_text(json.dumps({
            'username': username, 'salt': salt, 'iterations': 1000,
            'hash': hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 1000, 32).hex(),
        }))
        return {
            'Config': {'Labels': {
                'com.docker.compose.project': 'deepseek-harness',
                'com.docker.compose.service': 'gateway',
                'com.docker.compose.project.working_dir': str(root),
            }, 'Env': [f'HARNESS_AUTH_USERNAME={username}', f'HARNESS_AUTH_PASSWORD={password}']},
            'Mounts': [{'Type': 'bind', 'Source': str(data), 'Destination': '/data/gateway'}],
        }

    def test_migration_preserves_login_settings_ownership_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / '.env'
            preserved = b'# Keep exact spacing\r\nCUSTOM = value # comment\r\n'
            path.write_bytes(preserved + b'HARNESS_AUTH_USERNAME=operator\n')
            metadata = path.stat()
            password = 'literal $HOME ${OTHER} \\ "quote" \' unicode \u2603'
            container = self.gateway(root, password=password)
            auth = (root / 'data/gateway/auth.json').read_bytes()
            with patch.object(module, 'inspect_gateway', return_value=container):
                before = path.read_bytes()
                self.assertIn('would be migrated', module.ensure(path, dry_run=True))
                self.assertEqual(before, path.read_bytes())
                self.assertIn('login preserved', module.ensure(path))
            self.assertTrue(path.read_bytes().startswith(preserved))
            self.assertEqual(module.read_values(path)['HARNESS_AUTH_PASSWORD'], password)
            self.assertEqual(auth, (root / 'data/gateway/auth.json').read_bytes())
            after = path.stat()
            self.assertEqual((after.st_uid, after.st_gid), (metadata.st_uid, metadata.st_gid))
            self.assertEqual(after.st_mode & 0o777, 0o600)
            with patch.object(module, 'inspect_gateway', side_effect=AssertionError('unnecessary inspection')):
                self.assertIn('Keeping existing', module.ensure(path))
            self.assertEqual(after.st_mtime_ns, path.stat().st_mtime_ns)

    def test_partial_credentials_must_agree_with_existing_login(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / '.env'
            container = self.gateway(root)
            with patch.object(module, 'inspect_gateway', return_value=container):
                for entry in ['HARNESS_AUTH_USERNAME=operator', 'HARNESS_AUTH_PASSWORD=test-only-password', '']:
                    path.write_text(entry + '\n')
                    module.ensure(path)
                    self.assertEqual(len(module.read_values(path)), 2)
                for entry in ['HARNESS_AUTH_USERNAME=someone-else', 'HARNESS_AUTH_PASSWORD=different-password']:
                    path.write_text(entry + '\n')
                    before = path.read_bytes()
                    with self.assertRaisesRegex(module.CredentialError, 'conflict'):
                        module.ensure(path)
                    self.assertEqual(before, path.read_bytes())

    def test_wrong_container_identity_never_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / '.env'
            path.write_text('KEEP=unchanged\n')
            original = self.gateway(root)
            variants = [None]
            for key, value in [('project', 'other-project'), ('service', 'harness'), ('project.working_dir', '/wrong')]:
                variant = copy.deepcopy(original)
                variant['Config']['Labels']['com.docker.compose.' + key] = value
                variants.append(variant)
            for mounts in [[], [{'Type': 'volume', 'Source': str(root / 'data/gateway'), 'Destination': '/data/gateway'}],
                           [{'Type': 'bind', 'Source': '/wrong', 'Destination': '/data/gateway'}], original['Mounts'] * 2]:
                variant = copy.deepcopy(original)
                variant['Mounts'] = mounts
                variants.append(variant)
            for variant in variants:
                with self.subTest(variant=variants.index(variant)), patch.object(module, 'inspect_gateway', return_value=variant):
                    with self.assertRaises(module.CredentialError):
                        module.ensure(path)
                self.assertEqual(path.read_text(), 'KEEP=unchanged\n')

    def test_invalid_hash_and_state_never_initialize_or_migrate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / '.env'
            path.write_text('KEEP=unchanged\n')
            container = self.gateway(root)
            auth_path = root / 'data/gateway/auth.json'
            wrong_hash = dict(json.loads(auth_path.read_text()), hash='00' * 32)
            for record in ['not json', '{}', '[]', json.dumps(wrong_hash),
                           auth_path.read_text().replace('operator', 'other')]:
                auth_path.write_text(record)
                with patch.object(module, 'inspect_gateway', return_value=container):
                    with self.assertRaises(module.CredentialError):
                        module.ensure(path, first_setup_username='operator')
                self.assertEqual(path.read_text(), 'KEEP=unchanged\n')
            with patch.object(module, 'inspect_gateway', return_value=None):
                with self.assertRaises(module.CredentialError):
                    module.initialize(path, 'operator')
                auth_path.unlink()
                (root / 'data/dsh').mkdir()
                (root / 'data/dsh/settings.yaml').write_text('models: {}')
                with self.assertRaises(module.CredentialError):
                    module.initialize(path, 'operator')

    def test_atomic_write_failure_and_symlink_leave_private_state_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / '.env'
            path.write_text('KEEP=unchanged\n')
            with patch.object(module.os, 'replace', side_effect=PermissionError()):
                with self.assertRaises(PermissionError):
                    module.set_credentials(path, 'operator', 'test-only-password')
            self.assertEqual(path.read_text(), 'KEEP=unchanged\n')
            self.assertEqual(list(root.iterdir()), [path])
            link = root / 'link.env'
            link.symlink_to(path)
            with self.assertRaises(module.CredentialError):
                module.ensure(link)

    def test_concurrent_configuration_change_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / '.env'
            path.write_text('KEEP=original\n')
            container = self.gateway(root)

            def concurrent_edit():
                path.write_text('KEEP=operator-change\n')
                return container

            with patch.object(module, 'inspect_gateway', side_effect=concurrent_edit):
                with self.assertRaisesRegex(module.CredentialError, 'changed during'):
                    module.ensure(path)
            self.assertEqual(path.read_text(), 'KEEP=operator-change\n')

    def test_ambiguous_env_and_docker_errors_are_sanitized(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            for source in ['HARNESS_AUTH_USERNAME=a\n export HARNESS_AUTH_USERNAME=b\n',
                           'HARNESS_AUTH_PASSWORD="unterminated-secret',
                           'HARNESS_AUTH_PASSWORD=$EXPANDED_SECRET']:
                path.write_text(source)
                result = subprocess.run(['python3', str(ROOT / 'scripts/gateway-credentials.py'), '--ensure', str(path)],
                                        capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('Traceback', result.stderr)
                self.assertNotIn('unterminated-secret', result.stderr)
                self.assertNotIn('EXPANDED_SECRET', result.stderr)
                self.assertEqual(path.read_text(), source)
            with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'secret sentinel')):
                with self.assertRaisesRegex(module.CredentialError, '^Cannot inspect gateway credentials: check Docker access$'):
                    module.inspect_gateway()
            path.write_text('HARNESS_AUTH_USERNAME=a\nHARNESS_AUTH_USERNAME=b\n')
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                module.initialize(path, 'operator')
            self.assertEqual(before, path.read_bytes())


if __name__ == '__main__':
    unittest.main()
