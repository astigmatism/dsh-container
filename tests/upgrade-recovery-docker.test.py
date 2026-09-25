#!/usr/bin/env python3
"""CI-only recovery rehearsal with real Compose, bind mounts and image changes.

This checks the updater's recovery mechanism independently of session codecs.
The old image is a fixture derived from the built image, not a legacy Harness.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

if os.environ.get('CI') != 'true':
    sys.exit('This Docker rehearsal is restricted to disposable CI workers')
source = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('recovery', source / 'scripts/upgrade-recovery.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
image = sys.argv[1]
for name in ('deepseek-harness', 'deepseek-harness-gateway'):
    if subprocess.run(['docker', 'inspect', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        sys.exit('Refusing recovery rehearsal on a worker with an existing deployment')
project = Path(tempfile.mkdtemp(prefix='dsh-upgrade-recovery-ci-')).resolve()
old_image = 'local/dsh-recovery-fixture:old'
point = None
command = ['docker', 'compose', '--project-directory', str(project), '-f', str(project / 'compose.yaml')]
try:
    for root in recovery.ROOTS:
        folder = project / root
        folder.mkdir(parents=True)
        (folder / 'state').write_text('old data')
    (project / '.env').write_text("PRIVATE_VALUE='fixture-$literal'\n")
    os.chmod(project / '.env', 0o600)
    dockerfile = f'FROM {image}\nLABEL org.opencontainers.image.version="0.1.6-alpha.1"\n'
    result = subprocess.run(['docker', 'build', '--quiet', '--tag', old_image, '-'], input=dockerfile, text=True, capture_output=True)
    assert result.returncode == 0, 'old image fixture build'
    model = {'name': 'deepseek-harness', 'services': {}}
    for service, name, root in [('harness', 'deepseek-harness', 'dsh'), ('gateway', 'deepseek-harness-gateway', 'gateway')]:
        model['services'][service] = {
            'image': old_image, 'container_name': name, 'user': f'{os.getuid()}:{os.getgid()}',
            'entrypoint': ['node', '-e', 'setInterval(()=>{},1000)'],
            'volumes': [f'./data/{root}:/state'], 'environment': {'PRIVATE_VALUE': '${PRIVATE_VALUE}'},
            'healthcheck': {'test': ['CMD', 'node', '-e',
                'if(require("fs").readFileSync("/state/state","utf8")!=="old data"||process.env.PRIVATE_VALUE!=="fixture-$$literal")process.exit(1)'],
                'interval': '1s', 'timeout': '2s', 'retries': 5}}
    (project / 'compose.yaml').write_text(json.dumps(model))
    (project / 'compose.remote-ollama.yaml').write_text('services: {}\n')
    recovery.run(['git', '-C', str(project), 'init', '-q'])
    recovery.run(['git', '-C', str(project), 'add', 'compose.yaml', 'compose.remote-ollama.yaml'])
    recovery.run(['git', '-C', str(project), '-c', 'user.name=Recovery fixture', '-c', 'user.email=fixture@invalid',
                  'commit', '-qm', 'Old Compose fixture'])
    commit = recovery.run(['git', '-C', str(project), 'rev-parse', 'HEAD']).strip()
    recovery.run([*command, 'up', '-d', '--wait', '--wait-timeout', '30'])
    old_id = json.loads(recovery.run(['docker', 'inspect', 'deepseek-harness']))[0]['Image']
    point = recovery.prepare(project, 'remote', commit)
    assert point
    recovery.capture(point)
    for root in recovery.ROOTS:
        (project / root / 'state').write_text('migrated data')
    # Replace both actual containers, as a deployment failure after migration would.
    for service in model['services'].values():
        service['image'] = image
        service.pop('healthcheck')
    (project / 'compose.yaml').write_text(json.dumps(model))
    recovery.run([*command, 'up', '-d', '--force-recreate'])
    assert json.loads(recovery.run(['docker', 'inspect', 'deepseek-harness']))[0]['Image'] != old_id
    (project / '.env').write_text('PRIVATE_VALUE=new-value\n')
    recovery.restore(point)
    assert json.loads(recovery.run(['docker', 'inspect', 'deepseek-harness']))[0]['Image'] == old_id
    for root in recovery.ROOTS:
        assert (project / root / 'state').read_text() == 'old data'
        assert (point / 'failed-runtime' / root / 'state').read_text() == 'migrated data'
    assert (project / '.env').read_text() == "PRIVATE_VALUE='fixture-$literal'\n"
    print('Real Compose recovery restored previous image IDs, data, credentials and healthy recreated bind mounts.')
finally:
    subprocess.run([*command, 'down'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if point:
        saved = json.loads((point / 'compose.json').read_text())
        for service in saved['services'].values():
            subprocess.run(['docker', 'image', 'rm', service['image']], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['docker', 'image', 'rm', old_image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(project)
