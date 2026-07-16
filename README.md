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

## Status

- [x] `cargo check -p next-napi-bindings --target wasm32-wasip1-threads` passes with Turbopack enabled (v16.2.10)
- [x] native (host) build unaffected by the patch series
- [ ] release `.wasm` artifact via `napi build`
- [ ] loads under a wasi-threads host; `createProject` smoke test
- [ ] `next dev` end-to-end in a browser runtime
