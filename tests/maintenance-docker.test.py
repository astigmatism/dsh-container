#!/usr/bin/env python3
"""CI-only real Portal runner/update/rollback test using synthetic app images.

The fixture substitutes fetching/building a candidate and the external model
provider. All dispatcher, transaction, snapshot, health, gateway login, TLS,
Docker/Compose and Service Portal code is the shipping implementation.
"""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from argparse import Namespace
from unittest.mock import patch
from urllib.request import Request, urlopen

if os.environ.get('CI') != 'true':
    sys.exit('This integration rehearsal is restricted to disposable CI workers')
source = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(source))
from maintenance.common import LABEL, REPOSITORY, atomic_json, run
from maintenance.engine import install_labels, Updater
from maintenance.install import prepare
from maintenance import recovery
from maintenance.contract import configuration_bindings

PORTAL_REVISION = 'ed02de0b4842b705044b90e85ae124466c529d63'
NODE_IMAGE = 'node@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436'
harness_image, gateway_image = sys.argv[1:3]
mode = 'managed' if '--managed' in sys.argv[3:] else 'remote'
temporary = Path(tempfile.mkdtemp(prefix='dsh-maintenance-ci-')).resolve()
legacy = temporary / 'checkout'
legacy.mkdir()
root = legacy / 'data/deployment'
state = temporary / 'state'
credentials = temporary / 'credentials'
for directory in (state, credentials, credentials / 'tls', temporary / 'backend'):
    directory.mkdir(mode=0o700, exist_ok=True)
(state / 'session').write_text('original fixture history')
(temporary / 'backend/launch-token').write_text('a' * 43)
project = 'dsh-maintenance-ci-' + mode
portal_name = project + '-portal'
fixture_image = 'local/dsh-maintenance-ci:runner'
portal_image = 'local/dsh-maintenance-ci:portal'
uid, gid = os.getuid(), os.getgid()

def api(url, method='GET'):
    headers = {'X-Service-Portal-Action': 'update'} if method == 'POST' else {}
    with urlopen(Request(url, method=method, headers=headers), timeout=20) as response:
        return json.load(response)

def compose(*args):
    return run(['docker', 'compose', '--project-directory', root, '-f', root / 'compose.json', *args])

