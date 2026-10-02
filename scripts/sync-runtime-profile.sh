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

# Capture/migrate the writable patch before synchronizing managed software.
migrator=${DSH_PROFILE_02_MIGRATOR:-/opt/dsh-build/migrate-harness-02-profile.mjs}
if [ -f "$migrator" ]; then
  node "$migrator" "$runtime_home"
fi

# Keep the canonical-content policy without rewriting thousands of unchanged
# dependencies across Docker Desktop's host-file sharing on every restart.
# Compare actual bytes (not just timestamps), replace changed files atomically,
# and remove obsolete software only inside the two managed directories. The
# entrypoint starts Harness only after the entire synchronization succeeds.
python3 - "$seed_home" "$runtime_home" <<'PY'
import filecmp
import json
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

# Dependency versions stay image-owned; activation belongs to the operator.
# Resolve the merge before mutating any managed file, so unsupported additions
# fail without deleting user-installed packages.
seed_manifest = json.loads((seed / 'profiles/web/package.json').read_text())
manifest_path = profiles / 'web/package.json'
merged_manifest = None
if manifest_path.is_file() and not manifest_path.is_symlink() and seed_manifest.get('dshContainer'):
    previous = json.loads(manifest_path.read_text())
    selected = previous.get('dsh', {}).get('profile', {}).get('bundles')
    policy = seed_manifest['dshContainer']
    canonical = seed_manifest['dsh']['profile']['bundles']
    if selected is not None:
        if not isinstance(selected, list) or not all(isinstance(x, str) for x in selected):
            raise RuntimeError('Invalid saved bundle selection')
        allowed = set(canonical + policy['optionalBundles'] + ['dsh-playwright', '@zoytown/dsh-token'])
        unknown = set(selected) - allowed
        unknown_dependencies = set(previous.get('dependencies', {})) - set(seed_manifest['dependencies']) - set(policy['optionalBundles']) - {'dsh-playwright'}
        if unknown or unknown_dependencies:
            raise RuntimeError('Unmanaged plugins require qualification before updating: ' + ', '.join(sorted(unknown | unknown_dependencies)))
        selected = ['dsh-ego-browser' if x == 'dsh-playwright' else x for x in selected if x != '@zoytown/dsh-token']
        for name in ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-container-profile']:
            if name not in selected:
                raise RuntimeError('Required profile bundle was removed: ' + name)
        merged_manifest = dict(seed_manifest)
        merged_manifest['dsh'] = {'profile': {'bundles': list(dict.fromkeys(selected))}}


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
    if target == manifest_path and merged_manifest is not None:
        content = (json.dumps(merged_manifest, indent=2) + '\n').encode()
        if target.read_bytes() != content:
            descriptor, temporary = tempfile.mkstemp(prefix='.dsh-sync-', dir=target.parent)
            try:
                with os.fdopen(descriptor, 'wb') as stream:
                    stream.write(content)
                os.replace(temporary, target)
                updated += 1
            finally:
                Path(temporary).unlink(missing_ok=True)
        return
    # Since 0.1.7, the profile patch is the user's durable Settings document.
    # Software defaults live in the managed bundle, never in this writable file.
    if target == profiles / 'web/cordis.patch.yml' and (target.exists() or target.is_symlink()):
        if target.is_symlink() or not target.is_file():
            raise RuntimeError('Writable profile patch must be a regular file')
        return
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
            if target == profiles / 'web' and child.name in ('cordis.patch.yml', '.container-settings-v1.json'):
                continue
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
