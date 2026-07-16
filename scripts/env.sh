# Source this to set up the wasi build environment.
# Requires: sdk/wasi-sdk (see scripts/setup.sh), rustup with the nightly
# pinned by vendor/next.js/rust-toolchain.toml + wasm32-wasip1-threads target.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

export WASI_SDK_PATH="$ROOT/sdk/wasi-sdk"
# libemnapi-basic-mt.a from the `emnapi` npm package (npm install in sdk/)
export EMNAPI_LINK_DIR="${EMNAPI_LINK_DIR:-$ROOT/sdk/node_modules/emnapi/lib/wasm32-wasip1}"

export CC_wasm32_wasip1_threads="$WASI_SDK_PATH/bin/clang"
export CXX_wasm32_wasip1_threads="$WASI_SDK_PATH/bin/clang++"
export AR_wasm32_wasip1_threads="$WASI_SDK_PATH/bin/llvm-ar"
export CFLAGS_wasm32_wasip1_threads="--sysroot=$WASI_SDK_PATH/share/wasi-sysroot -pthread"
export CXXFLAGS_wasm32_wasip1_threads="$CFLAGS_wasm32_wasip1_threads"
