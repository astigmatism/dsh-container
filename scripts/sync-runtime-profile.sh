#!/bin/sh
set -eu

seed_home=${DSH_SEED_HOME:-/opt/dsh-seed}
runtime_home=${DSH_HOME:-/data/dsh}

case "$runtime_home" in
  ""|/|"$seed_home"|"$seed_home"/*)
    echo "Refusing unsafe DSH runtime path: $runtime_home" >&2
    exit 1
    ;;
esac

[ -d "$seed_home/profiles/web" ] || {
  echo "Canonical web profile is missing: $seed_home/profiles/web" >&2
  exit 1
}
[ -d "$seed_home/.dsh-plugins" ] || {
  echo "Canonical local plugins are missing: $seed_home/.dsh-plugins" >&2
  exit 1
}

# Keep the canonical-content policy without rewriting thousands of unchanged
# dependencies across Docker Desktop's host-file sharing on every restart.
# Compare actual bytes (not just timestamps), replace changed files atomically,
# and remove obsolete software only inside the two managed directories. The
# entrypoint starts Harness only after the entire synchronization succeeds.
python3 - "$seed_home" "$runtime_home" <<'PY'
import filecmp
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile

seed = Path(sys.argv[1]).resolve()
runtime = Path(sys.argv[2]).resolve()
if runtime == Path('/') or runtime == seed or seed in runtime.parents or runtime in seed.parents:
    raise SystemExit('Refusing an unsafe resolved DSH runtime path')
if not (seed / 'plugin-inventory.txt').is_file():
    raise SystemExit('Canonical plugin inventory is missing')
runtime.mkdir(parents=True, exist_ok=True)
profiles = runtime / 'profiles'
if profiles.is_symlink():
    raise SystemExit('Refusing to synchronize through a symlinked profiles directory')
profiles.mkdir(exist_ok=True)
updated = removed = 0


def remove(path):
    global removed
    if path.is_symlink() or not path.is_dir():
        path.unlink(missing_ok=True)
    else:
        shutil.rmtree(path)
    removed += 1


def mode(path, wanted):
    if stat.S_IMODE(path.stat().st_mode) != wanted:
        path.chmod(wanted)


def sync(source, target):
    global updated
    source_stat = source.lstat()
    source_mode = stat.S_IMODE(source_stat.st_mode)
    try:
        target_stat = target.lstat()
    except FileNotFoundError:
        target_stat = None
    if stat.S_ISLNK(source_stat.st_mode):
        link = os.readlink(source)
        if target_stat and stat.S_ISLNK(target_stat.st_mode) and os.readlink(target) == link:
            return
        if target_stat:
            remove(target)
        target.symlink_to(link)
        updated += 1
    elif stat.S_ISDIR(source_stat.st_mode):
        if target_stat and not stat.S_ISDIR(target_stat.st_mode):
            remove(target)
        target.mkdir(exist_ok=True)
        # Restore writable/searchable managed directories before repairing
        # their contents, even if a previous runtime changed their permissions.
        mode(target, source_mode | stat.S_IWUSR | stat.S_IXUSR)
        names = set()
        for child in source.iterdir():
            names.add(child.name)
            sync(child, target / child.name)
        for child in target.iterdir():
            if child.name not in names:
                remove(child)
        mode(target, source_mode)
    elif stat.S_ISREG(source_stat.st_mode):
        if target_stat and stat.S_ISREG(target_stat.st_mode):
            try:
                if filecmp.cmp(source, target, shallow=False):
                    if stat.S_IMODE(target_stat.st_mode) == source_mode:
                        return
                    # Do not change permissions on an external hard link.
                    if target_stat.st_nlink == 1:
                        mode(target, source_mode)
                        return
            except PermissionError:
                # An unreadable or differently owned managed file can still
                # be repaired by atomically replacing its directory entry.
                pass
        if target_stat and not stat.S_ISREG(target_stat.st_mode):
            remove(target)
        descriptor, temporary = tempfile.mkstemp(prefix='.dsh-sync-', dir=target.parent)
        os.close(descriptor)
        try:
            shutil.copyfile(source, temporary)
            os.chmod(temporary, source_mode)
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
        updated += 1
    else:
        raise RuntimeError(f'Unsupported canonical profile entry: {source}')


sync(seed / 'profiles/web', profiles / 'web')
sync(seed / '.dsh-plugins', runtime / '.dsh-plugins')
sync(seed / 'plugin-inventory.txt', runtime / 'plugin-inventory.txt')
print(f'Synchronized canonical runtime profile: {updated} files updated, {removed} obsolete entries removed.')
PY
