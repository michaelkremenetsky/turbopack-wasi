#!/usr/bin/env bash
# Apply the wasi patch series to a next.js checkout.
#
# Patches apply via git am --3way, EXCEPT the build.rs linking patch (0009):
# build.rs context drifts across versions (and on old tags the napi_build::setup()
# call is cfg'd out on macOS hosts entirely), so that change is applied by a script
# anchored on the `napi_build::setup();` literal instead.
#
# Usage: apply-patches.sh <checkout-dir>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKOUT="${1:?usage: apply-patches.sh <checkout-dir> [patch-series-dir]}"
SERIES="${2:-$ROOT/patches}"

# git am / commit need a committer identity; CI runners have none configured.
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-turbopack-wasi build}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-build@turbopack-wasi.invalid}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-$GIT_AUTHOR_NAME}"
export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-$GIT_AUTHOR_EMAIL}"

# The bindings crate was renamed crates/napi -> crates/next-napi-bindings during 16.2.
if [ -d "$CHECKOUT/crates/next-napi-bindings" ]; then
  BINDINGS_DIR="crates/next-napi-bindings"
else
  BINDINGS_DIR="crates/napi"
fi

ls "$SERIES"/*.patch | grep -v '0009-next-napi-bindings-fix-wasi-linking' | \
  xargs git -C "$CHECKOUT" am --3way

python3 - "$CHECKOUT/$BINDINGS_DIR/build.rs" <<'PYEOF'
import re, sys

path = sys.argv[1]
src = open(path).read()

if "wasi reactor crt" in src:
    print("build.rs already patched")
    sys.exit(0)

WASI_BLOCK = '''    if env::var("CARGO_CFG_TARGET_OS").is_ok_and(|value| value == "wasi") {
        // Mirrors napi_build::setup()'s wasi branch, except `--export-dynamic`: that flag
        // exports every dynamic symbol, and this workspace produces >100k of them, exceeding
        // V8's 100,000-export limit for wasm modules. Every `#[napi]` register function
        // carries `#[export_name]` and is exported explicitly by rustc regardless.
        let link_dir = env::var("EMNAPI_LINK_DIR").expect("EMNAPI_LINK_DIR must be set");
        println!("cargo:rerun-if-env-changed=EMNAPI_LINK_DIR");
        println!("cargo:rerun-if-env-changed=WASI_REGISTER_TMP_PATH");
        println!("cargo:rustc-link-search={link_dir}");
        println!("cargo:rustc-link-lib=static=emnapi-basic-mt");
        println!("cargo:rustc-link-arg=--export=malloc");
        println!("cargo:rustc-link-arg=--export=free");
        println!("cargo:rustc-link-arg=--export=napi_register_wasm_v1");
        println!("cargo:rustc-link-arg=--export-if-defined=node_api_module_get_api_version_v1");
        println!("cargo:rustc-link-arg=--export-table");
        println!("cargo:rustc-link-arg=--export=emnapi_async_worker_create");
        println!("cargo:rustc-link-arg=--export=emnapi_async_worker_init");
        println!("cargo:rustc-link-arg=--export-if-defined=wasi_thread_start");
        println!("cargo:rustc-link-arg=--import-memory");
        println!("cargo:rustc-link-arg=--import-undefined");
        println!("cargo:rustc-link-arg=--max-memory=4294967296");
        println!("cargo:rustc-link-arg=-zstack-size=6400000");
        println!("cargo:rustc-link-arg=--no-check-features");
        // The wasi reactor crt provides _initialize: main thread-pointer setup + C ctors.
        // rustc links no crt for cdylibs, and without TP setup napi registration spins
        // inside pthread_key handling. node:wasi's initialize() calls the export.
        let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let sysroot_out = Command::new(&rustc)
            .args(["--print", "sysroot"])
            .output()
            .expect("failed to run rustc --print sysroot");
        let sysroot = str::from_utf8(&sysroot_out.stdout)
            .expect("sysroot is not utf-8")
            .trim()
            .to_string();
        let target = env::var("TARGET").expect("TARGET is not set");
        println!(
            "cargo:rustc-link-arg={sysroot}/lib/rustlib/{target}/lib/self-contained/crt1-reactor.o"
        );
        println!("cargo:rustc-link-arg=--export=_initialize");
    } else {
        __ORIG_SETUP__
    }'''

# Find the napi_build::setup(); statement and any cfg attribute line directly above it.
m = re.search(r'^(?P<attr>[ \t]*#\[cfg\([^\n]*\)\]\n)?(?P<indent>[ \t]*)napi_build::setup\(\);', src, re.M)
if not m:
    sys.exit("could not find napi_build::setup(); in build.rs")

orig_stmt = "napi_build::setup();"
if m.group("attr"):
    # keep the original cfg attribute on the else-branch call only
    orig_stmt = m.group("attr").strip() + "\n        napi_build::setup();"

block = WASI_BLOCK.replace("__ORIG_SETUP__", orig_stmt)
src = src[: m.start()] + block + src[m.end() :]

# Upstream gates this linker workaround on the HOST os (build scripts compile
# for the host), so Linux hosts inject a cc-style flag into wasm links, which
# rust-lld rejects. Gate it on the compile target instead.
HOST_CFG_LINE = (
    '    #[cfg(all(target_os = "linux", not(target_arch = "wasm32")))]\n'
    '    println!("cargo:rustc-link-arg=-Wl,--warn-unresolved-symbols");\n'
)
TARGET_CHECK = (
    '    // (wasi patch) upstream gated this on the HOST os; build scripts compile for\n'
    '    // the host, so Linux hosts injected a cc-style flag into wasm links. Gate on\n'
    '    // the compile target instead.\n'
    '    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {\n'
    '        println!("cargo:rustc-link-arg=-Wl,--warn-unresolved-symbols");\n'
    '    }\n'
)
if HOST_CFG_LINE in src:
    src = src.replace(HOST_CFG_LINE, TARGET_CHECK, 1)
    print("build.rs host-cfg linker workaround retargeted")

open(path, "w").write(src)
print("build.rs patched (scripted)")
PYEOF

git -C "$CHECKOUT" add "$BINDINGS_DIR/build.rs"
git -C "$CHECKOUT" commit -q -m "next-napi-bindings: wasi linking fixes (scripted apply)" || true

# Pre-16.2 series: the wasi_stubs module registration in turbopack-node/src/lib.rs
# is scripted (anchored on `mod pool;`) because the surrounding module list drifts
# across tags. The stub file itself lands via the 0007 patch.
TPN_LIB="$CHECKOUT/turbopack/crates/turbopack-node/src/lib.rs"
if [ -f "$CHECKOUT/turbopack/crates/turbopack-node/src/wasi_stubs.rs" ] && \
   ! grep -q "mod wasi_stubs" "$TPN_LIB"; then
  python3 - "$TPN_LIB" <<'PYEOF'
import sys

path = sys.argv[1]
src = open(path).read()
anchor = "mod pool;\n"
if anchor not in src:
    sys.exit("could not find `mod pool;` in turbopack-node/src/lib.rs")
block = (
    anchor
    + "// Type-compatible stand-ins for tokio's process/net APIs (which don't exist on\n"
    + "// wasi) so the child-process pool compiles there; spawning fails at runtime.\n"
    + '#[cfg(target_family = "wasm")]\n'
    + "mod wasi_stubs;\n"
)
open(path, "w").write(src.replace(anchor, block, 1))
print("turbopack-node lib.rs patched (scripted)")
PYEOF
  git -C "$CHECKOUT" add "$TPN_LIB"
  git -C "$CHECKOUT" commit -q -m "turbopack-node: register wasi_stubs module (scripted apply)" || true
fi

# Point the workspace at our napi fork (vendor-crates/napi): upstream napi-rs
# compiles the custom-GC threadsafe function out on ALL wasm targets, so
# Buffer/TypedArray values dropped on wasi pthreads (e.g. NapiTaskMessage
# buffers inside turbo-tasks) call napi_reference_unref off-thread and crash
# under emnapi. The fork re-enables it for wasm + atomics. Scripted (not a
# .patch) because the path is machine-specific.
python3 - "$CHECKOUT/Cargo.toml" "$ROOT/vendor-crates/napi" <<'PYEOF'
import sys

path, napi_path = sys.argv[1], sys.argv[2]
src = open(path).read()

if "vendor-crates/napi" in src:
    print("Cargo.toml already points at the napi fork")
    sys.exit(0)

line = f'napi = {{ path = "{napi_path}" }} # turbopack-wasi fork: custom GC on wasm+atomics\n'
if "[patch.crates-io]" in src:
    src = src.replace("[patch.crates-io]\n", "[patch.crates-io]\n" + line, 1)
else:
    src += "\n[patch.crates-io]\n" + line
open(path, "w").write(src)
print("Cargo.toml patched with napi fork")
PYEOF

git -C "$CHECKOUT" add Cargo.toml
git -C "$CHECKOUT" commit -q -m "workspace: use turbopack-wasi napi fork (custom GC on wasm+atomics)" || true
echo "patch series applied"
