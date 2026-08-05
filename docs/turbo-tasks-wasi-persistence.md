# The on-disk turbo-tasks store on wasi

**Status: fixed and verified (patches 27 + 28).** The store persists, restores,
and compacts on wasi. It is kept off by default only for OPFS storage-footprint
reasons; opt in with `TURBOPACK_WASI_ALLOW_DISK_STORE=1`. The rest of this doc is
the root-cause writeup that led to the fix.

## What was actually wrong (root-caused)

Turbopack can persist its turbo-tasks cache to disk (`.next/cache/.../turbopack`)
so a second run reuses the first's work. On `wasm32-wasip1(-threads)` that path
was forced off; every build ran the in-memory (`noop`) store.

The real reason was **not** the write-batch concurrency assertion the old gate
comment blamed. Running the on-disk store on wasi at cal.com scale (see the repro
below) shows it never asserts, never panics, and survives concurrent compilation
+ graceful shutdown. What it did instead was fail to persist, silently:

    Persisting failed during shutdown: Unable to commit snapshot
    Caused by:
        0: Unable to open meta file 00000044.meta
        1: Failed to mmap
        2: platform not supported

`turbo-persistence` memory-maps every file it reads back — meta, SST and blob —
via `memmap2` (`Cargo.toml:25`, `memmap2 = "0.9.5"`). **`memmap2` has no
`wasm32-wasip1` backend**, so `Mmap::map` returns "platform not supported" the
moment `commit()` opens the meta file it just wrote to index it. The commit
returns `Err`, `WriteBatch`'s guard rolls back (`delete_orphan_files` removes
every file with `seq > seq_before`), and the error is swallowed at
`turbo-tasks-backend/src/backend/mod.rs:1448`
(`eprintln!("Persisting failed during shutdown: {err:?}")`). Net result: the
store directory ends with only a `CURRENT` file at `seq = 0` and zero `.sst` /
`.meta` / `.blob` data. The cache is write-a-no-op, so the next run restores
nothing.

This is why the WASI errno trace during shutdown is clean — `memmap2` fails
internally and issues no (failing) syscall — and why nothing ever crashes: the
failure is on the read-back-via-mmap step, caught and dropped.

## The fix (patch 27)

