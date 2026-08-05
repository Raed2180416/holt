#!/usr/bin/env python3
# SPDX-License-Identifier: FSL-1.1-MIT
"""Drive the installed Holt TUI through a real PTY without an internal watchdog.

Each redraw begins with Holt's clear/home sequence. The next redraw is therefore an exact frame
delimiter; no timing heuristic is used. A stalled or incomplete product stalls this driver until
the operator/test runner cancels it externally, which is the benchmark's no-internal-limit rule.
"""

import argparse
import base64
import errno
import fcntl
import json
import os
import signal
import struct
import subprocess
import sys
import termios
import tty


CLEAR_HOME = b"\x1b[2J\x1b[H"


def resize(fd, columns, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


def parse_args():
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--holt-bin", required=True)
    parser.add_argument("--cwd", required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    master, slave = os.openpty()
    tty.setraw(slave)
    resize(slave, 120, 36)
    child = subprocess.Popen(
        [args.holt_bin, "tui", "--cwd", args.cwd],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=os.environ.copy(),
        close_fds=True,
    )
    os.close(slave)
    transcript = bytearray()

    def read_more():
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                raise RuntimeError("TUI PTY closed before the expected redraw") from error
            raise
        if not chunk:
            raise RuntimeError("TUI PTY reached EOF before the expected redraw")
        transcript.extend(chunk)

    def marker_positions():
        positions = []
        at = 0
        while True:
            found = transcript.find(CLEAR_HOME, at)
            if found < 0:
                return positions
            positions.append(found)
            at = found + len(CLEAR_HOME)

    def wait_for_markers(count):
        while True:
            positions = marker_positions()
            if len(positions) >= count:
                return positions
            read_more()

    def send(value):
        os.write(master, value)

    frames = []
    stages = [
        ("initial-all-120x36", b"f", 120, 36),
        ("filter-atRisk-120x36", b"j", 120, 36),
        ("filter-atRisk-move-j-120x36", b"f", 120, 36),
        ("filter-holds-120x36", b"f", 120, 36),
        ("filter-unknown-empty-120x36", b"f", 120, 36),
    ]

    # One marker establishes that the initial draw began. The write containing the rest of that
    # frame was queued before Node can process the key, so the next marker delimits it exactly.
    wait_for_markers(1)
    for index, (name, key, columns, rows) in enumerate(stages, start=1):
        send(key)
        positions = wait_for_markers(index + 1)
        start = positions[index - 1] + len(CLEAR_HOME)
        end = positions[index]
        frames.append({
            "name": name,
            "columns": columns,
            "rows": rows,
            "rawBase64": base64.b64encode(bytes(transcript[start:end])).decode("ascii"),
        })

    # The fifth key above moved unknown -> disposable. Capture that full-size state first.  This
    # is deliberately an unbound key: the next clear/home marker delimits the prior frame without
    # changing the selected item or filter.
    send(b"x")
    positions = wait_for_markers(7)
    frames.append({
        "name": "filter-disposable-120x36",
        "columns": 120,
        "rows": 36,
        "rawBase64": base64.b64encode(bytes(
            transcript[positions[5] + len(CLEAR_HOME):positions[6]]
        )).decode("ascii"),
    })

    # The product redraws on stdout's resize event.  Wait for that exact redraw before sending a
    # navigation key; this eliminates the old race where SIGWINCH and `j` could be processed in
    # either order and a supposedly 80x20 capture still held a 120x36 frame.
    resize(master, 80, 20)
    os.kill(child.pid, signal.SIGWINCH)
    positions = wait_for_markers(8)

    send(b"j")
    positions = wait_for_markers(9)
    # An unbound key redraws without changing state and delimits the measured resized frame.
    send(b"x")
    positions = wait_for_markers(10)
    frames.append({
        "name": "filter-disposable-resized-move-j-80x20",
        "columns": 80,
        "rows": 20,
        "rawBase64": base64.b64encode(bytes(
            transcript[positions[8] + len(CLEAR_HOME):positions[9]]
        )).decode("ascii"),
    })

    send(b"q")
    while True:
        try:
            chunk = os.read(master, 65536)
            if not chunk:
                break
            transcript.extend(chunk)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
    os.close(master)
    exit_code = child.wait()
    if exit_code != 0:
        raise RuntimeError(f"installed TUI exited {exit_code}")

    json.dump({
        "schema": "holt-installed-tui-pty-v1",
        "exitCode": exit_code,
        "keys": ["f", "j", "f", "f", "f", "x", "resize:80x20", "j", "x", "q"],
        "frames": frames,
        "transcriptBase64": base64.b64encode(bytes(transcript)).decode("ascii"),
    }, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
