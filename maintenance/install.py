"""Generic adoption of rendered Compose; all destination facts remain local."""
import copy
import json
import os
from pathlib import Path
import re
import shutil

from .common import LABEL, REPOSITORY, SCHEMA, atomic_json, read_json, run
from .contract import SCRIPT, require, validate_config, validate_manifest, portal_services
from .engine import Updater, install_labels, validate_engine, validate_containers

STATE_TARGETS = {'/data/dsh', '/data/gateway', '/run/dsh-backend-auth', '/app/data', '/app/runtime'}
SYSTEM_TARGETS = {'/var/run/docker.sock', '/etc/passwd', '/etc/group'}


def compact_paths(paths):
    paths = sorted(set(str(Path(p).resolve()) for p in paths))
    return [p for p in paths if not any(p != q and Path(p).is_relative_to(q) for q in paths)]


def parse_roles(values, model):
    if values:
        roles = {}
        for value in values:
            service, separator, role = value.partition('=')
            require(separator and service in model['services'] and service not in roles,
                    'Roles must uniquely map an existing service to harness, gateway or router')
            roles[service] = role
    else:
        roles = {s: r for s, r in [('harness', 'harness'), ('gateway', 'gateway'),
                  ('ai-router', 'router'), ('router-init', 'router')] if s in model['services']}
    require(list(roles.values()).count('harness') == 1 and list(roles.values()).count('gateway') == 1
            and set(roles.values()) <= {'harness', 'gateway', 'router'}, 'Specify unambiguous --role SERVICE=ROLE mappings')
    return roles


