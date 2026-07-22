# What the patches do

There are three series, picked by tag in `scripts/build.sh`: `patches/` for
16.2+, `patches-16.0/` for 16.0.0-16.1.0, `patches-16.1/` for 16.1.1-16.1.7.
The older tags predate the `worker_pool` backend and the `crates/napi` ->
`crates/next-napi-bindings` rename, so they get rebased variants plus an
extra turbopack-node commit that stubs the child-process pool with
type-compatible wasi stand-ins (spawn/bind fail at runtime with
`Unsupported`).

The 16.2 series, in order:

| # | patch | what / why |
|---|-------|------------|
| 1 | turbopack-cli-utils | crossterm -> owo-colors (crossterm doesn't build on wasi; only ANSI styling was used anyway) |
| 2 | turbopack-trace-utils | gate the `ctrl_c` signal listeners (no signals on WASI; library consumers use `new_receiver`) |
| 3 | turbo-rcstr | drop the `compile_error!` blocking the napi feature on wasm (the impl is just String delegation) |
| 4 | turbo-persistence | `usize_from_u32`: allow 32-bit targets (`<=` instead of `<`) |
| 5 | turbo-tasks-fs | wasi symlinks via `std::os::wasi::fs::symlink_path` |
| 6 | turbo-tasks-fetch | stub the fetch client on wasm (reqwest doesn't build); fetches resolve to issues |
| 7 | next-api/build/core | make `process_pool` (child processes + TCP, impossible on wasi) an opt-out feature; wasi uses the `worker_pool` (worker_threads) backend instead |
| 8 | next-napi-bindings | actually enable the turbopack/next-api napi modules on wasm32 |
| 9 | next-napi-bindings | link fixes: drop `--export-dynamic` (the binding has >100k symbols, which blows V8's wasm export limit and bloated the binary 182MB->105MB), link `crt1-reactor.o`, export `_initialize` |
| 10 | misc runtime | temp_dir fallback, a thread parker for parking_lot_core 0.9.12 on nightly, parallelism plumbing |
| 11 | next-napi-bindings | the raw pre-napi runtime-install export (see the host contract in the README), 16MB tokio thread stacks, debug probes |
| 12 | next-napi-bindings | hold the `.next` dist-dir lockfile unlocked on wasi (there's no file-locking syscall there and `next dev` refused to boot on the `Unsupported` error) |
| 13 | next-core/next-api/bindings | run on stock configs: accept next's own JS-side default `turbopackPluginRuntimeStrategy: 'childProcesses'` (normalize it to the worker pool) and force the in-memory turbo-tasks store, since the on-disk one is broken on wasi |

About those 16MB stacks in patch 11: not optional. Wasm shadow-stack frames
run several times larger than native and the 2MB default overflows under
compile load.

On top of the series, `apply-patches.sh` points the workspace at
`vendor-crates/napi`, a fork of napi 2.16.13. Upstream compiles the custom-GC
threadsafe function out on all wasm targets. That means a `Buffer` dropped on
a wasi pthread calls `napi_reference_unref` off-thread and crashes under
emnapi, and worker-pool task messages inside turbo-tasks hit this constantly.
The fork gates on `any(not(target_family = "wasm"), target_feature =
"atomics")` instead, which is the shape I'd propose upstream.

Still native-only, on purpose: `css` (lightningcss-napi), the turbopack trace
server, swc wasm plugins. Persistent caching compiles but only the in-memory
(`noop`) backing store has been exercised. Don't trust the on-disk store on
wasi yet.
