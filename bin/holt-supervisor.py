#!/usr/bin/env python3
# SPDX-License-Identifier: FSL-1.1-MIT
"""Small OS lifetime bridge; no repository scanning, policy decisions, or network access.

Linux's subreaper relationship tracks orphaned descendants, including double-forked processes
and processes that create a new session. This is not a PID-name or process-group absence scan.
The private control descriptor is closed in the launched command and every descendant.
"""
import ctypes
import json
import os
import signal
import subprocess
import sys


def linux_subreaper():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong,
                          ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "could not establish child subreaper")
    enabled = ctypes.c_int(0)
    if libc.prctl(37, ctypes.addressof(enabled), 0, 0, 0) != 0 or enabled.value != 1:
        raise OSError(ctypes.get_errno(), "child subreaper verification failed")
    return "linux-subreaper"


def establish_backend():
    if sys.platform.startswith("linux"):
        return linux_subreaper()
    raise OSError("no verified process-tree supervisor is available on this platform")


def main():
    if sys.argv[1:] == ["--probe"]:
        try:
            backend = establish_backend()
            print(json.dumps({"available": True, "backend": backend, "descendants": True}))
        except Exception as error:
            print(json.dumps({"available": False, "reason": str(error)}))
            return 2
        return 0

    if len(sys.argv) < 3 or sys.argv[1] != "--":
        raise ValueError("supervisor requires -- followed by a command")
    control = os.fdopen(3, "w", encoding="utf-8", buffering=1)
    os.set_inheritable(3, False)
    # A separate private descriptor survives a crashed wrapper. Descendants inherit neither
    # channel. Recovery requires this supervisor's complete, synced lifecycle, never PID expiry.
    durable = os.fdopen(4, "w", encoding="utf-8", buffering=1)
    os.set_inheritable(4, False)

    def report(event):
        durable.write(json.dumps(event, separators=(",", ":")) + "\n")
        durable.flush()
        os.fsync(durable.fileno())
        try:
            control.write(json.dumps(event, separators=(",", ":")) + "\n")
            control.flush()
        except BrokenPipeError:
            # A crashed client cannot grant a release. Keep supervising its descendants; its
            # durable pending operation remains available to the recovery workflow.
            pass

    backend = establish_backend()
    report({"type": "ready", "backend": backend})
    child = None
    leader_status = None

    def forward(sig, _frame):
        # The terminal already signals its foreground group. An explicitly signalled wrapper
        # also reaches its direct command here. Never target an already-reaped/reused PID.
        if child is not None and leader_status is None:
            try:
                os.kill(child.pid, sig)
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGINT, forward)
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGHUP, forward)
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    launch_error = None
    try:
        child = subprocess.Popen(sys.argv[2:], close_fds=True)
        report({"type": "started", "pid": child.pid})
    except OSError as error:
        launch_error = str(error)

    reaped = 0
    failed_descendants = 0
    while True:
        try:
            # __WALL includes clone children with non-SIGCHLD termination signals too.
            pid, status = os.waitpid(-1, 0x40000000)
        except InterruptedError:
            continue
        except ChildProcessError:
            break
        reaped += 1
        if child is not None and pid == child.pid:
            leader_status = os.waitstatus_to_exitcode(status)
            child.returncode = leader_status  # prevent Popen from independently reaping again
            report({"type": "leader-exited", "exitCode": leader_status})
        elif os.waitstatus_to_exitcode(status) != 0:
            failed_descendants += 1

    exit_code = 127 if launch_error else leader_status
    if exit_code is None:
        raise RuntimeError("command termination status was not observed")
    report({"type": "drained", "exitCode": exit_code, "reaped": reaped,
            "failedDescendants": failed_descendants, "launchError": launch_error})
    return 128 - exit_code if exit_code < 0 else exit_code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("holt supervisor: " + str(error), file=sys.stderr)
        sys.exit(125)
