#!/usr/bin/env python3
"""Render a dedicated Mothership slot; output contains secret references only."""

import argparse
import ipaddress
import json
import pathlib
import re


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True, help='Exact Dokploy-generated appName')
    parser.add_argument('--subnet', required=True, choices=['172.31.240.0/24', '172.31.241.0/24'])
    parser.add_argument('--image', required=True, help='Locally built immutable Docker image ID')
    args = parser.parse_args()
    if not re.fullmatch(r't3-ci-linux-[12]-[a-z0-9]+', args.project):
        parser.error('Expected the dedicated T3 Linux Dokploy appName')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', args.image):
        parser.error('Use a full immutable Docker image ID; registry pulls are disabled')
    network = ipaddress.ip_network(args.subnet)
    substitutions = {
        '__T3_SLOT__': args.project,
        '__T3_SUBNET__': str(network),
        '__T3_GATEWAY__': str(network.network_address + 1),
        '__T3_BRIDGE__': 't3ci-ln1' if args.subnet == '172.31.240.0/24' else 't3ci-ln2',
        '__T3_RUNNER_IMAGE__': args.image,
    }
    template = pathlib.Path(__file__).with_name('docker-compose.dokploy.json').read_text()
    for placeholder, value in substitutions.items():
        template = template.replace(placeholder, value)
    if re.search(r'__[A-Z0-9_]+__', template):
        parser.error('Unresolved Compose template placeholder')
    print(json.dumps(json.loads(template), indent=2))


if __name__ == '__main__':
    main()
