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
from maintenance.common import LABEL, REPOSITORY, atomic_json, run, digest
from maintenance.engine import install_labels, Updater, stage_source_artifacts
from maintenance.install import prepare
from maintenance import recovery
from maintenance.contract import configuration_bindings

PORTAL_REVISION = 'ed02de0b4842b705044b90e85ae124466c529d63'
LEGACY_REVISION = 'bb6060953a9049c07f5756760ce3723df30dc667'
NODE_IMAGE = 'node@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436'
harness_image, gateway_image = sys.argv[1:3]
mode = 'managed' if '--managed' in sys.argv[3:] else 'external' if '--external' in sys.argv[3:] else 'remote'
temporary = Path(tempfile.mkdtemp(prefix='dsh-maintenance-ci-')).resolve()
legacy = temporary / 'checkout'
legacy.mkdir()
root = legacy / 'data/deployment'
state = temporary / 'state'
credentials = temporary / 'credentials'
for directory in (state, credentials, credentials / 'tls', temporary / 'backend'):
    directory.mkdir(mode=0o700, exist_ok=True)
(state / 'session').write_text('original fixture history')
(state / 'ego-browser/profile/Default').mkdir(parents=True)
(state / 'ego-browser/profile/Default/Cookies').write_bytes(b'synthetic-browser-profile')
(temporary / 'backend/launch-token').write_text('a' * 43)
project = 'dsh-maintenance-ci-' + mode
external_network = project + '-shared-network' if mode == 'external' else None
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
    code_binds = [
        ('seed/plugins/dsh-router-model-discovery.js', '/opt/dsh-seed/.dsh-plugins/dsh-router-model-discovery.js'),
        *[(f'scripts/{name}.mjs', f'/opt/dsh-build/{name}.mjs') for name in
          ('migrate-resident-models', 'verify-router-contract', 'verify-resident-client')]]
    override_dir = temporary / 'overrides'
    override_dir.mkdir()
    mappings = []
    for relative, target in code_binds:
        candidate = fixture / 'source-artifacts' / relative
        candidate.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / relative, candidate)
        old = override_dir / Path(relative).name
        old.write_text('export const oldDeploymentOverride = true;\n')
        mappings.append(f'application:{target}={relative}@{digest(old)}')
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
from maintenance.common import atomic_json, atomic_text, run, compose_command
from unittest.mock import patch
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
    next_image=Path('/opt/fixture/candidate-image')
    if next_image.exists():
        if (self.root/'inject-missing-legacy-gate').exists():
            next_image=Path('/opt/fixture/missing-entry-image')
        image=next_image.read_text().strip()
        model['services']['application']['image']=image
        engine.install_labels(model,manifest,image)
        manifest['images']={s:c['image'] for s,c in model['services'].items()}
        atomic_text(release/'runner-image',image+'\\n')
    engine.stage_source_artifacts(Path('/opt/fixture/source-artifacts'),model,manifest,release)
    manifest['bindings']=engine.configuration_bindings(model)
    atomic_json(release/'compose.json',model)
    atomic_json(release/'deployment.json',manifest)
    return release
Updater.build_candidate=fixture_candidate
original_application=engine.verify_application
def fixture_application(manifest,by_service):
    # Execute the installed runner's actual verifier list. External inference
    # is synthetic here; each command must still exist in the candidate image.
    # The image boot gate executes the legacy browser entry point against the
    # real authenticated ego plugin, including rejection cases.
    def check_entry_point(args,**kwargs):
        assert args[:2]==['docker','exec'] and args[3]=='node', args[:4]
        run(args[:4]+['--check',args[4]])
    with patch.object(engine,'run',check_entry_point):
        original_application(manifest,by_service)
    run(['docker','exec',by_service['application']['Id'],'node','/opt/fixture/provider.mjs'])
engine.verify_application=fixture_application
production_probe=engine.probe_release
def fixture_recovery(manifest,model,root):
    # The synthetic app has no ai-router endpoint; keep the real container,
    # authenticated gateway and fixture provider checks during rollback.
    production_probe(manifest,model,root,portal=False)
