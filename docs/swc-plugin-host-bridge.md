# Running SWC wasm plugins on a wasm host

## The problem

`experimental.swcPlugins` entries are themselves WebAssembly modules. Upstream runs
them with `swc_plugin_backend_wasmtime` — an embedded wasmtime engine. That engine
can't be compiled into our `wasm32-wasip1-threads` binding (no nested JIT, and it
drags in the `cap-std`/`wasi-common` stack that doesn't build for the target), so
today the binding swaps in `NoopRuntime`, whose `init` just bails:

    SWC wasm transform plugins are not supported on wasm host targets

Everything else about the plugin pipeline already type-checks and runs — plugin
module construction, config parsing, the whole `turbopack-ecmascript-plugins`
transform — right up to the point where a plugin would actually execute.

The native compiler transforms people usually reach for (`compiler.styledComponents`,
`compiler.emotion`, `next/font`, server actions, …) are Rust passes compiled straight
into the binding and already work. This document is only about the remaining gap:
third-party `experimental.swcPlugins` wasm modules.

## Why "just run it on the host WASI instance" isn't enough

An SWC plugin looks like a standalone wasm program but behaves like a co-routine.
During a single `__transform_plugin_process_impl` call it calls back into the host
around forty times (`swc_plugin_runner::imported_fn::build_import_object`):

- **metadata** — `__get_transform_plugin_config`, `__get_transform_context`, …
- **comments** — `__get_leading_comments_proxy`, `__add_trailing_comment_proxy`, …
- **source map** — `__lookup_char_pos_source_map_proxy`, `__span_to_lines_proxy`, …
- **hygiene** — `__mark_fresh_proxy`, `__syntax_context_apply_mark_proxy`, …
- **result / diagnostics** — `__set_transform_result`, `__emit_diagnostics`, …

Each of those imports is a Rust closure that (a) reads and mutates guest-resident swc
state — the `SourceMap`, the global hygiene interner, `Arc<Mutex<Vec<u8>>>` comment and
result buffers — and (b) reads and writes the **plugin's own** linear memory through a
`Caller` (`alloc` / `free` / `read_buf` / `write_buf`). And `Instance::transform` is
**synchronous**: it's called from inside swc's transform pass and must return a `u32`,
with no await point.

So you can't hand the plugin off to the host, let it run to completion, and collect a
result the way the fetch bridge (`WasmHttpClient`) does — fetch is genuinely async and
self-contained. The plugin has to interleave with live guest state mid-run.

Two tempting shortcuts, both rejected:

- *Service the imports in JS from pre-serialized snapshots.* Works for the read-only
  metadata calls, but the hygiene proxies mutate swc's global `Mark`/`SyntaxContext`
  interner, and reproducing that (plus the exact comment/source-map wire formats) in JS
  means reimplementing swc internals in JavaScript. Fragile, version-coupled, and not
  something upstream would take.
- *Keep the closures in the guest but run the plugin in the guest too.* That's the
  wasmtime approach, and it's exactly what doesn't build.

The design that keeps swc honest is the one where **JS is a dumb wasm-engine host**: it
instantiates the plugin, runs its exports, and forwards every env import back to the
unmodified guest closures. JS reimplements none of swc. The cost is that "forward back
to the guest" has to cross a wasm-instance boundary synchronously.

## Topology that makes it work

Three participants, all off the JS event-loop thread (so blocking is legal):

- **T** — the turbo-tasks worker thread inside the guest that is running the transform
  pass. It owns the guest swc state and the `imports` closures.