Gives `turbo-persistence` a non-mmap file backing where `memmap2` isn't
supported: a `FileMap` type (in `mmap_helper.rs`) that is a real `memmap2::Mmap`
off-wasi and an owned heap buffer (whole-file read) on `#[cfg(target_os =
"wasi")]`. Both `Deref<[u8]>`, so every read path is unchanged; the `madvise`
hints stay `#[cfg(unix)]` and are simply absent on the owned path. A boxed
slice's stable address preserves the zero-copy `ArcBytes`/`RcBytes` `from_mmap`
subslice invariants (and `meta_file.rs`'s `FilterRef` `'static` transmute /
field drop-order) exactly as an mmap would. Native builds are byte-identical.

`memmap2::Mmap` is swapped for `FileMap` in `meta_file.rs`, `db.rs`,
`static_sorted_file.rs`, `rc_bytes.rs`, `arc_bytes.rs`, `shared_bytes.rs` (the
`SharedBytes::MmapHandle: Deref<Target = FileMap>` bound), and the `sst_inspect`
debug bin; `mmap_helper.rs` grows the `FileMap` definition.

### Verified (patch 27, cal.com fixture, Node WASI)

`scripts/real-app-test.mjs` with `TURBOPACK_WASI_ALLOW_DISK_STORE=1
TURBO_ENGINE_IGNORE_DIRTY=1 SHORT_SESSION=0 TEST_ALL_ROUTES=1` + graceful
shutdown:

- **Before:** store dir is only `CURRENT` at seq 0 (0 data files); shutdown logs
  the swallowed `Failed to mmap / platform not supported`.
- **After:** first run persists ~1.3 GB (65 `.sst` + 4 `.meta`, `CURRENT`
  advances to seq 69); a second run **restores** and finishes in **2.5 s vs 62 s
  cold (24×)**; compaction reads old SSTs and writes new (`CURRENT` 69 → 79,
  65 → 39 SSTs) — no mmap / open / checksum errors.

The gate below (patch 28) is now a policy toggle, not a correctness one.

## The gate (now a policy toggle, patch 28)

`create_turbo_tasks`, `crates/next-napi-bindings/src/next_api/turbopack_ctx.rs`
still rewrites `persistent_caching` to `false` on wasi unless
`TURBOPACK_WASI_ALLOW_DISK_STORE=1` — but as of patch 28 that's a deliberate
policy default (the browser store lives in OPFS and a real app's cache is
~1GB+), not "it's broken." The old comment blaming a thread-local
`SyncUnsafeCell` concurrency assertion was wrong and has been replaced with the
mmap explanation. To make the store the wasi default, drop the `#[cfg(target_os
= "wasi")]` block (or invert it to an opt-out) once an OPFS quota/eviction policy
is in place. The 32-bit build fix that lets the crate compile at all is patch
`0004` (`usize_from_u32`).

## Code map (verified, 16.3 layout)

- Selection point: `turbopack_ctx.rs:259` `create_turbo_tasks`; on-disk arm
  `290-319` (`turbo_backing_storage` + `StorageMode`), in-memory arm `320-329`
  (`noop_backing_storage`).
- Storage constructors: `turbo-tasks-backend/src/lib.rs:31` / `:46`.
- Commit + swallowed error: `turbo-tasks-backend/src/kv_backing_storage.rs:316`
  (`batch.commit().context("Unable to commit snapshot")`),
  `turbo-tasks-backend/src/backend/mod.rs:1448` (eprintln, not propagated).
- Snapshot triggers: `backend/mod.rs` `SnapshotReason` (`Stop`, `IdleTimeout`,
  `RegularSnapshotInterval`, `InitialSnapshotTimeout`) — a hard `process.exit`
  fires none of them, so a persist test **must** call graceful shutdown.
- Persist path from JS: `project_shutdown` (`project.rs:841`) →
  `turbo_tasks().stop_and_wait()` → `SnapshotReason::Stop`.
- Single-writer guard (the assertion the old hypothesis blamed, never hit):
  `turbo-persistence/src/db.rs:661` `acquire_write_operation`, message at `:667`.
- mmap dependency: `turbo-persistence/src/{meta_file,db,rc_bytes,arc_bytes}.rs`,
  `memmap2` in `Cargo.toml:25`.

Next.js toggle: `experimental.turbopackFileSystemCacheForBuild`
(`packages/next/src/build/turbopack-build/impl.ts:81`) →
`ProjectOptions.isPersistentCachingEnabled` → `project.rs:609` →
`create_turbo_tasks`.

## Reproducing (host-side, no browser needed)

The wasi binding runs under Node's own `WASI` via `scripts/real-app-test.mjs`, so
the store can be exercised without strapkit. Flags added to the harness for this:
`TEST_ALL_ROUTES=1` (compile many routes → concurrent write batches),
`TEST_ROUTE_LIMIT`/`TEST_ROUTE_CONCURRENCY`, `SHORT_SESSION=0` (continuous
`ReadWrite` instead of `ReadWriteOnShutdown`), and a graceful `project.shutdown()`
before exit (`TEST_SHUTDOWN=0` to skip) so the `Stop` snapshot actually runs.

    cd turbopack-wasi
    DOTENV_CONFIG_PATH=fixtures/calcom/.env \
    NEXTAUTH_SECRET=dummy CALENDSO_ENCRYPTION_KEY=$(printf '1%.0s' {1..32}) \
    TURBOPACK_WASI_ALLOW_DISK_STORE=1 TURBO_ENGINE_IGNORE_DIRTY=1 SHORT_SESSION=0 \
    TEST_ALL_ROUTES=1 TEST_ROUTE_LIMIT=20 TEST_ROUTE_CONCURRENCY=8 \
    PROJECT_SUBDIR=apps/web NEXT_FIXTURE_VERSION=16.2.3 \
      node -r fixtures/calcom/node_modules/dotenv/config.js \
      scripts/real-app-test.mjs fixtures/calcom

Two flags are load-bearing and easy to miss:
- `TURBO_ENGINE_IGNORE_DIRTY=1` — turbopack disables the FS cache on a dirty git
  repo ("File System Cache is disabled") and the fixtures are dirty; without it
  the on-disk store never engages regardless of `ALLOW_DISK_STORE`.
- graceful `project.shutdown()` — without it the process hard-exits before any
  snapshot fires and the store looks empty for the *wrong* reason.

Ground truth (Aug 2026, `index.wasm32-wasi.wasm` 85 MB). Pre-fix: 3× 40-route
concurrent runs compiled clean (`ok=40 failed=0`, no assertion), and the
`Stop`-snapshot persist failed with the mmap error above, leaving `CURRENT` at
`seq = 0`. Post-fix (patch 27): the same command's store dir contains `.sst` /
`.meta` files and a `CURRENT` at `seq > 0`, and a second run restores in ~2.5 s
vs ~62 s cold — confirming the whole write → restore → compaction cycle.
