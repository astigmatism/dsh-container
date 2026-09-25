"""One update transaction for all topologies; no deployment-target constants."""
import copy
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import tempfile
import time
import uuid

from .common import Failure, LABEL, REPOSITORY, atomic_json, atomic_text, compose_command, digest, inspect, read_json, run, sync_path, sync_directory
from .contract import SCRIPT, require, validate_config, validate_manifest, validate_deployment, configuration_bindings, portal_services, verify_portal
from . import recovery

PACKAGE = Path(__file__).resolve().parent


def containers(model, root):
    ids = run(['docker', 'ps', '-a', '--filter', 'label=com.docker.compose.project=' + model['name'], '--format', '{{.ID}}']).split()
    return json.loads(run(['docker', 'inspect', *ids])) if ids else []


def validate_engine(manifest):
    actual = run(['docker', 'info', '--format', '{{.ID}}']).strip()
    local = run(['docker', '--host', 'unix:///var/run/docker.sock', 'info', '--format', '{{.ID}}']).strip()
    require(actual == local == manifest['engine_id'], 'Docker Engine does not match the local deployment socket')


def validate_containers(manifest, model, root, *, allow_empty=False):
    rows = containers(model, root)
    require(rows or allow_empty, 'No containers found for the registered Compose project')
    for row in rows:
        labels = row['Config'].get('Labels', {})
        require(labels.get('com.docker.compose.project') == model['name']
                and Path(labels.get('com.docker.compose.project.working_dir', '')).resolve() == Path(root).resolve(),
                'A container belongs to a different Compose deployment')
        require(labels.get('com.docker.compose.service') in model['services'], 'Unregistered project service')
    return rows


def qualify_runner(image):
    require(inspect('image', image)['Config'].get('Labels', {}).get('io.dsh.maintenance.schema') == '1',
            'Image does not supply the qualified maintenance runtime; bootstrap is required')
    run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', '/bin/sh', image,
         '-eu', '-c', 'python3 -B /opt/dsh-maintenance/main.py self-test; docker compose version; docker buildx version'])


def verify_application(manifest, by_service):
    harness = next(s for s, role in manifest['roles'].items() if role == 'harness')
    gateway = next(s for s, role in manifest['roles'].items() if role == 'gateway')
    for script, arguments in (
        ('verify-router-contract.mjs', ['--mode', manifest['mode']]),
        ('verify-sidebar-terminal.mjs', ['--native']),
        ('verify-sidebar-client.mjs', []),
        ('verify-dictation-client.mjs', []),
        ('verify-resident-client.mjs', ['--live']),
        ('verify-dsh-playwright-stream.mjs', []),
        ('verify-dsh-inference-contract.mjs', []),
    ):
        run(['docker', 'exec', by_service[harness]['Id'], 'node', '/opt/dsh-build/' + script, *arguments])
    run(['docker', 'exec', by_service[gateway]['Id'], 'node', '/opt/dsh-gateway/verify-dictation-backend.mjs'])


def probe_release(manifest, model, root, *, portal=True):
    rows = validate_containers(manifest, model, root)
    by_service = {row['Config']['Labels']['com.docker.compose.service']: row for row in rows}
    for service, config in model['services'].items():
        row = by_service.get(service)
        require(row is not None, 'A deployed service is missing')
        require(row['Image'] == inspect('image', config['image'])['Id'], 'A service is running an unexpected image')
        oneshot = any(c.get('depends_on', {}).get(service, {}).get('condition') == 'service_completed_successfully'
                      for c in model['services'].values())
        if config.get('restart') == 'no' or oneshot:
            require(row['State']['Status'] == 'exited' and row['State']['ExitCode'] == 0, 'An initialization service failed')
            continue
        require(row['State']['Running'] and row['State'].get('Health', {}).get('Status') == 'healthy',
                'An application service is not healthy')
    gateway = next(s for s, role in manifest['roles'].items() if role == 'gateway')
    run(['docker', 'exec', '-i', by_service[gateway]['Id'], 'node', '--input-type=module'],
        data=(PACKAGE / 'probe.mjs').read_text())
    verify_application(manifest, by_service)
    if portal:
        validate_deployment(manifest, model, root)
        advertiser = validate_config(model, root)[0]
        live = copy.deepcopy(model)
        for service in live['services']:
            live['services'][service]['labels'] = by_service[service]['Config'].get('Labels', {})
        validate_config(live, root)
        for service, expected in model['services'].items():
            for key, value in expected.get('labels', {}).items():
                if key.startswith(LABEL):
                    require(by_service[service]['Config']['Labels'].get(key) == value, 'Live updater labels differ from the installed contract')
        verify_portal(manifest['portal_url'], model['name'], by_service[advertiser]['Id'])


