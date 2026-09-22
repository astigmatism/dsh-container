import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('gateway_credentials', ROOT / 'scripts/gateway-credentials.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CredentialsTests(unittest.TestCase):
    def test_initialize_preserves_other_settings_and_does_not_rotate(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / '.env'
            path.write_text('# Keep me\nOTHER=value\nHARNESS_AUTH_USERNAME=\nHARNESS_AUTH_PASSWORD=\n')
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
            for value in ['abcdefgh', ' space $HOME ${OTHER} \\ "quote" \' apostrophe ', 'endswith\\']:
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
            path.write_text('HARNESS_AUTH_USERNAME=a\nHARNESS_AUTH_USERNAME=b\n')
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                module.initialize(path, 'operator')
            self.assertEqual(before, path.read_bytes())


if __name__ == '__main__':
    unittest.main()
