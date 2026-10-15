#!/usr/bin/env python3
"""Fixed RPC inside a disposable native package-validation guest; never deployed to user devices."""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import struct
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from bounded_process import bounded_run, stop_group

INPUT = Path('/home/t3-package/input/package.deb')

def run(argv, **options):
    result = bounded_run(argv, timeout=120, **options)
    if result.returncode:
        raise RuntimeError(f'{Path(argv[0]).name} failed ({result.returncode}): {result.stderr.decode(errors="replace")[-4000:]}')
    if len(result.stdout) > 4 * 1024 * 1024:
        raise RuntimeError('Guest command output exceeded its bound')
    return result.stdout.decode()

def package_name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z0-9][a-z0-9+.-]{0,127}', value):
        raise ValueError('Invalid Debian package name')
    return value

def server_entry(resources):
    entries = []
    for name in ['server.asar', 'app.asar']:
        archive = resources / name
        if not archive.is_file():
            continue
        with archive.open('rb') as source:
            prefix = source.read(16)
            if len(prefix) != 16:
                raise RuntimeError('Truncated installed ASAR header')
            size_pickle, header_size, _, json_size = struct.unpack('<4I', prefix)
            if size_pickle != 4 or not 2 <= json_size <= 32 * 1024 * 1024 or header_size < json_size + 8:
                raise RuntimeError('Invalid installed ASAR header bound')
            node = json.loads(source.read(json_size))
        for part in ['apps', 'server', 'dist', 'bin.mjs']:
            node = node.get('files', {}).get(part, {})
        if node.get('size', 0) > 0:
            if not node.get('unpacked') and 8 + header_size + int(node['offset']) + node['size'] > archive.stat().st_size:
                raise RuntimeError('Installed server entry exceeds its ASAR archive')
            entries.append(archive / 'apps/server/dist/bin.mjs')
    if len(entries) != 1:
        raise RuntimeError('Installed package has no unique supported server entry')
    return entries[0]

def probe(name, version):
    files = run(['/usr/bin/dpkg-query', '-L', name]).splitlines()
    executables = [Path(p) for p in files if p.startswith('/opt/') and Path(p).name == 't3code']
    if len(executables) != 1 or not executables[0].is_file():
        raise RuntimeError('Installed package has no unique native executable')
    executable = executables[0]
    entry = server_entry(executable.parent / 'resources')
    with tempfile.TemporaryDirectory(prefix='native-deb-probe-', dir='/home/t3-package') as scratch:
        env = {'PATH': '/usr/bin:/bin', 'HOME': scratch, 'ELECTRON_RUN_AS_NODE': '1',
               'T3CODE_HOME': scratch + '/data', 'T3CODE_MAINTENANCE_NAMESPACE': scratch + '/coordinator',
               'XDG_CONFIG_HOME': scratch + '/config', 'XDG_CACHE_HOME': scratch + '/cache'}
        output = run([str(executable), str(entry), '--version'], env=env)
        if version.replace('~', '-') not in output:
            raise RuntimeError(f'Installed CLI reports {output.strip()}, expected {version}')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        child = subprocess.Popen([str(executable), str(entry), 'serve', '--host', '127.0.0.1', '--port', str(port), '--no-browser'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    raise RuntimeError('Installed native CLI exited before readiness')
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/.well-known/t3/environment', timeout=1) as response:
                        if response.status == 200:
                            return {'uid': os.getuid(), 'version': output.strip(), 'httpStatus': 200}
                except OSError:
                    time.sleep(.2)
            raise RuntimeError('Installed native CLI did not become ready within sixty seconds')
        finally:
            stop_group(child)

def main():
    action = sys.argv[1] if len(sys.argv) == 2 else ''
    if os.getuid() != (0 if action == 'install' else 1001) or sys.platform != 'linux':
        raise RuntimeError('Native package probes require real guest UID 1001; only dpkg uses root')
    if action == 'receive':
        INPUT.parent.mkdir(mode=0o700, exist_ok=True)
        digest = hashlib.sha256()
        size = 0
        fd = os.open(INPUT, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as target:
            while chunk := sys.stdin.buffer.read(1024 * 1024):
                size += len(chunk)
                if size > 1024 * 1024 * 1024:
                    raise RuntimeError('Debian payload exceeded one GiB')
                target.write(chunk)
                digest.update(chunk)
            target.flush()
            os.fsync(target.fileno())
        return {'sha256': digest.hexdigest(), 'bytes': size}
    request = json.load(sys.stdin)
    if action == 'hello':
        return {'uid': os.getuid(), 'platform': sys.platform, 'protocol': 1,
                'helperSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'readOnlyHelper': bool(os.statvfs(Path(__file__)).f_flag & os.ST_RDONLY)}
    if action == 'info':
        raw = run(['/usr/bin/dpkg-deb', '-f', str(INPUT), 'Package', 'Version'])
        fields = dict(line.split(': ', 1) for line in raw.splitlines())
        return {'name': package_name(fields['Package']), 'version': fields['Version']}
    if action == 'install':
        with INPUT.open('rb') as source:
            actual = hashlib.file_digest(source, 'sha256').hexdigest()
        if actual != request.get('sha256'):
            raise RuntimeError('Guest Debian payload changed before install')
        run(['/usr/bin/dpkg', '-i', str(INPUT)])
        return True
    name = package_name(request.get('name')) if action in ('version', 'files', 'probe') else None
    if action == 'version':
        result = bounded_run(['/usr/bin/dpkg-query', '-W', '-f=${Version}', name], timeout=10)
        return result.stdout.decode().strip() if result.returncode == 0 else None
    if action == 'files':
        return run(['/usr/bin/dpkg-query', '-L', name]).splitlines()
    if action == 'read':
        path = request.get('path', '')
        if not isinstance(path, str) or not path.startswith('/opt/') or not path.endswith('/resources/package-type') or '\0' in path:
            raise ValueError('Invalid package marker path')
        if Path(path).stat().st_size > 1024:
            raise ValueError('Oversized package marker')
        return Path(path).read_text()
    if action == 'probe':
        version = request.get('version')
        if not isinstance(version, str) or not re.fullmatch(r'[0-9A-Za-z.+:~_-]{1,150}', version):
            raise ValueError('Invalid package version')
        return probe(name, version)
    raise ValueError('Unknown guest operation')

if __name__ == '__main__':
    for received in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(received, lambda *_: sys.exit(143))
    try:
        print(json.dumps({'result': main()}))
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
