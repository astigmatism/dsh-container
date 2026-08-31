#!/usr/bin/env python3
"""Atomically record one deployment mode without exposing other .env values."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


MODE_PATTERN = re.compile(rb"(?m)^DSH_DEPLOYMENT_MODE=([^\r\n]*)(\r?)$")
UID_PATTERN = re.compile(rb"(?m)^HOST_UID=([^\r\n]*)(\r?)$")
GID_PATTERN = re.compile(rb"(?m)^HOST_GID=([^\r\n]*)(\r?)$")


def fail(message: str) -> "NoReturn":
    raise RuntimeError(message)


def single_numeric(data: bytes, pattern: re.Pattern[bytes], name: str) -> int:
    matches = list(pattern.finditer(data))
    if len(matches) != 1:
        fail(f"{name} must occur exactly once in .env")
    value = matches[0].group(1)
    if not value or not value.isdigit():
        fail(f"{name} must be numeric in .env")
    return int(value)


def checked_stat(path: Path, expected_uid: int | None = None, expected_gid: int | None = None) -> os.stat_result:
    current = path.lstat()
    if not stat.S_ISREG(current.st_mode) or path.is_symlink():
        fail(".env must be a regular, non-symlink file")
    if stat.S_IMODE(current.st_mode) != 0o600:
        fail(".env mode must be exactly 0600")
    if expected_uid is not None and current.st_uid != expected_uid:
        fail(".env owner must equal HOST_UID")
    if expected_gid is not None and current.st_gid != expected_gid:
        fail(".env group must equal HOST_GID")
    return current


def record_mode(env_file: Path, requested_mode: str) -> None:
    if not env_file.is_absolute():
        env_file = Path.cwd() / env_file
    env_file = env_file.absolute()
    lock_dir = env_file.parent / ".env.deployment-mode.lock"
    try:
        lock_dir.mkdir(mode=0o700)
    except FileExistsError:
        fail(f"another deployment-mode update may be active: {lock_dir}")

    temporary_name: str | None = None
    try:
        initial_stat = checked_stat(env_file)
        original = env_file.read_bytes()
        expected_uid = single_numeric(original, UID_PATTERN, "HOST_UID")
        expected_gid = single_numeric(original, GID_PATTERN, "HOST_GID")
        checked_stat(env_file, expected_uid, expected_gid)

        matches = list(MODE_PATTERN.finditer(original))
        if len(matches) > 1:
            fail("DSH_DEPLOYMENT_MODE must not be duplicated")

        requested = requested_mode.encode("ascii")
        if matches:
            existing = matches[0].group(1)
            if existing == requested:
                print(f"Deployment mode is already recorded as {requested_mode}.")
                return
            if existing:
                fail("DSH_DEPLOYMENT_MODE conflicts with the requested deployment mode")
            value_start, value_end = matches[0].span(1)
            updated = original[:value_start] + requested + original[value_end:]
        else:
            if original and not original.endswith(b"\n"):
                separator = b"\r\n" if original.count(b"\r\n") == original.count(b"\n") and b"\n" in original else b"\n"
            else:
                separator = b""
            line_ending = b"\r\n" if original.count(b"\r\n") == original.count(b"\n") and b"\n" in original else b"\n"
            updated = original + separator + b"DSH_DEPLOYMENT_MODE=" + requested + line_ending

        resulting_matches = list(MODE_PATTERN.finditer(updated))
        if len(resulting_matches) != 1 or resulting_matches[0].group(1) != requested:
            fail("could not prepare exactly one requested deployment-mode entry")

        descriptor, temporary_name = tempfile.mkstemp(prefix=".env.", dir=env_file.parent)
        try:
            with os.fdopen(descriptor, "wb") as temporary:
                temporary.write(updated)
                temporary.flush()
                os.fchmod(temporary.fileno(), 0o600)
                if os.fstat(temporary.fileno()).st_uid != expected_uid or os.fstat(temporary.fileno()).st_gid != expected_gid:
                    os.fchown(temporary.fileno(), expected_uid, expected_gid)
                os.fsync(temporary.fileno())

            current_stat = checked_stat(env_file, expected_uid, expected_gid)
            if (
                current_stat.st_dev,
                current_stat.st_ino,
                current_stat.st_size,
                current_stat.st_mtime_ns,
            ) != (
                initial_stat.st_dev,
                initial_stat.st_ino,
                initial_stat.st_size,
                initial_stat.st_mtime_ns,
            ) or env_file.read_bytes() != original:
                fail(".env changed during the deployment-mode update")

            os.replace(temporary_name, env_file)
            temporary_name = None
            directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
            directory_fd = os.open(env_file.parent, directory_flags)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)

            final_stat = checked_stat(env_file, expected_uid, expected_gid)
            final_data = env_file.read_bytes()
            final_matches = list(MODE_PATTERN.finditer(final_data))
            if len(final_matches) != 1 or final_matches[0].group(1) != requested:
                fail("deployment-mode verification failed after atomic replacement")
            if final_stat.st_uid != initial_stat.st_uid or final_stat.st_gid != initial_stat.st_gid:
                fail(".env ownership changed during the deployment-mode update")
        finally:
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass

        print(f"Recorded DSH_DEPLOYMENT_MODE={requested_mode} atomically.")
    finally:
        try:
            lock_dir.rmdir()
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("external", "remote", "managed"))
    parser.add_argument(
        "--env-file",
        type=Path,
        default=Path(__file__).resolve().parent.parent / ".env",
    )
    args = parser.parse_args()
    try:
        record_mode(args.env_file, args.mode)
    except (OSError, RuntimeError) as error:
        print(f"Deployment mode was not changed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
