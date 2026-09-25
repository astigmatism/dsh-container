#!/usr/bin/env python3
"""Qualify an image with copied preferences, never production application state.

The source container supplies settings, environment and provider connectivity.
No production mount, host socket, port mapping, session or workspace is copied.
This also runs inside a Service Portal runner: all copying uses the Docker API,
not paths interpreted in the runner's filesystem namespace.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import uuid


class QualificationError(RuntimeError):
    pass


def docker(*args, data=None, timeout=900):
    result = subprocess.run(['docker', *map(str, args)], input=data, capture_output=True, timeout=timeout)
    if result.returncode:
        # Docker errors may echo environment/credential values. Retain the stage,
        # never the complete command or daemon response in a public job log.
        raise QualificationError(f'Docker {args[0]} failed during isolated qualification (exit {result.returncode})')
    return result.stdout


def inspect_container(container):
    rows = json.loads(docker('inspect', container))
    if len(rows) != 1:
        raise QualificationError('Expected one source container')
    return rows[0]


def candidate_command(source, image, name):
    user = source['Config']['User']
    if not re.fullmatch(r'\d+:\d+', user):
        raise QualificationError('Qualification requires the deployment numeric UID:GID')
    uid, gid = user.split(':')
    networks = [n for n in source['NetworkSettings']['Networks'] if n not in ('host', 'none')]
    if not networks:
        raise QualificationError('No isolated provider network is available')
    env = dict(item.split('=', 1) for item in source['Config'].get('Env', []) if '=' in item)
    env.update(DSH_HOME='/data/dsh', HOME='/tmp/verification-home', DSH_VERIFY_ISOLATED='1',
               DSH_WEB_LAUNCH_TOKEN_FILE='/run/dsh-backend-auth/launch-token',
               DSH_VERIFY_DIAGNOSTICS='/tmp/verification-diagnostics',
               DSH_TELEMETRY_DISABLED='1', HARNESS_TRUSTED_HOSTS='127.0.0.1:3080')
    # These inputs belong to production process state, never to its clone.
    for key in ('DSH_WEB_LAUNCH_TOKEN', 'DSH_BOOT_TOKEN', 'DSH_VERIFY_URL', 'DSH_PROFILE_ROOT'):
        env.pop(key, None)
    args = ['create', '--init', '--name', name, '--label', 'io.service-portal.maintenance=true',
            '--label', 'io.dsh.verification=isolated', '--user', user,
            '--network', networks[0], '--workdir', '/tmp', '--entrypoint', '/bin/sh',
            '--tmpfs', f'/data/dsh:uid={uid},gid={gid},mode=0700',
            '--tmpfs', f'/run/dsh-backend-auth:uid={uid},gid={gid},mode=0700']
    for item in source['HostConfig'].get('ExtraHosts') or []:
        args += ['--add-host', item]
    for key, value in env.items():
        args += ['--env', f'{key}={value}']
    args += [image, '-eu', '-c', 'mkdir -p "$HOME" /tmp/verification-diagnostics; '
             'while [ ! -f /tmp/verification-ready ]; do sleep 0.1; done; exec /usr/local/bin/dsh-entrypoint']
    return args, networks[1:]


# Explicit input allowlist: do not copy whole DSH_HOME or its storages tree.
EXPORT_SETTINGS = r'''
import io, os, pathlib, sys, tarfile
root = pathlib.Path('/data/dsh')
if (root / '.container-settings-pending.json').exists():
    raise RuntimeError('Settings migration is pending')
names = ['profiles/web/cordis.patch.yml']
if (root / '.credentials.yaml').exists():
    names.append('.credentials.yaml')
names += ['.container-settings-v1.json'] if (root / '.container-settings-v1.json').exists() else ['settings.yaml']
with tarfile.open(fileobj=sys.stdout.buffer, mode='w|') as archive:
    for name in names:
        path = root / name
        if not path.exists() and name == 'profiles/web/cordis.patch.yml':
            continue
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            raise RuntimeError('Unsafe or missing settings input')
        data = path.read_bytes()
        info = tarfile.TarInfo(name)
        info.size, info.mode = len(data), 0o600
        info.uid, info.gid = os.getuid(), os.getgid()
        archive.addfile(info, io.BytesIO(data))
'''

EXPORT_CREDENTIAL_VALUES = r'''
const fs = require('fs');
const file = '/data/dsh/.credentials.yaml';
if (!fs.existsSync(file)) { console.log('[]'); process.exit(0); }
const YAML = require('module').createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')('yaml');
const values = [];
function collect(value) {
  if (typeof value === 'string' && value.length >= 8) values.push(value);
  else if (value && typeof value === 'object') Object.values(value).forEach(collect);
}
collect(YAML.parse(fs.readFileSync(file, 'utf8')));
console.log(JSON.stringify(values));
'''


def redact(text, source):
    for value in sorted(source.get('_credential_values', []), key=len, reverse=True):
        text = text.replace(value, '<redacted>')
    for item in source['Config'].get('Env', []):
        key, _, value = item.partition('=')
        if value and re.search(r'password|secret|token|api.?key', key, re.I):
            text = text.replace(value, '<redacted>')
    return re.sub(r'([?&]token=)[^\s"<>]+', r'\1<redacted>', text)


def qualify(container, image=None, diagnostics=None):
    source = inspect_container(container)
    if not source['State']['Running']:
        raise QualificationError('The settings source container must be running')
    image = image or source['Image']
    # Resolve tags once; no tag race between qualification and identification.
    image = json.loads(docker('image', 'inspect', image))[0]['Id']
    name = 'dsh-verification-' + uuid.uuid4().hex[:12]
    command, extra_networks = candidate_command(source, image, name)
    created = False
    stage = 'create disposable runtime'
    try:
        docker(*command)
        created = True
        for network in extra_networks:
            docker('network', 'connect', network, name)
        docker('start', name)
        stage = 'copy deployment preferences'
        settings = docker('exec', '-i', container, 'python3', '-c', EXPORT_SETTINGS)
        source['_credential_values'] = json.loads(docker('exec', container, 'node', '-e', EXPORT_CREDENTIAL_VALUES))
        docker('exec', '-i', name, 'tar', '-x', '--no-same-owner', '-C', '/data/dsh', '-f', '-', data=settings)
        docker('exec', name, 'touch', '/tmp/verification-ready')
        stage = 'boot disposable runtime'
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            row = inspect_container(name)
            if not row['State']['Running']:
                raise QualificationError('Disposable Harness exited before readiness')
            if row['State'].get('Health', {}).get('Status') == 'healthy':
                break
            # The image healthcheck is not necessarily defined (Compose owns it).
            result = subprocess.run(['docker', 'exec', name, '/bin/sh', '-c',
                'test -s /run/dsh-backend-auth/launch-token && curl -fsS -o /dev/null '
                '"http://127.0.0.1:3080/?token=$(cat /run/dsh-backend-auth/launch-token)"'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            if result.returncode == 0:
                break
            time.sleep(1)
        else:
            raise QualificationError('Disposable Harness readiness timed out')
        for script in ('verify-sidebar-terminal.mjs', 'verify-sidebar-client.mjs',
                       'verify-dictation-client.mjs', 'verify-resident-client.mjs'):
            stage = script
            args = ['exec', name, 'node', '/opt/dsh-build/' + script]
            if script == 'verify-resident-client.mjs':
                args.append('--live')
            result = subprocess.run(['docker', *args], capture_output=True, timeout=2100)
            output = redact((result.stdout + result.stderr).decode(errors='replace'), source)
            print(output, end='', flush=True)
            if result.returncode:
                raise QualificationError(f'{script} failed in disposable runtime (exit {result.returncode})')
        print(f'Isolated acceptance passed for {image}; production sessions and preferences were not used.')
        return image
    except BaseException:
        if created and diagnostics:
            directory = Path(diagnostics)
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                output = subprocess.run(['docker', 'logs', '--tail', '200', name], capture_output=True, timeout=30)
                logs = (output.stdout + output.stderr).decode(errors='replace')
                (directory / 'runtime.log').write_text(redact(logs, source))
                (directory / 'failure.json').write_text(json.dumps({'stage': stage, 'image': image}))
                docker('cp', f'{name}:/tmp/verification-diagnostics/.', directory)
                for path in directory.iterdir():
                    if path.is_file():
                        path.chmod(0o600)
            except (QualificationError, OSError):
                print('Some isolated diagnostics could not be collected.', file=sys.stderr)
        raise
    finally:
        if created:
            docker('rm', '--force', name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', required=True)
    parser.add_argument('--image')
    parser.add_argument('--diagnostics', type=Path)
    args = parser.parse_args()
    def interrupted(signum, frame):
        raise QualificationError('Isolated qualification interrupted')
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, interrupted)
    os.umask(0o077)
    try:
        qualify(args.container, args.image, args.diagnostics)
    except (QualificationError, subprocess.TimeoutExpired) as error:
        print(str(error) if isinstance(error, QualificationError) else 'Isolated verification process timed out', file=sys.stderr)
        return 23
    return 0


if __name__ == '__main__':
    sys.exit(main())
