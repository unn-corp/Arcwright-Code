#!/usr/bin/env python3
"""Apply only T3's source-scoped IPv4 firewall rules in the host namespace."""
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys

if len(sys.argv) != 5 or sys.argv[1] not in {"apply", "verify"}:
    raise SystemExit("Usage: network-policy.py apply|verify SUBNET NETWORK HOST_PUBLIC_IP")
mode, subnet_text, network_name, public_ip_text = sys.argv[1:]
allowed = {"172.31.240.0/24": ("240", "1"), "172.31.241.0/24": ("241", "2")}
if os.geteuid() != 0 or subnet_text not in allowed:
    raise SystemExit("Root and an explicitly reserved T3 subnet are required")
slot, slot_number = allowed[subnet_text]
if not (re.fullmatch(rf"t3-ci-linux-{slot_number}(?:-[a-z0-9]{{1,12}})?_isolated", network_name)
        or network_name == f"t3-ci-policy-probe-{slot}"):
    raise SystemExit("Unexpected T3 network name")
subnet = ipaddress.IPv4Network(subnet_text)
gateway = str(subnet.network_address + 1)
public_ip = str(ipaddress.IPv4Address(public_ip_text))
out_chain, host_chain = f"T3CI{slot}_OUT", f"T3CI{slot}_HOST"
ipv6_chain = f"T3CI{slot}_V6"
bridge = f"t3ci-ln{slot_number}"
comment = f"t3-code-ci-{slot}"

