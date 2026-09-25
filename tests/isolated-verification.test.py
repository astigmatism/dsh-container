import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('isolated', ROOT / 'scripts/verify-isolated-runtime.py')
isolated = importlib.util.module_from_spec(spec)
spec.loader.exec_module(isolated)


class IsolationTests(unittest.TestCase):
    def source(self):
        return {'Config': {'User': '12345:54321', 'Env': ['HOME=/home/person',
                'DSH_HOME=/production', 'DSH_WEB_LAUNCH_TOKEN=private', 'OLLAMA_DSH_API_KEY=provider-secret']},
                'HostConfig': {'ExtraHosts': ['ai-router:192.0.2.1'],
                               'Binds': ['/production:/data/dsh', '/:/host', '/var/run/docker.sock:/var/run/docker.sock']},
                'NetworkSettings': {'Networks': {'provider-network': {}, 'second-network': {}}},
                'Mounts': [{'Source': '/production', 'Destination': '/data/dsh'}]}

    def test_source_permissions_ports_and_mounts_are_not_inherited(self):
        command, networks = isolated.candidate_command(self.source(), 'sha256:candidate', 'disposable')
        self.assertEqual(networks, ['second-network'])
        self.assertNotIn('--volume', command)
        self.assertNotIn('--mount', command)
        self.assertNotIn('--publish', command)
        self.assertNotIn('--privileged', command)
        self.assertNotIn('DSH_WEB_LAUNCH_TOKEN=private', command)
        self.assertIn('DSH_VERIFY_ISOLATED=1', command)
        self.assertIn('DSH_HOME=/data/dsh', command)
        self.assertIn('OLLAMA_DSH_API_KEY=provider-secret', command)
        self.assertIn('/data/dsh:uid=12345,gid=54321,mode=0700', command)

    def test_host_network_is_never_used_for_disposable_server(self):
        source = self.source()
        source['NetworkSettings']['Networks'] = {'host': {}}
        with self.assertRaises(isolated.QualificationError):
            isolated.candidate_command(source, 'image', 'disposable')

    def test_diagnostics_redact_provider_and_launch_tokens(self):
        source = self.source()
        source['_credential_values'] = ['credential-store-secret']
        value = isolated.redact('credential-store-secret provider-secret http://host/?token=temporary\nprivate', source)
        self.assertNotIn('credential-store-secret', value)
        self.assertNotIn('provider-secret', value)
        self.assertNotIn('temporary', value)
        self.assertNotIn('private', value)


if __name__ == '__main__':
    unittest.main()
