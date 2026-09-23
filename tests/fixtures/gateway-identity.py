"""Write synthetic legacy gateway state for isolated maintenance tests only."""
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
username = 'migration-fixture-user'
password = 'migration-fixture-$password'
data = root / 'data/gateway'
data.mkdir(parents=True, exist_ok=True)
salt = 'ab' * 16
(data / 'auth.json').write_text(json.dumps({
    'username': username, 'salt': salt, 'iterations': 1000,
    'hash': hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 1000, 32).hex(),
}))
(root / 'gateway-inspect.json').write_text(json.dumps([{
    'Config': {'Labels': {
        'com.docker.compose.project': 'deepseek-harness',
        'com.docker.compose.service': 'gateway',
        'com.docker.compose.project.working_dir': str(root),
    }, 'Env': [f'HARNESS_AUTH_USERNAME={username}', f'HARNESS_AUTH_PASSWORD={password}']},
    'Mounts': [{'Type': 'bind', 'Source': str(data), 'Destination': '/data/gateway'}],
}]))
path = root / '.env'
path.write_text(''.join(line for line in path.read_text().splitlines(keepends=True)
                        if not line.startswith('HARNESS_AUTH_')))