def run(arguments, *, input=None, check=True):
    result = subprocess.run(arguments, input=input, text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(f"{arguments[0]} failed: {result.stderr.strip()}")
    return result

def iptables(*arguments, check=True, version=4):
    binary = "/usr/sbin/iptables" if version == 4 else "/usr/sbin/ip6tables"
    return run([binary, "--wait", "10", *arguments], check=check)

lock = Path("/run/lock/t3-code-ci-firewall.lock").open("a")
fcntl.flock(lock, fcntl.LOCK_EX)

# Query safe network metadata, never container environments or registration keys.
ids = run(["docker", "--host", "unix:///var/run/docker.sock", "network", "ls", "--quiet"]).stdout.split()
networks = json.loads(run(["docker", "--host", "unix:///var/run/docker.sock", "network", "inspect", *ids]).stdout)
docker_subnets = set()
found_network = False
for network in networks:
    for config in network.get("IPAM", {}).get("Config") or []:
        value = config.get("Subnet")
        if not value:
            continue
        candidate = ipaddress.ip_network(value)
        if candidate.version != 4:
            continue
        if candidate.overlaps(subnet):
            if candidate != subnet or network["Name"] != network_name or network.get("EnableIPv6"):
                raise SystemExit("T3 subnet collides with another network or enables IPv6")
            if config.get("Gateway") != gateway:
                raise SystemExit("Unexpected T3 gateway")
            if network.get("Options", {}).get("com.docker.network.bridge.name") != bridge:
                raise SystemExit("The reserved bridge interface is missing")
            found_network = True
        else:
            docker_subnets.add(str(candidate))
if not found_network:
    raise SystemExit("Create the empty owned T3 bridge before applying policy")

addresses = json.loads(run(["ip", "-4", "-j", "address", "show"]).stdout)
routes = json.loads(run(["ip", "-4", "-j", "route", "show"]).stdout)
connected_subnets = {
    str(ipaddress.IPv4Network(route["dst"])) for route in routes
    if route.get("scope") == "link" and route.get("dst") != "default"
}
connected_subnets.discard(subnet_text)
host_ips = {public_ip, gateway}
for interface in addresses:
    for address in interface.get("addr_info", []):
        if address.get("family") == "inet":
            host_ips.add(str(ipaddress.IPv4Address(address["local"])))

if iptables("-C", "FORWARD", "-j", "DOCKER-USER", check=False).returncode:
    raise SystemExit("Docker's DOCKER-USER forwarding hook is missing")

rules = []
def rule(chain, *arguments):
    rules.append(["-A", chain, "-m", "comment", "--comment", comment, *arguments])

# Host and existing Docker destinations stay denied even for previously established
# flows. Same-pair traffic is the sole private exception, excluding its host gateway.
for address in sorted(host_ips):
    rule(out_chain, "-d", address, "-j", "DROP")
rule(out_chain, "-d", subnet_text, "-j", "RETURN")
nonpublic = {
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
    "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
    "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
    "224.0.0.0/4", "240.0.0.0/4",
}
for destination in sorted(nonpublic | docker_subnets | connected_subnets):
    rule(out_chain, "-d", destination, "-j", "DROP")
rule(out_chain, "-m", "conntrack", "--ctstate", "INVALID", "-j", "DROP")
rule(out_chain, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "RETURN")
rule(out_chain, "-p", "tcp", "-m", "multiport", "--dports", "80,443", "-j", "RETURN")
for protocol in ["tcp", "udp"]:
    rule(out_chain, "-p", protocol, "--dport", "53", "-j", "RETURN")
rule(out_chain, "-j", "DROP")
rule(host_chain, "-j", "DROP")

# The early source-only FORWARD hook covers libvirt rules that precede Docker's
# hook. Existing rules and other sources retain their original behavior/order.
jumps = [
    [chain, "-s", subnet_text, "-m", "comment", "--comment", comment, "-j", target]
    for chain, target in [("FORWARD", out_chain), ("DOCKER-USER", out_chain), ("INPUT", host_chain)]
]
interface_rules = [
    ["FORWARD", "-i", bridge, "!", "-s", subnet_text, "-m", "comment", "--comment", comment, "-j", "DROP"],
    ["FORWARD", "-i", bridge, "-m", "comment", "--comment", comment, "-j", out_chain],
    ["INPUT", "-i", bridge, "-m", "comment", "--comment", comment, "-j", host_chain],
]
ipv6_jumps = [[chain, "-i", bridge, "-m", "comment", "--comment", comment, "-j", ipv6_chain]
              for chain in ["INPUT", "FORWARD"]]

if mode == "apply":
    for chain in [out_chain, host_chain]:
        if iptables("-S", chain, check=False).returncode:
            iptables("-N", chain)
        else:
            existing = iptables("-S", chain).stdout.splitlines()
            if any(line.startswith("-A ") and comment not in line for line in existing):
                raise SystemExit("Refusing to replace a chain without T3 ownership comments")
    commands = ["*filter", f"-F {out_chain}", f"-F {host_chain}"]
    # These tokens are fixed rules or ipaddress-validated literals. restore's
    # parser is not a shell; quoting its special `!` token changes its meaning.
    commands.extend(" ".join(arguments) for arguments in rules)
    # Reversed insertion leaves anti-spoofing ahead of the interface's allow
    # rules, and both ahead of libvirt/Docker's preexisting forwarding hooks.
    for jump in reversed([*interface_rules, *jumps]):
        if iptables("-C", *jump, check=False).returncode == 0:
            commands.append(" ".join(["-D", *jump]))
        commands.append(" ".join(["-I", jump[0], "1", *jump[1:]]))
    commands.append("COMMIT")
    batch = "\n".join(commands) + "\n"
    restore = ["/usr/sbin/iptables-restore", "--wait", "10", "--noflush"]
    run([*restore, "--test"], input=batch)
    run(restore, input=batch)
    if iptables("-S", ipv6_chain, check=False, version=6).returncode:
        iptables("-N", ipv6_chain, version=6)
    else:
        existing = iptables("-S", ipv6_chain, version=6).stdout.splitlines()
        if any(line.startswith("-A ") and comment not in line for line in existing):
            raise SystemExit("Refusing to replace an IPv6 chain without T3 ownership comments")
    ipv6_rules = ["*filter", f"-F {ipv6_chain}",
                  f"-A {ipv6_chain} -m comment --comment {comment} -j DROP"]
    for jump in ipv6_jumps:
        if iptables("-C", *jump, check=False, version=6).returncode == 0:
            ipv6_rules.append(" ".join(["-D", *jump]))
        ipv6_rules.append(" ".join(["-I", jump[0], "1", *jump[1:]]))
    ipv6_rules.append("COMMIT")
    run(["/usr/sbin/ip6tables-restore", "--wait", "10", "--noflush"],
        input="\n".join(ipv6_rules) + "\n")
    # This changes only the bridge owned by this slot. A privileged DinD child
    # can alter its own sysctls, but cannot re-enable IPv6 in the host namespace.
    run(["sysctl", "-w", f"net.ipv6.conf.{bridge}.disable_ipv6=1"])

for arguments in rules:
    iptables("-C", *arguments[1:])
for jump in [*jumps, *interface_rules]:
    iptables("-C", *jump)
for jump in ipv6_jumps:
    iptables("-C", *jump, version=6)
iptables("-C", ipv6_chain, "-m", "comment", "--comment", comment, "-j", "DROP", version=6)
if run(["sysctl", "-n", f"net.ipv6.conf.{bridge}.disable_ipv6"]).stdout.strip() != "1":
    raise SystemExit("Host bridge IPv6 is enabled")
print(f"[t3-ci-firewall] {mode} passed for {subnet_text}; "
      f"blocked {len(host_ips)} host addresses and {len(docker_subnets)} other Docker subnets")
