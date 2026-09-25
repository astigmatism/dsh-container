"""The same update capability contract is used by installers, CI and updates."""
import os
from pathlib import Path, PurePosixPath
import re
import stat
from urllib.parse import urlsplit
from urllib.request import urlopen
import json

from .common import Failure, LABEL, SCHEMA, REPOSITORY

SCRIPT = 'scripts/update-and-restart.sh'


def require(condition, message):
    if not condition:
        raise Failure(message)


def relative_script(value):
    require(isinstance(value, str) and bool(re.fullmatch(r'[A-Za-z0-9._ /-]{1,200}', value)),
            'Updater script is not a valid relative path')
    path = PurePosixPath(value)
    require(not path.is_absolute() and '..' not in path.parts and str(path) != '.',
            'Updater script escapes the operational directory')
    return path


def validate_config(model, root, *, script_root=None):
    require(bool(re.fullmatch(r'[a-z0-9][a-z0-9_.-]{0,62}', model.get('name', ''))),
            'Invalid Compose project name')
    root = Path(root)
    require(root.is_absolute() and str(root) != '/' and ':' not in str(root),
            'Invalid Compose operational directory')
    services = model.get('services', {})
    advertisers = []
    for name, service in services.items():
        labels = service.get('labels', {})
        update = {k: v for k, v in labels.items() if k.startswith(LABEL)}
        if not update:
            continue
        require(labels.get(LABEL + 'enabled') == 'true', f'{name}: updates must be enabled')
        relative = relative_script(labels.get(LABEL + 'script'))
        require(bool(re.fullmatch(r'\d+:\d+', labels.get(LABEL + 'user', ''))),
                f'{name}: updater requires numeric UID:GID')
        image = labels.get(LABEL + 'image', '')
        require(bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}', image)),
                f'{name}: updater requires an explicit image')
        home = labels.get(LABEL + 'host-home', '')
        require(not home or (home.startswith('/') and home != '/' and ':' not in home and '\0' not in home),
                f'{name}: invalid updater host-home')
        file = Path(script_root or root).joinpath(*relative.parts)
        require(file.is_file() and not file.is_symlink() and os.access(file, os.X_OK),
                f'{name}: updater is not an existing executable regular file')
        require(file.resolve().is_relative_to(Path(script_root or root).resolve()),
                f'{name}: updater resolves outside the operational directory')
        advertisers.append((name, str(relative), image, labels[LABEL + 'user'], home))
    require(len(advertisers) == 1, 'Exactly one service must advertise the project updater')
    return advertisers[0]


def portal_services(url):
    parts = urlsplit(url)
    require(parts.scheme in ('http', 'https') and bool(parts.hostname)
            and not parts.username and not parts.password and not parts.query and not parts.fragment,
            'A deployment-local HTTP(S) Portal URL without embedded credentials is required')
    try:
        with urlopen(url.rstrip('/') + '/api/services', timeout=15) as response:
            data = json.load(response)
        require(isinstance(data.get('services'), list), 'Portal returned an invalid service listing')
        return data['services']
    except Failure:
        raise
    except Exception:
        raise Failure('Service Portal discovery is unavailable; private response withheld') from None


def verify_portal(url, project, container_id):
    rows = portal_services(url)
    matches = [row for row in rows if row.get('project') == project
               and row.get('id') in (container_id, container_id[:12])]
    require(len(matches) == 1, 'Portal did not discover the expected application container')
    update = matches[0].get('update') or {}
    require(update.get('available') is True and update.get('project') == project,
            'Portal did not confirm the mandatory update capability')


def validate_manifest(manifest, root):
    require(manifest.get('schema') == SCHEMA, 'Unsupported deployment manifest schema')
    require(manifest.get('repository') == REPOSITORY and manifest.get('branch') == 'main',
            'Unexpected source repository or branch')
    require(Path(manifest.get('root', '')).resolve() == Path(root).resolve(),
            'Manifest belongs to a different operational directory')
    require(manifest.get('mode') in ('remote', 'external', 'managed'), 'Invalid deployment mode')
    require(bool(re.fullmatch(r'[0-9a-f]{40}', manifest.get('revision', ''))), 'Invalid source revision')
    require(bool(manifest.get('engine_id')), 'Missing Docker Engine identity')
    roles = manifest.get('roles', {})
    require(len([r for r in roles.values() if r == 'harness']) == 1
            and len([r for r in roles.values() if r == 'gateway']) == 1
            and set(roles.values()) <= {'harness', 'gateway', 'router'}, 'Ambiguous application service roles')
    for field in ('state_paths', 'input_paths', 'artifact_paths'):
        require(isinstance(manifest.get(field), list), f'Missing {field}')
        for value in manifest[field]:
            path = Path(value)
            require(path.is_absolute() and str(path) != '/' and ':' not in value,
                    f'Unsafe path in {field}')
    state = [Path(p).resolve() for p in manifest['state_paths']]
    for index, path in enumerate(state):
        require(not Path(root).resolve().is_relative_to(path), 'State snapshot would include deployment metadata')
        for other in state[index + 1:]:
            require(not path.is_relative_to(other) and not other.is_relative_to(path), 'Overlapping snapshot roots')
    require(bool(manifest.get('portal_url')), 'Missing Service Portal URL')
