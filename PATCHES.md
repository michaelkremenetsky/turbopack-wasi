# The details

## What the patches do

There are four series, picked by tag in `scripts/build.sh`: `patches/` for
16.3+, `patches-16.2/` for 16.2.x, `patches-16.0/` for 16.0.0-16.1.0,
`patches-16.1/` for 16.1.1-16.1.7.
The older tags predate the `worker_pool` backend and the `crates/napi` ->
`crates/next-napi-bindings` rename, so they get rebased variants plus a
turbopack-node commit that makes the child-process pool host-bridged: the
binding exposes `initTurbopackProcessBridge(spawn, write, action, listen)`
and the pool's `Command`/`Child`/`TcpListener`/`TcpStream` delegate to the
registered host callbacks (`src/host_pool.rs`). Plain wasi has neither
subprocesses nor TCP, but the napi host usually has both — plain Node's
child_process/net, or a node-compatible wasi runtime's guest syscalls — so
the pool runs its stock length-prefixed protocol over bridged streams and
pool children are ordinary `node <entrypoint>` processes that never load
the binding. Same move as the host fetch bridge (patch 15 of the 16.2
series); with no bridge registered, spawning fails with `Unsupported` like
the old stubs did. `loader.cjs` registers the bridge whenever the binding
exports it, so pre-16.2 postcss/tailwind/webpack-loader evaluation works
wherever the loader runs.

16.3.0 forced the 16.2/16.3 split. It moved `DiskFileSystem` out of
`turbo-tasks-fs/src/lib.rs` into a new `disk.rs` (the symlink patch, #5, follows
it there), migrated the workspace from `once_cell::Lazy` to
`std::sync::LazyLock` (the temp_dir and parallelism statics, #10, change
constructor), and routes worker-count through the new `turbo_tasks::parallel`
module, and it added a synchronous `EventListener::wait` that calls
`event_listener`'s blocking API (compiled out on wasm). None of that applies to
a 16.2.x tree, and npm versions are immutable, so `patches-16.2/` is frozen to
keep the already-published 16.2.x builds reproducible while `patches/` moves
forward.

Patches 1-15 below are the same set in both `patches/` and `patches-16.2/`;
only the anchor locations and the `Lazy` -> `LazyLock` constructors differ.
The two series each carry a *different* patch #16, because the version-specific
work landed at the boundary:

- `patches-16.2/` #16 — notify watcher `follow_symlinks` fix. 16.3.0 took this
  upstream verbatim, so it's dropped from `patches/`.
- `patches/` #16 — `block_on` the new synchronous `EventListener::wait` on wasm
  (`event_listener` compiles its blocking `Listener::wait` out on
  `target_family = "wasm"`; wasm32-wasip1-threads can block, so we drive the
  listener future instead). New in 16.3.0.

The series, in order:

