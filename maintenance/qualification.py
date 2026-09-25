"""Discover all first-party Compose definitions and check rendered profiles."""
import json
import os
from pathlib import Path
import re

from .common import run
from .contract import require, validate_config


def registered_files(root):
    root = Path(root)
    registry = json.loads((root / 'config/deployment-profiles.json').read_text())
    require(registry.get('schema') == 1, 'Unsupported deployment registry')
    registered = {file for files in registry['profiles'].values() for file in files}
    discovered = set()
    files = run(['git', '-C', root, 'ls-files', '--cached', '--others', '--exclude-standard']).splitlines()
    for relative in files:
        path = root / relative
        if relative in registry['separate_projects']:
            continue
        if path.suffix not in ('.yaml', '.yml') or not path.is_file():
            continue
        if 'compose' in path.name.lower() or re.search(r'^services:\s*$', path.read_text(), re.M):
            discovered.add(relative)
    require(discovered == registered, 'An application Compose definition is unregistered or missing: ' + ', '.join(sorted(discovered ^ registered)))
    return registry


def qualify(root):
    root = Path(root).resolve()
    registry = registered_files(root)
    env = dict(os.environ, HARNESS_AUTH_USERNAME='synthetic-user', HARNESS_AUTH_PASSWORD='synthetic-password')
    for profile, files in registry['profiles'].items():
        command = ['docker', 'compose', '--project-directory', root, '--env-file', root / '.env.example']
        for file in files:
            command += ['-f', root / file]
        model = json.loads(run([*command, 'config', '--format', 'json'], env=env))
        require(validate_config(model, root)[0] == 'harness', 'The Harness service must own the update capability')
        print('Qualified mandatory updater:', profile)


if __name__ == '__main__':
    qualify(Path(__file__).resolve().parents[1])
