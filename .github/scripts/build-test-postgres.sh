#!/usr/bin/env bash
# Build only disposable test tooling; never install into the runner's root filesystem.
set -euo pipefail
: "${RELAY_POSTGRES_HOME:?Set a private PostgreSQL installation directory}"
[[ "$RELAY_POSTGRES_HOME" == /* ]] || exit 64
version=16.14
sha256=f6d077142737920858ce958ccdb75c6ee137a63b5b0853c70693d401ac7e3471
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
curl --fail --silent --show-error --retry 2 --connect-timeout 15 --max-time 120 \
  "https://ftp.postgresql.org/pub/source/v$version/postgresql-$version.tar.bz2" \
  -o "$build/source.tar.bz2"
printf '%s  %s\n' "$sha256" "$build/source.tar.bz2" | sha256sum --check --status
tar -xjf "$build/source.tar.bz2" --directory "$build" --no-same-owner
cd "$build/postgresql-$version"
# These fixtures use local sockets and C collation, with no external services.
./configure --prefix="$RELAY_POSTGRES_HOME" --without-readline --without-zlib \
  --without-icu > "$build/configure.log" 2>&1 || { tail -50 "$build/configure.log"; exit 1; }
make --silent -j4 > "$build/build.log" 2>&1 || { tail -50 "$build/build.log"; exit 1; }
make --silent install > "$build/install.log" 2>&1 || { tail -50 "$build/install.log"; exit 1; }
"$RELAY_POSTGRES_HOME/bin/postgres" --version
