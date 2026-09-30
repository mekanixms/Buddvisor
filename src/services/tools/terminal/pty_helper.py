#!/usr/bin/env python3
"""
PTY bridge for the `terminal` agent tool (Linux and macOS).

Usage: pty_helper.py COLS ROWS -- CMD [ARGS...]

Runs CMD attached to a fresh pseudo-terminal and relays bytes between this
process's stdin/stdout and the PTY master. Uses only the Python standard
library so the Node app needs no native PTY module.

The PTY starts with echo disabled so typed input does not come back as output.
When stdin reaches EOF or this process gets SIGTERM/SIGHUP, the child's session
is hung up and, if it does not exit promptly, killed.
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

READ_CHUNK = 65536
POLL_SECONDS = 0.25
GRACE_SECONDS = 1.5

stop_requested = False


def request_stop(_signum, _frame):
    global stop_requested
    stop_requested = True


def set_winsize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def disable_echo(fd):
    attrs = termios.tcgetattr(fd)
    attrs[3] &= ~(termios.ECHO | termios.ECHOE | termios.ECHOK | termios.ECHONL)
    termios.tcsetattr(fd, termios.TCSANOW, attrs)


def child_exit_code(status):
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


def reap(pid, block_seconds):
    deadline = time.time() + block_seconds
    while True:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            return status
        if time.time() >= deadline:
            return None
        time.sleep(0.05)


def terminate(pid):
    """Hang up the child's session, then kill its process group if it lingers."""
    for sig in (signal.SIGHUP, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except (ProcessLookupError, PermissionError):
            pass
        status = reap(pid, GRACE_SECONDS if sig == signal.SIGHUP else 1.0)
        if status is not None:
            return status
    return 0


def main():
    if len(sys.argv) < 5 or sys.argv[3] != "--":
        sys.stderr.write("usage: pty_helper.py COLS ROWS -- CMD [ARGS...]\n")
        return 2

    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[4:]

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGHUP, request_stop)

    pid, master = pty.fork()
    if pid == 0:
        try:
            disable_echo(0)
            os.execvp(argv[0], argv)
        except OSError as exc:
            sys.stderr.write("exec failed: %s\n" % exc)
        os._exit(127)

    set_winsize(master, rows, cols)
    os.set_blocking(master, False)
    os.set_blocking(0, False)
    os.set_blocking(1, True)

    pending_input = b""
    stdin_open = True
    status = None

    while not stop_requested:
        readers = [master]
        writers = []
        if stdin_open:
            readers.append(0)
        if pending_input:
            writers.append(master)

        try:
            ready_r, ready_w, _ = select.select(readers, writers, [], POLL_SECONDS)
        except InterruptedError:
            continue

        if master in ready_r:
            try:
                data = os.read(master, READ_CHUNK)
            except OSError as exc:
                if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    data = None
                else:
                    data = b""
            if data == b"":
                break
            if data:
                os.write(1, data)

        if stdin_open and 0 in ready_r:
            try:
                chunk = os.read(0, READ_CHUNK)
            except OSError as exc:
                chunk = None if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK) else b""
            if chunk == b"":
                stdin_open = False
                break
            if chunk:
                pending_input += chunk

        if pending_input and master in ready_w:
            try:
                written = os.write(master, pending_input)
                pending_input = pending_input[written:]
            except OSError as exc:
                if exc.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                    break

        done, st = os.waitpid(pid, os.WNOHANG)
        if done:
            status = st
            while True:
                try:
                    data = os.read(master, READ_CHUNK)
                except OSError:
                    break
                if not data:
                    break
                os.write(1, data)
            break

    if status is None:
        status = terminate(pid)
    else:
        try:
            os.killpg(pid, signal.SIGHUP)
        except (ProcessLookupError, PermissionError):
            pass

    try:
        os.close(master)
    except OSError:
        pass
    return child_exit_code(status)


if __name__ == "__main__":
    sys.exit(main())
