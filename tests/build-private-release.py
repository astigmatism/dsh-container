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
import json
from unittest.mock import patch

source = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(source))
from maintenance.common import atomic_json, REPOSITORY, run, inspect, Failure
from maintenance.contract import configuration_bindings
from maintenance.engine import Updater, install_labels
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

    # Exercise the real candidate builder twice at one revision. Only source
    # retrieval is substituted so CI qualifies its current commit before merge.
    # A failed second candidate must leave the first candidate's tags and image
    # identities available, including on Docker's containerd image store.
    operations = context.parent / (context.name + '-operations')
    operations.mkdir(mode=0o700)
    previous_umask = os.umask(0o077)
    try:
        revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
        def stage_source(destination):
            shutil.copytree(context, destination, dirs_exist_ok=True)
            return revision
        model = {'name': 'dsh-image-retention-ci', 'services': {
            'application': {'image': inspect('image', harness)['Id'], 'user': '12345:12345'},
            'edge': {'image': inspect('image', gateway)['Id']}}}
        manifest = {'schema': 1, 'root': str(operations), 'project': model['name'],
            'repository': REPOSITORY, 'branch': 'main', 'mode': 'remote',
            'revision': revision, 'engine_id': 'build-only-fixture',
            'roles': {'application': 'harness', 'edge': 'gateway'}, 'user': '12345:12345',
            'portal_url': 'http://portal.invalid', 'state_paths': [], 'input_paths': [],
            'artifact_paths': [], 'source_artifacts': [],
            'images': {s: c['image'] for s, c in model['services'].items()},
            'bindings': configuration_bindings(model)}
        install_labels(model, manifest, model['services']['application']['image'])
        atomic_json(operations / 'compose.json', model)
        atomic_json(operations / 'deployment.json', manifest)
        build_tags = []
        def command(args, **kwargs):
            if args[:2] == ['docker', 'build']:
                build_tags.append(args[args.index('--tag') + 1])
            return run(args, **kwargs)
        with patch('maintenance.engine.fetch_source', stage_source), patch('maintenance.engine.run', command):
            first = Updater(operations).build_candidate()
            first_manifest = json.loads((first / 'deployment.json').read_text())
            retained = {image: set(inspect('image', image)['RepoTags']) for image in first_manifest['images'].values()}
            with patch('maintenance.engine.qualify_runner', side_effect=Failure('synthetic candidate rejection')):
                try:
                    Updater(operations).build_candidate()
                except Failure as error:
                    assert str(error) == 'synthetic candidate rejection', error
                else:
                    raise AssertionError('Candidate rejection did not run')
            for image, tags in retained.items():
                assert tags <= set(inspect('image', image)['RepoTags']), 'A rebuild replaced a retained release tag'
            assert len(build_tags) == len(set(build_tags)) == 4, 'Build attempts must own distinct tags'
            assert not (operations / 'transaction.json').exists()
        print('Actual candidate builds preserve prior image references after a same-revision candidate failure.')
    finally:
        os.umask(previous_umask)
        shutil.rmtree(operations)
