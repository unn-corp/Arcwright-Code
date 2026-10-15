#!/usr/bin/env python3
"""Run real Debian package gates in a disposable KVM guest without privileged job containers."""
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid

sys.path.insert(0, "/usr/local/lib/t3-ci")
from bounded_process import bounded_run, stop_group

BASE = Path('/opt/t3-ci/linux-package-vm')
GUEST_HELPER = '/opt/t3-validation-helper/deb-guest.py'

def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as source:
        while chunk := source.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()

def run(argv, **options):
    options.setdefault('env', {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'TMPDIR': tempfile.gettempdir()})
    return subprocess.run(argv, check=True, timeout=120, **options)

def check_base():
    manifest = json.loads((BASE / 'manifest.json').read_text())
    image = BASE / 'base.qcow2'
    if image.is_symlink() or image.stat().st_uid != 0 or image.stat().st_mode & 0o222:
        raise RuntimeError('Package guest base must be root-owned and immutable')
    if manifest.get('protocol') != 1 or digest(image) != manifest.get('sha256'):
        raise RuntimeError('Package guest base digest verification failed')
    for command in ['/usr/bin/qemu-system-x86_64', '/usr/bin/qemu-img', '/usr/bin/genisoimage', '/usr/bin/ssh', '/usr/bin/ssh-keygen']:
        if not os.access(command, os.X_OK):
            raise RuntimeError(f'Missing trusted package guest tool: {command}')
    helper = BASE / 'helpers'
    for name, checksum in manifest['helpers'].items():
        file = helper / name
        if file.is_symlink() or file.stat().st_uid != 0 or file.stat().st_mode & 0o222 or digest(file) != checksum:
            raise RuntimeError('Trusted guest helper digest/ownership check failed')
    return image, manifest

def ssh(config, action, request=None, source=None):
    if action not in ('hello', 'receive', 'info', 'install', 'version', 'files', 'read', 'probe'):
        raise ValueError('Invalid guest action')
    argv = ['/usr/bin/ssh', '-F', '/dev/null', '-i', config['key'], '-p', str(config['port']),
            '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + config['knownHosts'],
            '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=3',
            '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3',
            't3-package@127.0.0.1', ('/usr/bin/sudo -n ' if action == 'install' else '') + '/usr/bin/python3 ' + GUEST_HELPER + ' ' + action]
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(Path(config['key']).parent), 'LC_ALL': 'C'}
    if source is not None:
        with Path(source).open('rb') as payload:
            result = bounded_run(argv, stdin=payload, timeout=300, env=env)
    else:
        result = bounded_run(argv, input=json.dumps(request or {}).encode(), timeout=180, env=env)
    if len(result.stdout) > 4 * 1024 * 1024:
        raise RuntimeError('Guest RPC output exceeded its bound')
    if result.returncode:
        raise RuntimeError('Package guest RPC failed: ' + (result.stdout + result.stderr).decode(errors='replace')[-5000:])
    reply = json.loads(result.stdout)
    if 'error' in reply:
        raise RuntimeError(reply['error'])
    return reply['result']

def tool(config_path, action, arguments):
    path = Path(config_path)
    if path.is_symlink() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise RuntimeError('Package VM connection record is not private')
    config = json.loads(path.read_text())
    if ssh(config, 'hello') != config.get('identity'):
        raise RuntimeError('Native guest helper identity/read-only media verification changed')
    if action in ('info', 'install'):
        payload = Path(arguments[0]).resolve(strict=True)
        expected = digest(payload)
        if config.get('uploadedSha256') != expected:
            copied = ssh(config, 'receive', source=payload)
            if copied != {'sha256': expected, 'bytes': payload.stat().st_size}:
                raise RuntimeError('Guest Debian payload transfer did not match the source')
            config['uploadedSha256'] = expected
            path.write_text(json.dumps(config))
        if action == 'info':
            result = ssh(config, 'info')
        else:
            result = ssh(config, 'install', {'sha256': expected})
    elif action == 'read':
        result = ssh(config, action, {'path': arguments[0]})
    elif action in ('version', 'files'):
        result = ssh(config, action, {'name': arguments[0]})
    elif action == 'probe':
        result = ssh(config, action, {'name': arguments[0], 'version': arguments[1]})
    else:
        raise ValueError('Invalid package tool operation')
    print(json.dumps(result))

