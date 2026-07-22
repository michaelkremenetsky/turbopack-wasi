# turbopack-wasi

Next.js ships a WebAssembly build of its native binding, `@next/swc-wasm-nodejs`,
so `next` can run where there's no prebuilt native `next-swc` — StackBlitz,
WebContainers, Termux, the odd BSD. But that build has Turbopack stripped out of
it, so the moment anything touches `next dev --turbopack` you get:

```
Error: turbo.createProject is not supported by the wasm bindings.
```

This repo builds the binding *with* Turbopack left in, for
`wasm32-wasip1-threads`. It's a patch series on top of `vercel/next.js` plus a
pipeline that applies it to any release tag, so the artifact you get always
matches the exact `next` version you're running. Every published version lives
on npm as `next-swc-wasi`.

## Using it

Install the build tagged for your Next.js version:

```sh
npm install next-swc-wasi@next-16.2.10
```

The dist-tag (`next-<version>`) always points at the newest build for that
release, so you don't have to track the `-build.N` suffix yourself. Point Next
at the binding with `__INTERNAL_CUSTOM_TURBOPACK_BINDINGS` (Next's own escape
hatch for supplying raw Turbopack bindings) and read the host contract below —
this isn't a drop-in `.node` swap, there's some setup the host has to do.

## Why it needs patching at all

Turbopack assumes a native environment: a filesystem it can read and write, real
threads, subprocess spawning, TCP. Most of that has a wasi answer and some of it
doesn't, and the patch series is mostly the bookkeeping of drawing that line.
There are three series because the codebase moved under us — `patches/` covers
16.2 and up, `patches-16.0/` and `patches-16.1/` cover the older lines, which
predate both the `worker_pool` backend and the `crates/napi` →
`crates/next-napi-bindings` rename.

The bulk of it is unremarkable: crossterm doesn't build on wasi so the CLI's
issue styling moves to owo-colors; there are no signals so the Ctrl-C exit
handlers get gated off; reqwest doesn't build so the fetch client becomes a stub
that turns network fetches into build issues instead of hard errors; a couple of
`usize`/`u32` assertions have to accept a 32-bit target. Symlinks go through
`std::os::wasi::fs`. None of that is interesting, it just has to be done.

Two things took real work. The first is process isolation: Next has two ways to
evaluate JS (PostCSS, webpack loaders) during a compile — a pool of child Node
processes talking over TCP, and a pool of `worker_threads`. The subprocess pool
can't exist on wasi, so it's compiled behind a feature flag and the wasi build
uses `worker_threads`. On 16.0/16.1, which predate the worker pool entirely,
the subprocess pool is instead stubbed with type-compatible stand-ins that
compile fine and fail at runtime with a clear "needs 16.2" message — so those
builds work for everything *except* PostCSS/Tailwind, which is a limitation of
the version, not the port.

The second is the linker. `--export-dynamic` exports every symbol, and this
workspace has over 137k of them, which blows past V8's hard cap of 100k
exports per wasm module — so it's dropped, and the `#[napi]` register
functions get exported explicitly instead (which also shaves the binary from
182MB to 105MB). rustc links no C runtime for a cdylib, so nothing sets up the
main thread's thread-pointer, and napi registration spins forever inside
`pthread_key` code; linking `crt1-reactor.o` and exporting `_initialize` fixes
that.

There's also a small fork of napi-rs itself (`vendor-crates/napi`). Upstream
compiles its custom-GC threadsafe function out on every wasm target, which is a
fair call for single-threaded wasm but wrong for wasi-threads: a `Buffer`
dropped on a non-JS thread — which happens constantly, because turbo-tasks moves
worker-pool task messages across threads — calls `napi_reference_unref` from the
wrong thread and takes down emnapi. The fork gates it on
`any(not(target_family = "wasm"), target_feature = "atomics")` instead, which is
the shape I'd send upstream.

