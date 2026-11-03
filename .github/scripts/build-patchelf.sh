#!/usr/bin/env bash
# Build pinned tooling in the runner's writable temporary directory.
set -euo pipefail
: "${RUNNER_TEMP:?}"
version=0.18.0
sha256=64de10e4c6b8b8379db7e87f58030f336ea747c0515f381132e810dbf84a86e7
build=$(mktemp -d "$RUNNER_TEMP/patchelf-build.XXXXXX")
trap 'rm -rf "$build"' EXIT
curl --fail --silent --show-error --location --retry 2 --connect-timeout 15 --max-time 120 \
  "https://github.com/NixOS/patchelf/releases/download/$version/patchelf-$version.tar.gz" -o "$build/source.tar.gz"
printf '%s  %s\n' "$sha256" "$build/source.tar.gz" | sha256sum --check --status
tar -xzf "$build/source.tar.gz" -C "$build" --no-same-owner
cd "$build/patchelf-$version"
./configure --prefix="$RUNNER_TEMP/patchelf" > "$build/configure.log" 2>&1 || { tail -50 "$build/configure.log"; exit 1; }
make -s -j4 > "$build/build.log" 2>&1 || { tail -50 "$build/build.log"; exit 1; }
make -s install > "$build/install.log" 2>&1 || { tail -50 "$build/install.log"; exit 1; }
"$RUNNER_TEMP/patchelf/bin/patchelf" --version
