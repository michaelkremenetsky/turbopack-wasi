# The on-disk turbo-tasks store on wasi

## Where things stand

Turbopack can persist its turbo-tasks cache to disk (`.next/cache/.../turbopack`)
so a second `next build` reuses the first one's work. On the
`wasm32-wasip1-threads` binding that on-disk path is **forced off**: every build
runs against the in-memory (`noop`) backing store, and the persistent cache is a
no-op between runs.

The switch is a single `#[cfg(target_os = "wasi")]` block in
`create_turbo_tasks`, `vendor/next.js/crates/next-napi-bindings/src/next_api/turbopack_ctx.rs:277`.
It rewrites `persistent_caching` to `false` unless
`TURBOPACK_WASI_ALLOW_DISK_STORE=1` is set (the escape hatch exists purely so the
store bug can be reproduced/bisected). Installed by patch `0023`.

Everything below the switch already builds and links for wasi — `turbo-persistence`
is 32-bit-clean thanks to patch `0004` (`usize_from_u32`). The gap is **runtime
correctness of the disk path**, not compilation. The failure mode reported when
the store was last exercised on wasi (older pre-16.2 layout, commit message on
`patches-16.1/0017`) was the single-writer assertion tripping and wedging the
first compile:

    Another write batch is already active (only a single write operation is allowed at a time)

## The code map (verified by reading, 16.3 layout)

Selection point — `next-napi-bindings/src/next_api/turbopack_ctx.rs`:
- `create_turbo_tasks` (`259`). The wasi gate is `277-289`; the on-disk arm
  (`290-319`) calls `turbo_backing_storage(...)` and picks a `StorageMode`
  (`ReadOnly` if `TURBO_ENGINE_READ_ONLY`, `ReadWriteOnShutdown` for CI/short
  sessions, else `ReadWrite`); the in-memory arm (`320-329`) uses
  `noop_backing_storage()` + `storage_mode: None`.

Storage constructors — `turbopack/crates/turbo-tasks-backend/src/lib.rs`:
- `turbo_backing_storage` (`31`) → `TurboBackingStorage::open_versioned_on_disk`.
- `noop_backing_storage` (`46`) → `TurboBackingStorage::new_in_memory`.

The KV store is turbopack's own `turbo-persistence` crate (SST + memmap; **not**
LMDB/heed — there is no lmdb/heed anywhere). Deps: `memmap2`, `thread_local`,
`parking_lot`, `dashmap`, `qfilter`, `zerocopy`, `lzzzz`, `postcard`; none are
target-gated.

Single-writer guard — `turbopack/crates/turbo-persistence/src/db.rs`:
- `acquire_write_operation` (`661`) locks `active_write_operation:
  Mutex<Option<ActiveWriteState>>` (`259`) and bails with "Another … is already
  active" (`667`) if the slot is still `Some(Active(..))`.
- `write_batch` (`696`) and `compact` (`1248`) each acquire it; the slot is
  released by `WriteOperationGuard::drop` (`226`) — `None` on success, rollback +
  `None`/`Error` on failure.

Thread-local write state — `turbopack/crates/turbo-persistence/src/write_batch.rs`:
- `thread_locals: ThreadLocal<SyncUnsafeCell<ThreadLocalState<..>>>` (`88`).
- `thread_local_state` (`135`) hands out `&mut` from the cell, "only accessed
  from the current thread".
- `put`/`delete` (`235`/`249`) obtain that `&mut` and use it; `flush` (`264`,
  `unsafe`) and `finish` (`325`, `&mut self`) drain every bucket.

Next.js toggle: `experimental.turbopackFileSystemCacheForBuild`
(`packages/next/src/build/turbopack-build/impl.ts:81`) → napi `ProjectOptions.
isPersistentCachingEnabled` → `project.rs:609` → the `persistent_caching`
parameter of `create_turbo_tasks`. Dev uses `isFileSystemCacheEnabledForDev`.

## Why the obvious root cause does not hold up

The comment on the gate (and the first-pass investigation) blames the
`SyncUnsafeCell` in `write_batch.rs`: it hands out `&mut` on the assumption that
thread ids are stable, and the wasi blocking pool churns threads mid-batch, so
the reasoning goes that a recycled thread id aliases a live `&mut`. Reading the
actual write path, that mechanism does **not** explain the observed symptom:

1. **The `&mut` never crosses a suspension point.** `put`/`delete` fetch the
   thread-local state and the collector, mutate them, and return — all
   synchronous, no `.await`, no `parallel_scheduler` hop in between. A worker
   thread cannot be parked and recycled in the middle of one `put`, so two live
   threads never hold `&mut` into the same `SyncUnsafeCell` at once.
2. **Bucket reuse is sequential, not concurrent.** The `thread_local` crate only
   recycles a bucket after its owning thread is fully dead, and `finish` (under
   `&mut self`) drains *every* bucket — so a thread that inherits a dead thread's
   bucket sees valid, still-to-be-flushed data, not a data race, and nothing is
   lost.
3. **The reported symptom is thread-id-independent.** "Another write batch is
   already active" comes from a single global `Mutex<Option<ActiveWriteState>>`
   (`db.rs:259`), which has nothing to do with thread ids or the
   `SyncUnsafeCell`. Thread churn cannot produce that message.

So a patch to `turbo-persistence`'s thread-local handling would very likely be a
fix for a bug that isn't there — the same trap that the worker-fd investigation
fell into (a plausible code hypothesis that the runtime contradicted).

## The candidates that actually fit the symptom

Ranked by how well they explain "single write operation already active",
**all unverified** pending a repro:

1. **A leaked / not-yet-dropped `WriteOperationGuard`.** If a `write_batch` or
   `compact` errors and the guard's `Drop` rollback (`delete_orphan_files`,
   `db.rs:202`) blocks, panics, or the guard is otherwise kept alive on wasi, the
   slot stays `Active` and the *next* operation bails. This is consistent with
   "wedges the first compile" — one stuck operation poisons everything after.
2. **Genuine overlap under the wasi scheduler.** turbo-tasks may schedule a
   compaction concurrently with (or racing the teardown of) a write batch; on
   native the interleaving happens not to overlap, on wasi's different task/thread
   timing it does, tripping the single-writer guard. This is a caller-layer
   (`turbo-tasks-backend`) concern, not a `turbo-persistence` soundness bug.
3. **The symptom no longer reproduces at all.** The last data point is from the
   pre-16.2 layout. Several wasi runtime and scheduler patches have landed since
   (and the worker/fork bugs that shared the same "wasi threading is different"
   flavor turned out to be already fixed). The current disk path may simply work,
   or fail somewhere new.

## Getting ground truth (the repro that gates any fix)

There is no shortcut around actually running the on-disk store on wasi. It is a
build → install → `next build` campaign, because the binding is loaded from the
*app's* `node_modules` (`next-swc-wasi`), not baked into strapkit:

1. Build the wasi binding from this repo **with patch 0023 applied** (so the
   `TURBOPACK_WASI_ALLOW_DISK_STORE` opt-in exists) and make an app install it.
2. In the app, set `experimental.turbopackFileSystemCacheForBuild: true`.
3. Run **`next build`** (not `dev` — the build path is where
   `isPersistentCachingEnabled` flows through) under strapkit with
   `TURBOPACK_WASI_ALLOW_DISK_STORE=1`. Run it **twice** against a warm
   `.next/cache` so the second run exercises the read+write path, not just the
   initial write.
4. Capture the real error and where it originates. If it's the single-writer
   assertion, add a backtrace at `db.rs:667` and at `WriteOperationGuard::drop`
   to see which operation is holding the slot and why it wasn't released.

Only after step 4 is the fix knowable. If it is candidate 1, the fix is in the
guard/rollback path (make `Drop` release the slot even when rollback fails, which
it half-does via `ActiveWriteState::Error` — check that path on wasi). If it is
candidate 2, the fix is serializing compaction vs. write-batch in the backend
caller. If it is candidate 3, delete the gate and flip the default.

## Recommendation

Leave the gate as-is (in-memory forced, env opt-in) until the repro exists — it
is the honest posture, and flipping it blind would ship an unverified behavior
change. When the repro is run, **also correct the gate comment in
`turbopack_ctx.rs`**: its current "recycled thread ids alias a live `&mut`"
explanation is not supported by the write path and should be replaced with
whatever the repro actually shows.
