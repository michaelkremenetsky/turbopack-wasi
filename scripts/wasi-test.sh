#!/usr/bin/env bash
# Run a turbopack crate's Rust test suite on the wasm32-wasip1-threads target —
# the thing `cargo test --target wasm32-wasip1-threads` can't do out of the box.
#
#   scripts/wasi-test.sh turbo-persistence [turbo-rcstr ...]
#
# Why this exists (each is a real blocker for running the suite on wasi):
#
#   1. Bench deps don't build. `criterion` (codspeed-criterion-compat) hard-errors
#      on wasi via rayon. Crates must target-gate it:
#        [target.'cfg(not(target_family = "wasm"))'.dev-dependencies]
#        criterion = { workspace = true }
#      (benches never run under `cargo test`, so this is loss-free.)
#
#   2. `std::env::temp_dir()` is `panic!("not supported by WASI yet")` on wasi
#      (library/std/src/sys/paths/wasi.rs), so every `tempfile`-using test aborts.
#      We inject a patched `tempfile` (falls back to $TMPDIR / /tmp on wasi) via
#      `--config patch.crates-io` — dev-dep only, prod builds untouched.
#
#   3. wasi builds are panic=abort (no unwind), so one panicking test aborts the
#      whole test binary and libtest can't isolate it. We enumerate tests and run
#      each in its OWN wasmtime process, so a panic fails only that test.
#
#   4. wasmtime >= 47 dropped the wasi-threads proposal these modules use; we pin
#      a wasmtime that still has `-S threads` and cache it locally.
#
# Everything lands under .wasi-test-cache/ (gitignored).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="${VENDOR_DIR:-$ROOT/vendor/next.js}"
CACHE="$ROOT/.wasi-test-cache"
mkdir -p "$CACHE"
TMPPREOPEN="$CACHE/tmp"; mkdir -p "$TMPPREOPEN"

[ $# -ge 1 ] || { echo "usage: $0 <crate> [crate ...]" >&2; exit 2; }

# --- 1. wasmtime with wasi-threads -------------------------------------------
WT_VER="25.0.2"
arch="$(uname -m)"; case "$arch" in arm64) arch="aarch64";; esac
WT="$CACHE/wasmtime-v$WT_VER-$arch-macos/wasmtime"
if [ ! -x "$WT" ]; then
  os="macos"
  case "$(uname -s)" in Linux) os="linux";; esac
  tarball="wasmtime-v$WT_VER-$arch-$os.tar.xz"
  echo "==> fetching wasmtime v$WT_VER (has wasi-threads)"
  curl -fsSL "https://github.com/bytecodealliance/wasmtime/releases/download/v$WT_VER/$tarball" \
    -o "$CACHE/$tarball"
  tar xf "$CACHE/$tarball" -C "$CACHE"
fi
"$WT" --version >/dev/null || { echo "wasmtime unusable" >&2; exit 1; }

# --- 2. patched tempfile (wasi temp_dir fallback) ----------------------------
# Locate the exact tempfile version in the lockfile and patch a private copy.
TF_VER="$(awk '/^name = "tempfile"$/{n=1;next} n&&/^version = /{gsub(/^version = "|"$/,"");print;exit}' "$VENDOR/Cargo.lock")"
: "${TF_VER:=3.20.0}"
TF_SRC="$(find "$HOME/.cargo/registry/src" -maxdepth 2 -name "tempfile-$TF_VER" -type d 2>/dev/null | head -1)"
TF_PATCHED="$CACHE/tempfile-$TF_VER"
if [ -n "$TF_SRC" ] && [ ! -f "$TF_PATCHED/.patched" ]; then
  rm -rf "$TF_PATCHED"; cp -R "$TF_SRC" "$TF_PATCHED"; chmod -R u+w "$TF_PATCHED"
  # Replace the std::env::temp_dir fallback with a wasi-aware one.
  perl -0pi -e 's/\.unwrap_or_else\(env::temp_dir\)/.unwrap_or_else(|| {\n            #[cfg(target_os = "wasi")] { return std::path::PathBuf::from(env::var_os("TMPDIR").unwrap_or_else(|| "\/tmp".into())); }\n            #[cfg(not(target_os = "wasi"))] { env::temp_dir() }\n        })/' "$TF_PATCHED/src/env.rs"
  touch "$TF_PATCHED/.patched"