def pinned_bases(source):
    for filename in (source / 'Dockerfile', source / 'ollama-router/Dockerfile'):
        arguments, stages = {}, set()
        for line in filename.read_text().splitlines():
            if line.startswith('ARG ') and '=' in line:
                key, value = line[4:].split('=', 1)
                arguments[key] = value
            if line.startswith('FROM '):
                words = line.split()
                image = words[1]
                if image.startswith('${') and image.endswith('}'):
                    image = arguments.get(image[2:-1], '')
                require(image in stages or bool(re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}', image)),
                        'Release source contains an unpinned base image')
                if len(words) == 4 and words[2].upper() == 'AS':
                    stages.add(words[3])


def fetch_source(destination):
    env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1', GIT_TERMINAL_PROMPT='0')
    output = run(['git', '-c', 'credential.helper=', 'ls-remote', REPOSITORY, 'refs/heads/main'], env=env)
    lines = output.strip().splitlines()
    require(len(lines) == 1 and bool(re.fullmatch(r'[0-9a-f]{40}\s+refs/heads/main', lines[0])),
            'Cannot resolve canonical main to one immutable commit')
    revision = lines[0].split()[0]
    run(['git', 'init', '--quiet', destination], env=env)
    run(['git', '-C', destination, '-c', 'credential.helper=', 'fetch', '--quiet', '--depth=1', REPOSITORY, revision], env=env)
    require(run(['git', '-C', destination, 'rev-parse', 'FETCH_HEAD']).strip() == revision, 'Fetched source revision mismatch')
    run(['git', '-C', destination, 'checkout', '--quiet', '--detach', revision], env=env)
    return revision


def install_labels(model, manifest, runner):
    harness = next(s for s, role in manifest['roles'].items() if role == 'harness')
    for service in model['services'].values():
        labels = service.setdefault('labels', {})
        for key in list(labels):
            if key.startswith(LABEL):
                del labels[key]
    model['services'][harness]['labels'].update({
        LABEL + 'enabled': 'true', LABEL + 'script': SCRIPT,
        LABEL + 'image': runner, LABEL + 'user': manifest['user'],
    })


def stage_source_artifacts(source, model, manifest, release_dir):
    """Only files explicitly imported from repository source are refreshed."""
    for artifact in manifest.get('source_artifacts', []):
        src = source / artifact['relative']
        require(src.is_file() and not src.is_symlink() and src.resolve().is_relative_to(source.resolve()),
                'Release is missing a required source-managed operational artifact')
        destination = release_dir / 'artifacts' / artifact['relative']
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copy2(src, destination)
        for service in model['services'].values():
            for mount in service.get('volumes', []):
                if mount.get('source') == artifact['installed']:
                    mount['source'] = str(destination)
        artifact['installed'] = str(destination)


