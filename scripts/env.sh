# Source this to set up the wasi build environment.
# Requires: sdk/wasi-sdk (see scripts/setup.sh), rustup with the nightly
# pinned by vendor/next.js/rust-toolchain.toml + wasm32-wasip1-threads target.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

export WASI_SDK_PATH="$ROOT/sdk/wasi-sdk"
# libemnapi-basic-mt.a from the `emnapi` npm package (npm install in sdk/)
export EMNAPI_LINK_DIR="${EMNAPI_LINK_DIR:-$ROOT/sdk/node_modules/emnapi/lib/wasm32-wasip1-threads}"

export CC_wasm32_wasip1_threads="$WASI_SDK_PATH/bin/clang"
export CXX_wasm32_wasip1_threads="$WASI_SDK_PATH/bin/clang++"
export AR_wasm32_wasip1_threads="$WASI_SDK_PATH/bin/llvm-ar"
export CFLAGS_wasm32_wasip1_threads="--sysroot=$WASI_SDK_PATH/share/wasi-sysroot -pthread"
export CXXFLAGS_wasm32_wasip1_threads="$CFLAGS_wasm32_wasip1_threads"

# The napi CLI sets GLOBAL CC/CFLAGS to wasi values via setEnvIfNotExists,
# which breaks host-targeted build deps (e.g. psm's aarch64 assembly in the
# 16.0.x tree: `-mllvm -wasm-enable-sjlj` is rejected by the host compile).
# Pre-set the globals to host-safe values so the CLI leaves them alone; the
# wasm compiles are driven by the target-scoped vars above, which take
# precedence in cc-rs. Non-empty on purpose ("" is falsy for the CLI's check
# and treated as unset by some cc-rs versions).
export CC=cc
export CXX=c++
export AR=ar
export RANLIB=ranlib
export CFLAGS="-O2"
export CXXFLAGS="-O2"
export HOST_CC=cc
export HOST_CXX=c++
export HOST_CFLAGS="-O2"
export HOST_CXXFLAGS="-O2"