def prepare(args, source):
    original_root = Path(args.project_directory or source).resolve()
    root = Path(args.deployment_dir or original_root / 'data/deployment').resolve()
    require(not (root / '.git').exists() and root != source.resolve(), 'Operational artifacts must be outside the source checkout root')
    if (root / 'adoption.json').is_file():
        previous = read_json(root / 'adoption.json')
        require(Path(previous['root']).resolve() == original_root, 'Pending adoption belongs to a different project directory')
        updater = Updater(root)
        validate_engine(updater.manifest)
        portal_services(updater.manifest['portal_url'])
        if args.dry_run:
            print('Dry-run: pending adoption can be resumed; no files or services changed.')
            return
        import fcntl
        with (root / '.maintenance.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if (root / 'transaction.json').exists():
                updater.recover()
            release = updater.build_candidate()
            updater.cutover(release, previous_root=original_root, previous_model=previous['model'])
            (root / 'adoption.json').unlink()
        return
    require(not (root / 'deployment.json').exists(), 'This directory is already registered; use its updater')
    require(not (original_root / 'data/update-and-restart.lock').exists(), 'Legacy maintenance lock exists; inspect it before adopting')
    files = [Path(f).resolve() for f in args.compose_file] if args.compose_file else [source / 'compose.yaml', source / f'compose.{args.mode}-ollama.yaml']
    env_file = Path(args.env_file).resolve() if args.env_file else original_root / '.env'
    if env_file.exists():
        recorded = [line.split('=', 1)[1] for line in env_file.read_text().splitlines() if line.startswith('DSH_DEPLOYMENT_MODE=')]
        require(len(recorded) <= 1, 'Duplicated deployment mode in environment')
        if recorded and recorded[0]:
            require(recorded[0] in ('remote', 'external', 'managed'), 'Invalid recorded deployment mode')
            require(args.mode is None or args.mode == recorded[0], 'Requested mode conflicts with local configuration')
            args.mode = recorded[0]
        if not args.portal_url:
            urls = [line.split('=', 1)[1] for line in env_file.read_text().splitlines() if line.startswith('SERVICE_PORTAL_URL=')]
            require(len(urls) <= 1, 'Duplicated Portal URL in environment')
            args.portal_url = urls[0] if urls else ''
    args.mode = args.mode or 'remote'
    if not args.compose_file:
        files = [source / 'compose.yaml', source / f'compose.{args.mode}-ollama.yaml']
    command = ['docker', 'compose', '--project-directory', original_root]
    if env_file.exists():
        command += ['--env-file', env_file]
    for file in files:
        require(file.is_file(), 'A deployment Compose input is missing')
        command += ['-f', file]
    model = json.loads(run([*command, 'config', '--format', 'json']))
    previous = copy.deepcopy(model)
    roles = parse_roles(args.role, model)
    harness = next(s for s, role in roles.items() if role == 'harness')
    user = model['services'][harness].get('user', '')
    require(bool(re.fullmatch(r'\d+:\d+', user)), 'Harness must declare its numeric UID:GID')
    require(int(user.split(':')[0]) == os.getuid(), 'Run adoption as the configured deployment UID to preserve state ownership')
    portal_services(args.portal_url)
    state = list(args.state_path)
    configuration_inputs = [str(f) for f in files] + ([str(env_file)] if env_file.exists() else [])
    # Compose/environment inputs are imported into the operational bundle.
    # Future updates must not depend on the old checkout continuing to exist.
    inputs = [str(root / 'config-inputs')]
    external = {str(Path(p).resolve()) for p in args.external_path}
    source_artifacts = []
    for service, config in model['services'].items():
        for mount in config.get('volumes', []):
            require(mount['type'] == 'bind', 'Adoption requires explicit bind mounts for application state; named volumes must be migrated first')
            path = Path(mount['source']).resolve()
            target = mount['target']
            require(path.exists(), 'A deployment bind source is missing')
            if target in STATE_TARGETS:
                state.append(str(path))
            elif target in SYSTEM_TARGETS or str(path) in external or target == config.get('working_dir') or target == '/host':
                continue
            elif path.is_file() and path.is_relative_to(source.resolve()) and not path.is_relative_to(source / 'data'):
                relative = str(path.relative_to(source))
                installed = str(root / 'artifacts' / relative)
                source_artifacts.append({'relative': relative, 'installed': installed, 'original': str(path)})
                mount['source'] = installed
            elif mount.get('read_only'):
                inputs.append(str(path))
            else:
                require(str(path) in state, 'Classify an additional writable bind using --state-path or --external-path')
        for secret in config.get('secrets', []):
            name = secret['source'] if isinstance(secret, dict) else secret
            file = model.get('secrets', {}).get(name, {}).get('file')
            require(file and Path(file).is_file(), 'Application secrets must use existing deployment-local files')
            inputs.append(str(Path(file).resolve()))
        for env in config.get('env_file', []):
            file = env['path'] if isinstance(env, dict) else env
            inputs.append(str(Path(file).resolve()))
        config.pop('build', None)
    require(any(m.get('target') == '/data/dsh' for m in model['services'][harness].get('volumes', [])), 'Harness durable state must have an explicit /data/dsh bind')
    # Rendering preserves literal dollars in the form Compose expects on reread.
    manifest = {'schema': SCHEMA, 'repository': REPOSITORY, 'branch': 'main',
                'root': str(root), 'project': model['name'], 'mode': args.mode,
                'roles': roles, 'user': user, 'portal_url': args.portal_url,
                'engine_id': run(['docker', 'info', '--format', '{{.ID}}']).strip(),
                'revision': run(['git', '-C', source, 'rev-parse', 'HEAD']).strip(),
                'images': {s: c['image'] for s, c in model['services'].items()},
                'state_paths': compact_paths(state), 'input_paths': compact_paths(inputs),
                'artifact_paths': [], 'source_artifacts': source_artifacts,
                'previous_root': str(original_root)}
    # Adopt only the existing application-owned unit. Do not install a host-
    # specific scheduler or modify arbitrary units/drop-ins.
    boot_unit = Path(args.boot_unit).resolve() if args.boot_unit else None
    if boot_unit is None:
        home = previous['services'][harness].get('labels', {}).get(LABEL + 'host-home')
        if home:
            candidate = Path(home) / '.config/systemd/user/deepseek-harness-after-network.service'
            if candidate.is_file():
                boot_unit = candidate
    if boot_unit:
        text = boot_unit.read_text()
        require(f'ExecStart={original_root}/start-after-network.sh' in text.splitlines(),
                'Existing boot unit is not the recognized application entrypoint')
        require(not any(c in str(root) for c in (' ', '%', '\\', '\n')), 'Boot integration requires a systemd-safe operational path')
        manifest['boot_unit'] = str(boot_unit)
        manifest['artifact_paths'].append(str(boot_unit))
    if not args.adopt:
        validate_config(previous, original_root, script_root=source)
    install_labels(model, manifest, model['services'][harness]['image'])
    validate_manifest(manifest, root)
    # Source/configuration inputs are captured but never rewritten by adoption.
    # Refuse a state root that includes another service or operational bundle.
    require(all(not root.is_relative_to(Path(p)) for p in manifest['state_paths']), 'Operational directory overlaps application state')
    validate_config(model, root, script_root=source)
    # Verify the original deployment identity before writing an operational file.
    ids = run([*command, 'ps', '-a', '-q']).split()
    if ids:
        rows = json.loads(run(['docker', 'inspect', *ids]))
        for row in rows:
            labels = row['Config'].get('Labels', {})
            require(labels.get('com.docker.compose.project') == model['name']
                    and Path(labels.get('com.docker.compose.project.working_dir', '')).resolve() == original_root,
                    'Running project identity does not match the adoption inputs')
    for name in ('maintenance', 'compose.json', SCRIPT):
        require(not (root / name).exists(), 'Operational destination already contains unmanaged maintenance artifacts')
    if args.dry_run:
        print('Dry-run: adoption inputs, project identity, mount classifications and Portal reachability validated. No files or services changed.')
        return
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(root, 0o700)
    (root / 'scripts').mkdir(mode=0o700, exist_ok=True)
    shutil.copy2(source / SCRIPT, root / SCRIPT)
    shutil.copytree(source / 'maintenance', root / 'maintenance', ignore=shutil.ignore_patterns('__pycache__'))
    (root / 'config-inputs').mkdir(mode=0o700)
    for index, filename in enumerate(configuration_inputs):
        destination = root / 'config-inputs' / (str(index) + '-' + Path(filename).name)
        shutil.copyfile(filename, destination)
        destination.chmod(0o600)
    for artifact in source_artifacts:
        destination = Path(artifact['installed'])
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copy2(artifact['original'], destination)
    atomic_json(root / 'deployment.json', manifest)
    atomic_json(root / 'compose.json', model)
    atomic_json(root / 'adoption.json', {'root': str(original_root), 'model': previous})
    updater = Updater(root)
    # Installations use the same lock as normal updates and recovery.
    import fcntl
    with (root / '.maintenance.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        release = updater.build_candidate()
        updater.cutover(release, previous_root=original_root, previous_model=previous)
        (root / 'adoption.json').unlink()
    print('Installed checkout-free maintenance. Operational directory: ' + str(root))
