#!/usr/bin/env python3
"""Run inside an owned, unregistered canary on the first reserved T3 bridge."""
from pathlib import Path
import socket
import urllib.request

def blocked(name, address, port):
    try:
        connection = socket.create_connection((address, port), timeout=1)
    except OSError:
        print(f"PASS blocked {name}", flush=True)
    else:
        connection.close()
        raise SystemExit(f"FAIL reachable {name}")

with urllib.request.urlopen("http://172.31.240.2:2376", timeout=5) as response:
    assert response.read() == b"t3-ci-policy-canary"
print("PASS same-slot TCP 2376", flush=True)
with urllib.request.urlopen("https://github.com/", timeout=15) as response:
    assert response.status == 200
print("PASS public HTTPS and DNS", flush=True)
with socket.create_connection(("example.com", 80), timeout=10):
    print("PASS public TCP 80", flush=True)

blocked("cross-slot listener", "172.31.241.2", 2376)
blocked("host gateway witness", "172.31.240.1", 43879)
blocked("host public HTTPS", "67.222.144.10", 443)
blocked("metadata", "169.254.169.254", 80)
blocked("CGNAT", "100.64.0.1", 443)
blocked("other public-looking Docker subnet", "172.32.0.10", 443)
for interface in ["all", "default", "eth0"]:
    assert Path(f"/proc/sys/net/ipv6/conf/{interface}/disable_ipv6").read_text().strip() == "1"
print("PASS container IPv6 disabled", flush=True)
