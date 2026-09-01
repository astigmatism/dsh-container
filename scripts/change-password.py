#!/usr/bin/env python3
"""Set Harness gateway credentials without exposing the password in shell history."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import secrets
import tempfile


PROJECT_DIR = Path(__file__).resolve().parent.parent
AUTH_PATH = PROJECT_DIR / "data" / "gateway" / "auth.json"
ENV_PATH = PROJECT_DIR / ".env"
ITERATIONS = 240_000


def configured_username() -> str | None:
    try:
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return None
    for line in lines:
        key, separator, value = line.partition("=")
        if separator and key == "HARNESS_AUTH_USERNAME" and value:
            return value
    return None


def existing_username() -> str | None:
    try:
        record = json.loads(AUTH_PATH.read_text(encoding="utf-8"))
        value = record["username"]
    except (FileNotFoundError, KeyError, json.JSONDecodeError, TypeError):
        return None
    return value if isinstance(value, str) and value else None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Set the gateway username and password before or after deployment."
    )
    parser.add_argument(
        "--username",
        help="Basic Auth username (defaults to the existing identity or .env value)",
    )
    arguments = parser.parse_args()

    username = arguments.username or existing_username() or configured_username()
    if username is None:
        raise SystemExit("No username is configured; pass --username or run configure.sh first.")
    if ":" in username or any(character in username for character in "\r\n"):
        raise SystemExit("Username must not contain a colon or newline.")

    password = getpass.getpass(f"New password for {username}: ")
    if len(password) < 8:
        raise SystemExit("Password unchanged: use at least 8 characters.")
    confirmation = getpass.getpass("Confirm new password: ")
    if password != confirmation:
        raise SystemExit("Password unchanged: the two entries did not match.")

    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        ITERATIONS,
        dklen=32,
    ).hex()
    record = {
        "username": username,
        "salt": salt,
        "iterations": ITERATIONS,
        "hash": digest,
    }

    AUTH_PATH.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".auth.json.", dir=AUTH_PATH.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(record, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, AUTH_PATH)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise

    print("Gateway identity hash updated. Restart the gateway to activate it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
