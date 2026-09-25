#!/usr/bin/env python3
"""Build shipping images from tracked source with maintenance's private modes.

All later image and detached-runner checks use these images. This catches COPY
permissions that work in an ordinary checkout but fail after an updater fetch.
"""
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile

source = Path(__file__).resolve().parents[1]
harness, gateway, router = sys.argv[1:]
tracked = subprocess.check_output(['git', '-C', str(source), 'ls-files', '-z']).split(b'\0')

with tempfile.TemporaryDirectory(prefix='dsh-private-release-') as temporary:
    context = Path(temporary)
    for entry in tracked:
        if not entry:
            continue
        relative = Path(os.fsdecode(entry))
        original, target = source / relative, context / relative
        if not original.exists() and not original.is_symlink():
            continue
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copy2(original, target, follow_symlinks=False)
        if not target.is_symlink():
            target.chmod(stat.S_IMODE(original.stat().st_mode) & 0o700)
    for directory in context.rglob('*'):
        if directory.is_dir() and not directory.is_symlink():
            directory.chmod(0o700)
    for role, image in [('harness', harness), ('gateway', gateway), ('router', router)]:
        build_context = context / 'ollama-router' if role == 'router' else context
        subprocess.run(['docker', 'build', '--target', role, '--tag', image, str(build_context)], check=True)
