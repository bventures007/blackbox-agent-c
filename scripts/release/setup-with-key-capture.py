#!/usr/bin/env python3
"""Run `./blackbox setup` under a pseudo-terminal, capture the owner key that setup prints exactly once
into a 0600 file, and write a transcript with the key redacted (evidence for INSTALL-01 / DIST-02).

    setup-with-key-capture.py <install-dir> <key-file> <transcript-file> [extra setup args...]

The key never appears on this script's stdout or in the transcript. Exit code = setup's exit code.
"""
import os
import pty
import re
import select
import subprocess
import sys

KEY_RE = re.compile(rb"bbk_[A-Za-z0-9_-]{20,}")


def main() -> int:
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    install_dir, key_file, transcript = sys.argv[1:4]
    extra = sys.argv[4:]
    master, slave = pty.openpty()
    proc = subprocess.Popen(["./blackbox", "setup", *extra], cwd=install_dir, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    buf = b""
    while True:
        r, _, _ = select.select([master], [], [], 1.0)
        if master in r:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            # progress lines (redacted) so a watcher sees phases without the key
            sys.stdout.write(KEY_RE.sub(b"bbk_<redacted>", chunk).decode("utf-8", "replace"))
            sys.stdout.flush()
        if proc.poll() is not None and not r:
            break
    proc.wait()
    keys = KEY_RE.findall(buf)
    if keys:
        fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(keys[-1] + b"\n")
        os.chmod(key_file, 0o600)
    with open(transcript, "wb") as f:
        f.write(KEY_RE.sub(b"bbk_<redacted>", buf))
    print(f"\nsetup exit code {proc.returncode}; owner key {'captured to ' + key_file + ' (0600)' if keys else 'NOT found in output'}; transcript (redacted): {transcript}")
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
