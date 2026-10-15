"""Bounded subprocess IO and teardown for disposable native package checks."""
import os
import selectors
import signal
import subprocess
import tempfile
import time


def stop_group(child):
    # This new session/group was captured at spawn; it contains no unrelated jobs.
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    # The direct child can exit while a descendant ignores TERM. Retire the
    # captured group even in that case, before considering teardown complete.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait(timeout=5)


def bounded_run(argv, *, input=None, stdin=None, env=None, timeout=120, max_output=4 * 1024 * 1024):
    if input is not None and stdin is not None:
        raise ValueError('Choose input bytes or an input file')
    with tempfile.TemporaryFile() as request:
        if input is not None:
            request.write(input)
            request.seek(0)
        child = subprocess.Popen(argv, stdin=stdin if stdin is not None else request,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env=env, start_new_session=True)
        output, errors = bytearray(), bytearray()
        deadline = time.monotonic() + timeout
        try:
            with selectors.DefaultSelector() as events:
                events.register(child.stdout, selectors.EVENT_READ, output)
                events.register(child.stderr, selectors.EVENT_READ, errors)
                while events.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(argv, timeout)
                    for event, _ in events.select(min(remaining, .25)):
                        chunk = os.read(event.fileobj.fileno(), 64 * 1024)
                        if not chunk:
                            events.unregister(event.fileobj)
                            continue
                        if len(output) + len(errors) + len(chunk) > max_output:
                            raise RuntimeError('Package-check subprocess output exceeded its bound')
                        event.data.extend(chunk)
            code = child.wait(timeout=max(.01, deadline - time.monotonic()))
            return subprocess.CompletedProcess(argv, code, bytes(output), bytes(errors))
        finally:
            stop_group(child)
            child.stdout.close()
            child.stderr.close()
