#!/usr/bin/env python3
"""Copy OpenWebUI's configured OpenAI-compatible STT key into a mode-0600 secret."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sqlite3
import tempfile


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    uri = f"file:{args.database.resolve()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as connection:
        row = connection.execute(
            "SELECT value FROM config WHERE key = ?",
            ("audio.stt.openai.api_key",),
        ).fetchone()
    if row is None:
        raise SystemExit("OpenWebUI has no audio.stt.openai.api_key setting")
    key = json.loads(row[0])
    if not isinstance(key, str) or not key.strip():
        raise SystemExit("OpenWebUI's speech API key is empty")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".stt_api_key.", dir=args.output.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(key.strip())
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, args.output)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise

    print(f"Imported the configured OpenWebUI STT key into {args.output} (value not displayed).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