try:
    # Real Portal source, immutable revision, digest-pinned CI base.
    portal_source = temporary / 'portal'
    run(['git', 'init', '--quiet', portal_source])
    run(['git', '-C', portal_source, 'fetch', '--quiet', '--depth=1', 'https://github.com/astigmatism/service-portal.git', PORTAL_REVISION])
    run(['git', '-C', portal_source, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'])
    (portal_source / 'Dockerfile.ci').write_text(f'FROM {NODE_IMAGE}\nWORKDIR /app\nCOPY server.js index.html labels.json star.svg ./\nENV PORT=80 DATA_DIR=/data\nCMD ["node","server.js"]\n')
    run(['docker', 'build', '-f', portal_source / 'Dockerfile.ci', '-t', portal_image, portal_source])
    run(['docker', 'run', '-d', '--name', portal_name, '-p', '0.0.0.0::80', '--tmpfs', '/data',
         '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock', portal_image])
    portal_port = json.loads(run(['docker', 'inspect', portal_name]))[0]['NetworkSettings']['Ports']['80/tcp'][0]['HostPort']
    bridge = run(['docker', 'network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}']).strip()
    portal_url = f'http://{bridge}:{portal_port}'
    host_portal = f'http://127.0.0.1:{portal_port}'
    for _ in range(60):
        try:
            api(host_portal + '/api/services')
            break
        except Exception:
            time.sleep(1)
    else:
        raise AssertionError('Portal did not start')

    fixture = temporary / 'fixture'
    fixture.mkdir()
    (fixture / 'application.mjs').write_text('''import http from 'node:http';
http.createServer((req,res)=>{if(req.url.includes('token=')){res.writeHead(303,{'set-cookie':'dsh-auth-fixture=v1.test.test','location':'/'});res.end();}else{res.end('synthetic application');}}).listen(3080,'0.0.0.0');
setInterval(()=>{},1000);
''')
    (fixture / 'provider.mjs').write_text("import {readFileSync} from 'node:fs'; if(!readFileSync('/data/dsh/session','utf8'))process.exit(1);\n")
    (fixture / 'driver.py').write_text('''import sys, runpy, shutil, copy, os, uuid
from pathlib import Path
sys.path.insert(0, '/opt')
import maintenance.engine as engine
from maintenance.engine import Updater
from maintenance.common import atomic_json, run, compose_command
def fixture_candidate(self):
    release=self.root/'releases'/('ci-'+uuid.uuid4().hex)
    release.mkdir(parents=True)
    for name in ('scripts','maintenance'):
        shutil.copytree(self.root/name, release/name)
    for name in ('runner-image','start-after-network.sh'):
        shutil.copy2(self.root/name, release/name)
    model=copy.deepcopy(self.model)
    manifest=copy.deepcopy(self.manifest)
    manifest['revision']='b'*40
    atomic_json(release/'compose.json',model)
    atomic_json(release/'deployment.json',manifest)
    return release
Updater.build_candidate=fixture_candidate
def fixture_application(manifest,by_service):
    run(['docker','exec',by_service['application']['Id'],'node','/opt/dsh-build/verify-router-contract.mjs'])
engine.verify_application=fixture_application
production_probe=engine.probe_release
def fixture_probe(manifest,model,root,**kwargs):
    if kwargs.get('portal',True) and (Path(root)/'inject-portal-failure').exists():
        # Simulate post-start external drift. The candidate passed the real
        # pre-cutover contract gate; the live container now loses its button.
        for state in manifest['state_paths']:
            for name in ('session','router-history'):
                file=Path(state)/name
                if file.exists(): file.write_text('migrated fixture history')
        drift=copy.deepcopy(model)
        drift['services']['application']['labels']['io.service-portal.update.enabled']='false'
        file=Path(root)/'synthetic-drift.json'
        atomic_json(file,drift)
        run([*compose_command(root,file),'up','-d','--force-recreate','--no-build','--pull','never','--wait','--wait-timeout','60'])
    return production_probe(manifest,model,root,**kwargs)
engine.probe_release=fixture_probe
runpy.run_path('/opt/dsh-maintenance/production-main.py',run_name='__main__')
''')
    (fixture / 'Dockerfile').write_text(f'''FROM {harness_image}
USER root
RUN mv /opt/dsh-maintenance/main.py /opt/dsh-maintenance/production-main.py && ln -s /opt/dsh-maintenance /opt/maintenance
COPY driver.py /opt/dsh-maintenance/main.py
COPY application.mjs /opt/fixture/application.mjs
COPY provider.mjs /opt/dsh-build/verify-router-contract.mjs
USER node
''')
    run(['docker', 'build', '-t', fixture_image, fixture])
    fixture_id = json.loads(run(['docker', 'image', 'inspect', fixture_image]))[0]['Id']
    gateway_id = json.loads(run(['docker', 'image', 'inspect', gateway_image]))[0]['Id']

    # IP-only leaf: localhost is intentionally absent. No CA key is mounted.
    def openssl(*args):
        run(['openssl', *args], cwd=credentials / 'tls')
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'issuer.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=Synthetic CI authority', '-addext', 'basicConstraints=critical,CA:TRUE')
    openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'request.pem', '-subj', '/O=Synthetic fixture')
    (credentials / 'tls/extensions').write_text('subjectAltName=IP:192.0.2.17\nextendedKeyUsage=serverAuth\n')
    openssl('x509', '-req', '-in', 'request.pem', '-CA', 'ca.crt', '-CAkey', 'issuer.key', '-CAcreateserial', '-out', 'server.crt', '-days', '1', '-extfile', 'extensions')
    (credentials / 'tls/issuer.key').unlink()
    baseline_tls = (credentials / 'tls/server.crt').read_bytes()
    model = {'name': project, 'services': {
        'application': {'image': fixture_id, 'user': f'{uid}:{gid}',
          'entrypoint': ['node', '/opt/fixture/application.mjs'],
          'volumes': [{'type': 'bind', 'source': str(state), 'target': '/data/dsh'},
                      {'type': 'bind', 'source': str(temporary / 'backend'), 'target': '/run/dsh-backend-auth'}],
          'healthcheck': {'test': ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3080').then(r=>{if(!r.ok)process.exit(1)})"], 'interval': '1s', 'timeout': '3s', 'retries': 30}},
        'edge': {'image': gateway_id, 'user': f'{uid}:{gid}', 'network_mode': 'service:application',
          'depends_on': {'application': {'condition': 'service_healthy'}},
          'environment': {'HARNESS_AUTH_USERNAME': 'synthetic-user', 'HARNESS_AUTH_PASSWORD': 'synthetic-$$password',
            'HARNESS_TLS_MODE': 'external', 'HARNESS_TLS_IP': '192.0.2.17', 'HARNESS_TLS_VERIFY_NAME': '192.0.2.17',
            'HARNESS_BACKEND_URL': 'http://127.0.0.1:3080'},
          'volumes': [{'type': 'bind', 'source': str(credentials), 'target': '/data/gateway'},
                      {'type': 'bind', 'source': str(temporary / 'backend'), 'target': '/run/dsh-backend-auth', 'read_only': True}],
          'healthcheck': {'test': ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3081/healthz').then(r=>{if(!r.ok)process.exit(1)})"], 'interval': '1s', 'timeout': '3s', 'retries': 30}}
    }}
    if mode == 'managed':
        router_state = temporary / 'router-state'
        router_state.mkdir()
        (router_state / 'router-history').write_text('original router history')
        model_store = temporary / 'shared-models'
        model_store.mkdir()
        (model_store / 'model.blob').write_bytes(b'synthetic shared model blob')
        model['services']['router'] = {
            'image': fixture_id, 'user': f'{uid}:{gid}',
            'entrypoint': ['node', '/opt/fixture/application.mjs'],
            'volumes': [{'type': 'bind', 'source': str(router_state), 'target': '/app/data'},
                        {'type': 'bind', 'source': str(model_store), 'target': '/models', 'read_only': True}],
            'healthcheck': copy.deepcopy(model['services']['application']['healthcheck'])}
    # Start a checkout-based deployment with custom ports, credentials and an
    # absent update capability. Adoption must preserve it without source edits.
    model['services']['application']['labels'] = {LABEL + 'enabled': 'false'}
    atomic_json(legacy / 'compose.json', model)
    before_checkout = (legacy / 'compose.json').read_bytes()
    run(['docker', 'compose', '--project-directory', legacy, '-f', legacy / 'compose.json',
         'up', '-d', '--wait', '--wait-timeout', '120'])
    roles = ['application=harness', 'edge=gateway'] + (['router=router'] if mode == 'managed' else [])
    args = Namespace(project_directory=legacy, deployment_dir=None, compose_file=[str(legacy/'compose.json')],
        env_file=None, mode=mode, portal_url=portal_url, role=roles, state_path=[], external_path=[],
        adopt=True, dry_run=True, boot_unit=None)
    baseline = recovery.inventory(legacy)
    prepare(args, source)
    assert recovery.inventory(legacy) == baseline and not root.exists()

    def adopted_candidate(updater):
        release = updater.root / 'releases/bootstrap'
        release.mkdir(parents=True)
        for name in ('scripts', 'maintenance'):
            shutil.copytree(updater.root / name, release / name)
        (release / 'runner-image').write_text(fixture_id + '\n')
        (release / 'start-after-network.sh').write_text('#!/bin/sh\nexit 0\n')
        manifest = copy.deepcopy(updater.manifest)
        manifest['revision'] = 'a'*40
        atomic_json(release / 'deployment.json', manifest)
        atomic_json(release / 'compose.json', updater.model)
        return release

    def fixture_application(manifest, rows):
        run(['docker', 'exec', rows['application']['Id'], 'node', '/opt/dsh-build/verify-router-contract.mjs'])

    args.dry_run = False
    with patch.object(Updater, 'build_candidate', adopted_candidate), patch('maintenance.engine.verify_application', fixture_application):
        prepare(args, source)
    assert (legacy / 'compose.json').read_bytes() == before_checkout
    (legacy / 'compose.json').unlink()  # Updates now have no source Compose input.
    installed = json.loads((root / 'deployment.json').read_text())
    assert installed['mode'] == mode
    if mode == 'managed':
        assert str(router_state) in installed['state_paths']
        assert str(model_store) not in installed['state_paths'] + installed['input_paths']
    unrelated = project + '-unrelated'
    run(['docker', 'run', '-d', '--name', unrelated, '--entrypoint', 'node', fixture_id,
         '-e', 'setInterval(()=>{},1000)'])
    unrelated_id = json.loads(run(['docker', 'inspect', unrelated]))[0]['Id']
    services = api(host_portal + '/api/services')['services']
    selected = next(row for row in services if row['project'] == project and row['name'].endswith('application-1'))
    assert selected['update']['available']
    # The real Portal endpoint launches the shipping POSIX script with only its
    # normal project/socket mounts. The script supplies the external state mounts.
    def update():
        current = next(row for row in api(host_portal+'/api/services')['services'] if row['project']==project and row['name'].endswith('application-1'))
        result = api(host_portal + '/api/projects/' + project + '/update', 'POST')
        job = result.get('job', result)
        for _ in range(180):
            response = api(host_portal + '/api/maintenance/' + job['id'])
            record = response.get('job', response)
            if record['state'] not in ('queued', 'running'):
                return record
            time.sleep(1)
        raise AssertionError('Portal maintenance job timed out')
    result = update()
    assert result['state'] == 'succeeded', result
    assert json.loads((root/'deployment.json').read_text())['revision'] == 'b'*40
    assert (credentials/'tls/server.crt').read_bytes() == baseline_tls
    assert (state/'session').read_text() == 'original fixture history'
    (root/'inject-portal-failure').write_text('fixture only')
    result = update()
    assert result['state'] == 'failed', result
    status = json.loads((root/'maintenance-status.json').read_text())
    assert status['recovery'] == 'succeeded', (status, result)
    assert json.loads((root/'compose.json').read_text())['services']['application']['labels'][LABEL+'enabled'] == 'true'
    assert (credentials/'tls/server.crt').read_bytes() == baseline_tls
    assert (state/'session').read_text() == 'original fixture history'
    assert json.loads(run(['docker','inspect',unrelated]))[0]['Id'] == unrelated_id
    assert json.loads(run(['docker','inspect',unrelated]))[0]['State']['Running']
    if mode == 'managed':
        assert (router_state/'router-history').read_text() == 'original router history'
        assert (model_store/'model.blob').read_bytes() == b'synthetic shared model blob'
    print('Real Portal runner verified: detached dispatch, external state mounts, authenticated IP-only TLS, update and automatic rollback.')
finally:
    subprocess.run(['docker', 'compose', '--project-directory', str(root), '-f', str(root/'compose.json'), 'down'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['docker', 'rm', '-f', portal_name, project + '-unrelated'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(temporary)
