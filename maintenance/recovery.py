"""Verified stopped-writer snapshots with resumable, whole-root restoration."""
import os
from pathlib import Path
import shutil
import stat

from .common import Failure, atomic_json, digest, read_json, sync_path, sync_directory
from .contract import require


def inventory(root):
    root = Path(root)
    if not root.exists() and not root.is_symlink():
        return None
    result = {}
    def visit(path):
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode),
                'Snapshot contains an unsupported special file')
        row = [info.st_mode, info.st_uid, info.st_gid]
        if path.is_symlink():
            row.append(os.readlink(path))
        elif path.is_file():
            row.append(digest(path))
        result[str(path.relative_to(root))] = row
        if path.is_dir() and not path.is_symlink():
            for child in sorted(path.iterdir()):
                visit(child)
    visit(root)
    return result


def copy_path(source, destination):
    source, destination = Path(source), Path(destination)
    require(not source.is_symlink(), 'Snapshot roots must not be symlinks')
    def copy_file(src, dst):
        shutil.copy2(src, dst, follow_symlinks=False)
        preserve_owner(Path(src), Path(dst))
        return dst
    if source.is_dir():
        shutil.copytree(source, destination, symlinks=True, copy_function=copy_file)
        for parent, dirs, files in os.walk(source, followlinks=False):
            for path in [Path(parent), *(Path(parent) / name for name in dirs + files)]:
                preserve_owner(path, destination / path.relative_to(source))
    else:
        copy_file(source, destination)
    require(inventory(source) == inventory(destination), 'Snapshot copy failed integrity or ownership verification')
    sync_path(destination)
    sync_directory(destination.parent)


def preserve_owner(source, target):
    info = source.lstat()
    try:
        # Assign ownership explicitly even when copying as the same UID. Shared
        # filesystems can briefly report stale ownership for a new directory;
        # relying on that first stat can reject an otherwise faithful snapshot.
        os.chown(target, info.st_uid, info.st_gid, follow_symlinks=False)
    except PermissionError:
        # Some filesystems forbid even an unchanged chown. Accept only already
        # correct ownership; never silently drop another service's identity.
        pass
    actual = target.lstat()
    require((actual.st_uid, actual.st_gid) == (info.st_uid, info.st_gid),
            'Cannot preserve snapshot ownership as the deployment user')


def bytes_used(path):
    path = Path(path)
    if not path.exists():
        return 0
    if path.is_file():
        return path.stat().st_size
    return sum(item.lstat().st_size for item in path.rglob('*') if item.is_file() and not item.is_symlink())


def check_space(point, paths):
    # Reserve both the snapshot and restoration staging. Check destination
    # filesystems independently: external credential mounts need not share one.
    needed = sum(bytes_used(path) for path in paths)
    require(shutil.disk_usage(point).free >= needed * 2 + 64 * 1024 * 1024,
            'Insufficient free space for snapshot and recovery')
    for path in paths:
        parent = Path(path).parent
        require(shutil.disk_usage(parent).free >= bytes_used(path) + 64 * 1024 * 1024,
                'Insufficient restoration space on a persistent-state filesystem')


def capture(point, paths):
    point = Path(point)
    payload = point / 'snapshot'
    payload.mkdir(mode=0o700)
    records = []
    for index, path in enumerate(paths):
        path = Path(path)
        require(not path.is_symlink(), 'Snapshot roots must not be symlinks')
        before = inventory(path)
        if before is not None:
            copy_path(path, payload / str(index))
            require(before == inventory(path) == inventory(payload / str(index)),
                    'Persistent state changed while taking the stopped-writer snapshot')
        records.append({'path': str(path), 'inventory': before})
    for record in records:
        require(inventory(record['path']) == record['inventory'], 'Persistent state changed during the snapshot transaction')
    atomic_json(point / 'snapshot.json', records)
    return records


def restore(point):
    point = Path(point)
    records = read_json(point / 'snapshot.json')
    # Validate every snapshot before touching any destination.
    for index, record in enumerate(records):
        require(inventory(point / 'snapshot' / str(index)) == record['inventory'],
                'Recovery snapshot failed integrity verification')
    state_file = point / 'restore.json'
    state = read_json(state_file) if state_file.exists() else {'done': [], 'prepared': []}
    for index, record in enumerate(records):
        if index in state['done']:
            continue
        target = Path(record['path'])
        original = point / 'snapshot' / str(index)
        if inventory(target) == record['inventory']:
            # Configuration inputs that the transaction never changed must
            # retain their original inode and timestamps (including checkouts).
            state['done'].append(index)
            atomic_json(state_file, state)
            continue
        # Stage and retain on the destination filesystem, enabling atomic
        # renames even when credentials and application data live separately.
        suffix = point.name + '-' + str(index)
        stage = target.with_name('.' + target.name + '.restore-' + suffix)
        failed = target.with_name('.' + target.name + '.failed-' + suffix)
        if index not in state['prepared']:
            require(not stage.exists() and not failed.exists(), 'Unexpected recovery staging already exists')
            state['prepared'].append(index)
            atomic_json(state_file, state)
        if record['inventory'] is not None and not stage.exists() and not failed.exists():
            copy_path(original, stage)
        if stage.exists():
            require(inventory(stage) == record['inventory'], 'Interrupted recovery staging failed integrity verification')
        if target.is_file() and not target.is_symlink() and original.is_file():
            # Keep manifest, Compose, and dispatcher paths continuously present
            # so a killed recovery can still be launched from the Portal.
            if not failed.exists():
                os.link(target, failed)
            if inventory(target) != record['inventory']:
                require(stage.exists() and inventory(target) == inventory(failed),
                        'Interrupted file restore found changed destination state')
                stage.replace(target)
            sync_directory(target.parent)
            state['done'].append(index)
            atomic_json(state_file, state)
            continue
        if failed.exists() and target.exists():
            require(inventory(target) == record['inventory'], 'Interrupted restore found changed destination state')
        else:
            if target.exists():
                target.rename(failed)
            if stage.exists():
                stage.rename(target)
        require(inventory(target) == record['inventory'], 'Restored state failed integrity verification')
        sync_directory(target.parent)
        state['done'].append(index)
        atomic_json(state_file, state)
