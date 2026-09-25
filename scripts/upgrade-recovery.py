#!/usr/bin/env python3
"""Private recovery point for upgrades that change Harness's on-disk format.

The updater owns the maintenance lock. This helper never changes Git or contacts
another host. Docker commands operate on the selected local Compose project.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOTS = ('data/dsh', 'data/gateway', 'data/backend-auth', 'secrets')
TARGET = '0.1.7-rc.2'


def run(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        # Compose config and container inspection may contain credentials.
        raise RuntimeError(f'{args[0]} {args[1]} failed (exit {result.returncode}); output withheld')
    return result.stdout


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def copy_file(source, destination):
    shutil.copy2(source, destination, follow_symlinks=False)
    info = os.lstat(source)
    if os.geteuid() == 0:
        os.chown(destination, info.st_uid, info.st_gid, follow_symlinks=False)
    elif info.st_uid != os.geteuid():
        raise RuntimeError('Cannot preserve ownership of a recovery file as this user')
    return destination


def copy_path(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        raise RuntimeError(f'Recovery root must not be a symlink: {source.name}')
    if source.is_dir():
        shutil.copytree(source, destination, symlinks=True, copy_function=copy_file)
        for directory, dirs, _ in os.walk(source, followlinks=False):
            for path in [Path(directory), *(Path(directory) / name for name in dirs)]:
                info = path.lstat()
                if os.geteuid() == 0:
                    os.chown(destination / path.relative_to(source), info.st_uid, info.st_gid, follow_symlinks=False)
                elif info.st_uid != os.geteuid():
                    raise RuntimeError('Cannot preserve ownership of a recovery directory as this user')
    else:
        copy_file(source, destination)


def inventory(root):
    result = {}
    if not root.exists():
        return result
    rows = [(str(root.parent), [], [root.name])] if not root.is_dir() else os.walk(root, followlinks=False)
    for directory, dirs, files in rows:
        paths = [*(Path(directory) / name for name in dirs + files)]
        if root.is_dir():
            paths.insert(0, Path(directory))
        for path in paths:
            relative = str(path.relative_to(root))
            info = path.lstat()
            row = [info.st_mode, info.st_uid, info.st_gid]
            if path.is_symlink():
                row.append(os.readlink(path))
            elif path.is_file():
                with path.open('rb') as stream:
                    row.append(hashlib.file_digest(stream, 'sha256').hexdigest())
            result[relative] = row
    return result


def escape_compose(value):
    if isinstance(value, str):
        return value.replace('$', '$$')
    if isinstance(value, dict):
        return {key: escape_compose(item) for key, item in value.items()}
    if isinstance(value, list):
        return [escape_compose(item) for item in value]
    return value


def compose(point, *arguments):
    return run(['docker', 'compose', '--project-directory', str(point.parent.parent.parent),
                '-f', str(point / 'compose.json'), *arguments])


def prepare(project, mode, commit):
    # Inspect only this named project, and require the deployed Compose identity.
    probe = subprocess.run(['docker', 'inspect', 'deepseek-harness'], capture_output=True, text=True)
    if probe.returncode:
        return None  # Fresh installation has no old runtime to roll back.
    container = json.loads(probe.stdout)[0]
    labels = container['Config'].get('Labels', {})
    if labels.get('org.opencontainers.image.version') == TARGET:
        return None  # This one-time storage migration has already happened.
    if (labels.get('com.docker.compose.project') != 'deepseek-harness'
            or labels.get('com.docker.compose.service') != 'harness'
            or Path(labels.get('com.docker.compose.project.working_dir', '')).resolve() != project):
        raise RuntimeError('Recovery refused: the deployed Harness belongs to another checkout')
    recovery_root = project / 'data/upgrade-recovery'
    recovery_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(recovery_root, 0o700)
    point = Path(tempfile.mkdtemp(prefix=time.strftime('%Y%m%dT%H%M%S-'), dir=recovery_root))
    copy_file(project / '.env', point / '.env')
    os.chmod(point / '.env', 0o600)
    files = []
    for name in ('compose.yaml', f'compose.{mode}-ollama.yaml'):
        source = run(['git', '-c', f'safe.directory={project}', '-C', str(project), 'show', f'{commit}:{name}'])
        path = point / name
        path.write_text(source)
        files.extend(['-f', str(path)])
    command = ['docker', 'compose', '--project-directory', str(project), '--env-file', str(point / '.env'), *files]
    spec = json.loads(run([*command, 'config', '--format', 'json']))
    ids = run([*command, 'ps', '-aq']).split()
    if not ids:
        raise RuntimeError('Recovery refused: deployed Compose containers could not be captured')
    deployed = json.loads(run(['docker', 'inspect', *ids]))
    images = {}
    for item in deployed:
        item_labels = item['Config'].get('Labels', {})
        if item_labels.get('com.docker.compose.project') != 'deepseek-harness':
            raise RuntimeError('Recovery refused a container from another Compose project')
        images[item_labels['com.docker.compose.service']] = item['Image']
    if not {'harness', 'gateway'} <= images.keys():
        raise RuntimeError('Recovery requires the previous Harness and gateway containers')
    for service, config in spec['services'].items():
        image = images.get(service)
        if not image:
            image = json.loads(run(['docker', 'image', 'inspect', config['image']]))[0]['Id']
        tag = f'local/dsh-upgrade-rollback:{point.name.lower()}-{service}'
        run(['docker', 'image', 'tag', image, tag])
        config['image'] = tag
        config['pull_policy'] = 'never'
        config.pop('build', None)
    write_json(point / 'compose.json', escape_compose(spec))
    write_json(point / 'state.json', {'stage': 'prepared', 'project': str(project), 'from_commit': commit,
                                    'mode': mode, 'old_version': labels.get('org.opencontainers.image.version')})
    return point


def read_state(point):
    state = json.loads((point / 'state.json').read_text())
    if Path(state['project']).resolve() != point.parent.parent.parent.resolve():
        raise RuntimeError('Recovery point belongs to another checkout')
    return state


def capture(point):
    state = read_state(point)
    project = Path(state['project'])
    if state['stage'] != 'prepared':
        raise RuntimeError('Recovery snapshot has already been attempted')
    size = sum(path.lstat().st_size for relative in ROOTS for path in (project / relative).rglob('*')
               if path.is_file() and not path.is_symlink())
    if shutil.disk_usage(project).free < size * 2 + 64 * 1024 * 1024:
        raise RuntimeError('Insufficient disk space for a complete migration snapshot and recovery copy')
    state['stage'] = 'stopping'
    write_json(point / 'state.json', state)
    compose(point, 'stop')
    payload = point / 'snapshot'
    payload.mkdir(mode=0o700)
    for relative in ROOTS:
        source = project / relative
        if source.exists() or source.is_symlink():
            copy_path(source, payload / relative)
    # The environment was captured before the updater migrated image/version pins.
    copy_file(point / '.env', payload / '.env')
    manifest = inventory(payload)
    # Compare every copied tree while all writers are stopped.
    for relative in ROOTS:
        if inventory(project / relative) != inventory(payload / relative):
            raise RuntimeError(f'Recovery snapshot did not preserve {relative}')
    write_json(point / 'manifest.json', manifest)
    os.sync()
    state['stage'] = 'captured'
    write_json(point / 'state.json', state)


def restore(point):
    state = read_state(point)
    if state['stage'] in ('prepared', 'stopping'):
        # Deployment has not started: snapshot failure must leave old data intact.
        compose(point, 'start')
        return
    if state['stage'] not in ('captured', 'restoring', 'restored'):
        raise RuntimeError('Recovery point is not restorable')
    payload = point / 'snapshot'
    if inventory(payload) != json.loads((point / 'manifest.json').read_text()):
        raise RuntimeError('Recovery snapshot failed integrity verification; data was not replaced')
    project = Path(state['project'])
    if state['stage'] != 'restored':
        compose(point, 'stop')
        state['stage'] = 'restoring'
        write_json(point / 'state.json', state)
        failed = point / 'failed-runtime'
        failed.mkdir(mode=0o700, exist_ok=True)
        for relative in (*ROOTS, '.env'):
            destination = project / relative
            retained = failed / relative
            staged = point / 'restore-stage' / relative
            if relative in state.get('restored_roots', []):
                continue
            original = payload / relative
            if retained.exists() and destination.exists():
                # A process may die after rename but before recording the root.
                if inventory(destination) != inventory(original):
                    raise RuntimeError('Interrupted restore found changed destination data; retained both copies')
            elif original.exists():
                if staged.exists() and inventory(staged) != inventory(original):
                    raise RuntimeError('Interrupted restore staging is incomplete; retained all source data')
                if not staged.exists():
                    copy_path(original, staged)
            if destination.exists() and not retained.exists():
                retained.parent.mkdir(parents=True, exist_ok=True)
                destination.rename(retained)
            if staged.exists():
                staged.rename(destination)
            state.setdefault('restored_roots', []).append(relative)
            write_json(point / 'state.json', state)
        state['stage'] = 'restored'
        write_json(point / 'state.json', state)
    compose(point, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '240')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'capture', 'restore'])
    parser.add_argument('--project', type=Path)
    parser.add_argument('--mode', choices=['external', 'remote', 'managed'])
    parser.add_argument('--from-commit')
    parser.add_argument('--point', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.action == 'prepare':
            if not all((args.project, args.mode, args.from_commit)):
                parser.error('prepare requires --project, --mode and --from-commit')
            point = prepare(args.project.resolve(), args.mode, args.from_commit)
            if point:
                print(point)
        else:
            if not args.point:
                parser.error('--point is required')
            {'capture': capture, 'restore': restore}[args.action](args.point.resolve())
    except Exception as error:
        print(f'Upgrade recovery failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