class Updater:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.manifest = read_json(self.root / 'deployment.json')
        self.model = read_json(self.root / 'compose.json')

    def preflight(self, dry_run=False, *, allow_empty=False):
        validate_deployment(self.manifest, self.model, self.root)
        validate_engine(self.manifest)
        _, _, runner, _, _ = validate_config(self.model, self.root)
        require(inspect('image', runner)['Config'].get('Labels', {}).get('io.dsh.maintenance.schema') == '1',
                'The installed maintenance image is missing or unqualified')
        require(self.model['name'] == self.manifest['project'], 'Compose project differs from manifest')
        run([*compose_command(self.root), 'config', '--quiet'])
        portal_services(self.manifest['portal_url'])
        # During interrupted cutover the running Compose root may be either the
        # previous or candidate root. Recovery validates that recorded identity.
        if not (self.root / 'transaction.json').exists():
            validate_containers(self.manifest, self.model, self.root, allow_empty=allow_empty)
        for path in self.manifest['state_paths'] + self.manifest['input_paths']:
            require(Path(path).exists() and not Path(path).is_symlink(), 'A declared state or configuration path is missing or symlinked')
        if dry_run:
            require(not (self.root / 'transaction.json').exists(), 'Interrupted maintenance requires recovery before another update')
            print('Dry-run: validated deployment, state paths and Portal reachability. Would fetch pinned main, build, verify, snapshot, deploy and verify Portal capability; rollback on failure.')

    def build_candidate(self):
        source = Path(tempfile.mkdtemp(prefix='dsh-release-'))
        try:
            revision = fetch_source(source)
            pinned_bases(source)
            candidate = copy.deepcopy(self.model)
            manifest = copy.deepcopy(self.manifest)
            manifest['revision'] = revision
            images = {}
            for role in sorted(set(manifest['roles'].values())):
                tag = f'local/dsh-release-{manifest["project"]}:{revision}-{role}'
                context = source / 'ollama-router' if role == 'router' else source
                command = ['docker', 'build', '--pull', '--label', 'org.opencontainers.image.revision=' + revision,
                           '--tag', tag]
                if role != 'router':
                    command += ['--target', role]
                print(f'Building {role} at {revision}', flush=True)
                run([*command, context])
                images[role] = inspect('image', tag)['Id']
            qualify_runner(images['harness'])
            # Offline runtime checks do not mount production state.
            run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node',
                 images['harness'], '/opt/dsh-build/verify-router-startup.mjs'])
            run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node',
                 images['gateway'], '--check', '/opt/dsh-gateway/server.mjs'])
            release_dir = self.root / 'releases' / (revision + '-' + uuid.uuid4().hex[:8])
            release_dir.mkdir(parents=True, mode=0o700)
            for service, config in candidate['services'].items():
                config.pop('build', None)
                if service in manifest['roles']:
                    config['image'] = images[manifest['roles'][service]]
                else:
                    if re.fullmatch(r'sha256:[0-9a-f]{64}', config['image']):
                        inspect('image', config['image'])
                    else:
                        require('@sha256:' in config['image'], 'Fixed dependency images must be digest-pinned')
                        run(['docker', 'pull', config['image']])
                config['pull_policy'] = 'never'
                if manifest['roles'].get(service) == 'harness':
                    config.setdefault('environment', {})['HOST_EXEC_IMAGE'] = images['harness']
            install_labels(candidate, manifest, images['harness'])
            stage_source_artifacts(source, candidate, manifest, release_dir)
            manifest['images'] = {s: c['image'] for s, c in candidate['services'].items()}
            manifest['bindings'] = configuration_bindings(candidate)
            shutil.copytree(source / 'maintenance', release_dir / 'maintenance', ignore=shutil.ignore_patterns('__pycache__'))
            (release_dir / 'scripts').mkdir(mode=0o700)
            shutil.copy2(source / SCRIPT, release_dir / SCRIPT)
            atomic_json(release_dir / 'compose.json', candidate)
            atomic_text(release_dir / 'runner-image', images['harness'] + '\n')
            atomic_text(release_dir / 'start-after-network.sh', '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$root/scripts/update-and-restart.sh" --boot\n')
            (release_dir / 'start-after-network.sh').chmod(0o700)
            manifest['maintenance_artifacts'] = {str(path.relative_to(release_dir)): digest(path)
                for path in [*sorted((release_dir / 'maintenance').rglob('*.py')),
                             release_dir / 'maintenance/probe.mjs', release_dir / SCRIPT,
                             release_dir / 'runner-image', release_dir / 'start-after-network.sh']}
            atomic_json(release_dir / 'deployment.json', manifest)
            validate_deployment(manifest, candidate, self.root, script_root=release_dir)
            run([*compose_command(self.root, release_dir / 'compose.json'), 'config', '--quiet'])
            atomic_json(release_dir / 'provenance.json', {'repository': REPOSITORY, 'revision': revision,
                        'images': manifest['images'], 'compose_sha256': digest(release_dir / 'compose.json')})
            return release_dir
        finally:
            shutil.rmtree(source)

    def status(self, state, **fields):
        atomic_json(self.root / 'maintenance-status.json', {'state': state, 'time': time.time(), **fields})

    def old_model(self, root, model):
        previous = copy.deepcopy(model)
        rows = validate_containers(self.manifest, model, root, allow_empty=True)
        by_service = {r['Config']['Labels']['com.docker.compose.service']: r for r in rows}
        for service, config in previous['services'].items():
            config.pop('build', None)
            if service in by_service:
                image = by_service[service]['Image']
                # Retained tags protect every rollback image from ordinary pruning.
                tag = f'local/dsh-rollback-{model["name"]}:{uuid.uuid4().hex}-{service}'
                run(['docker', 'image', 'tag', image, tag])
                config['image'] = image
            config['pull_policy'] = 'never'
        return previous, bool(rows)

    def cutover(self, release, *, previous_root=None, previous_model=None):
        # Recheck after potentially long builds, before any service interruption.
        # A concurrent operator edit is never silently overwritten.
        require(read_json(self.root / 'deployment.json') == self.manifest
                and read_json(self.root / 'compose.json') == self.model,
                'Deployment configuration changed during maintenance; services remain unchanged')
        validate_deployment(read_json(Path(release) / 'deployment.json'),
                            read_json(Path(release) / 'compose.json'), self.root, script_root=release)
        portal_services(self.manifest['portal_url'])
        old_root = Path(previous_root or self.root)
        old_model, existed = self.old_model(old_root, previous_model or self.model)
        point = self.root / 'recovery' / (time.strftime('%Y%m%dT%H%M%S-') + uuid.uuid4().hex[:8])
        point.mkdir(parents=True, mode=0o700)
        paths = list(dict.fromkeys(self.manifest['state_paths'] + self.manifest['input_paths']
                + self.manifest['artifact_paths'] + [str(self.root / p) for p in ('compose.json', 'deployment.json', SCRIPT, 'maintenance', 'runner-image', 'start-after-network.sh')]))
        # Never snapshot a parent and its child twice.
        paths = [p for p in paths if not any(Path(p).is_relative_to(Path(q)) and p != q for q in paths)]
        recovery.check_space(point, paths)
        atomic_json(point / 'previous-compose.json', old_model)
        transaction = {'point': str(point), 'previous_root': str(old_root), 'previous_model': old_model,
                       'existed': existed, 'phase': 'prepared', 'paths': paths,
                       'previous_manifest': self.manifest}
        atomic_json(self.root / 'transaction.json', transaction)
        try:
            transaction['phase'] = 'stopping'
            atomic_json(self.root / 'transaction.json', transaction)
            if existed:
                run([*compose_command(old_root, point / 'previous-compose.json'), 'stop'])
            recovery.capture(point, paths)
            transaction['phase'] = 'captured'
            atomic_json(self.root / 'transaction.json', transaction)
            for name in ('maintenance',):
                destination = self.root / name
                if destination.exists():
                    shutil.rmtree(destination)
                shutil.copytree(Path(release) / name, destination)
            script_target = self.root / SCRIPT
            script_temporary = script_target.with_suffix('.partial')
            shutil.copy2(Path(release) / SCRIPT, script_temporary)
            script_temporary.replace(script_target)
            for name in ('compose.json', 'deployment.json'):
                atomic_json(self.root / name, read_json(Path(release) / name))
            atomic_text(self.root / 'runner-image', (Path(release) / 'runner-image').read_text())
            shutil.copy2(Path(release) / 'start-after-network.sh', self.root / 'start-after-network.sh')
            if self.manifest.get('boot_unit'):
                unit = Path(self.manifest['boot_unit'])
                text = unit.read_text()
                lines = []
                for line in text.splitlines():
                    if line.startswith('WorkingDirectory='):
                        line = 'WorkingDirectory=' + str(self.root)
                    elif line.startswith('ExecStart='):
                        line = 'ExecStart=' + str(self.root / 'start-after-network.sh')
                    lines.append(line)
                atomic_text(unit, '\n'.join(lines) + '\n')
            transaction['phase'] = 'installed'
            atomic_json(self.root / 'transaction.json', transaction)
            run([*compose_command(self.root), 'up', '-d', '--force-recreate', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '900'])
            candidate, manifest = read_json(self.root / 'compose.json'), read_json(self.root / 'deployment.json')
            probe_release(manifest, candidate, self.root)
            for name in ('maintenance', SCRIPT, 'start-after-network.sh'):
                sync_path(self.root / name)
                sync_directory((self.root / name).parent)
            transaction['phase'] = 'complete'
            atomic_json(self.root / 'transaction.json', transaction)
            self.status('ok', revision=manifest['revision'], recovery_point=str(point),
                        boot_activation='host-daemon-reload-required' if manifest.get('boot_unit') else 'unchanged')
            (self.root / 'transaction.json').unlink()
        except BaseException:
            self.recover()
            raise

    def recover(self):
        file = self.root / 'transaction.json'
        if not file.exists():
            return
        transaction = read_json(file)
        point = Path(transaction['point'])
        require(point.resolve().parent == (self.root / 'recovery').resolve(), 'Invalid recovery point location')
        validate_engine(transaction['previous_manifest'])
        allowed_roots = {Path(transaction['previous_root']).resolve(), self.root}
        for row in containers(transaction['previous_model'], self.root):
            labels = row['Config'].get('Labels', {})
            require(Path(labels.get('com.docker.compose.project.working_dir', '')).resolve() in allowed_roots
                    and labels.get('com.docker.compose.service') in transaction['previous_model']['services'],
                    'Recovery found a conflicting Compose deployment; services were not changed')
        if transaction['phase'] == 'complete':
            file.unlink()
            return
        self.status('recovering', recovery_point=str(point))
        try:
            old_root = Path(transaction['previous_root'])
            if transaction['phase'] not in ('prepared', 'stopping'):
                # Use the recorded project identity even if installation died
                # before writing a valid candidate Compose file.
                run([*compose_command(old_root, point / 'previous-compose.json'), 'stop'])
                recovery.restore(point)
            if transaction['existed']:
                run([*compose_command(old_root, point / 'previous-compose.json'), 'up', '-d', '--force-recreate', '--no-build',
                     '--pull', 'never', '--wait', '--wait-timeout', '900'])
                probe_release(transaction['previous_manifest'], transaction['previous_model'], old_root, portal=False)
            else:
                run([*compose_command(old_root, point / 'previous-compose.json'), 'down'])
            self.status('failed', recovery='succeeded', recovery_point=str(point))
            file.unlink()
        except BaseException:
            self.status('failed', recovery='failed', recovery_point=str(point))
            raise Failure('Automatic recovery incomplete; retained transaction and snapshot require inspection') from None

    def update(self, dry_run=False):
        if dry_run:
            self.preflight(True)
            return
        with (self.root / '.maintenance.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Failure('Another maintenance operation is active') from None
            if (self.root / 'transaction.json').exists():
                self.recover()
                raise Failure('Recovered interrupted maintenance; retry the update explicitly')
            self.preflight()
            self.status('building')
            try:
                release = self.build_candidate()
                self.cutover(release)
            except BaseException:
                if not (self.root / 'maintenance-status.json').exists() or read_json(self.root / 'maintenance-status.json')['state'] == 'building':
                    self.status('failed', recovery='not-needed')
                raise
