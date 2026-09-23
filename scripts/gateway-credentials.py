#!/usr/bin/env python3
"""Provision gateway credentials in the private Compose environment, never stdout."""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tempfile


KEYS = ('HARNESS_AUTH_USERNAME', 'HARNESS_AUTH_PASSWORD')


class CredentialError(ValueError):
    """A safe, credential-free diagnostic suitable for maintenance logs."""


def read_values(path):
    if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
        raise CredentialError('Deployment environment must be a regular, non-symlinked file')
    values = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line.startswith('export '):
            line = line[7:].lstrip()
        key, sep, value = line.partition('=')
        key = key.strip()
        if not sep or key not in KEYS:
            continue
        if key in values:
            raise CredentialError('Duplicate gateway credential setting; resolve it privately first')
        value = value.strip()
        if value.startswith('"'):
            try:
                decoded, end = json.JSONDecoder().raw_decode(value)
                if value[end:].strip() and not value[end:].lstrip().startswith('#'):
                    raise ValueError()
                if '$' in decoded.replace('$$', ''):
                    raise ValueError()
                value = decoded.replace('$$', '$')
            except ValueError:
                raise CredentialError('Invalid or interpolated gateway credential; configure it privately') from None
        elif value.startswith("'"):
            match = re.fullmatch(r"'((?:\\'|[^'])*)'\s*(?:#.*)?", value)
            if not match:
                raise CredentialError('Malformed quoted gateway credential')
            value = match[1].replace("\\'", "'")
        else:
            value = re.split(r'\s+#', value, maxsplit=1)[0].rstrip()
            if '$' in value or any(c in value for c in '\"\''):
                raise CredentialError('Ambiguous gateway credential; configure it privately')
        values[key] = value
    return values


def validate(username, password, partial=False):
    if partial and not username and not password:
        return
    if (username or not partial) and (not username or any(c in username for c in ':\r\n\0')):
        raise CredentialError('Username must be nonempty and contain no colon, newline or NUL')
    if (password or not partial) and (len(password) < 8 or any(c in password for c in '\r\n\0')):
        raise CredentialError('Use a password of at least 8 characters without newline or NUL')


