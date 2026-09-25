#!/usr/bin/env python3
"""Entrypoint usable both from the source tree and a packaged runtime."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import uuid

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
# Docker installs this directory as /opt/dsh-maintenance; source and bundles use maintenance.
if Path(__file__).resolve().parent.name != 'maintenance':
    import importlib.util
    spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).parent / '__init__.py',
                                                submodule_search_locations=[str(Path(__file__).parent)])
    package = importlib.util.module_from_spec(spec)
    sys.modules['maintenance'] = package
    spec.loader.exec_module(package)

from maintenance.common import Failure, LABEL, compose_command, inspect, read_json, run
from maintenance.contract import require, validate_config, validate_manifest
from maintenance.engine import Updater, probe_release, validate_engine


def launch(root, dry_run=False, action='update'):
    manifest = read_json(root / 'deployment.json')
    validate_manifest(manifest, root)
    validate_engine(manifest)
    model = read_json(root / 'compose.json')
    _, _, image, user, _ = validate_config(model, root)
    require(inspect('image', image)['Config'].get('Labels', {}).get('io.dsh.maintenance.schema') == '1',
            'Updater image lacks the qualified runtime; bootstrap required')
    paths = {str(root): False}
    # Parent mounts permit whole-root restoration without renaming a mountpoint.
    for path in manifest['state_paths'] + manifest['artifact_paths']:
        parent = str(Path(path).parent)
        require(parent != '/', 'State/configuration directly under filesystem root needs a narrower deployment directory')
        paths[parent] = False
    for path in manifest['input_paths']:
        # Imported configuration and read-only credential inputs are never
        # rewritten by the transaction. Do not expose their entire parent home.
        if path not in paths:
            paths[path] = True
    name = 'dsh-maintenance-' + uuid.uuid4().hex[:12]
    command = ['docker', 'run', '--rm', '--init', '--name', name,
               '--label', 'io.service-portal.maintenance=true', '--user', user,
               '--group-add', str(os.stat('/var/run/docker.sock').st_gid),
               '--workdir', str(root), '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
               '--entrypoint', 'python3']
    for path, readonly in paths.items():
        require(',' not in path, 'A mount path contains unsupported comma syntax')
        command += ['--mount', f'type=bind,src={path},dst={path}' + (',readonly' if readonly else '')]
    command += [image, '-B', '/opt/dsh-maintenance/main.py', action, '--manifest', str(root / 'deployment.json')]
    if dry_run:
        command.append('--dry-run')
    process = subprocess.Popen(command)
    def stop(sig, frame):
        subprocess.run(['docker', 'stop', '--time', '60', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    code = process.wait()
    require(code == 0, f'Maintenance worker failed (exit {code}); inspect the private maintenance status')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('install', 'launch', 'update', 'verify', 'boot', 'self-test'))
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--deployment-dir', type=Path)
    parser.add_argument('--project-directory', type=Path)
    parser.add_argument('--compose-file', action='append', default=[])
    parser.add_argument('--env-file')
    parser.add_argument('--boot-unit')
    parser.add_argument('--legacy-entrypoint', type=Path,
                        help='Preserve the currently advertised update script as a forwarding entrypoint during adoption')
    parser.add_argument('--worker-action', choices=('update', 'boot', 'verify'), default='update')
    parser.add_argument('--portal-url', default=os.environ.get('SERVICE_PORTAL_URL', ''))
    parser.add_argument('--role', action='append', default=[])
    parser.add_argument('--state-path', action='append', default=[])
    parser.add_argument('--external-path', action='append', default=[])
    parser.add_argument('--adopt', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--remote-ollama', dest='mode', action='store_const', const='remote')
    modes.add_argument('--external-ollama', dest='mode', action='store_const', const='external')
    modes.add_argument('--managed-ollama', dest='mode', action='store_const', const='managed')
    args = parser.parse_args()
    if args.action == 'self-test':
        from maintenance import recovery, install
        require(callable(recovery.restore) and callable(install.prepare), 'Incomplete maintenance package')
        print('Maintenance schema 1 available')
        return
    if args.action == 'install':
        from maintenance.install import prepare
        source = Path(__file__).resolve().parent.parent
        prepare(args, source)
        return
    require(args.manifest is not None, '--manifest is required')
    root = args.manifest.resolve().parent
    require(args.manifest.name == 'deployment.json', 'Manifest must be named deployment.json')
    manifest = read_json(args.manifest)
    if args.mode:
        require(args.mode == manifest['mode'], 'Requested topology conflicts with installed deployment')
    if args.action == 'launch':
        launch(root, args.dry_run, args.worker_action)
    elif args.action == 'update':
        def interrupted(sig, frame):
            raise Failure('Maintenance interrupted; recovering the transaction')
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, interrupted)
        Updater(root).update(args.dry_run)
    else:
        import fcntl
        with (root / '.maintenance.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Failure('Maintenance is active; boot/verification must wait') from None
            updater = Updater(root)
            updater.preflight()
            require(not (root / 'transaction.json').exists(), 'Interrupted update requires recovery before boot or verification')
            if args.action == 'boot':
                run([*compose_command(root), 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '900'])
            probe_release(manifest, updater.model, root)
            print('Deployment and mandatory Portal capability verified')


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except (Failure, OSError, ValueError, KeyError) as error:
        # Unexpected OS/parser errors may include private file contents/paths.
        print('Maintenance failed: ' + (str(error) if isinstance(error, Failure) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
