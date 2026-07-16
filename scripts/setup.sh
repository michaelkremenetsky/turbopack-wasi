#!/usr/bin/env bash
# One-time setup: wasi-sdk + rust toolchain for the currently vendored next.js.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WASI_SDK_VERSION=33
ARCH="$(uname -m | sed 's/x86_64/x86_64/;s/arm64/arm64/')"
OS="$(uname -s | tr '[:upper:]' '[:lower:]' | sed 's/darwin/macos/')"

if [ ! -d "$ROOT/sdk/wasi-sdk" ]; then
  mkdir -p "$ROOT/sdk"
  curl -sL -o "$ROOT/sdk/wasi-sdk.tar.gz" \
    "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_VERSION}.0-${ARCH}-${OS}.tar.gz"
  tar xzf "$ROOT/sdk/wasi-sdk.tar.gz" -C "$ROOT/sdk"
  mv "$ROOT/sdk/wasi-sdk-${WASI_SDK_VERSION}.0-${ARCH}-${OS}" "$ROOT/sdk/wasi-sdk"
  rm "$ROOT/sdk/wasi-sdk.tar.gz"
fi
mkdir -p "$ROOT/sdk/emnapi-stub"

if [ -f "$ROOT/vendor/next.js/rust-toolchain.toml" ]; then
  CHANNEL="$(grep '^channel' "$ROOT/vendor/next.js/rust-toolchain.toml" | cut -d'"' -f2)"
  rustup toolchain install "$CHANNEL" --profile minimal
  rustup target add wasm32-wasip1-threads --toolchain "$CHANNEL"
fi

echo "setup complete"
