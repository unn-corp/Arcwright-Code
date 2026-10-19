#!/usr/bin/env python3
"""Run a command against one owned, socket-only PostgreSQL fixture, then remove it."""

import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile


def main():
    command = sys.argv[1:]
    if command[:1] == ["--"]:
        command = command[1:]
    if not command or os.getuid() == 0:
        raise SystemExit("A test command and an unprivileged user are required.")
    binary = Path(os.environ["RELAY_POSTGRES_BIN"]).resolve(strict=True)
    root = Path(tempfile.mkdtemp(prefix="arcwright-relay-pg-", dir="/tmp")).resolve()
    data, socket = root / "data", root / "socket"
    socket.mkdir(mode=0o700)
    identity = "arcwright_test_" + secrets.token_hex(12)
    password = secrets.token_hex(32)
    password_file = root / "password"
    password_file.write_text(password + "\n")
    password_file.chmod(0o600)
    # Do not pass the job's GitHub/provider credentials to the database process.
    db_env = {"PATH": str(binary) + ":/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(root)}
    child = None
    result = 1

    def interrupt(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    try:
        with (root / "setup.log").open("w") as log:
            subprocess.run(
                [str(binary / "initdb"), "-D", str(data), "-U", identity,
                 "--auth-local=scram-sha-256", "--auth-host=reject",
                 "--locale=C", "--encoding=UTF8", "--pwfile=" + str(password_file)],
                env=db_env, stdout=log, stderr=log, check=True,
            )
            subprocess.run(
                [str(binary / "pg_ctl"), "-D", str(data), "-l", str(root / "postgres.log"),
                 "-w", "-t", "30", "-o", shlex.join([
                     "-c", "listen_addresses=", "-k", str(socket), "-p", "5432",
                     "-c", "unix_socket_permissions=0700",
                 ]), "start"],
                env=db_env, stdout=log, stderr=log, check=True,
            )
            subprocess.run(
                [str(binary / "createdb"), "-h", str(socket), "-U", identity, identity],
                env={**db_env, "PGPASSWORD": password}, stdout=log, stderr=log, check=True,
            )
        receipt = root / "connection.json"
        receipt.write_text(json.dumps({
            "kind": "owned-native-postgres-v1", "fixtureOnly": True, "productionTarget": False,
            "rootDirectory": str(root), "dataDirectory": str(data), "host": str(socket),
            "port": 5432, "database": identity, "username": identity, "password": password,
            "ownerUid": os.getuid(), "postmasterPid": int((data / "postmaster.pid").read_text().splitlines()[0]),
        }))
        receipt.chmod(0o600)
        print("[relay-postgres] Owned PostgreSQL fixture ready; TCP disabled.", flush=True)
        child = subprocess.Popen(command, env={
            **os.environ, "RELAY_ACCOUNT_DELETION_TEST_FIXTURE_FILE": str(receipt),
        }, start_new_session=True)
        result = child.wait()
    except KeyboardInterrupt:
        result = 130
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        if (data / "postmaster.pid").exists():
            stopped = subprocess.run(
                [str(binary / "pg_ctl"), "-D", str(data), "-m", "immediate", "-w", "-t", "15", "stop"],
                env=db_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            if stopped.returncode != 0:
                raise RuntimeError("Owned PostgreSQL fixture could not stop; data retained.")
        shutil.rmtree(root)
    return result if result >= 0 else 128 - result


if __name__ == "__main__":
    sys.exit(main())
