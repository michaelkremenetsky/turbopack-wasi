#!/usr/bin/env bash
# Build the Turbopack-enabled next-swc wasi binding for a given next.js release tag.
#
# Usage: scripts/build.sh v16.2.10
#
# Output: dist/<tag>/ containing the .wasm + JS glue produced by the napi CLI.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:?usage: build.sh <next.js tag, e.g. v16.2.10>}"
VENDOR="$ROOT/vendor/next.js"
NAPI_CLI_VERSION="3.0.0-alpha.45"

# --- vendor checkout ---------------------------------------------------------
if [ ! -d "$VENDOR/.git" ]; then
  git clone --filter=blob:none --depth 1 --branch "$TAG" --sparse \
    https://github.com/vercel/next.js "$VENDOR"
  git -C "$VENDOR" sparse-checkout set crates turbopack packages/next-swc packages/next scripts .cargo
else
  git -C "$VENDOR" fetch --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG" || true
  git -C "$VENDOR" checkout -f "refs/tags/$TAG"
  git -C "$VENDOR" clean -fd
fi

# --- apply patch series ------------------------------------------------------
git -C "$VENDOR" switch -C "wasi-port-$TAG"
git -C "$VENDOR" am --3way "$ROOT"/patches/*.patch || {
  echo "PATCH SERIES FAILED TO APPLY on $TAG — resolve conflicts and re-export patches." >&2
  git -C "$VENDOR" am --abort || true
  exit 2
}

# --- toolchain ---------------------------------------------------------------
"$ROOT/scripts/setup.sh"
source "$ROOT/scripts/env.sh"

# napi CLI (pins emnapi with a broken gyp install script; skip scripts)
if [ ! -f "$ROOT/sdk/node_modules/@napi-rs/cli/dist/cli.js" ]; then
  (cd "$ROOT/sdk" && npm install --no-save --ignore-scripts "@napi-rs/cli@$NAPI_CLI_VERSION" emnapi@latest)
fi

# --- build -------------------------------------------------------------------
cd "$VENDOR/packages/next-swc"
node "$ROOT/sdk/node_modules/@napi-rs/cli/dist/cli.js" build \
  --platform --target wasm32-wasip1-threads \
  -p next-napi-bindings --cwd ../../ \
  --output-dir packages/next-swc/native \
  --release --no-default-features

# --- collect artifacts -------------------------------------------------------
DIST="$ROOT/dist/$TAG"
mkdir -p "$DIST"
cp -v native/*wasm32-wasi* "$DIST"/ 2>/dev/null || cp -Rv native/. "$DIST"/
echo "artifacts in $DIST"
