#!/usr/bin/env python3
"""Dokploy-owned Windows worker: one fresh overlay/network/VM per Actions job."""

import base64
import fcntl
import hashlib
import json
import os
import pathlib
import re
import secrets
import signal
import subprocess
import time
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET

import libvirt
import libvirt_qemu

libvirt.registerErrorHandler(lambda *_: None, None)


def api(path, token, body=None, method=None):
    request = urllib.request.Request(
        'https://api.github.com' + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                 'User-Agent': 'unn-t3-windows-runner', 'X-GitHub-Api-Version': '2022-11-28'},
        method=method,
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        value = response.read()
        return json.loads(value) if value else None


def app_access_token():
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).rstrip(b'=')
    now = int(time.time())
    unsigned = encode({'alg': 'RS256', 'typ': 'JWT'}) + b'.' + encode({
        'iat': now - 60, 'exp': now + 540, 'iss': os.environ['GITHUB_APP_ID'],
    })
    signature = subprocess.run(
        ['openssl', 'dgst', '-sha256', '-sign', os.environ['CI_RUNNER_APP_PRIVATE_KEY_FILE']],
        input=unsigned, capture_output=True, check=True,
    ).stdout
    jwt = (unsigned + b'.' + base64.urlsafe_b64encode(signature).rstrip(b'=')).decode()
    org = os.environ.get('GITHUB_ORG', 'unn-corp')
    installations = api('/app/installations', jwt)
    installation = next(item for item in installations if item['account']['login'].lower() == org.lower())
    access = api(f"/app/installations/{installation['id']}/access_tokens", jwt, {})['token']
    return access


def registration_token():
    org = os.environ.get('GITHUB_ORG', 'unn-corp')
    return api(f'/orgs/{org}/actions/runners/registration-token', app_access_token(), {})['token']


