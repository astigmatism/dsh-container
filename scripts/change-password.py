#!/usr/bin/env python3
"""Change private gateway credentials without printing them or changing sessions."""
import argparse
import getpass
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('gateway_credentials', ROOT / 'scripts/gateway-credentials.py')
credentials = importlib.util.module_from_spec(spec)
spec.loader.exec_module(credentials)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--username')
    args = parser.parse_args()
    path = ROOT / '.env'
    if not path.is_file():
        raise SystemExit('Missing .env; run configure.sh first.')
    username = args.username or credentials.read_values(path).get('HARNESS_AUTH_USERNAME')
    if not username:
        raise SystemExit('No username configured; pass --username.')
    password = getpass.getpass(f'New password for {username}: ')
    if len(password) < 8:
        raise SystemExit('Password unchanged: use at least 8 characters.')
    if password != getpass.getpass('Confirm new password: '):
        raise SystemExit('Password unchanged: the two entries did not match.')
    credentials.set_credentials(path, username, password)
    print("Private .env updated. Recreate gateway with the deployment's Compose files to activate it; restart alone does not reload environment variables.")


if __name__ == '__main__':
    main()
