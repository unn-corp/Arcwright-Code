#!/usr/bin/env python3
"""Create a clean, unregistered Windows image; never copy a live VM disk."""

import argparse
import ipaddress
import pathlib
import secrets
import subprocess
import tempfile
from xml.sax.saxutils import escape

BASE = 't3-ci-windows-base'
POOL = 'images'
URI = 'qemu:///system'


def run(*arguments):
    return subprocess.run(arguments, check=True, text=True, capture_output=True).stdout.strip()


def virsh(*arguments):
    return run('virsh', '-c', URI, *arguments)


def filter_xml(host_addresses):
    # Only gateway DNS is exempt from private-address denial. Every network
    # owns one VM with an explicit .2 address and matching anti-spoofing IP.
    rules = [
        "<rule action='drop' direction='out' priority='-1000'><mac match='no' srcmacaddr='$MAC'/></rule>",
        "<rule action='drop' direction='inout' priority='-990'><mac protocolid='ipv6'/></rule>",
        "<rule action='accept' direction='out' priority='-970'><udp dstipaddr='$GATEWAY' dstportstart='53'/></rule>",
        "<rule action='accept' direction='out' priority='-970'><tcp dstipaddr='$GATEWAY' dstportstart='53'/></rule>",
    ]
    prefixes = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
                '169.254.0.0/16', '172.0.0.0/8', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4']
    prefixes.extend(str(ipaddress.ip_network(address)) for address in host_addresses)
    for prefix in prefixes:
        network = ipaddress.ip_network(prefix)
        rules.append(f"<rule action='drop' direction='out' priority='-960'><all dstipaddr='{network.network_address}' dstipmask='{network.prefixlen}'/></rule>")
    rules.extend([
        "<rule action='accept' direction='out' priority='-950'><tcp dstportstart='80'/></rule>",
        "<rule action='accept' direction='out' priority='-950'><tcp dstportstart='443'/></rule>",
        "<rule action='drop' direction='out' priority='-940'><all/></rule>",
        "<filterref filter='clean-traffic'/>",
    ])
    return "<filter name='t3-ci-windows-egress' chain='root'>" + ''.join(rules) + '</filter>'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--windows-iso', default='/var/lib/libvirt/images/win2022-eval.iso')
    parser.add_argument('--virtio-iso', default='/var/lib/libvirt/images/virtio-win.iso')
    parser.add_argument('--host-ip', action='append', required=True)
    args = parser.parse_args()
    if BASE in virsh('list', '--all', '--name').splitlines():
        raise SystemExit('The clean base already exists; inspect it instead of recreating it.')
    password = secrets.token_urlsafe(30) + '!aA7'
    command = 'cmd.exe /c for %d in (D E F G H I J) do @if exist %d:\\bootstrap.ps1 powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File %d:\\bootstrap.ps1'
    answer = f'''<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
<settings pass="windowsPE">
<component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><SetupUILanguage><UILanguage>en-US</UILanguage></SetupUILanguage><InputLocale>en-US</InputLocale><SystemLocale>en-US</SystemLocale><UILanguage>en-US</UILanguage><UserLocale>en-US</UserLocale></component>
<component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
<DiskConfiguration><Disk xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" wcm:action="add"><DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk><CreatePartitions><CreatePartition wcm:action="add"><Order>1</Order><Type>Primary</Type><Size>500</Size></CreatePartition><CreatePartition wcm:action="add"><Order>2</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition></CreatePartitions><ModifyPartitions><ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>NTFS</Format><Label>System</Label><Active>true</Active></ModifyPartition><ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition></ModifyPartitions></Disk><WillShowUI>OnError</WillShowUI></DiskConfiguration>
<ImageInstall><OSImage><InstallFrom><MetaData xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>2</Value></MetaData></InstallFrom><InstallTo><DiskID>0</DiskID><PartitionID>2</PartitionID></InstallTo><WillShowUI>OnError</WillShowUI></OSImage></ImageInstall>
<UserData><AcceptEula>true</AcceptEula><FullName>T3 CI</FullName><Organization>unn-corp</Organization></UserData></component></settings>
<settings pass="specialize"><component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><ComputerName>T3CI-WIN-BASE</ComputerName><TimeZone>UTC</TimeZone></component></settings>
<settings pass="oobeSystem"><component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"><OOBE><HideEULAPage>true</HideEULAPage><HideLocalAccountScreen>true</HideLocalAccountScreen><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC></OOBE><UserAccounts><AdministratorPassword><Value>{password}</Value><PlainText>true</PlainText></AdministratorPassword></UserAccounts><AutoLogon><Password><Value>{password}</Value><PlainText>true</PlainText></Password><Enabled>true</Enabled><LogonCount>1</LogonCount><Username>Administrator</Username></AutoLogon><FirstLogonCommands><SynchronousCommand xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" wcm:action="add"><Order>1</Order><Description>Build clean CI image</Description><CommandLine>{escape(command)}</CommandLine><RequiresUserInput>false</RequiresUserInput></SynchronousCommand></FirstLogonCommands></component></settings></unattend>'''
    with tempfile.TemporaryDirectory(prefix='t3-ci-win-install-') as directory:
        root = pathlib.Path(directory)
        (root / 'autounattend.xml').write_text(answer)
        (root / 'bootstrap.ps1').write_bytes(pathlib.Path(__file__).with_name('bootstrap.ps1').read_bytes())
        run('xorriso', '-as', 'mkisofs', '-V', 'T3CI_BOOT', '-J', '-R', '-o', str(root / 'answer.iso'), str(root / 'autounattend.xml'), str(root / 'bootstrap.ps1'))
        (root / 'filter.xml').write_text(filter_xml(args.host_ip))
        virsh('nwfilter-define', str(root / 'filter.xml'))
        network = f"<network><name>{BASE}-net</name><forward mode='nat'/><bridge name='t3ciwinbase' stp='on' delay='0'/><dns><forwarder addr='1.1.1.1'/><forwarder addr='8.8.8.8'/></dns><ip address='192.168.230.1' netmask='255.255.255.0'/></network>"
        (root / 'network.xml').write_text(network)
        virsh('net-define', str(root / 'network.xml'))
        virsh('net-start', BASE + '-net')
        virsh('vol-create-as', POOL, BASE + '.qcow2', '100G', '--format', 'qcow2')
        virsh('vol-create-as', POOL, BASE + '-answer.iso', str((root / 'answer.iso').stat().st_size), '--format', 'raw')
        virsh('vol-upload', BASE + '-answer.iso', str(root / 'answer.iso'), '--pool', POOL)
        run('virt-install', '--connect', URI, '--name', BASE, '--memory', '8192', '--vcpus', '4', '--cpu', 'host-passthrough', '--machine', 'q35', '--os-variant', 'win2k22', '--cdrom', args.windows_iso, '--disk', f'vol={POOL}/{BASE}.qcow2,bus=sata', '--disk', f'vol={POOL}/{BASE}-answer.iso,device=cdrom,bus=sata', '--disk', f'path={args.virtio_iso},device=cdrom,bus=sata', '--network', f'network={BASE}-net,model=e1000,filterref.filter=t3-ci-windows-egress', '--xml', './devices/interface/filterref/parameter/@name=GATEWAY', '--xml', './devices/interface/filterref/parameter/@value=192.168.230.1', '--xml', './devices/interface/filterref/parameter[2]/@name=IP', '--xml', './devices/interface/filterref/parameter[2]/@value=192.168.230.2', '--xml', './devices/interface/filterref/parameter[3]/@name=CTRL_IP_LEARNING', '--xml', './devices/interface/filterref/parameter[3]/@value=none', '--channel', 'unix,target_type=virtio,name=org.qemu.guest_agent.0', '--graphics', 'vnc,listen=127.0.0.1', '--noautoconsole', '--wait', '0')
    print('Clean Windows base install started. No GitHub credentials were supplied.')


if __name__ == '__main__':
    main()
