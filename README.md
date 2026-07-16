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

## The patch series (v16.x)

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
- [x] all 11 stable **16.2.x versions built** (8 unique fingerprints), publish dry-runs green
- [ ] CSS/tailwind pages: next's `worker_pool` JS workers must attach to the shared wasm
      instance as emnapi child threads (loader-level work; native builds share process statics)
- [ ] 16.0.x / 16.1.x rebased patch-series variants (mostly comment-rewrap conflicts)
- [ ] `next dev` end-to-end in a browser runtime

## Host contract (important)

1. Call `instance.exports.init_turbopack_wasi_runtime_raw(threads)` **before any napi call**
   (napi calls force-initialize a single-threaded fallback runtime that starves turbo-tasks).
2. Async instantiation (`instantiateNapiModule`), shared memory matching the module's declared
   limits (parse the import section), preloaded worker pool recommended.
3. `next.config`: `experimental.turbopackPluginRuntimeStrategy: 'workerThreads'`.
4. `process.cwd()` must be the app dir when loading next config (next dev semantics).
