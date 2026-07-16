#!/usr/bin/env bash
# Build every stable 16.2.x version, deduplicating by Rust-tree fingerprint:
# versions whose Rust workspace is byte-identical share one compiled artifact.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Fingerprint groups (verified via git tree comparison of crates/ + turbopack/ +
# Cargo.{toml,lock} + rust-toolchain.toml): first entry of each group builds,
# the rest copy.
GROUPS_LIST=(
  "16.2.0"
  "16.2.1"
  "16.2.2"
  "16.2.3"
  "16.2.4"
  "16.2.5"
  "16.2.6"
  "16.2.10 16.2.7 16.2.8 16.2.9"
)

for group in "${GROUPS_LIST[@]}"; do
  set -- $group
  rep="$1"; shift
  if [ ! -f "$ROOT/dist/v$rep/index.wasm32-wasi.wasm" ]; then
    echo "=== building v$rep ==="
    bash "$ROOT/scripts/build.sh" "v$rep"
  else
    echo "=== v$rep already built ==="
  fi
  for v in "$@"; do
    if [ ! -f "$ROOT/dist/v$v/index.wasm32-wasi.wasm" ]; then
      echo "=== v$v: copying from fingerprint-identical v$rep ==="
      mkdir -p "$ROOT/dist/v$v"
      cp -R "$ROOT/dist/v$rep/." "$ROOT/dist/v$v/"
    fi
  done
done
echo "ALL 16.2.x BUILDS COMPLETE"
ls "$ROOT/dist"