- **P** — a dedicated JS worker that owns the plugin `WebAssembly.Instance`. Never the
  main thread (the main thread can't `Atomics.wait`).
- **C** — a small shared `SharedArrayBuffer` control block that T and P hand-shake over.

The linear memories are shared buffers:

- **G** — the guest's own linear memory. It's already a shared `WebAssembly.Memory`
  (threads build), so P can view it.
- **M** — the plugin's linear memory, a shared `WebAssembly.Memory` created by P. P can
  view it; T cannot (T is guest wasm and only sees G).

Because P can see both G and M, every byte transfer is a memcpy P performs — T and P
never need a third staging buffer.

## The coroutine protocol

    T: serialize Program into G, post {TRANSFORM, g_ptr, g_len, mark, comments} to C,
       Atomics.notify(P), then loop-wait on C.

    P: wake. Ensure the plugin instance for this module is built (cache by module bytes
       hash). Copy G[g_ptr..g_len] into M via the plugin's __alloc. Call
       __transform_plugin_process_impl(m_ptr, m_len, mark, comments).

       When the plugin calls an env import (a JS function P installed):
         P: post {IMPORT, idx, args...} to C, notify(T), wait on C.

    T: wake on IMPORT. Run imports[idx].func(caller, args). The closure may issue
       Caller ops; each is a request back to P:
         T: post {CALLER, op, ...} to C, notify(P), wait on C.
         P: perform op against M (alloc/free/memcpy), post {CALLER_DONE, ret}, notify(T).
       When the closure returns, T posts {IMPORT_DONE, rets...}, notify(P), wait again.

    P: resume the plugin with the import's return values. Eventually
       __transform_plugin_process_impl returns; P posts {TRANSFORM_DONE, ret_ptr},
       notify(T).

    T: wake on TRANSFORM_DONE. free the program allocation, read the result buffers
       (already populated by the __set_transform_result closure), return.

T and P are symmetric nested wait-loops. Neither blocks the main thread. The only
serialization crossing the boundary is opaque bytes; all swc logic stays in T.

### Cost

Per transform: one round trip to place the program, ~N import calls, and a few Caller
ops per import. Comment-proxy-heavy plugins on comment-heavy files are the worst case
(hundreds of round trips); metadata-only plugins are cheap (tens). A futex round trip is
microseconds, so overhead is milliseconds per file — and only for files a plugin
actually touches. Acceptable, and it degrades gracefully rather than being wrong.

## Where the code lives

Guest (built into the binding, replacing `NoopRuntime`):

- A new `HostBridgeRuntime` implementing `swc_plugin_runner::runtime::{Runtime,
  Instance, Caller}`. `prepare_module` keeps the raw bytes; `init` registers the plugin
  with P and stashes the `imports` Vec indexed by position; `transform` runs the T-side
  loop; the `Caller` impl issues CALLER requests. Shared by both plugin pipelines
  (`turbopack-ecmascript-plugins` and the legacy `next-napi-bindings` transform) — the
  two duplicate `wasm_noop_runtime.rs` copies collapse into this one implementation.
- A napi export `init_swc_plugin_bridge(handler)` next to `init_turbopack_fetch_bridge`
  in `next-napi-bindings/src/lib.rs`, handing JS the control-block wiring. Same
  register-once `OnceLock` + `set_…` pattern as `set_wasm_http_client`.

Host (the sdk loader, `pkg/loader.cjs` + a new worker script):

- The P worker: instantiates plugin wasm with a WASI shim + the ~40 env imports (each a
  thin function that drives the C protocol), caches instances by module hash, and owns M.
- Loader wiring to spawn P lazily on the first `init_swc_plugin_bridge` call and connect
  the control block.

## Build stages

1. **Guest skeleton.** `HostBridgeRuntime` + the napi bridge export, compiling into the
   binding, with the C protocol defined as a shared header. No JS driver yet — `init`
   without a registered host still returns a clear error (parity with today, but routed
   through the new path). Collapse the two `wasm_noop_runtime.rs` copies.
2. **JS driver.** The P worker: plugin instantiation, WASI shim, env-import forwarding,
   instance cache.
3. **Wire + end-to-end.** Spawn P from the loader, connect the control block, run a real
   plugin (`@swc/plugin-emotion` or a trivial custom plugin) against a fixture app and
   diff the output against native swc.
4. **Hardening.** Error/panic propagation across the boundary, schema-version mismatch
   messages, module-cache eviction, and a fixture in the CI real-app flow.

## Building the plugins themselves

The bridge runs whatever `wasm32-wasip1` plugin you hand it, but the plugin has to be
built with a sane toolchain. SWC plugins intern every identifier string through hstr's
thread-local `Atom` store during AST (de)serialization. rustc 1.87+ ships a std change to
wasip1 thread-local *destructor* registration that spins forever inside wasi-libc's
`pthread_key_delete` — it walks a thread list that was never initialized (the module has
no `_start`) — the first time such a thread-local with a `Drop` type is touched. The
symptom is a plugin that hangs on its very first `Ident` decode, under *any* host engine
(reproduced identically under V8 and under stock wasmtime), with a backtrace that ends in
`__pthread_key_delete ← LazyKey::lazy_init ← hstr::Atom::from ← Ident::decode`.

Pin the plugin build to the last toolchain before that regression. `fixtures/plugin-marker`
does this with a `rust-toolchain.toml` (`channel = "1.86.0"`), which is also how the SWC
project builds its own fixture plugins. To sanity-check a freshly built plugin in
isolation before wiring it through the whole bridge, run it under the fuel-instrumented
wasmtime probe — a healthy plugin returns in tens of thousands of fuel units; a hung one
traps on fuel exhaustion with the TLS backtrace above.

## Status

**Done — the bridge runs real transforming plugins end-to-end under V8.**
`scripts/plugin-bridge-test.mjs` compiles `fixtures/plugin-marker`, registers the driver
worker, and runs `transform` with `experimental.plugins`; the marker plugin renames
`__PLUGIN_MARKER_IN__` → `__PLUGIN_MARKER_OUT__` and the transformed output comes back
correctly renamed. Stages 1–3 are complete. Remaining Stage-4 hardening: panic propagation
across the boundary, schema-version-mismatch messaging, module-cache eviction, and folding
the fixture build + e2e into the CI real-app flow.
