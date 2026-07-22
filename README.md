# turbopack-wasi

Next.js ships a wasi build of its native binding (`next-swc`, crate
`next-napi-bindings`) but compiles Turbopack out of it — try to use it and you
get `turbo.createProject is not supported by the wasm bindings`. This repo is a
patch series and build pipeline that puts Turbopack back in, targeting
`wasm32-wasip1-threads` so the result runs under emnapi in Node or in a
browser. The pipeline applies against any `vercel/next.js` release tag, so you
can always get an artifact matching the exact `next` version a project uses.

Prebuilt artifacts are on npm as [`next-swc-wasi`](https://www.npmjs.com/package/next-swc-wasi).
Install via the dist-tag for your next version:

```sh
npm install next-swc-wasi@next-16.2.10
```

## What the patches do

There are three series, picked by tag in `scripts/build.sh`: `patches/` for
16.2+, `patches-16.0/` for 16.0.0–16.1.0, `patches-16.1/` for 16.1.1–16.1.7.
The old tags predate the `worker_pool` backend and the `crates/napi` →
`crates/next-napi-bindings` rename, so they get rebased variants plus an extra
turbopack-node commit that stubs the child-process pool with type-compatible
wasi stand-ins (spawn/bind fail at runtime with `Unsupported`).

The 16.2 series, in order:

| # | patch | what / why |
|---|-------|------------|
| 1 | turbopack-cli-utils | crossterm → owo-colors (crossterm doesn't build on wasi; only ANSI styling was used) |
| 2 | turbopack-trace-utils | gate the `ctrl_c` signal listeners (no signals on WASI; library consumers use `new_receiver`) |
| 3 | turbo-rcstr | drop the `compile_error!` blocking the napi feature on wasm (the impl is just String delegation) |
| 4 | turbo-persistence | `usize_from_u32`: allow 32-bit targets (`<=` instead of `<`) |
| 5 | turbo-tasks-fs | wasi symlinks via `std::os::wasi::fs::symlink_path` |
| 6 | turbo-tasks-fetch | stub the fetch client on wasm (reqwest doesn't build); fetches resolve to issues |
| 7 | next-api/build/core | make `process_pool` (child processes + TCP, impossible on wasi) an opt-out feature; wasi uses the `worker_pool` (worker_threads) backend instead |
| 8 | next-napi-bindings | actually enable the turbopack/next-api napi modules on wasm32 |
| 9 | next-napi-bindings | link fixes: drop `--export-dynamic` (the binding has >100k symbols, which blows V8's wasm export limit and bloated the binary 182MB→105MB), link `crt1-reactor.o`, export `_initialize` |
| 10 | misc runtime | temp_dir fallback, a thread parker for parking_lot_core 0.9.12 on nightly, parallelism plumbing |
| 11 | next-napi-bindings | the raw pre-napi runtime-install export (see host contract below), 16MB tokio thread stacks, debug probes |
| 12 | next-napi-bindings | hold the `.next` dist-dir lockfile unlocked on wasi (no file-locking syscall exists there; `next dev` refused to boot on the `Unsupported` error) |

The 16MB stacks in patch 11 aren't optional: wasm shadow-stack frames run
several times larger than native, and the 2MB default overflows under compile
load.

On top of the series, `apply-patches.sh` points the workspace at
`vendor-crates/napi`, a fork of napi 2.16.13. Upstream compiles the custom-GC
threadsafe function out on *all* wasm targets, which means a `Buffer` dropped
on a wasi pthread calls `napi_reference_unref` off-thread and crashes under
emnapi — worker-pool task messages inside turbo-tasks hit this constantly. The
fork gates on `any(not(target_family = "wasm"), target_feature = "atomics")`
instead, which is the shape I'd propose upstream.

Still native-only, on purpose: `css` (lightningcss-napi), the turbopack trace
server, swc wasm plugins. Persistent caching compiles but only the in-memory
(`noop`) backing store has been exercised; don't trust the on-disk store on
wasi yet.

## Building

```sh
scripts/setup.sh                # fetches wasi-sdk + the pinned Rust nightly
scripts/build.sh v16.2.10       # artifacts land in dist/v16.2.10/
```

`scripts/env.sh` has the cross-compile environment (CC/AR for the wasi
target, `EMNAPI_LINK_DIR` from the emnapi npm package). On GitHub you can
trigger the `build-turbopack-wasi` workflow with a next.js tag, and a daily
workflow watches npm for new stable releases, builds them, tests them against
a real app, and publishes on green.

A couple of hard-won build gotchas, encoded in the scripts so you don't have
to care, but worth knowing if you touch them:

- napi CLI 3.0.0-alpha.45 (matches napi crate v2 conventions), patched for
  the `wasm32-wasip1-threads` triple rename. Its bundled emnapi is from 2023
  and must be swapped for the current one: the emnapi static lib and the
  runtime `@emnapi/core` JS have to be the *same version*, or async work
  silently deadlocks (the tid never lands at struct offset 20 — fun one to
  find).
- Loaders must instantiate asynchronously (`instantiateNapiModule`). The sync
  path can't complete the worker-spawn handshake for the async work pool.

## What runs today

- `cargo check` with Turbopack enabled passes on v16.2.10, and the native
  build is unaffected by the series.
- Release artifact is 63MB raw / 11MB brotli after `wasm-opt -O2` (a 100MB
  debug build with names is kept alongside), with napi's generated JS glue
  for both node and browser.
- Loads under plain Node; timers, tokio spawn, the blocking pool, fs reads
  and threadsafe functions all check out (`scripts/stage-test-async.mjs`).
- A real app (`fixtures/hello-app`, next@16.2.10) goes createProject →
  entrypoints → `writeToDisk` and compiles the page — server bundle, client
  chunks, HMR client — in about 3s (`scripts/real-app-test.mjs`).
- cal.com (next@16.2.3, version-matched artifact): 160 routes discovered,
  `/api/version` compiled with manifests in 8.2s.
- CSS/postcss pages compile through the `worker_pool` backend. Pool workers
  call three binding methods that touch global Rust state (`workerCreated`,
  `sendTaskMessage`, `recvTaskMessageInWorker`); since wasm has no shared
  process statics across worker_threads, `scripts/wasi-bindings-shim.cjs`
  bridges those calls to the main thread over `parentPort`.
- 16.0.x and 16.1.x work end-to-end with their rebased series (verified on
  16.0.11 and 16.1.2). Those versions predate `worker_pool` entirely though,
  so any JS evaluation — postcss, tailwind, webpack loaders — fails with a
  clear `Unsupported` pointing at next ≥ 16.2. Nothing to be done there; the
  child-process pool those versions want cannot exist on wasi.
- All 31 stable v16 versions build (18 unique fingerprints — many tags share
  a byte-identical Rust tree, see `scripts/build-all-v16.sh`) and are
  published.

Not done yet: `next dev` end-to-end in a browser runtime.

## Use Node 26+

Under compile load on Node 22, roughly 5–10% of runs die with
`memory access out of bounds` inside bulk memory ops on freshly allocated
regions. It's a V8 TurboFan bug family: the optimizing tier caches the shared
memory's size while another thread grows it. Liftoff-only runs
(`--no-wasm-tier-up`) are clean, every crash site is a bulk op, and Node 24
still reproduces it. Node 26 is clean over 25 runs. So: Node ≥ 26 for real
workloads, or catch the `RuntimeError` and retry.

Preallocating memory shrinks the window but can't close it (the allocator
keeps growing regardless). Separate dlmalloc footnote: initial memory must
stay under 32768 pages — a single ≥2GB free chunk overflows its chunk-size
representation at startup, though growing past 2GB in increments is fine.

## Host contract

If you're embedding the artifact, four things are non-negotiable:

1. Call `instance.exports.init_turbopack_wasi_runtime_raw(threads)` **before
   any napi call**. A napi call made first force-initializes a
   single-threaded fallback runtime that starves turbo-tasks forever.
2. Instantiate async (`instantiateNapiModule`), with a shared memory matching
   the module's declared limits (parse the import section). Preload the
   worker pool if you can.
3. `next.config`: `experimental.turbopackPluginRuntimeStrategy: 'workerThreads'`.
4. `process.cwd()` must be the app dir when next config loads — same as real
   `next dev`.

## Publishing / versioning

npm versions are immutable, so publishing plain `16.2.10` would make our own
layer's fixes unshippable for that next version forever. Every publish is
`<next-version>-build.N` instead, with a moving dist-tag `next-<next-version>`
pointing at the newest build, and `latest` tracking the highest stable next
version. `-build.N` only increments when the wasi layer itself changes.
