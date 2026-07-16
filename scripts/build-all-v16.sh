#!/usr/bin/env bash
# Build every stable v16 version, deduplicating by Rust-tree fingerprint:
# versions whose Rust workspace is byte-identical share one compiled artifact.
# First entry of each group builds, the rest copy.
#
# Usage: build-all-v16.sh [--force]   (--force rebuilds groups even if dist exists)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORCE="${1:-}"

# Fingerprint groups, verified via git tree/blob OID comparison of
# crates/ + turbopack/ + Cargo.{toml,lock} + rust-toolchain.toml per tag.
GROUPS_LIST=(
  "16.0.0"
  "16.0.1 16.0.2"
  "16.0.3"
  "16.0.4 16.0.5 16.0.6 16.0.7 16.0.8 16.0.9 16.0.10 16.0.11"
  "16.1.0"
  "16.1.1"
  "16.1.2 16.1.3 16.1.4"
  "16.1.5"
  "16.1.6"
  "16.1.7"
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
  if [ "$FORCE" = "--force" ] || [ ! -f "$ROOT/dist/v$rep/index.wasm32-wasi.wasm" ]; then
    echo "=== building v$rep ($(date +%H:%M:%S)) ==="
    bash "$ROOT/scripts/build.sh" "v$rep"
  else
    echo "=== v$rep already built ==="
  fi
  for v in "$@"; do
    echo "=== v$v: copying from fingerprint-identical v$rep ==="
    rm -rf "$ROOT/dist/v$v"
    mkdir -p "$ROOT/dist/v$v"
    cp -R "$ROOT/dist/v$rep/." "$ROOT/dist/v$v/"
  done
done
echo "ALL v16 BUILDS COMPLETE"
ls "$ROOT/dist"