CSS and swc plugins stay native-only on purpose (lightningcss-napi and the swc
wasm plugin host don't come along), and the on-disk persistent cache compiles
but is untested — run it with the in-memory backing store.

## The host contract

The hardest bug in the whole thing wasn't a compile error, it was that napi
wraps every exported call in `within_runtime_if_available`, which quietly spins
up a single-threaded fallback tokio runtime the first time you call in. Once
that exists, you can't install a real one, and turbo-tasks' scheduler sizes
itself to one worker and deadlocks. So the host has to install the runtime
*before the first napi call*, through a raw wasm export:

1. Call `instance.exports.init_turbopack_wasi_runtime_raw(threads)` immediately
   after instantiation, before touching any napi function.
2. Instantiate asynchronously (`instantiateNapiModule`) with a shared memory
   sized to the module's declared limits — parse them out of the import section.
3. Set `experimental.turbopackPluginRuntimeStrategy: 'workerThreads'` in
   `next.config`.
4. Make `process.cwd()` the app directory when you load the Next config, the
   same as `next dev`.

For the worker pool specifically: Next's pool workers `require()` the binding
directly, but on wasm there's no instance in a fresh worker thread — native gets
process-wide statics for free, wasm doesn't. So the pool worker's binding is a
proxy that forwards the three calls the protocol uses (`workerCreated`,
`sendTaskMessage`, `recvTaskMessageInWorker`, all backed by global Rust state)
back to the main thread over `parentPort`, where they run against the real
instance. `scripts/wasi-bindings-shim.cjs` is a working reference for both sides.

## The Node version thing

Under compile load you'll occasionally hit `memory access out of bounds` inside
a `memory.copy` or `memory.fill` on a freshly grown region. It's a V8 bug, not
ours: the optimizing tier caches the shared memory's size while another thread
grows it. The tells are clean: Liftoff-only runs (`--no-wasm-tier-up`) never
reproduce it, TurboFan runs do, and every crash is a bulk memory op. It bites on
Node 22 and 24; Node 26 was clean across 25 straight runs, so **use Node ≥ 26**,
or be prepared to retry on that specific error. Preallocating memory narrows the
window but can't close it, since the allocator keeps growing anyway — the fix is
the newer V8. One unrelated gotcha: keep the *initial* memory under 32768 pages,
because a single ≥2GB free chunk overflows dlmalloc's chunk-size field at
startup. Growing past 2GB incrementally is fine.

## Building it yourself

```sh
scripts/setup.sh              # wasi-sdk + the nightly pinned by the tag
scripts/build.sh v16.2.10     # -> dist/v16.2.10/
scripts/build-all-v16.sh      # every stable v16, deduped by source fingerprint
```

`scripts/env.sh` sets up the cross-compile environment. A few sharp edges worth
knowing if you go poking:

The napi CLI is pinned to `3.0.0-alpha.45`. The stable v3 CLI can't drive this
crate — it sets `NAPI_TYPE_DEF_TMP_FOLDER` while napi-derive 2.x reads
`TYPE_DEF_TMP_PATH`, so the wasi glue never gets generated. The alpha's bundled
emnapi is from 2023 and its C ABI doesn't match current `@emnapi/core`, so the
build swaps it for the current one — and the static lib and the runtime JS have
to be the *same* version or async work silently deadlocks (the thread id never
lands where emnapi expects it). Loaders have to use async instantiation; the sync
path can't finish the worker-spawn handshake.

A GitHub Actions workflow (`watch-next-releases.yml`) checks npm daily for new
stable v16+ releases, builds them, runs a real app compile against that exact
version, and publishes over OIDC. When the series doesn't apply cleanly it opens
an issue instead — which, in practice, only happens at minor-version boundaries,
since within a line the source is usually byte-identical from release to release.

## What's verified

Real apps compile end to end: a small app-router app on 16.2.10 (createProject →
all routes → a page written to disk in ~3s), cal.com on 16.2.3 (160 routes
discovered, an app route compiled with its manifests in ~8s), and PostCSS/Tailwind
pages through the worker pool. The 16.0 and 16.1 lines are verified on their own
fixtures too, minus the worker-pool features they never had. All 31 stable v16
releases are built and on npm.

The one thing that isn't done: `next dev` running fully in-browser. The binding
works, the compile path works, but wiring it into a browser runtime's own worker
and filesystem model is its own project.
