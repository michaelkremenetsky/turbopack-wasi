#!/usr/bin/env bash
# Build the Turbopack-enabled next-swc wasi binding for a given next.js release tag.
#
# Usage: scripts/build.sh v16.2.10
#
# Output: dist/<tag>/ containing the .wasm + JS glue produced by the napi CLI.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:?usage: build.sh <next.js tag, e.g. v16.2.10>}"
VENDOR="${VENDOR_DIR:-$ROOT/vendor/next.js}"
# Pinned to the same alpha upstream's build-native-wasi uses; see install notes below.
# (The stable v3 CLI can't drive this napi v2 crate: it sets NAPI_TYPE_DEF_TMP_FOLDER,
# but napi-derive 2.x reads TYPE_DEF_TMP_PATH, so typedefs and wasi glue never generate.)
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
# 16.0.x/16.1.x predate the worker_pool backend and the crates/napi rename;
# they carry a rebased series with a host-bridged child-process pool (the
# loader provides child_process/net, see PATCHES.md).
# 16.3.0 refactored DiskFileSystem into turbo-tasks-fs/src/disk.rs and migrated
# once_cell::Lazy -> std::sync::LazyLock, so the 16.2.x series is frozen in
# patches-16.2 (keeping those already-published builds reproducible) and
# patches/ carries the 16.3+ variants.
case "$TAG" in
  v16.0.*|v16.1.0) SERIES="$ROOT/patches-16.0" ;;
  v16.1.*) SERIES="$ROOT/patches-16.1" ;;
  v16.2.*) SERIES="$ROOT/patches-16.2" ;;
  *) SERIES="$ROOT/patches" ;;
esac
git -C "$VENDOR" switch -C "wasi-port-$TAG"
"$ROOT/scripts/apply-patches.sh" "$VENDOR" "$SERIES" || {
  echo "PATCH SERIES FAILED TO APPLY on $TAG — resolve conflicts and re-export patches." >&2
  git -C "$VENDOR" am --abort || true
  exit 2
}

# --- toolchain ---------------------------------------------------------------
"$ROOT/scripts/setup.sh"
source "$ROOT/scripts/env.sh"

# napi CLI. We use the 3.0.0-alpha CLI (matches napi crate v2's TYPE_DEF_TMP_PATH /
# WASI_REGISTER_TMP_PATH conventions and generates the v2 wasi glue), patched to accept the
# renamed wasm32-wasip1-threads triple. Its bundled emnapi is from 2023 and its C ABI does not
# match current @emnapi/core JS, so swap it for the current emnapi (must version-match the
# @emnapi/core used at runtime).
if [ ! -f "$ROOT/sdk/node_modules/napi-cli-alpha/dist/cli.js" ]; then
  # Pinned as a coherent set: @napi-rs/wasm-runtime 1.2.0 moved to the emnapi
  # 2.x alphas (peer @emnapi/core@^2.0.0-alpha.3), which both ERESOLVEs against
  # emnapi 1.x here and would violate the static-lib/JS same-version rule at
  # runtime. These are the versions the published artifacts run against.
  (cd "$ROOT/sdk" && npm install --save --ignore-scripts \
    "napi-cli-alpha@npm:@napi-rs/cli@$NAPI_CLI_VERSION" \
    emnapi@1.11.3 @emnapi/core@1.11.3 @emnapi/runtime@1.11.3 @napi-rs/wasm-runtime@1.1.6)
  # accept the renamed triple (alpha only knows wasm32-wasi-preview1-threads)
  sed -i.bak "s/rawTriple === 'wasm32-wasi-preview1-threads')/rawTriple === 'wasm32-wasi-preview1-threads' || rawTriple === 'wasm32-wasip1-threads')/" \
    "$ROOT/sdk/node_modules/napi-cli-alpha/dist/utils/target.js"
  # swap the CLI's bundled 2023 emnapi for the current one
  rm -rf "$ROOT/sdk/node_modules/napi-cli-alpha/node_modules/emnapi"
  ln -s ../../emnapi "$ROOT/sdk/node_modules/napi-cli-alpha/node_modules/emnapi"
fi

# --- build -------------------------------------------------------------------
# The bindings crate/package was renamed during 16.2.
if [ -d "$VENDOR/crates/next-napi-bindings" ]; then
  BINDINGS_PKG="next-napi-bindings"
else
  BINDINGS_PKG="next-swc-napi"
fi
mkdir -p "$VENDOR/packages/next-swc/native"
cd "$VENDOR/packages/next-swc"
node "$ROOT/sdk/node_modules/napi-cli-alpha/dist/cli.js" build \
  --platform --target wasm32-wasip1-threads \
  -p "$BINDINGS_PKG" --cwd ../../ \
  --output-dir packages/next-swc/native \
  --release --no-default-features

# 16.3.0+ registers turbo-tasks functions/traits/values through scattered-collect
# -> link-section, which on wasm keeps its registries in custom sections and reads
# them back at startup via an `env.read_custom_section` host import. The napi-cli
# loaders don't provide it (the module fails to instantiate without it), so inject
# it into the generated node loaders and ship the helper alongside them.
node "$ROOT/scripts/inject-read-custom-section.mjs" "$VENDOR/packages/next-swc/native"

# --- collect artifacts -------------------------------------------------------
DIST="$ROOT/dist/$TAG"
mkdir -p "$DIST"
cp -Rv native/. "$DIST"/
# Production pass: keep the full binary (with the ~26MB name section, useful for profiling)
# as *.debug.wasm; ship a wasm-opt'd, name-stripped binary (100MB -> ~63MB).
mv "$DIST/index.wasm32-wasi.wasm" "$DIST/index.wasm32-wasi.debug.wasm"
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -O2 -all --strip-debug --strip-producers \
    "$DIST/index.wasm32-wasi.debug.wasm" -o "$DIST/index.wasm32-wasi.wasm"
else
  echo "WARNING: wasm-opt not found (brew/apt install binaryen); shipping stripped-only binary" >&2
  "$WASI_SDK_PATH/bin/llvm-strip" --strip-all \
    -o "$DIST/index.wasm32-wasi.wasm" "$DIST/index.wasm32-wasi.debug.wasm"
fi
if command -v brotli >/dev/null 2>&1; then
  brotli -q 9 -f -k "$DIST/index.wasm32-wasi.wasm"
fi
(cd "$DIST" && shasum -a 256 index.wasm32-wasi.wasm *.cjs *.mjs *.js index.d.ts > SHA256SUMS)
echo "artifacts in $DIST"