fi

# --- 3. env + per-test isolated runner ---------------------------------------
# shellcheck disable=SC1091
source "$ROOT/scripts/env.sh"
TARGET="wasm32-wasip1-threads"
run_wasm() { "$WT" run -W threads=y -S threads=y --dir "$TMPPREOPEN::/tmp" \
  --env TMPDIR=/tmp --env RUST_BACKTRACE=1 "$@"; }

CONFIG_ARGS=()
[ -d "$TF_PATCHED" ] && CONFIG_ARGS=(--config "patch.crates-io.tempfile.path=\"$TF_PATCHED\"")

grand_pass=0; grand_fail=0; declare -a grand_failures=()
cd "$VENDOR"

# Temporarily strip an ungated `criterion` dev-dep (+ its bench target) from a
# crate's Cargo.toml so the test binary builds for wasm, restoring on exit. The
# upstream-correct form is a permanent `[target.'cfg(not(target_family =
# "wasm"))'.dev-dependencies]` move; this keeps the runner usable before that.
declare -a _restore=()
cleanup() { for m in "${_restore[@]:-}"; do [ -n "$m" ] && mv -f "$m" "${m%.wasitest-bak}"; done; }
trap cleanup EXIT

for crate in "$@"; do
  manifest="$VENDOR/turbopack/crates/$crate/Cargo.toml"
  if [ -f "$manifest" ] && grep -qE '^criterion = ' "$manifest"; then
    cp "$manifest" "$manifest.wasitest-bak"; _restore+=("$manifest.wasitest-bak")
    # drop the criterion dev-dep line and the [[bench]] section (to EOF or next table)
    perl -0pi -e 's/^criterion = .*\n//mg; s/\n\[\[bench\]\]\n(?:(?!\n\[).*\n?)*//g' "$manifest"
  fi
  echo "==> building $crate tests for $TARGET"
  build_ok=1
  cargo test -p "$crate" --target "$TARGET" --lib --no-run "${CONFIG_ARGS[@]}" 2>&1 \
    | grep -iE "error\[|error:|Finished" || true
  # `|| true` so a non-building crate (some don't compile for wasm — that's a
  # finding, not a runner crash) doesn't trip pipefail+set -e on the empty glob.
  wasm="$(ls -t "target/$TARGET/debug/deps/${crate//-/_}"-*.wasm 2>/dev/null | head -1 || true)"
  if [ -z "$wasm" ]; then
    echo "  SKIP $crate: no wasm test binary (did not build for $TARGET)"
    grand_failures+=("$crate :: <build> — did not compile for wasm32-wasip1-threads")
    continue
  fi

  mapfile -t tests < <(run_wasm "$wasm" --list --format=terse 2>/dev/null | sed -n 's/: test$//p')
  echo "==> $crate: ${#tests[@]} tests (isolated)"
  p=0; f=0
  for t in "${tests[@]}"; do
    if run_wasm "$wasm" --exact "$t" --nocapture >/dev/null 2>"$CACHE/last.err"; then
      p=$((p+1))
    else
      f=$((f+1))
      reason="$(grep -oiE "panicked at [^,]*|Error: .*|os error [0-9]+|handle_alloc_error|unreachable|out of bounds" "$CACHE/last.err" | head -1)"
      grand_failures+=("$crate :: $t — ${reason:-unknown}")
    fi
  done
  echo "    $crate: PASS=$p FAIL=$f"
  grand_pass=$((grand_pass+p)); grand_fail=$((grand_fail+f))
done

echo
echo "======== wasm32-wasip1-threads test summary: PASS=$grand_pass FAIL=$grand_fail ========"
if [ "${#grand_failures[@]}" -gt 0 ]; then
  printf '  FAIL  %s\n' "${grand_failures[@]}"
  exit 1
fi
