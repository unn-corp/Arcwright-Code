#!/usr/bin/env python3
"""Provision the immutable native Debian-validation guest during trusted runner-image build."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path('/opt/t3-ci/linux-package-vm')
SOURCE = 'https://cloud-images.ubuntu.com/noble/20260926/noble-server-cloudimg-amd64.img'
SOURCE_SHA256 = '6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2'
SNAPSHOT = '20261014T000000Z'

def run(argv, **options):
    return subprocess.run(argv, check=True, timeout=120, **options)

def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()

def main():
    if os.getuid() != 0:
        raise RuntimeError('Build only in the trusted runner-image construction step')
    ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='t3-package-base-') as scratch:
        directory = Path(scratch)
        original = directory / 'ubuntu.qcow2'
        print('Downloading pinned Ubuntu package-validation base', flush=True)
        started, size = time.monotonic(), 0
        with urllib.request.urlopen(SOURCE, timeout=60) as source, original.open('wb') as target:
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                if size > 2 * 1024 * 1024 * 1024 or time.monotonic() - started > 600:
                    raise RuntimeError('Ubuntu cloud-image download exceeded its size/time bound')
                target.write(chunk)
        print(f'Downloaded {size} verified-source bytes in {time.monotonic()-started:.1f}s', flush=True)
        if sha(original) != SOURCE_SHA256:
            raise RuntimeError('Ubuntu cloud-image digest mismatch')
        disk = directory / 'prepared.qcow2'
        run(['qemu-img', 'create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', str(original), str(disk)])
        run(['qemu-img', 'resize', '-q', str(disk), '24G'])
        provision = '''import os, pathlib, subprocess
for pattern in ('*.sources', '*.list'):
    for path in pathlib.Path('/etc/apt/sources.list.d').glob(pattern): path.unlink()
pathlib.Path('/etc/apt/sources.list').write_text(SOURCES)
env = dict(os.environ, DEBIAN_FRONTEND='noninteractive')
subprocess.run(['apt-get','update'],env=env,check=True)
subprocess.run(['apt-get','install','--yes','--no-install-recommends',
'python3','openssh-server','sudo','ca-certificates','dbus','desktop-file-utils','shared-mime-info',
'libasound2t64','libatspi2.0-0t64','libgbm1','libgtk-3-0t64','libnotify4','libnss3',
'libsecret-1-0','libuuid1','libxss1','libxtst6','xdg-utils'],env=env,check=True)
pathlib.Path('/opt/t3-native-deb-base-ready').write_text('1')
subprocess.run(['sync'],check=True)
print('T3_NATIVE_DEB_BASE_READY',flush=True)
'''
        sources = ''.join(f'deb [check-valid-until=no signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://snapshot.ubuntu.com/ubuntu/{SNAPSHOT} {suite} main universe restricted multiverse\n' for suite in ['noble','noble-updates','noble-security'])
        provision = 'SOURCES = ' + repr(sources) + '\n' + provision
        userdata = {
            'users': [], 'disable_root': True, 'ssh_pwauth': False,
            'write_files': [
                {'path': '/root/t3-provision.py', 'permissions': '0600', 'content': provision},
            ],
            'runcmd': [['/usr/bin/python3', '/root/t3-provision.py']],
            'power_state': {'mode': 'poweroff', 'delay': 'now', 'condition': True},
        }
        (directory / 'user-data').write_text('#cloud-config\n' + json.dumps(userdata))
        (directory / 'meta-data').write_text('instance-id: t3-native-deb-base\nlocal-hostname: t3-deb-base\n')
        seed = directory / 'seed.iso'
        run(['genisoimage', '-quiet', '-output', str(seed), '-volid', 'cidata', '-joliet', '-rock', str(directory / 'user-data'), str(directory / 'meta-data')])
        logfile = directory / 'boot.log'
        with logfile.open('wb') as log:
            vm = subprocess.Popen(['qemu-system-x86_64', '-no-user-config', '-nodefaults', '-machine', 'q35,accel=tcg', '-cpu', 'max', '-smp', '2', '-m', '2048', '-display', 'none', '-monitor', 'none', '-serial', 'stdio',
                '-drive', f'file={disk},format=qcow2,if=virtio', '-drive', f'file={seed},format=raw,media=cdrom,readonly=on',
                '-device', 'virtio-net-pci,netdev=net0', '-netdev', 'user,id=net0'], stdout=log, stderr=log)
            try:
                code = vm.wait(timeout=1200)
            finally:
                if vm.poll() is None:
                    vm.kill()
                    vm.wait(timeout=10)
        output = logfile.read_text(errors='replace')
        if code != 0 or 'T3_NATIVE_DEB_BASE_READY' not in output:
            raise RuntimeError('Package base provisioning failed: ' + output[-12000:])
        base = ROOT / 'base.qcow2'
        run(['qemu-img', 'convert', '-O', 'qcow2', str(disk), str(base)])
        base.chmod(0o444)
        (ROOT / 'manifest.json').write_text(json.dumps({'protocol': 1, 'sha256': sha(base), 'source': SOURCE, 'sourceSha256': SOURCE_SHA256, 'ubuntuSnapshot': SNAPSHOT}, indent=2) + '\n')
        (ROOT / 'manifest.json').chmod(0o444)
        print('Immutable package guest built and checksum recorded', flush=True)

if __name__ == '__main__':
    main()
