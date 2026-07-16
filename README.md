# turbopack-wasi

Builds of Next.js's native binding (`next-swc`, the crate `next-napi-bindings`,
which contains **Turbopack** and the Rust half of Next.js) for
**`wasm32-wasip1-threads`** — the napi-rs wasi target that runs under emnapi in
Node-compatible runtimes and browsers.

Upstream ships this target already (`build-native-wasi` in
`packages/next-swc/package.json`) but compiles Turbopack out
(`turbo.createProject is not supported by the wasm bindings`). This repo
carries a small patch series (`patches/`) that turns Turbopack on for the wasi
build, and a build pipeline that applies it to any `vercel/next.js` release tag
so the artifact always matches the user's exact `next` version.

## The patch series

Three series, selected by tag (`scripts/build.sh`): `patches/` (16.2+),
`patches-16.0/` (16.0.0–16.1.0) and `patches-16.1/` (16.1.1–16.1.7) — the old
tags predate the `worker_pool` backend and the `crates/napi` →
`crates/next-napi-bindings` rename, so they carry rebased variants plus a
`turbopack-node` commit that compiles the child-process pool via
type-compatible wasi stubs (spawn/bind fail at runtime with `Unsupported`).

The 16.2 series:

| # | patch | what / why |
|---|-------|------------|
| 1 | turbopack-cli-utils | crossterm → owo-colors (crossterm doesn't build on wasi; only ANSI styling was used) |
| 2 | turbopack-trace-utils | gate `ctrl_c` signal listeners (no signals on WASI; library consumers use `new_receiver`) |
| 3 | turbo-rcstr | drop the `compile_error!` blocking the napi feature on wasm (impl is just String delegation) |
| 4 | turbo-persistence | `usize_from_u32`: allow 32-bit targets (`<=` instead of `<`) |
| 5 | turbo-tasks-fs | wasi symlink support via `std::os::wasi::fs::symlink_path` |
| 6 | turbo-tasks-fetch | stub fetch client on wasm (reqwest doesn't build); fetches resolve to issues |
| 7 | next-api/build/core | make `process_pool` (child processes + TCP — impossible on wasi) an opt-out feature; wasi uses the `worker_pool` (worker_threads) backend |
| 8 | next-napi-bindings | enable the turbopack/next-api napi modules on wasm32 + misc |
| 9 | next-napi-bindings | wasi link fixes: drop `--export-dynamic` (>100k exports exceeds V8's 100k wasm export limit; also 182MB→105MB) and link `crt1-reactor.o` + export `_initialize` (main-thread TP setup — without it napi registration spins in pthread_key handling) |
| 10 | wasi runtime fixes | temp_dir fallback, thread parker (parking_lot_core 0.9.12+nightly), parallelism plumbing |
| 11 | next-napi-bindings | raw pre-napi runtime install export (see host contract) + **16MB tokio thread stacks** (wasm shadow-stack frames are several times native size; the 2MB default overflows under compile load) + debug probes |

Additionally, `apply-patches.sh` points the workspace at **`vendor-crates/napi`**,
a fork of napi 2.16.13 that enables the custom-GC threadsafe function on
wasm+atomics (upstream compiles it out on all wasm targets, so `Buffer`/
`TypedArray` values dropped on wasi pthreads — e.g. worker-pool task messages
inside turbo-tasks — called `napi_reference_unref` off-thread and crashed under
emnapi). Upstreamable shape: `any(not(target_family = "wasm"), target_feature = "atomics")`.

Deliberately still native-only: `css` (lightningcss-napi), the turbopack trace
server, swc wasm plugins. Persistent caching compiles but should run with the
in-memory (`noop`) backing storage; the on-disk store is untested on wasi.

## Usage

```sh
scripts/build.sh v16.2.10       # artifacts land in dist/v16.2.10/
```

`scripts/setup.sh` fetches wasi-sdk and the pinned Rust nightly;
`scripts/env.sh` exports the cross-compile environment (CC/AR for
wasm32-wasip1-threads, `EMNAPI_LINK_DIR` from the `emnapi` npm package).

On GitHub, trigger the `build-turbopack-wasi` workflow with a `next.js` tag.

## Runtime requirements

- wasi p1 **threads**: shared `WebAssembly.Memory` + a host that spawns wasi
  threads on workers (browser needs COOP/COEP for SharedArrayBuffer)
- emnapi-based napi host (what `@napi-rs/cli` generates glue for)
- `worker_threads` good enough to back turbopack-node's worker pool
- 32-bit address space: max 4 GiB — use in-memory cache, expect large apps to hit the ceiling

## Gotchas encoded in scripts/build.sh

- napi CLI **3.0.0-alpha.45** (matches napi crate v2 conventions), patched for the
  `wasm32-wasip1-threads` triple rename, with its bundled 2023-era emnapi swapped for the
  current one — the emnapi **static lib and the runtime `@emnapi/core` JS must be the same
  version** (mismatch = async work silently deadlocks: tid never lands at struct offset 20).
- Loaders must use **async instantiation** (`instantiateNapiModule`) — the sync path can't
  complete the worker-spawn handshake for the async work pool.

## Status

- [x] `cargo check -p next-napi-bindings --target wasm32-wasip1-threads` passes with Turbopack enabled (v16.2.10)
- [x] native (host) build unaffected by the patch series
- [x] release `.wasm` artifact via `napi build` + `wasm-opt -O2` (**63MB raw / 11MB brotli**;
      100MB debug variant with names kept alongside; full JS glue for node + browser)
- [x] loads under plain Node 22; all primitives verified (timers, tokio spawn, blocking pool,
      fs reads, threadsafe functions) — `scripts/stage-test-async.mjs`
- [x] **real Next.js app** (`fixtures/hello-app`, next@16.2.10): createProject → entrypoints
      (all routes) → `writeToDisk` compiles the page (server bundle + client chunks + HMR
      client, ~3s first compile) — `scripts/real-app-test.mjs`
- [x] **cal.com** (next@16.2.3, version-matched artifact): createProject → **160 routes
      discovered** → `/api/version` app-route compiled with manifests in 8.2s
- [x] **CSS/postcss pages compile** through the `worker_pool` (workerThreads) backend:
      the bindings shim bridges pool-worker binding calls (`workerCreated` /
      `sendTaskMessage` / `recvTaskMessageInWorker` — all global-Rust-state ops) to the
      main thread over `parentPort` RPC (`scripts/wasi-bindings-shim.cjs`)
- [x] 16.0.x / 16.1.x rebased patch series; all 10 unique old fingerprints apply,
      16.0.0 cargo-checks green. **Caveat**: `worker_pool` only exists from 16.2.0 —
      on 16.0/16.1 any JS evaluation (postcss/tailwind/webpack loaders) fails at
      runtime with a clear `Unsupported` error (inherent to those versions; the
      child-process pool cannot exist on wasi)
- [ ] `next dev` end-to-end in a browser runtime

## Known host issue: spurious OOB traps on Node 22 (V8 TurboFan)

Under compile load on Node 22 (V8 12.x, macOS arm64 verified), ~5–10% of runs
trap with `memory access out of bounds` inside **bulk memory ops**
(`memory.copy`/`memory.fill`) on freshly allocated regions. Evidence points at
V8's optimizing tier caching the shared memory's size while another thread
grows it (a known V8 bug family; Liftoff-only runs — `--no-wasm-tier-up` — are
0/20 clean, TurboFan runs reproduce, and every crash site is a bulk op).
**Node 26 runs 0/25 clean — use Node ≥ 24 for real workloads**, or retry on
`RuntimeError: memory access out of bounds`. Preallocating memory
(`WASI_MEM_INITIAL_PAGES`) shrinks but does not close the window (the allocator
keeps growing). Also: initial memory must stay **< 32768 pages** (a single ≥2GB
free chunk overflows dlmalloc's chunk-size representation at startup; growing
past 2GB in increments is fine).

## Host contract (important)

1. Call `instance.exports.init_turbopack_wasi_runtime_raw(threads)` **before any napi call**
   (napi calls force-initialize a single-threaded fallback runtime that starves turbo-tasks).
2. Async instantiation (`instantiateNapiModule`), shared memory matching the module's declared
   limits (parse the import section), preloaded worker pool recommended.
3. `next.config`: `experimental.turbopackPluginRuntimeStrategy: 'workerThreads'`.
4. `process.cwd()` must be the app dir when loading next config (next dev semantics).
