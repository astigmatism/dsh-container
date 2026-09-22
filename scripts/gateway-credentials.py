#!/usr/bin/env python3
"""Provision gateway credentials in the private Compose environment, never stdout."""
import argparse
import json
import os
from pathlib import Path
import secrets
import tempfile


def read_values(path):
    values = {}
    for line in path.read_text().splitlines():
        key, sep, value = line.partition('=')
        if not sep or key not in ('HARNESS_AUTH_USERNAME', 'HARNESS_AUTH_PASSWORD'):
            continue
        if key in values:
            raise ValueError('Duplicate gateway credential setting; resolve it privately first')
        if value.startswith('"'):
            value = json.loads(value).replace('$$', '$')
        elif value.startswith("'") and value.endswith("'"):
            value = value[1:-1].replace("\\'", "'")
        values[key] = value
    return values


def set_credentials(path, username, password):
    if not username or any(c in username for c in ':\r\n\0'):
        raise ValueError('Username must be nonempty and contain no colon, newline or NUL')
    if len(password) < 8 or any(c in password for c in '\r\n\0'):
        raise ValueError('Use a password of at least 8 characters without newline or NUL')
    if path.is_symlink():
        raise ValueError('Refusing to replace a symlinked deployment environment')
    read_values(path)
    wanted = {'HARNESS_AUTH_USERNAME': username, 'HARNESS_AUTH_PASSWORD': password}
    lines = [line for line in path.read_text().splitlines() if line.partition('=')[0] not in wanted]
    # Compose double quotes decode JSON escapes; doubled dollars prevent expansion.
    lines.extend(key + '=' + json.dumps(value, ensure_ascii=False).replace('$', '$$')
                 for key, value in wanted.items())
    fd, temporary = tempfile.mkstemp(prefix='.env.', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write('\n'.join(lines) + '\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def initialize(path, username):
    existing = read_values(path)
    user = existing.get('HARNESS_AUTH_USERNAME', '')
    password = existing.get('HARNESS_AUTH_PASSWORD', '')
    if user and password:
        if len(password) < 8 or any(c in user for c in ':\r\n\0') or any(c in password for c in '\r\n\0'):
            raise ValueError('Invalid configured gateway credentials; update them privately')
        return False
    if password and not user:
        raise ValueError('Gateway password has no username; configure both explicitly')
    set_credentials(path, user or username, secrets.token_urlsafe(24))
    return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--initialize', type=Path, required=True)
    parser.add_argument('--username', required=True)
    args = parser.parse_args()
    changed = initialize(args.initialize, args.username)
    print('Private gateway credentials initialized; inspect .env privately.' if changed
          else 'Keeping existing private gateway credentials.')
