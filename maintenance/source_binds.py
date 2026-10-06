"""Explicit, digest-reviewed ownership transfer for deployment-local code binds."""
from pathlib import Path, PurePosixPath
import re
from .common import digest
from .contract import require


def source_file(source, relative):
    path = PurePosixPath(relative)
    require(not path.is_absolute() and '..' not in path.parts and str(path) != '.', 'Unsafe source artifact path')
    file = source / path
    require(file.is_file() and not file.is_symlink() and file.resolve().is_relative_to(source.resolve()),
            'Source artifact must be a regular file within the pinned release')
    return file


def plan_binds(values, model, roles, source):
    """SERVICE:/container/path=repository/path@sha256-of-current-bind."""
    result, seen = [], set()
    for value in values:
        identity, equal, content = value.partition('=')
        service, colon, target = identity.partition(':')
        relative, at, expected = content.rpartition('@')
        require(equal and colon and at and re.fullmatch(r'[a-f0-9]{64}', expected),
                'Source bind syntax is SERVICE:/target=repository/path@CURRENT_SHA256')
        require(service in roles and target.startswith('/') and '..' not in PurePosixPath(target).parts and (service, target) not in seen,
                'Source binds must uniquely identify a registered service and absolute destination')
        seen.add((service, target))
        mounts = [m for m in model['services'][service].get('volumes', []) if m.get('target') == target]
        require(len(mounts) == 1 and mounts[0].get('type') == 'bind' and mounts[0].get('read_only'),
                'Source adoption requires one read-only file bind at the exact destination')
        current = Path(mounts[0]['source'])
        require(current.is_file() and not current.is_symlink() and digest(current) == expected,
                'Source bind changed or is not a regular file; review it again')
        candidate = source_file(source, relative)
        print(f'Source bind {service}:{target}: {expected} -> {digest(candidate)} ({relative})')
        result.append({'service': service, 'target': target, 'relative': relative,
                       'installed': str(current), 'original': str(current), 'adoption_sha256': expected})
    return result


def check_inputs(artifacts):
    for artifact in artifacts:
        expected = artifact.get('adoption_sha256')
        if expected:
            path = Path(artifact['original'])
            require(path.is_file() and not path.is_symlink() and digest(path) == expected,
                    'Reviewed source bind changed during maintenance; services remain unchanged')


def register_binds(manifest, artifacts):
    for artifact in artifacts:
        manifest['source_artifacts'] = [old for old in manifest.get('source_artifacts', [])
            if (old.get('service'), old.get('target')) != (artifact['service'], artifact['target'])
            and not ('service' not in old and old['installed'] == artifact['installed'])]
        manifest['source_artifacts'].append(artifact)
        if artifact['original'] not in manifest['input_paths']:
            manifest['input_paths'].append(artifact['original'])


RESIDENT_CODE_TARGETS = {
    '/opt/dsh-seed/.dsh-plugins/dsh-router-model-discovery.js',
    *('/opt/dsh-build/' + name + '.mjs' for name in
      ('migrate-resident-models', 'verify-router-contract', 'verify-resident-client')),
}


def validate_resident_binds(model, manifest):
    """A known executable destination may not silently shadow a new image."""
    artifacts = manifest.get('source_artifacts', [])
    for service, role in manifest['roles'].items():
        if role != 'harness':
            continue
        for mount in model['services'][service].get('volumes', []):
            target = mount.get('target', '')
            affected = [code for code in RESIDENT_CODE_TARGETS
                        if code == target or code.startswith(target.rstrip('/') + '/')]
            if not affected:
                continue
            require(target in RESIDENT_CODE_TARGETS and any(
                artifact['installed'] == mount.get('source') and
                ('service' not in artifact or (artifact['service'] == service and artifact['target'] == target))
                for artifact in artifacts),
                'Unmanaged resident code bind shadows the image; explicitly adopt each file with --source-bind')
