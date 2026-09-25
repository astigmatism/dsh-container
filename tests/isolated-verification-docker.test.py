#!/usr/bin/env python3
"""Linux-only acceptance: two real live UI runs leave populated production intact."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('isolated', ROOT / 'scripts/verify-isolated-runtime.py')
isolated = importlib.util.module_from_spec(spec)
spec.loader.exec_module(isolated)
docker = isolated.docker
image = sys.argv[1]
suffix = uuid.uuid4().hex[:8]
network, source, router = [f'dsh-verification-test-{suffix}-{s}' for s in ('network', 'source', 'router')]

RPC = r'''
const fs = require('fs'), crypto = require('crypto');
(async () => {
 const token = fs.readFileSync('/run/dsh-backend-auth/launch-token','utf8').trim();
 const auth = await fetch('http://127.0.0.1:3080/?token='+token,{redirect:'manual'});
 const cookie = auth.headers.get('set-cookie').split(';')[0];
 async function rpc(method,request) {
   const args=method==='session/list'?{_request:{}}:{request};
   const response=await fetch('http://127.0.0.1:3080/api/'+method,{method:'POST',headers:{cookie,'content-type':'application/json'},
    body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args}})});
   const data=await response.json(); if(!data.result.ok) throw Error(method+' failed'); return data.result.value;
 }
 const workspace = await rpc('workspace/create',{path:'/tmp'});
 const {sessionId} = await rpc('session/create',{workspaceId:workspace.workspace.workspaceId});
 await rpc('session/rename',{sessionId,title:'Existing user conversation'});
 await rpc('session/prompt',{sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:'Reply with READY.'}]});
 for(let i=0;i<120;i++) {
   const row=(await rpc('session/list',{})).items.find(r=>r.sessionId===sessionId);
   if(!row.running && !row.blank) { console.log(sessionId); return; }
   await new Promise(r=>setTimeout(r,1000));
 }
 throw Error('User fixture failed to become idle');
})().catch(e=>{console.error(e.message);process.exitCode=1});
'''

SNAPSHOT = r'''
import hashlib,json,pathlib
root=pathlib.Path('/data/dsh')
files=[]
for name in ('sessions','storages'):
    path=root/name
    if path.exists(): files.extend(p for p in path.rglob('*') if p.is_file())
files.append(root/'profiles/web/cordis.patch.yml')
print(json.dumps({str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)},sort_keys=True))
'''

try:
    docker('network', 'create', network)
    docker('run', '-d', '--name', router, '--network', network, '--network-alias', 'ai-router',
           '--entrypoint', 'node', '--volume', f'{ROOT / "tests/fixtures/verification-router.mjs"}:/fixture.mjs:ro', image, '/fixture.mjs')
    docker('run', '-d', '--name', source, '--network', network, '--user', '12345:12345',
           '--env', 'HOME=/', '--env', 'DSH_WEB_LAUNCH_TOKEN_FILE=/run/dsh-backend-auth/launch-token',
           '--tmpfs', '/data/dsh:uid=12345,gid=12345,mode=0700',
           '--tmpfs', '/run/dsh-backend-auth:uid=12345,gid=12345,mode=0700', image)
    for attempt in range(180):
        result = subprocess.run(['docker', 'exec', source, '/bin/sh', '-c',
          'test -s /run/dsh-backend-auth/launch-token && curl -fsS -o /dev/null '
          '"http://127.0.0.1:3080/?token=$(cat /run/dsh-backend-auth/launch-token)"'], capture_output=True)
        if result.returncode == 0:
            break
        time.sleep(1)
    else:
        raise AssertionError('Source fixture did not become ready')
    docker('exec', '-i', source, 'node', data=RPC.encode())
    before = docker('exec', '-i', source, 'python3', '-c', SNAPSHOT)
    with tempfile.TemporaryDirectory(prefix='dsh-verification-artifacts-') as directory:
        for attempt in range(2):
            isolated.qualify(source, diagnostics=directory)
            assert docker('exec', '-i', source, 'python3', '-c', SNAPSHOT) == before, 'Verification modified production state'
        # A real provider rejection must fail acceptance without changing user data.
        docker('exec', router, 'node', '-e', "fetch('http://127.0.0.1:11434/test/fail',{method:'POST'})")
        try:
            isolated.qualify(source, diagnostics=directory)
        except isolated.QualificationError:
            assert (Path(directory) / 'failure.json').is_file(), 'Missing failure diagnostics'
        else:
            raise AssertionError('Provider failure incorrectly passed qualification')
        assert docker('exec', '-i', source, 'python3', '-c', SNAPSHOT) == before, 'Failure cleanup modified production state'
    assert not docker('ps', '-aq', '--filter', 'label=io.dsh.verification=isolated').strip(), 'Disposable runtime leaked'
    print('Repeated live picker/inference verification and provider failure preserved all production sessions and preferences.')
finally:
    subprocess.run(['docker', 'rm', '-f', source, router], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['docker', 'network', 'rm', network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
