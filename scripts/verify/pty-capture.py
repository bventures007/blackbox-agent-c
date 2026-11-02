#!/usr/bin/env python3
"""Run a host command under a pseudo-terminal, capture any once-shown key (bbk_ owner key / AGE recovery identity)
into 0600 files, and write a transcript with every key redacted (generalisation of scripts/release/setup-with-key-capture.py).

    pty-capture.py <cwd> <owner-key-file-or-"-"> <transcript> -- <command> [args...]

Exit code = the command's exit code. Nothing secret is printed to stdout.
"""
import os, pty, re, select, subprocess, sys
OWNER_RE = re.compile(rb"bbk_[A-Za-z0-9_-]{20,}")
AGE_RE = re.compile(rb"AGE-SECRET-KEY-1[A-Z0-9]{10,}")

def main() -> int:
    sep = sys.argv.index("--")
    cwd, keyfile, transcript = sys.argv[1:sep][:3]
    cmd = sys.argv[sep + 1:]
    master, slave = pty.openpty()
    proc = subprocess.Popen(cmd, cwd=cwd, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
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
        if proc.poll() is not None and not r:
            break
    proc.wait()
    keys = OWNER_RE.findall(buf)
    if keys and keyfile != "-":
        fd = os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(keys[-1] + b"\n")
        os.chmod(keyfile, 0o600)
    red = AGE_RE.sub(b"AGE-SECRET-KEY-1<redacted>", OWNER_RE.sub(b"bbk_<redacted>", buf))
    with open(transcript, "wb") as f:
        f.write(red)
    print(f"command exit {proc.returncode}; owner key {'captured' if keys else 'not shown'}; transcript (redacted): {transcript}")
    return proc.returncode

if __name__ == "__main__":
    sys.exit(main())