| # | patch | what / why |
|---|-------|------------|
| 1 | turbopack-cli-utils | crossterm -> owo-colors (crossterm doesn't build on wasi; only ANSI styling was used anyway) |
| 2 | turbopack-trace-utils | gate the `ctrl_c` signal listeners (no signals on WASI; library consumers use `new_receiver`) |
| 3 | turbo-rcstr | drop the `compile_error!` blocking the napi feature on wasm (the impl is just String delegation) |
| 4 | turbo-persistence | `usize_from_u32`: allow 32-bit targets (`<=` instead of `<`) |
| 5 | turbo-tasks-fs | wasi symlinks via `std::os::wasi::fs::symlink_path` |
| 6 | turbo-tasks-fetch | stub the fetch client on wasm (reqwest doesn't build); fetches resolve to issues (patch 15 later adds a real client via the host) |
| 7 | next-api/build/core | make `process_pool` (child processes + TCP, impossible on wasi) an opt-out feature; wasi uses the `worker_pool` (worker_threads) backend instead |
| 8 | next-napi-bindings | actually enable the turbopack/next-api napi modules on wasm32 |
| 9 | next-napi-bindings | link fixes: drop `--export-dynamic` (the binding has >100k symbols, which blows V8's wasm export limit and bloated the binary 182MB->105MB), link `crt1-reactor.o`, export `_initialize` |
| 10 | misc runtime | temp_dir fallback, a thread parker for parking_lot_core 0.9.12 on nightly, parallelism plumbing |
| 11 | next-napi-bindings | the raw pre-napi runtime-install export (see the host contract below), 16MB tokio thread stacks, debug probes |
| 12 | next-napi-bindings | hold the `.next` dist-dir lockfile unlocked on wasi (there's no file-locking syscall there and `next dev` refused to boot on the `Unsupported` error) |
| 13 | next-core/next-api/bindings | run on stock configs: accept next's own JS-side default `turbopackPluginRuntimeStrategy: 'childProcesses'` (normalize it to the worker pool) and force the in-memory turbo-tasks store, since the on-disk one is broken on wasi |
| 14 | turbo-tasks-fs | skip watching nonexistent dirs on wasi. notify's PollWatcher fallback reports them as async Io error events ("watch error" spam + spurious invalidations); inotify's synchronous PathNotFound was already swallowed, so match that |
| 15 | turbo-tasks-fetch/bindings | host fetch bridge on wasm: `initTurbopackFetchBridge(handler)` lets the loader register a node http client, so `next/font` Google Fonts downloads work. No handler registered keeps the resolve-to-issue behavior from patch 6. (Patch 24 reframes the Rust side as a `WasmHttpClient` trait) |

Patches 16-25 are `patches/`-only (16.3+); they landed with the 16.3.0 rebase
and the nightly bump that came with it, plus the later upstream-acceptability
pass (23-25):

| # | patch | what / why |
|---|-------|------------|
| 16 | turbo-tasks | `block_on` the new synchronous `EventListener::wait` on wasm (`event_listener` compiles its blocking `Listener::wait` out on `target_family = "wasm"`; wasm32-wasip1-threads can block, so drive the listener future instead) |
| 17 | turbo-rcstr | build `rcstr!` statics at runtime on 16/32-bit targets — the proc-macro emits a runtime `from_static` on wasm32, where turbo-rcstr's tagged-pointer representation makes the `const` path fail const-eval |
| 18 | next / turbopack | convert non-inline (`>7` char) `const RcStr = rcstr!(...)` module constants to `static LazyLock<RcStr>` (const-eval can't turn the interned static's pointer into an integer on wasm32) and deref at the use sites; inline literals like `"project"` stay `const` |
| 19 | turbopack-ecmascript-plugins, next-napi-bindings | drop the wasmtime SWC-plugin backend on wasm. It can't run a wasm plugin inside a wasm guest and pulls in `cap-std`/`cap-primitives`/`wasi-common`, which stopped building for wasi (recent std dropped the `wasi_ext` metadata/open-options methods those crates use). Gate the dep on `cfg(not(target_family = "wasm"))` and swap `WasmtimeRuntime` for a `NoopRuntime` stub, keeping swc_core's pure-Rust plugin *host* types |
| 20 | turbo-tasks-fetch | update the wasm fetch client for the 16.3.0 API: `session_dependent` became a `#[turbo_tasks::function]` flag (was a free `mark_session_dependent()` call), and `FetchClientConfig` grew timeout/retry fields the shared construction site now sets |
| 21 | next-napi-bindings | make `turbopackMemoryEviction` optional in `NapiTurboEngineOptions` (default `Off`) — it was the one non-`Option` field, and next's createProject omits it when the config option is unset, so projectNew rejected the whole options object. Unused on wasi anyway (persistent caching is forced off) |
| 22 | next-napi-bindings | resolve a relative dist dir against the project dir (`root_path + project_path`) on wasm. 16.3.0's new eager `create_dir_all(dist_dir)` in projectNew assumes a process cwd (native next runs in the project dir); wasi has none, so `.next` failed with ENOENT. Native path unchanged |
| 23 | next-napi-bindings, turbo-tasks-fs | stop changing wasi semantics silently: log the lockfile/store/watch fallbacks (patches 11-13) at their decision points — `debug!` on the lockfile bypass, `warn!` when persistent caching was requested but is forced to the in-memory store (with `TURBOPACK_WASI_ALLOW_DISK_STORE=1` to opt back into the on-disk path for repro), `trace!` on a skipped nonexistent-dir watch |
| 24 | turbo-tasks-fetch, next-napi-bindings | model the host fetch backend as a `WasmHttpClient` trait — the wasm analog of the native reqwest client — instead of a bare `Box<dyn Fn>` "bridge": `set_wasm_http_client` + a `HostHttpClient` impl over the JS handler's threadsafe fn. Reads as a pluggable HTTP backend rather than an embedder callback bolted on. napi export `initTurbopackFetchBridge` unchanged; no behavior change |
| 25 | next-napi-bindings | make the dev startup file-I/O benchmark robust: `create_dir_all(node_root)` before the probe (node_root may not exist yet at createProject time, so on wasi the temp-file write failed with ENOENT and printed a spurious "Failed to benchmark file I/O" warning every boot — also helps native on a fresh project), and skip the "slow filesystem / network drive" event on wasi where that distinction is meaningless |
| 26 | turbopack-ecmascript-plugins, swc-plugin-host-bridge, next-napi-bindings | actually run `experimental.swcPlugins` wasm modules, replacing patch 19's `NoopRuntime` hard-error. New `swc-plugin-host-bridge` crate implements swc's `Runtime`/`Instance`/`Caller` by handing the plugin off to a JS driver worker that owns a real WebAssembly engine (the binding has no nested engine), rendezvousing through a control block in the guest's shared linear memory and forwarding the plugin's ~40 host imports back to swc's own closures; `init_swc_plugin_bridge` registers the host callback (same shape as `initTurbopackFetchBridge`). Deletes the two `wasm_noop_runtime.rs` stubs. Pairs with the vendored `swc` fork's un-gated plugin path (wired by apply-patches.sh) and the host-side `pkg/swc-plugin-worker.mjs`. Plugins must be built with rustc ≤ 1.86 — see `docs/swc-plugin-host-bridge.md` for the 1.87+ wasip1 TLS-destructor hang |
| 27 | turbo-persistence | make the on-disk turbo-tasks store actually persist on wasi. turbo-persistence memory-maps every meta/SST/blob file via `memmap2`, which has no wasm32-wasip1 backend — `Mmap::map` fails at runtime with "platform not supported", so every snapshot commit failed opening the meta file it had just written, rolled back, and swallowed the error (the store looked empty: only `CURRENT` at seq 0, no run ever restored). New `FileMap` abstraction (`mmap_helper.rs`): a real mmap off-wasi, an owned heap buffer (whole-file read) on wasi; both `Deref<[u8]>` so read paths are unchanged and `madvise` stays `#[cfg(unix)]`. A boxed slice's stable address preserves the zero-copy `ArcBytes`/`RcBytes` `from_mmap` subslice invariants. Native builds byte-identical. Verified end-to-end on the cal.com fixture under Node WASI: persists ~1.3GB, restores in 2.5s vs 62s cold (24×), compaction reads+rewrites SSTs — see `docs/turbo-tasks-wasi-persistence.md` |
| 28 | next-napi-bindings | the on-disk store works now (patch 27), so reword the wasi persist gate (from patch 23): correct the stale comment (it blamed a thread-local `SyncUnsafeCell` concurrency assertion that was never the cause) and reframe `TURBOPACK_WASI_ALLOW_DISK_STORE` as a deliberate policy opt-in — kept off by default because the browser runtime's store lives in OPFS and a real app's cache is ~1GB+, not because it's broken |

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

Still native-only, on purpose: `css` (lightningcss-napi) and the turbopack
trace server. (SWC wasm plugins were here too: patch 19 first made them an
explicit `NoopRuntime` error instead of a silent no-op; patch 26 now runs them
for real on the host's WebAssembly engine, so an app with configured
`swcPlugins` works rather than erroring.) Persistent caching works on wasi as of
patch 27 (the `memmap2` → owned-buffer fallback): it persists, restores, and
compacts, verified at cal.com scale. It's kept off by default (patch 28) only
for OPFS storage-footprint reasons in the browser, not correctness — opt in with
`TURBOPACK_WASI_ALLOW_DISK_STORE=1`.

## Building

```sh
scripts/setup.sh                # fetches wasi-sdk + the pinned Rust nightly
scripts/build.sh v16.2.10       # artifacts land in dist/v16.2.10/
```

`scripts/env.sh` has the cross-compile environment (CC/AR for the wasi
target, `EMNAPI_LINK_DIR` from the emnapi npm package). On GitHub you can
trigger the `build-turbopack-wasi` workflow with a next.js tag. There's also
`watch-next-releases`, which polls npm every 5 minutes; when a new stable
next shows up it builds it, tests it against a real app on that exact
version, and publishes on green. On red it opens an issue with the log tails,
which in practice means "a human needs to rebase the series" and historically
only happens at minor version boundaries.

Two build gotchas that cost me real time. They're encoded in the scripts so
you don't have to care, but if you touch the scripts, know this:

- napi CLI 3.0.0-alpha.45 (matches napi crate v2 conventions), patched for
  the `wasm32-wasip1-threads` triple rename. Its bundled emnapi is from 2023
  and must be swapped for the current one. The emnapi static lib and the
  runtime `@emnapi/core` JS have to be the *same version* or async work
  silently deadlocks; the tid never lands at struct offset 20. Fun one to
  find.
- Loaders must instantiate asynchronously (`instantiateNapiModule`). The sync
  path can't complete the worker-spawn handshake for the async work pool.

## What runs today

- `cargo check` with Turbopack enabled passes on v16.2.10, and the native
  build is unaffected by the series.
- Release artifact is 63MB raw, 11MB brotli after `wasm-opt -O2` (a 100MB
  debug build with names is kept alongside), with napi's generated JS glue
  for both node and browser.
- Loads under plain Node. Timers, tokio spawn, the blocking pool, fs reads
  and threadsafe functions all check out (`scripts/stage-test-async.mjs`).
- A real app (`fixtures/hello-app`, next@16.2.10) goes createProject ->
  entrypoints -> `writeToDisk` and compiles the page (server bundle, client
  chunks, HMR client) in about 3s. That's `scripts/real-app-test.mjs`.
- cal.com, next@16.2.3, version-matched artifact: 160 routes discovered,
  `/api/version` compiled with manifests in 8.2s.
- CSS/postcss pages compile through the `worker_pool` backend. Pool workers
  call three binding methods that touch global Rust state (`workerCreated`,
  `sendTaskMessage`, `recvTaskMessageInWorker`), and wasm has no shared
  process statics across worker_threads, so `auto.cjs` bridges those calls
  to the main thread over `parentPort`.
- `next dev` end-to-end inside a browser runtime works, Turbopack compile
  and all. The browser side lives in the embedding host, not here; this repo
  just has to keep the artifact and loader honest.
- 16.0.x and 16.1.x work end-to-end with their rebased series. Those
  versions predate `worker_pool` entirely, so JS evaluation used to fail
  with `Unsupported` — the child-process pool they want can't exist on
  plain wasi. It CAN exist on the hosts we actually run on, though, so the
  pool is now host-bridged (see above): with the loader's bridge registered,
  postcss/tailwind compiles work on 16.0.x/16.1.x too (verified on 16.1.6 +
  tailwind 3, `fixtures/hello-1616-tw`).
- All 31 stable v16 versions build and are published. Only 18 unique
  fingerprints among them; many tags share a byte-identical Rust tree. See
  `scripts/build-all-v16.sh`.

## Use Node 26+

Under compile load on Node 22, roughly 5-10% of runs die with
`memory access out of bounds` inside bulk memory ops on freshly allocated
regions. It's a V8 TurboFan bug family: the optimizing tier caches the shared
memory's size while another thread grows it. Liftoff-only runs
(`--no-wasm-tier-up`) are clean, every crash site is a bulk op, and Node 24
still reproduces it. Node 26 is nearly clean; I've seen it once in CI under
heavy load, so the CI test retries that signature once. For real workloads:
Node >= 26, or catch the `RuntimeError` and retry.

Preallocating memory shrinks the window but can't close it, since the
allocator keeps growing regardless. Separate dlmalloc footnote: initial
memory must stay under 32768 pages. A single >=2GB free chunk overflows its
chunk-size representation at startup, though growing past 2GB in increments
is fine.

## Host contract

`auto.cjs` handles all of this for you. If you're embedding the artifact by
hand instead, four things are load-bearing:

1. Call `instance.exports.init_turbopack_wasi_runtime_raw(threads)` before
   any napi call. A napi call made first force-initializes a single-threaded
   fallback runtime that starves turbo-tasks forever.
2. Instantiate async (`instantiateNapiModule`), with a shared memory matching
   the module's declared limits (parse the import section). Preload the
   worker pool if you can.
3. `next.config`: `experimental.turbopackPluginRuntimeStrategy:
   'workerThreads'`. (With patch 13 the stock default also works.)
4. `process.cwd()` must be the app dir when next config loads, same as real
   `next dev`.
5. Pre-16.2 artifacts only: register the process bridge
   (`initTurbopackProcessBridge`) with child_process/net-backed callbacks if
   you want JS evaluation — `loader.cjs` is the reference implementation.
   Skipping it degrades to the old behavior (postcss/loader evaluation fails
   with `Unsupported`).

## Publishing / versioning

npm versions are immutable, so publishing plain `16.2.10` would make our own
layer's fixes unshippable for that next version forever. Every publish is
`<next-version>-build.N` instead, with a moving dist-tag
`next-<next-version>` pointing at the newest build. `-build.N` only
increments when the wasi layer itself changes. There's also a `latest` tag
that's supposed to track the highest stable next version, but it's
best-effort: CI publishes via OIDC trusted publishing, which can set a tag
during publish but can't run `npm dist-tag` afterwards, so `latest` can lag.
Use the `next-*` tags; they're the real interface.
