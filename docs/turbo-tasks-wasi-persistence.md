# The on-disk turbo-tasks store on wasi

## What's actually wrong (root-caused)

Turbopack can persist its turbo-tasks cache to disk (`.next/cache/.../turbopack`)
so a second run reuses the first's work. On `wasm32-wasip1(-threads)` that path is
forced off; every build runs the in-memory (`noop`) store.

The real reason it was forced off is **not** the write-batch concurrency
assertion the gate comment blames. Running the on-disk store on wasi at cal.com
scale (see the repro below) shows it never asserts, never panics, and survives
concurrent compilation + graceful shutdown. What it does instead is fail to
persist, silently:

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

## The fix

Give `turbo-persistence` a non-mmap file backing on targets where `memmap2`
isn't supported: on wasi, read the whole file into an owned heap buffer
(`Box<[u8]>` / `Vec<u8>`) instead of mapping it. A boxed slice has a stable
address for the file's lifetime, so it satisfies the same borrow contract the
mmap paths rely on (notably `meta_file.rs`'s `FilterRef` `'static` transmute and
its declared field drop-order), arguably more safely (no unmap window).

Sites to convert (all in `turbopack/crates/turbo-persistence/src`):
- `meta_file.rs` — `MetaFile.mmap: Mmap` (`Mmap`/`MmapOptions` at `12`); this is
  the one that actually fails first (`Unable to open meta file`).
- `db.rs:610` — blob-file `Mmap::map`.
- the SST reader's mmap (`static_sorted_file*.rs`).
- `rc_bytes.rs` / `arc_bytes.rs` — already model a `Backing::Mmap` variant; add /
  reuse an owned-buffer variant for the wasi path so `RcBytes`/`ArcBytes` can be
  backed by either.
- `mmap_helper.rs` — already cfg-gates `advise_mmap_for_persistence` (linux-only,
  no-op elsewhere); the natural home for a `map_or_read(file) -> FileBacking`
  helper that is `Mmap::map` off-wasi and `read-to-end` on wasi.

Keep it behind `#[cfg(target_family = "wasi")]` (or `not`-mmap-capable) so native
builds are byte-for-byte unchanged. This is upstreamable: `memmap2` genuinely has
no wasi backend, and a read-based fallback is the conventional workaround.

Once persistence lands data, re-run the repro and confirm a second run restores
(warm cache), then the wasi force-off gate (below) can be removed.

## The gate to remove once fixed

`create_turbo_tasks`, `crates/next-napi-bindings/src/next_api/turbopack_ctx.rs:277-289`
rewrites `persistent_caching` to `false` on wasi unless
`TURBOPACK_WASI_ALLOW_DISK_STORE=1`. Its comment (recycled thread ids aliasing a
`&mut` from a thread-local `SyncUnsafeCell`) is **wrong** — that was never the
failure; replace it with the mmap explanation when the fallback lands. Installed
by patch `0023`; the 32-bit build fix that lets the crate compile at all is patch
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

Ground truth observed (Aug 2026, `index.wasm32-wasi.wasm` 85 MB): 3× 40-route
concurrent runs compiled clean (`ok=40 failed=0`, no assertion), and the
`Stop`-snapshot persist failed with the mmap error above, leaving `CURRENT` at
`seq = 0`. After a fix, the same command's store dir should contain `.sst` /
`.meta` files and a `CURRENT` at `seq > 0`, and a second run should restore.
