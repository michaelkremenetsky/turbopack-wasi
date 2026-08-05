#!/usr/bin/env bash
# Regression check for the SWC host-plugin bridge (docs/swc-plugin-host-bridge.md):
# build the marker fixture from source with its pinned toolchain, then run it
# through the real binding end-to-end. Exits nonzero on any failure so CI catches
# a broken bridge, a mis-built plugin, or the wasip1 TLS-destructor hang that a
# too-new rustc reintroduces.
#
# Usage: scripts/test-swc-plugin.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$ROOT/fixtures/plugin-marker"
WASM="$FIXTURE/target/wasm32-wasip1/release/plugin_marker.wasm"

echo "==> SWC plugin bridge regression test"

if ! command -v cargo >/dev/null 2>&1; then
  echo "FAIL: cargo not found on PATH" >&2
  exit 1
fi

# The fixture pins rustc via rust-toolchain.toml (1.86.0). rustc 1.87+ ships a
# wasip1 thread-local-destructor regression that hangs the plugin on its first
# Ident intern, so the pin is load-bearing, not incidental.
PINNED="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' "$FIXTURE/rust-toolchain.toml" | head -1)"
if [ -n "$PINNED" ] && ! rustup toolchain list 2>/dev/null | grep -q "^$PINNED"; then
  echo "FAIL: pinned toolchain '$PINNED' is not installed." >&2
  echo "      run: rustup toolchain install $PINNED && rustup target add wasm32-wasip1 --toolchain $PINNED" >&2
  exit 1
fi

echo "==> building fixture (toolchain: ${PINNED:-default})"
( cd "$FIXTURE" && cargo build --release --target wasm32-wasip1 )

if [ ! -f "$WASM" ]; then
  echo "FAIL: expected plugin wasm was not produced at $WASM" >&2
  exit 1
fi
echo "==> built $(cd "$ROOT" && du -h "$WASM" | cut -f1) plugin"

echo "==> running end-to-end transform through the binding"
node "$ROOT/scripts/plugin-bridge-test.mjs"
# plugin-bridge-test.mjs exits 0 only on PASS (marker renamed IN->OUT); its
# nonzero exits propagate through here via set -e.
echo "==> PASS: SWC plugin bridge works end-to-end"
