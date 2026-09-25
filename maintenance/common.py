"""Private operational files and commands. Never include command output in errors."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

REPOSITORY = 'https://github.com/astigmatism/dsh-container.git'
SCHEMA = 1
LABEL = 'io.service-portal.update.'


class Failure(RuntimeError):
    pass


def run(args, *, cwd=None, data=None, env=None):
    result = subprocess.run([str(x) for x in args], cwd=cwd, input=data,
                            capture_output=True, text=True, env=env)
    if result.returncode:
        raise Failure(f'{Path(str(args[0])).name} failed (exit {result.returncode}); private output withheld')
    return result.stdout


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def read_json(path):
    with Path(path).open() as stream:
        return json.load(stream)


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.partial')
    # Do not follow an old or malicious temporary-file symlink.
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_text(path, text):
    path = Path(path)
    temporary = path.with_name(path.name + '.partial')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    sync_directory(path.parent)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def sync_path(path):
    """Flush only this transaction's files, never unrelated host filesystems."""
    path = Path(path)
    if path.is_symlink():
        return
    if path.is_dir():
        for child in path.iterdir():
            sync_path(child)
        sync_directory(path)
    elif path.is_file():
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def compose_command(root, model=None):
    root = Path(root)
    return ['docker', 'compose', '--project-directory', str(root),
            '-f', str(model or root / 'compose.json')]


def inspect(kind, identity):
    return json.loads(run(['docker', kind, 'inspect', identity]))[0]