engine.verify_recovered_release=fixture_recovery
def fixture_probe(manifest,model,root,**kwargs):
    if kwargs.get('portal',True) and (Path(root)/'inject-portal-failure').exists():
        # Simulate post-start external drift. The candidate passed the real
        # pre-cutover contract gate; the live container now loses its button.
        for state in manifest['state_paths']:
            for name in ('session','router-history','ego-browser/profile/Default/Cookies'):
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
COPY provider.mjs /opt/fixture/provider.mjs
COPY source-artifacts /opt/fixture/source-artifacts
USER node
''')
    run(['docker', 'build', '-t', fixture_image, fixture])
    fixture_id = json.loads(run(['docker', 'image', 'inspect', fixture_image]))[0]['Id']
    initial_id = fixture_id
    if mode == 'remote':
        # The worker keeps running its installed Python after cutover. A
        # rehearsal using only today's updater cannot catch removed APIs that
        # an older worker still invokes against the replacement application.
        old_source = temporary / 'legacy-maintenance-source'
        run(['git', 'init', '--quiet', old_source])
        run(['git', '-C', old_source, 'fetch', '--quiet', '--depth=1', REPOSITORY, LEGACY_REVISION])
        run(['git', '-C', old_source, 'checkout', '--quiet', '--detach', LEGACY_REVISION])
        old_fixture = temporary / 'legacy-runner'
        old_fixture.mkdir()
        broken_fixture = temporary / 'missing-legacy-gate'
        broken_fixture.mkdir()
        (broken_fixture / 'Dockerfile').write_text(f'FROM {fixture_image}\nUSER root\nRUN rm /opt/dsh-build/verify-dsh-playwright-stream.mjs\nUSER node\n')
        broken_image = 'local/dsh-maintenance-ci:missing-legacy-gate'
        run(['docker', 'build', '-t', broken_image, broken_fixture])
        broken_id = json.loads(run(['docker', 'image', 'inspect', broken_image]))[0]['Id']
        shutil.copytree(old_source / 'maintenance', old_fixture / 'maintenance')
        shutil.copy2(fixture / 'driver.py', old_fixture / 'driver.py')
        (old_fixture / 'candidate-image').write_text(fixture_id + '\n')
        (old_fixture / 'missing-entry-image').write_text(broken_id + '\n')
        (old_fixture / 'Dockerfile').write_text(f'''FROM {fixture_image}