class Supervisor:
    def __init__(self):
        self.slot = os.environ.get('CI_RUNNER_SLOT', 't3-ci-win1')
        if not re.fullmatch(r't3-ci-win[1-9][0-9]*', self.slot):
            raise ValueError('Invalid allowlisted Windows slot prefix')
        self.conn = libvirt.open('qemu:///system')
        self.pool = self.conn.storagePoolLookupByName('images')
        self.base_name = os.environ.get('CI_RUNNER_BASE', 't3-ci-windows-base')
        self.gateway = os.environ.get('CI_RUNNER_GATEWAY', '192.168.231.1')
        if not re.fullmatch(r'192\.168\.(23[1-9]|24[0-9])\.1', self.gateway):
            raise ValueError('Windows network gateway is outside the dedicated range')
        self.stopping = False
        self.name = None
        self.domain = None
        self.volume = None
        self.network = None

    def load_base(self):
        # Local orphan fencing runs before this admission check. A missing or
        # invalid template must never prevent teardown of the previous job.
        self.base = self.conn.lookupByName(self.base_name)
        if self.base.isActive():
            raise RuntimeError('Clean base is still running; do not clone an active disk')
        base_source_xml = self.base.XMLDesc(libvirt.VIR_DOMAIN_XML_INACTIVE)
        self.base_xml = ET.fromstring(base_source_xml)
        if self.base_xml.find("./devices/disk[@device='disk']/source").get('file') != f'/var/lib/libvirt/images/{self.base_name}.qcow2':
            raise RuntimeError('Unexpected base disk')
        approval_path = pathlib.Path('/state/base-approved.json')
        if not approval_path.is_file():
            raise RuntimeError('Independent base readiness approval is missing')
        approval = json.loads(approval_path.read_text())
        if approval.get('base_uuid') != self.base.UUIDString():
            raise RuntimeError('Readiness approval does not match this clean base')
        base_volume = self.pool.storageVolLookupByName(self.base_name + '.qcow2')
        volume_xml = ET.fromstring(base_volume.XMLDesc(0))
        mtime = volume_xml.findtext('./target/timestamps/mtime')
        if not mtime or not approval.get('base_mtime') or approval.get('base_disk') != base_volume.path() or approval['base_mtime'] != mtime:
            raise RuntimeError('The approved clean base disk has changed')
        if approval.get('base_xml_sha256') != hashlib.sha256(base_source_xml.encode()).hexdigest():
            raise RuntimeError('The approved base device configuration has changed')
        if len(self.base_xml.findall('./devices/interface')) != 1 or len(self.base_xml.findall("./devices/disk[@device='disk']")) != 1:
            raise RuntimeError('Clean base must have exactly one disk and network interface')
        if self.base_xml.findall('./devices/filesystem') or self.base_xml.findall('./devices/hostdev'):
            raise RuntimeError('Clean base must not expose host filesystems/devices')

    def stopping_signal(self, *_):
        self.stopping = True

    def agent(self, execute, arguments=None):
        value = {'execute': execute}
        if arguments is not None:
            value['arguments'] = arguments
        # Registration material never enters host argv or logs. This fresh,
        # time-limited token is consumed by config.cmd in this guest only;
        # --ephemeral limits the registered runner to one job.
        result = libvirt_qemu.qemuAgentCommand(self.domain, json.dumps(value), 30, 0)
        decoded = json.loads(result)
        if 'error' in decoded:
            raise RuntimeError('Guest agent command failed: ' + execute)
        return decoded['return']

    def powershell(self, script, wait=True, timeout=120):
        encoded = base64.b64encode(script.encode('utf-16-le')).decode()
        result = self.agent('guest-exec', {
            'path': r'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe',
            'arg': ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            'capture-output': True,
        })
        pid = result['pid']
        if not wait:
            return pid
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not self.stopping:
            status = self.agent('guest-exec-status', {'pid': pid})
            if status.get('exited'):
                if status.get('exitcode') != 0:
                    raise RuntimeError('Guest validation/registration failed (output withheld)')
                return base64.b64decode(status.get('out-data', '')).decode('utf-8', errors='replace').strip()
            time.sleep(2)
        raise RuntimeError('Guest operation deadline reached')

    def janitor(self):
        pattern = re.compile(re.escape(self.slot) + r'-[a-f0-9]{12}$')
        failures = []
        for domain in self.conn.listAllDomains():
            if pattern.fullmatch(domain.name()):
                try:
                    if domain.isActive():
                        domain.destroy()
                    domain.undefine()
                except libvirt.libvirtError:
                    failures.append('domain')
        for volume in self.pool.listAllVolumes():
            if volume.name().endswith('.qcow2') and pattern.fullmatch(volume.name()[:-6]):
                try:
                    volume.delete(0)
                except libvirt.libvirtError:
                    failures.append('volume')
        for network in self.conn.listAllNetworks():
            if pattern.fullmatch(network.name()):
                try:
                    if network.isActive():
                        network.destroy()
                    network.undefine()
                except libvirt.libvirtError:
                    failures.append('network')
        try:
            self.remove_registrations(pattern)
        except Exception:
            failures.append('registration')
        if failures:
            raise RuntimeError('Reserved worker cleanup incomplete: ' + ','.join(failures))

    def remove_registrations(self, pattern):
        org = os.environ.get('GITHUB_ORG', 'unn-corp')
        access = app_access_token()
        page = 1
        matches = []
        while True:
            runners = api(f'/orgs/{org}/actions/runners?per_page=100&page={page}', access)['runners']
            matches.extend(runner for runner in runners if pattern.fullmatch(runner['name']))
            if len(runners) < 100:
                break
            page += 1
        for runner in matches:
            try:
                api(f"/orgs/{org}/actions/runners/{runner['id']}", access, method='DELETE')
            except urllib.error.HTTPError as error:
                if error.code != 404:
                    raise

    def create(self):
        self.load_base()
        self.name = self.slot + '-' + secrets.token_hex(6)
        root = ET.fromstring(ET.tostring(self.base_xml))
        root.find('name').text = self.name
        for tag in ('uuid',):
            for node in root.findall(tag):
                root.remove(node)
        for node in root.findall("./devices/disk[@device='cdrom']"):
            root.find('devices').remove(node)
        root.find('./on_reboot').text = 'restart'
        root.find('./on_crash').text = 'destroy'
        root.find('./memory').text = str(int(os.environ.get('CI_RUNNER_MEMORY_MB', '16384')) * 1024)
        root.find('./currentMemory').text = root.find('./memory').text
        root.find('./vcpu').text = os.environ.get('CI_RUNNER_CPUS', '8')
        disk = root.find("./devices/disk[@device='disk']")
        base_path = disk.find('source').get('file')
        volume_xml = f"<volume><name>{self.name}.qcow2</name><capacity unit='GiB'>100</capacity><target><format type='qcow2'/></target><backingStore><path>{base_path}</path><format type='qcow2'/></backingStore></volume>"
        self.volume = self.pool.createXML(volume_xml, 0)
        disk.find('source').set('file', self.volume.path())
        for node in disk.findall('backingStore'):
            disk.remove(node)
        subnet = self.gateway.rsplit('.', 1)[0]
        bridge = 't3w' + self.name[-10:]
        network_xml = f"<network><name>{self.name}</name><forward mode='nat'/><bridge name='{bridge}' stp='on' delay='0'/><dns><forwarder addr='1.1.1.1'/><forwarder addr='8.8.8.8'/></dns><ip address='{self.gateway}' netmask='255.255.255.0'/></network>"
        self.network = self.conn.networkDefineXML(network_xml)
        self.network.create()
        interface = root.find('./devices/interface')
        interface.set('type', 'network')
        interface.find('source').attrib.clear()
        interface.find('source').set('network', self.name)
        for node in interface.findall('mac') + interface.findall('target'):
            interface.remove(node)
        filterref = interface.find('filterref')
        if filterref is None or filterref.get('filter') != 't3-ci-windows-egress':
            raise RuntimeError('Base lacks the mandatory host-enforced network filter')
        parameters = {node.get('name'): node for node in filterref.findall('parameter')}
        for key, value in {'GATEWAY': self.gateway, 'IP': subnet + '.2', 'CTRL_IP_LEARNING': 'none'}.items():
            node = parameters.get(key)
            if node is None:
                node = ET.SubElement(filterref, 'parameter', {'name': key})
            node.set('value', value)
        for graphics in root.findall('./devices/graphics'):
            root.find('devices').remove(graphics)
        for channel in root.findall('./devices/channel/source'):
            channel.attrib.clear()
        self.domain = self.conn.defineXML(ET.tostring(root, encoding='unicode'))
        self.domain.create()
        print('Created fresh Windows VM ' + self.name, flush=True)

    def readiness(self):
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline and not self.stopping:
            try:
                self.agent('guest-ping')
                break
            except libvirt.libvirtError:
                time.sleep(5)
        else:
            raise RuntimeError('Windows guest agent did not become ready')
        script = r"""$ErrorActionPreference='Stop';
$index=(Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object -First 1).InterfaceIndex
Set-NetIPInterface -InterfaceIndex $index -AddressFamily IPv4 -Dhcp Disabled
Get-NetIPAddress -InterfaceIndex $index -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false
Get-NetRoute -InterfaceIndex $index -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object DestinationPrefix -eq '0.0.0.0/0' | Remove-NetRoute -Confirm:$false
New-NetIPAddress -InterfaceIndex $index -IPAddress '192.168.231.2' -PrefixLength 24 -DefaultGateway '192.168.231.1' | Out-Null
Set-DnsClientServerAddress -InterfaceIndex $index -ServerAddresses '192.168.231.1'
for($attempt=0;$attempt -lt 20;$attempt++){Clear-DnsClientCache;try{if(Resolve-DnsName github.com -Type A -DnsOnly -QuickTimeout -ErrorAction Stop){break}}catch{};Start-Sleep -Seconds 2}
if($attempt -eq 20){throw 'Dedicated network DNS did not become ready'}
if ((Get-Content C:\ci-bootstrap\status.txt) -ne 'ready-for-validation') { throw 'Base not ready' }
foreach($path in @('C:\Program Files\PowerShell\7\pwsh.exe','C:\Program Files\Git\bin\bash.exe','C:\Program Files\nodejs\node.exe','C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat','C:\actions-runner\config.cmd')) {if(!(Test-Path $path)){throw 'Missing native tool'}}
foreach($path in @('C:\actions-runner\.runner','C:\actions-runner\.credentials')) {if(Test-Path $path){throw 'Base contains prior runner registration'}}
function Tcp($address,$port) { $c=New-Object Net.Sockets.TcpClient; try {$t=$c.ConnectAsync($address,$port); if(!$t.Wait(3000)){return $false};return $c.Connected} catch {return $false} finally {$c.Dispose()} }
if(!(Tcp 'github.com' 443)){throw 'GitHub HTTPS is unreachable'}
foreach($address in @('67.222.144.10','192.168.122.28','169.254.169.254','192.168.231.1')) {foreach($port in @(80,443,2375,22)){if(Tcp $address $port){throw 'Private/host network escape'}}}
'Windows tools and network boundary verified'
"""
        script = script.replace("'192.168.231.1'", "'" + self.gateway + "'")
        script = script.replace("'192.168.231.2'", "'" + self.gateway.rsplit('.', 1)[0] + ".2'")
        self.powershell(script, timeout=90)
        print('Verified fresh Windows tools and blocked host/private routes', flush=True)

    def start_runner(self):
        token = registration_token()
        org = os.environ.get('GITHUB_ORG', 'unn-corp')
        group = os.environ.get('RUNNER_GROUP', 'T3 Code')
        if not re.fullmatch(r'[A-Za-z0-9 _.-]+', group) or not re.fullmatch(r'[A-Za-z0-9-]+', org):
            raise ValueError('Invalid runner organization/group')
        escaped_token = token.replace("'", "''")
        script = f"""$ErrorActionPreference='Stop';
Set-Location C:\\actions-runner;
& .\\config.cmd --url 'https://github.com/{org}' --token '{escaped_token}' --name '{self.name}' --work '_work' --labels 'unn,unn-isolated,t3-ci' --runnergroup '{group}' --unattended --ephemeral --disableupdate;
if($LASTEXITCODE -ne 0){{exit $LASTEXITCODE}}
"""
        self.powershell(script)
        del token, escaped_token, script
        return self.powershell(r"Set-Location C:\actions-runner; & .\run.cmd; exit $LASTEXITCODE", wait=False)

    def cleanup(self):
        errors = []
        for kind, value in (('domain', self.domain), ('volume', self.volume), ('network', self.network)):
            if value is None:
                continue
            try:
                if kind == 'domain':
                    if value.isActive():
                        value.destroy()
                    value.undefine()
                elif kind == 'volume':
                    value.delete(0)
                else:
                    if value.isActive():
                        value.destroy()
                    value.undefine()
            except libvirt.libvirtError:
                errors.append(kind)
        self.domain = self.volume = self.network = None
        if errors:
            raise RuntimeError('Cleanup incomplete: ' + ','.join(errors))
        if self.name is not None:
            self.remove_registrations(re.compile(re.escape(self.name) + '$'))
        print('Destroyed Windows worker disk, VM, and network', flush=True)

    def cycle(self):
        created_at = time.monotonic()
        try:
            self.create()
            self.readiness()
            pid = self.start_runner()
            deadline = created_at + int(os.environ.get('CI_RUNNER_MAX_LIFETIME_SECONDS', '28800'))
            idle_deadline = created_at + int(os.environ.get('CI_RUNNER_MAX_IDLE_SECONDS', '3500'))
            worker_seen = False
            next_worker_check = 0
            while time.monotonic() < deadline and not self.stopping:
                result = self.agent('guest-exec-status', {'pid': pid})
                if result.get('exited'):
                    print('Ephemeral runner exited: ' + str(result.get('exitcode')), flush=True)
                    return
                if not worker_seen and time.monotonic() >= next_worker_check:
                    worker_seen = self.powershell("(@(Get-Process -Name Runner.Worker -ErrorAction SilentlyContinue).Count -gt 0).ToString()", timeout=15).lower() == 'true'
                    next_worker_check = time.monotonic() + 30
                if not worker_seen and time.monotonic() >= idle_deadline:
                    print('Recycling idle Windows listener', flush=True)
                    return
                time.sleep(5)
            print('Windows worker lifetime/stop reached', flush=True)
        finally:
            self.cleanup()


def main():
    pathlib.Path('/state').mkdir(exist_ok=True)
    with pathlib.Path('/state/slot.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        supervisor = Supervisor()
        signal.signal(signal.SIGTERM, supervisor.stopping_signal)
        signal.signal(signal.SIGINT, supervisor.stopping_signal)
        supervisor.janitor()
        while not supervisor.stopping:
            try:
                supervisor.janitor()
                supervisor.cycle()
            except Exception as error:
                # Errors can contain HTTP/guest details; emit the type only.
                print('Windows worker cycle failed: ' + type(error).__name__, flush=True)
                for _ in range(30):
                    if supervisor.stopping:
                        break
                    time.sleep(1)
        supervisor.janitor()


if __name__ == '__main__':
    main()