def set_credentials(path, username, password, expected=None):
    validate(username, password)
    read_values(path)
    metadata = path.stat()
    original = path.read_bytes()
    if expected is not None and original != expected:
        raise CredentialError('Deployment environment changed during credential migration; retry maintenance')
    wanted = dict(zip(KEYS, (username, password)))
    lines = []
    for line in original.decode('utf-8').splitlines(keepends=True):
        key = line.strip().removeprefix('export ').partition('=')[0].strip()
        if key not in wanted:
            lines.append(line)
    preserved = ''.join(lines)
    if preserved and not preserved.endswith(('\n', '\r')):
        preserved += '\n'
    # Compose double quotes decode JSON escapes; doubled dollars prevent expansion.
    updated = preserved + ''.join(key + '=' + json.dumps(value, ensure_ascii=False).replace('$', '$$') + '\n'
                                  for key, value in wanted.items())
    fd, temporary = tempfile.mkstemp(prefix='.env.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            current = os.fstat(output.fileno())
            if (current.st_uid, current.st_gid) != (metadata.st_uid, metadata.st_gid):
                os.fchown(output.fileno(), metadata.st_uid, metadata.st_gid)
            os.fchmod(output.fileno(), 0o600)
            output.write(updated.encode('utf-8'))
            output.flush()
            os.fsync(output.fileno())
        if path.is_symlink() or path.read_bytes() != original or path.stat().st_ino != metadata.st_ino:
            raise CredentialError('Deployment environment changed during credential migration; retry maintenance')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def docker(*arguments):
    try:
        result = subprocess.run(['docker', *arguments], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        raise CredentialError('Cannot inspect gateway credentials: Docker is unavailable') from None
    if result.returncode:
        raise CredentialError('Cannot inspect gateway credentials: check Docker access')
    return result.stdout


def inspect_gateway():
    # Listing first distinguishes an absent container from an inaccessible daemon.
    ids = docker('container', 'ls', '--all', '--quiet', '--filter',
                 'name=^/deepseek-harness-gateway$').split()
    if not ids:
        return None
    if len(ids) != 1 or not re.fullmatch(r'[a-f0-9]{12,64}', ids[0]):
        raise CredentialError('Cannot uniquely identify the existing gateway container')
    try:
        records = json.loads(docker('inspect', ids[0]))
        if not isinstance(records, list) or len(records) != 1 or not isinstance(records[0], dict):
            raise ValueError()
        return records[0]
    except ValueError:
        raise CredentialError('Cannot read the existing gateway identity') from None


def recover(path, container):
    if container is None:
        raise CredentialError('No existing gateway credentials can be recovered; run change-password.py --username YOUR_USER privately')
    root = path.parent.resolve()
    config = container.get('Config') or {}
    if not isinstance(config, dict):
        raise CredentialError('Cannot read the existing gateway configuration')
    labels = config.get('Labels') or {}
    environment = config.get('Env') or []
    all_mounts = container.get('Mounts') or []
    if (not isinstance(labels, dict) or not isinstance(environment, list)
            or any(not isinstance(entry, str) for entry in environment)
            or not isinstance(all_mounts, list) or any(not isinstance(m, dict) for m in all_mounts)):
        raise CredentialError('Cannot read the existing gateway configuration')
    working_dir = labels.get('com.docker.compose.project.working_dir', '')
    mounts = [m for m in all_mounts if m.get('Destination') == '/data/gateway']
    if (labels.get('com.docker.compose.project') != 'deepseek-harness'
            or labels.get('com.docker.compose.service') != 'gateway'
            or not Path(working_dir).is_absolute() or Path(working_dir).resolve() != root
            or len(mounts) != 1 or mounts[0].get('Type') != 'bind'
            or not Path(mounts[0].get('Source', '')).is_absolute()
            or Path(mounts[0]['Source']).resolve() != (root / 'data/gateway').resolve()):
        raise CredentialError('Existing gateway does not belong to this deployment; credentials were not changed')
    values = {}
    for entry in environment:
        key, _, value = entry.partition('=')
        if key in KEYS:
            if key in values:
                raise CredentialError('Existing gateway has duplicate credentials')
            values[key] = value
    username, password = (values.get(key, '') for key in KEYS)
    validate(username, password)
    auth_path = root / 'data/gateway/auth.json'
    try:
        if auth_path.is_symlink() or not auth_path.is_file():
            raise ValueError()
        auth = json.loads(auth_path.read_text(encoding='utf-8'))
        if (auth['username'] != username or type(auth['iterations']) is not int
                or not 1 <= auth['iterations'] <= 1_000_000
                or not re.fullmatch(r'[a-f0-9]{32}', auth['salt'])
                or not re.fullmatch(r'[a-f0-9]{64}', auth['hash'])):
            raise ValueError()
        digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'),
                                     auth['salt'].encode('utf-8'), auth['iterations'], dklen=32).hex()
        if not hmac.compare_digest(digest, auth['hash']):
            raise ValueError()
    except (OSError, ValueError, KeyError, TypeError):
        raise CredentialError('Existing gateway credentials do not match a valid persisted login; provision credentials privately') from None
    return username, password


def ensure(path, dry_run=False, first_setup_username=None):
    if path.is_symlink() or not path.is_file():
        raise CredentialError('Deployment environment must be a regular, non-symlinked file')
    original = path.read_bytes()
    existing = read_values(path)
    user, password = (existing.get(key, '') for key in KEYS)
    validate(user, password, partial=True)
    if user and password:
        return 'Keeping existing private gateway credentials.'
    container = inspect_gateway()
    # Initialization is permitted only with no deployed gateway or persisted
    # login. A legacy environment must never trigger a silent password reset.
    auth_path = path.parent / 'data/gateway/auth.json'
    if (first_setup_username is not None and container is None and not os.path.lexists(auth_path)
            and not os.path.lexists(path.parent / 'data/dsh/settings.yaml')):
        if password:
            raise CredentialError('Gateway password has no username; configure both explicitly')
        if dry_run:
            return 'Private gateway credentials would be initialized for first setup.'
        set_credentials(path, user or first_setup_username, secrets.token_urlsafe(24), expected=original)
        return 'Private gateway credentials initialized; inspect .env privately.'
    recovered_user, recovered_password = recover(path, container)
    if (user and user != recovered_user) or (password and password != recovered_password):
        raise CredentialError('Partial private credentials conflict with the existing gateway; credentials were not changed')
    if dry_run:
        return 'Existing gateway login verified; private credentials would be migrated.'
    set_credentials(path, recovered_user, recovered_password, expected=original)
    return 'Migrated existing gateway credentials into private .env; login preserved.'


def initialize(path, username):
    # Retain the first-setup API used by configure.sh and existing callers.
    return not ensure(path, first_setup_username=username).startswith('Keeping existing')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--initialize', type=Path, help='First setup, or preserve/migrate an existing deployment')
    modes.add_argument('--ensure', type=Path, help='Validate or migrate an existing deployment without rotating its login')
    modes.add_argument('--check', type=Path, help='Read-only check, including recovery feasibility')
    parser.add_argument('--username', help='Username for first setup only')
    args = parser.parse_args()
    if args.initialize and not args.username:
        parser.error('--initialize requires --username')
    try:
        print(ensure(args.initialize or args.ensure or args.check, dry_run=bool(args.check),
                     first_setup_username=args.username if args.initialize else None))
    except CredentialError as error:
        print(f'Gateway credential preflight failed: {error}', file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, KeyError):
        print('Gateway credential preflight failed: cannot safely read or write private credential state; services were not changed.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