USER root
COPY maintenance/ /opt/dsh-maintenance/
RUN mv /opt/dsh-maintenance/main.py /opt/dsh-maintenance/production-main.py
COPY driver.py /opt/dsh-maintenance/main.py
COPY candidate-image /opt/fixture/candidate-image
COPY missing-entry-image /opt/fixture/missing-entry-image
RUN chmod -R a+rX /opt/dsh-maintenance /opt/fixture
USER node
''')
        legacy_image = 'local/dsh-maintenance-ci:legacy-runner'
        run(['docker', 'build', '-t', legacy_image, old_fixture])
        initial_id = json.loads(run(['docker', 'image', 'inspect', legacy_image]))[0]['Id']
    gateway_id = json.loads(run(['docker', 'image', 'inspect', gateway_image]))[0]['Id']
    run(['docker', 'run', '--rm', '--user', '0:0',
         '--mount', f'type=bind,src={state},dst=/data/dsh',
         '--entrypoint', '/bin/sh', fixture_id, '-c',
         "printf 'root-owned operational placeholder' > /data/dsh/root-owned"])
    assert (state / 'root-owned').stat().st_uid == 0

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
        'application': {'image': initial_id, 'user': f'{uid}:{gid}',
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
    model['services']['application']['volumes'].extend(
        {'type': 'bind', 'source': str(override_dir / Path(relative).name), 'target': target, 'read_only': True}
        for relative, target in code_binds)
    if external_network:
        run(['docker', 'network', 'create', external_network])
        model['networks'] = {'shared_model': {'name': external_network, 'external': True}}
        model['services']['application']['networks'] = {'shared_model': {}}
        network_id = json.loads(run(['docker', 'network', 'inspect', external_network]))[0]['Id']
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
    def live_gateway_environment():
        identity = run(['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=' + project,
                        '--filter', 'label=com.docker.compose.service=edge']).strip()
        return json.loads(run(['docker', 'inspect', identity]))[0]['Config']['Env']
    original_gateway_environment = live_gateway_environment()
    roles = ['application=harness', 'edge=gateway'] + (['router=router'] if mode == 'managed' else [])
    args = Namespace(project_directory=legacy, deployment_dir=None, compose_file=[str(legacy/'compose.json')],
        env_file=None, mode=mode, portal_url=portal_url, role=roles, state_path=[], external_path=[],
        adopt=True, dry_run=True, boot_unit=None, source_bind=mappings)
    baseline = recovery.inventory(legacy)
    prepare(args, source)
    assert recovery.inventory(legacy) == baseline and not root.exists()

    def adopted_candidate(updater):
        release = updater.root / 'releases/bootstrap'
        release.mkdir(parents=True)
        for name in ('scripts', 'maintenance'):
            shutil.copytree(updater.root / name, release / name)
        (release / 'runner-image').write_text(initial_id + '\n')
        (release / 'start-after-network.sh').write_text('#!/bin/sh\nexit 0\n')
        manifest = copy.deepcopy(updater.manifest)
        manifest['revision'] = 'a'*40
        model = copy.deepcopy(updater.model)
        stage_source_artifacts(source, model, manifest, release)
        manifest['bindings'] = configuration_bindings(model)
        atomic_json(release / 'deployment.json', manifest)
        atomic_json(release / 'compose.json', model)
        return release

    def fixture_application(manifest, rows):
        run(['docker', 'exec', rows['application']['Id'], 'node', '/opt/fixture/provider.mjs'])

    args.dry_run = False
    with patch.object(Updater, 'build_candidate', adopted_candidate), patch('maintenance.engine.verify_application', fixture_application):
        prepare(args, source)
    assert (legacy / 'compose.json').read_bytes() == before_checkout
    assert sorted(live_gateway_environment()) == sorted(original_gateway_environment)
    (legacy / 'compose.json').unlink()  # Updates now have no source Compose input.
    installed = json.loads((root / 'deployment.json').read_text())
    assert installed['mode'] == mode
    assert len(installed['source_artifacts']) == 4
    original_overrides = {str(path): path.read_bytes() for path in override_dir.iterdir()}
    def check_code_binds():
        active = json.loads((root / 'deployment.json').read_text())
        container = run(['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=' + project,
                         '--filter', 'label=com.docker.compose.service=application']).strip()
        mounts = json.loads(run(['docker', 'inspect', container]))[0]['Mounts']
        for artifact in active['source_artifacts']:
            assert any(m['Destination'] == artifact['target'] and m['Source'] == artifact['installed'] for m in mounts)
            assert digest(Path(artifact['installed'])) == digest(source / artifact['relative'])
        assert {str(path): path.read_bytes() for path in override_dir.iterdir()} == original_overrides
    check_code_binds()
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
    if mode == 'remote':
        (root / 'inject-missing-legacy-gate').write_text('fixture only')
        result = update()
        assert result['state'] == 'failed', result
        status = json.loads((root / 'maintenance-status.json').read_text())
        assert status['recovery'] == 'succeeded', status
        assert json.loads((root / 'compose.json').read_text())['services']['application']['image'] == initial_id
        assert (state / 'session').read_text() == 'original fixture history'
        assert (state / 'ego-browser/profile/Default/Cookies').read_bytes() == b'synthetic-browser-profile'
        (root / 'inject-missing-legacy-gate').unlink()
        print('Pinned legacy updater rejected the missing browser verifier and restored the prior generation.')
    result = update()
    assert result['state'] == 'succeeded', result
    if mode == 'remote':
        active = json.loads((root / 'compose.json').read_text())
        assert active['services']['application']['image'] == fixture_id
        assert active['services']['application']['labels'][LABEL+'image'] == fixture_id
        print(f'Pinned legacy updater {LEGACY_REVISION} completed candidate cutover and verification entry points.')
    assert json.loads((root/'deployment.json').read_text())['revision'] == 'b'*40
    check_code_binds()
    assert (credentials/'tls/server.crt').read_bytes() == baseline_tls
    assert (state/'session').read_text() == 'original fixture history'
    assert (state/'ego-browser/profile/Default/Cookies').read_bytes() == b'synthetic-browser-profile'
    assert (state/'root-owned').read_text() == 'root-owned operational placeholder'
    assert (state/'root-owned').stat().st_uid == 0
    (root/'inject-portal-failure').write_text('fixture only')
    result = update()
    assert result['state'] == 'failed', result
    status = json.loads((root/'maintenance-status.json').read_text())
    assert status['recovery'] == 'succeeded', (status, result)
    check_code_binds()
    assert json.loads((root/'compose.json').read_text())['services']['application']['labels'][LABEL+'enabled'] == 'true'
    assert (credentials/'tls/server.crt').read_bytes() == baseline_tls
    assert (state/'session').read_text() == 'original fixture history'
    assert (state/'ego-browser/profile/Default/Cookies').read_bytes() == b'synthetic-browser-profile'
    assert (state/'root-owned').read_text() == 'root-owned operational placeholder'
    assert (state/'root-owned').stat().st_uid == 0
    assert json.loads(run(['docker','inspect',unrelated]))[0]['Id'] == unrelated_id
    assert json.loads(run(['docker','inspect',unrelated]))[0]['State']['Running']
    if external_network:
        assert json.loads(run(['docker', 'network', 'inspect', external_network]))[0]['Id'] == network_id
        assert json.loads((root/'compose.json').read_text())['networks']['shared_model']['external'] is True
    if mode == 'managed':
        assert (router_state/'router-history').read_text() == 'original router history'
        assert (model_store/'model.blob').read_bytes() == b'synthetic shared model blob'
    print(f'Real Portal runner ({mode}) verified: detached dispatch, external state mounts, authenticated IP-only TLS, update and automatic rollback.')
finally:
    subprocess.run(['docker', 'compose', '--project-directory', str(root), '-f', str(root/'compose.json'), 'down'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['docker', 'rm', '-f', portal_name, project + '-unrelated'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if external_network:
        subprocess.run(['docker', 'network', 'rm', external_network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(temporary)
