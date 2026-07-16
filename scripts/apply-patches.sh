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
CHECKOUT="${1:?usage: apply-patches.sh <checkout-dir>}"

ls "$ROOT"/patches/*.patch | grep -v '0009-next-napi-bindings-fix-wasi-linking' | \
  xargs git -C "$CHECKOUT" am --3way

python3 - "$CHECKOUT/crates/next-napi-bindings/build.rs" <<'PYEOF'
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
open(path, "w").write(src)
print("build.rs patched (scripted)")
PYEOF

git -C "$CHECKOUT" add crates/next-napi-bindings/build.rs
git -C "$CHECKOUT" commit -q -m "next-napi-bindings: wasi linking fixes (scripted apply)" || true
echo "patch series applied"
