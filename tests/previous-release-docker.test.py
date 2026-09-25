#!/usr/bin/env python3
"""Build the deployed previous release and upgrade it through the real Portal."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

if os.environ.get('CI') != 'true':
    sys.exit('Docker release qualification is restricted to disposable Linux CI')
root = Path(__file__).resolve().parents[1]
revision = '5742e98463c1dcc8a39f7a0e816e304794702530'
image = 'local/dsh-contract-previous:' + revision
with tempfile.TemporaryDirectory(prefix='dsh-previous-release-') as directory:
    subprocess.run(['git', 'init', '--quiet', directory], check=True)
    subprocess.run(['git', '-C', directory, 'fetch', '--quiet', '--depth=1',
                    'https://github.com/astigmatism/dsh-container.git', revision], check=True)
    subprocess.run(['git', '-C', directory, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], check=True)
    subprocess.run(['docker', 'build', '--target', 'harness', '--tag', image, directory], check=True)
    subprocess.run([sys.executable, str(root/'tests/maintenance-docker.test.py'),
                    *sys.argv[1:3], '--previous-image', image], check=True)
