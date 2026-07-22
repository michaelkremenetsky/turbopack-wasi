# turbopack-wasi

Next.js ships a wasi build of its native binding (`next-swc`, crate
`next-napi-bindings`), but Turbopack is compiled out of it. Try to use it and
you get `turbo.createProject is not supported by the wasm bindings`. This repo
is a patch series and a build pipeline that put Turbopack back in. The target
is `wasm32-wasip1-threads`, so the artifact runs under emnapi, in Node or in a
browser. The pipeline applies against any `vercel/next.js` release tag, which
matters because the binding has to match the exact next version a project
uses.

Prebuilt artifacts are on npm as
[`next-swc-wasi`](https://www.npmjs.com/package/next-swc-wasi), one dist-tag
per next version:

```sh
npm install next-swc-wasi@next-16.2.10
```

The loader ships inside the package. In a Node-compatible wasi-threads host,
`require('next-swc-wasi/auto.cjs')` once per process before any next code
loads (`NODE_OPTIONS=--require` is the easy way) and you're done: it hooks
next's custom-bindings escape hatch, does the async instantiation, and
bridges the worker pool. Stock next configs, no edits to next itself. This is
deliberate. Anything that knows about next internals lives in the
version-matched package, so when next changes, the fix ships as a new build
on the same dist-tag and the host never has to care.

## What the patches do

See [PATCHES.md](PATCHES.md): the three series, the per-patch table, the napi
fork, and what's still native-only.

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
- 16.0.x and 16.1.x work end-to-end with their rebased series (verified on
  16.0.11 and 16.1.2). Those versions predate `worker_pool` entirely though,
  so any JS evaluation (postcss, tailwind, webpack loaders) fails with a
  clear `Unsupported` pointing at next >= 16.2. Nothing to be done there.
  The child-process pool those versions want cannot exist on wasi.
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
