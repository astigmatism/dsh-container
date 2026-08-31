#!/usr/bin/env python3
"""Replace the Harness gateway password without exposing it in shell history."""

from __future__ import annotations

import getpass
import hashlib
import json
import os
from pathlib import Path
import secrets
import tempfile


AUTH_PATH = Path(__file__).resolve().parent.parent / "data" / "gateway" / "auth.json"
ITERATIONS = 240_000


def main() -> int:
    try:
        current = json.loads(AUTH_PATH.read_text(encoding="utf-8"))
        username = current["username"]
    except (FileNotFoundError, KeyError, json.JSONDecodeError) as error:
        raise SystemExit(f"Cannot read the existing gateway identity at {AUTH_PATH}: {error}")

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

    print("Password hash updated. Restart the gateway to activate it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