def seed(directory, config):
    for name in ['client-key', 'host-key']:
        run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(directory / name)])
    host_public = (directory / 'host-key.pub').read_text().strip()
    Path(config['knownHosts']).write_text(f'[127.0.0.1]:{config["port"]} {host_public}\n')
    userdata = {
        'users': [{'name': 't3-package', 'uid': 1001, 'lock_passwd': True, 'sudo': 'ALL=(ALL) NOPASSWD:ALL',
                   'ssh_authorized_keys': [(directory / 'client-key.pub').read_text().strip()]}],
        'disable_root': True, 'ssh_pwauth': False, 'ssh_deletekeys': True,
        'mounts': [['/dev/disk/by-label/T3HELPER', '/opt/t3-validation-helper', 'iso9660', 'ro,nosuid,nodev,noexec', '0', '0']],
        'ssh_keys': {'ed25519_private': (directory / 'host-key').read_text(), 'ed25519_public': host_public},
    }
    (directory / 'user-data').write_text('#cloud-config\n' + json.dumps(userdata))
    (directory / 'meta-data').write_text(json.dumps({'instance-id': 't3-deb-' + str(uuid.uuid4()), 'local-hostname': 't3-deb-validation'}))
    run(['/usr/bin/genisoimage', '-quiet', '-output', str(directory / 'seed.iso'), '-volid', 'cidata', '-joliet', '-rock', str(directory / 'user-data'), str(directory / 'meta-data')])
    run(['/usr/bin/genisoimage', '-quiet', '-output', str(directory / 'helpers.iso'), '-volid', 'T3HELPER', '-joliet', '-rock', str(BASE / 'helpers')])

def execute(command):
    image, manifest = check_base()
    if os.getuid() != 1001 or not os.access('/dev/kvm', os.R_OK | os.W_OK):
        raise RuntimeError('Package guest requires the unprivileged KVM-enabled CI worker')
    with tempfile.TemporaryDirectory(prefix='t3-native-deb-vm-') as scratch:
        directory = Path(scratch)
        os.chmod(directory, 0o700)
        if ',' in str(directory):
            raise RuntimeError('Unsupported QEMU temporary path')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        config = {'key': str(directory / 'client-key'), 'knownHosts': str(directory / 'known_hosts'), 'port': port,
                  'identity': {'uid': 1001, 'platform': 'linux', 'protocol': 1, 'helperSha256': manifest['helpers']['deb-guest.py'], 'readOnlyHelper': True}}
        seed(directory, config)
        overlay = directory / 'disk.qcow2'
        run(['/usr/bin/qemu-img', 'create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', str(image), str(overlay)])
        run(['/usr/bin/qemu-img', 'resize', '-q', str(overlay), '24G'])
        config_path = directory / 'connection.json'
        config_path.write_text(json.dumps(config))
        os.chmod(config_path, 0o600)
        with (directory / 'boot.log').open('wb') as log:
            vm = subprocess.Popen(['/usr/bin/qemu-system-x86_64', '-no-user-config', '-nodefaults', '-machine', 'q35,accel=kvm', '-cpu', 'host', '-smp', '2', '-m', '4096',
                '-display', 'none', '-monitor', 'none', '-serial', 'stdio',
                '-drive', f'file={overlay},format=qcow2,if=virtio', '-drive', f'file={directory / "seed.iso"},format=raw,media=cdrom,readonly=on',
                '-drive', f'file={directory / "helpers.iso"},format=raw,media=cdrom,readonly=on',
                '-device', 'virtio-net-pci,netdev=net0', '-netdev', f'user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:{port}-:22',
                '-sandbox', 'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny'], stdout=log, stderr=log,
                env={'PATH': '/usr/bin:/bin', 'HOME': str(directory), 'TMPDIR': str(directory), 'LC_ALL': 'C'})
            try:
                deadline = time.monotonic() + 180
                while True:
                    if vm.poll() is not None:
                        raise RuntimeError('Package guest exited during boot: ' + (directory / 'boot.log').read_text(errors='replace')[-4000:])
                    try:
                        hello = ssh(config, 'hello')
                        if hello != config['identity']:
                            raise RuntimeError('Unexpected native guest identity')
                        break
                    except (RuntimeError, subprocess.TimeoutExpired):
                        if time.monotonic() >= deadline:
                            raise RuntimeError('Package guest did not become ready: ' + (directory / 'boot.log').read_text(errors='replace')[-4000:])
                        time.sleep(1)
                print('[t3-package-vm] Verified native guest, UID1001, base SHA256 ' + manifest['sha256'], flush=True)
                env = {**os.environ, 'T3_FORK_DEB_VM_CONFIG': str(config_path)}
                child = subprocess.Popen(command, env=env, start_new_session=True)
                try:
                    return child.wait(timeout=1800)
                finally:
                    stop_group(child)
            finally:
                if vm.poll() is None:
                    vm.terminate()
                    try:
                        vm.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        vm.kill()
                        vm.wait(timeout=10)

if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['preflight']:
            check_base()
        elif len(sys.argv) >= 5 and sys.argv[1] == 'tool':
            tool(sys.argv[2], sys.argv[3], sys.argv[4:])
        elif len(sys.argv) >= 4 and sys.argv[1:3] == ['run', '--']:
            signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
            sys.exit(execute(sys.argv[3:]))
        else:
            raise ValueError('Usage: package-vm.py preflight | run -- COMMAND... | tool CONFIG ACTION ARG...')
    except Exception as error:
        print('[t3-package-vm] ' + str(error), file=sys.stderr)
        sys.exit(1)
