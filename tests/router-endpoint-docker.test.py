#!/usr/bin/env python3
"""Docker rehearsal: the router a container actually resolves comes from the setting.

Usage: tests/router-endpoint-docker.test.py <image>

The decision test (tests/router-endpoint.test.py) proves the updater re-derives
the mapping from the deployment's one router setting. This proves the
consequence where it counts: a consumer started from the materialized model
resolves the canonical `ai-router` name to the address that setting names —
including the first time, when the model still carries the address it was
installed with — and follows the setting to a second router and back. The
address the consumer left is never resolved again, and the router it left keeps
running: that is what makes a per-consumer migration safe and reversible.
"""
from pathlib import Path
import json
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from maintenance import router
from maintenance.common import atomic_json

FIRST, SECOND = '192.168.1.4', '192.168.1.23'


def run(*args):
    result = subprocess.run([str(x) for x in args], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f'{" ".join(str(x) for x in args)} failed ({result.returncode}):\n'
                         + result.stdout + result.stderr)
    return result.stdout


def resolved_address(logs):
    for line in logs.splitlines():
        fields = line.split()
        if len(fields) >= 2 and fields[1] == router.CANONICAL_NAME:
            return fields[0]
    raise SystemExit('the container never resolved ' + router.CANONICAL_NAME + ':\n' + logs)


def main():
    image = sys.argv[1]
    temporary = Path(tempfile.mkdtemp(prefix='dsh-router-endpoint-'))
    root = temporary / 'data/operations'
    root.mkdir(parents=True)
    project = 'dsh-router-endpoint'
    manifest = {'mode': 'remote', 'roles': {'harness': 'harness'}}
    environment = temporary / '.env'
    model = {'name': project, 'services': {'harness': {
        'image': image, 'entrypoint': 'cat', 'command': ['/etc/hosts'],
        'pull_policy': 'never', 'network_mode': 'none',
        # The address this deployment was installed with, baked into the
        # materialized model: what a forwarded update would keep using.
        'extra_hosts': [f'{router.CANONICAL_NAME}={FIRST}']}}}
    observed = []

    def deploy(label, setting):
        environment.write_text(f'HARNESS_AUTH_PASSWORD=irrelevant\n{router.SETTING}={setting}\n')
        router.apply(model, manifest, root)
        atomic_json(root / 'compose.json', model)
        run('docker', 'compose', '--project-directory', root, '-f', root / 'compose.json',
            'up', '--abort-on-container-exit', '--force-recreate', '--remove-orphans')
        container = run('docker', 'ps', '-a', '--filter', f'name={project}-harness-1',
                        '--format', '{{.ID}}').split()[0]
        address = resolved_address(run('docker', 'logs', container))
        observed.append((label, setting, address))
        print(f'{label}: {router.SETTING}={setting} -> the consumer resolves '
              f'{router.CANONICAL_NAME} to {address}', flush=True)

    try:
        deploy('installed with', FIRST)
        # Simulate a model whose baked address was never refreshed, which is
        # exactly the state a forwarded update used to leave behind.
        model['services']['harness']['extra_hosts'] = [f'{router.CANONICAL_NAME}={FIRST}']
        deploy('moved to', SECOND)
        deploy('moved back to', FIRST)
    finally:
        run('docker', 'compose', '--project-directory', root, '-f', root / 'compose.json',
            'down', '--remove-orphans')
    if [(label, address) for label, setting, address in observed] != \
            [('installed with', FIRST), ('moved to', SECOND), ('moved back to', FIRST)]:
        raise SystemExit(f'the consumer did not follow the setting: {observed}')
    if any(entry != f'{router.CANONICAL_NAME}={FIRST}'
           for entry in model['services']['harness']['extra_hosts']):
        raise SystemExit('the address the consumer left is still baked into the model')
    print('A DSH consumer follows its one router setting and follows it back; '
          f'the router it leaves keeps serving ({FIRST} stays up for {SECOND}).')


if __name__ == '__main__':
    main()
