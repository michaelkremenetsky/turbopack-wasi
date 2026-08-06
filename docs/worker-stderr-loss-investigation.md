# The "build worker exited with code: 1" family — investigation state

This picks apart the webpack-sweep failure bucket where next's build fails
with `⨯ Next.js build worker exited with code: 1 and signal: null` and none
of the real error text (gsp-build-errors, app-dynamic-error,
json-serialize-original-error, mixed-ssg-serverprops-error,
export-image-loader ×2). Everything below was established live in-guest on
dist-deno-proto, 2026-08-06.

## The punchline so far

The guest is rendering and failing CORRECTLY. With jest-worker patched to
`silent:false` (worker stdio inherited), the dying static worker prints
exactly what upstream CI expects and exits 1 by design (prerenderEarlyExit):

    Error occurred prerendering page "/dynamic-error" ...
    Error: Route /dynamic-error with `dynamic = "error"` couldn't be rendered
      statically because it used `headers()`. ...
    Export encountered an error on /dynamic-error/page: /dynamic-error, exiting the build.

The ONLY defect is that with jest-worker's stock `silent:true` (stderr as a
pipe), those writes never surface: the parent's `child.stderr` 'data' event
never fires at all for the real static worker, even though the same parent
receives the worker's IPC messages and exit event fine. next's parent then
`process.exit(1)`s from its child-exit handler and the test sees an empty
cliOutput. So: not an error-handling bug, not an exit-ordering bug — a
piped-stderr delivery loss specific to the real static worker.

## What was ruled out (each with an in-guest probe, all deliver correctly)

- Pipe flush on fast exit: 70KB to stderr + immediate `process.exit` survives
  (spawnSync and async spawn).
- `unhandledRejection` / `uncaughtException` semantics: handlers fire,
  process stays alive.
- `fork({silent:true})`: stdout+stderr+IPC+exit code all delivered; execArgv
  `--require` preloads run.
- Exit-vs-data ordering: parent's exit handler already sees the child's
  final stderr (EXITSNAP probe).
- jest-worker itself (next's compiled copy): a worker that console.errors
  and exits 1 delivers through `getStderr()`.
- `NODE_OPTIONS=--enable-source-maps` in worker env: still delivers.
- next's double-pipe (Transform sink + collector on the same merged stream):
  still delivers.
- Full next-style wiring (fork via jest-worker, `getStderr().pipe`, parent
  `process.exit` inside `_child.on('exit')`): still delivers, data seen
  before the exit handler (T4 probe).
- execArgv contents: EXEC_ARGV_ONLY_OPTIONS is inspector-only; empty here.
- Kernel-level death: spawn trace shows the worker reaps via a genuine guest
  `exit` message code=1 (traps reap 127 with a diag line; kills reap 128+sig
  with err="killed" — neither seen).

## RESOLVED DOWN TO THE EXACT EDGE (2026-08-06, second session)

The two "suspects" below are both dead — this section supersedes them.
Established live with kernel-side probes (gated behind __SRK_SPAWN_DEBUG=1,
left in strapkit-rust os/web/runtime/kernel/kernel.js: `[stdw]` in _routeStd,
`[piperd]`/`[pipoll]`/`[pidrn]` in the pipe read/poll/drain paths):

- next's export worker does NOT patch console (plain console.error in
  export/worker.ts; `{type:'activity'}` is only sent on successful exports).
- In the failing worker, console.error IS called with the full expected text
  (processChild.js shim, /tmp/werr8.log) but process.stderr.write is NOT what
  it uses — deno's console is op_print, which writes fd2 directly. All three
  write paths (fs.writeSync(2), the node stream, op_print) deliver EARLY in
  the worker's life and are ALL lost LATE, each claiming success (writeStd is
  fire-and-forget; op_print additionally swallows BrokenPipe).
- Kernel truth: every "lost" write REACHES the kernel and IS appended to the
  child's stderr sink pipe (readOpen=1, no EPIPE, nothing dropped). The bytes
  sit in the pipe buffer forever (e.g. pipe 50: buf grows 0->514 across the
  error prints, never consumed).
- Read side: the PARENT (next build main, MAIN reactor — tgt=main on every
  poll/read) reads the pipe fine through the collect-page-data phase. At the
  export-phase transition the parked pipe poller is woken once more by the
  first error write (`[pidrn] pollers=1 r=1 tgts=main` — completion written
  to main's CQ + wake) and after that the parent NEVER issues another
  pipe-poll or pipe-read for that pipe, ever — while the same realm's
  spinner/IPC/exit handling all keep running. Even the EOF-time poll answer
  (`buf=514 wo=0 -> ready`) is never followed by a read. The export pool's
  OTHER workers' stderr pipes show the same neglect (their EARLY markers sat
  unconsumed too).

So: the readiness edge dies inside the parent guest between the CQ completion
and tokio's read task — the mio interest/waker for the pipe effectively
vanishes at the export-phase transition (new worker pool + heavy reactor
churn). Same family as the dropped cross-thread waitAsync wakeups fixed in
strapkit-rust de8af562e, and plausibly the cacheComponents stall's root.

Next step (all live-served, no rebuild): add __srkPollDbg-gated logs in
os/web/runtime/proc/wasi.js poll_oneoff — when a pipe read sub is collected
(fd, pipeId, delivered-locally vs waitSub), in handleEv for `p*` keys, and in
_consumeStrayEv — to see whether the CE1 completion was (a) matched in byOp
and returned as readiness that tokio then ignored (waker mapping/task gone),
or (b) consumed as a stray with no later pipe sub to deliver it to (interest
dropped). Case (a) points at uv_compat/node-stream backpressure or a dropped
read future; case (b) points at tokio io-driver interest loss. The repro is
one harness run (~7 min): the werr8 URL in the session scratchpad
(werr8url.txt) — jest app-dynamic-error with NEXT_TEST_SKIP_CLEANUP=1, then
patch processChild.js, then a direct `next build`.

## Remaining suspects (superseded — kept for history)

1. next's static worker bootstrap patches console/stdio. Suggestive detail:
   lib/worker.ts expects workers to emit `{type:'activity'}` IPC messages on
   log output, and the fork-tee (wtrace4) saw NO activity messages from the
   real workers — only call results. Find where the export worker installs
   its logger (dist/export/worker.js + server/lib) and what console.error
   actually writes to in that process.
2. Writes originating on a wasi thread (worker_threads inside the guest
   static worker — app-router prerender machinery) may route fd2 differently
   than main-thread writes. The cacheComponents prerender stall also lives
   in this machinery; could share a root cause.
3. Whatever it is, it must explain: IPC delivered, exit delivered, stderr
   silently dropped — for THIS worker only, while trivial workers deliver.

## Repro assets / techniques that work in-guest

- Suite: `npx jest --ci --forceExit --runInBand "app-dynamic-error"` with
  IS_WEBPACK_TEST=1, NEXT_TEST_PKG_PATHS, on dist-deno-proto.
- Keep the isolated install: env NEXT_TEST_SKIP_CLEANUP=1; it lands in
  /tmp/next-install-*; then iterate with a direct
  `./node_modules/.bin/next build` in that dir — no reinstall (~30s/cycle).
- Make worker stdio visible: patch the installed
  `next/dist/compiled/jest-worker/index.js`, `silent:true` → `silent:false`.
- Instrument every worker via the fixture's next.config.js (it's copied into
  the install and evaluated in every build process): prepend a shim that
  fs.appendFileSync's to /tmp/*.log (survives any crash) — wrap
  process.exit for call-site stacks, listen to uncaughtExceptionMonitor and
  globalThis error/unhandledrejection, monkeypatch child_process.fork to tee
  every child's stdout/stderr/message/exit.
- Kernel spawn/reap tracing: env __SRK_SPAWN_DEBUG=1 → `[spawn]` lines in the
  serve-web progress log, incl. reap codes and err reasons.

## Side findings (also open, smaller)

- NODE_OPTIONS `--require=/path` (equals form, what next's formatNodeOptions
  emits) appears NOT to run the preload in-guest, while the space form does
  (`--require /path` via execArgv works). Worth a targeted probe + fix in the
  node-options parsing.
- `DR ATTACH REFUSED(ipc-fdpass)` in the kernel log is by-design (SCM_RIGHTS
  pairs stay on the kernel path) — noisy but not a bug.
- The `file://http://.../deno.js: Invalid source map` console line comes from
  next's patch-error-inspect (caught, cosmetic); the frame file is our eval'd
  deno.js URL, `path.isAbsolute` misses it, upstream pathToFileURL prepends
  file://. Harmless; could be silenced by giving eval'd frames a
  file://-shaped sourceURL.

## Third session (2026-08-06, cont.): the eater is stray-stash starvation — two fixes landed, one gap left

- Confirmed with SRK_PIPE_DEBUG (new env flag, wasi.js/process.js/thread.js in
  strapkit-rust): the fatal poll completion surfaces as `stray-noinfo` only at
  child-EOF time — it sat undelivered for the whole failure window. No
  subpolls-clear, no strayops-overflow: the stash simply is not consumed while
  the parent realm idles.
- With SRK_POLL_DEBUG on, the parent's io driver runs ~100 EMPTY polls/s
  (nsubs=0, `empty0` counter) during the export phase — its child-pipe reads do
  NOT ride poll_oneoff subscriptions there, and neither the empty branch nor
  the first ready-now fast path consumed the stray stash.
- Fixes landed in strapkit-rust wasi.js (uncommitted, for review): stray-stash
  + CQ consumption added to (1) the first ready-now fast path and (2) the
  empty-poll branch, mirroring the timer-only branch. Both are correct and
  stay; with full debug env the suite went GREEN once.
- BUT the plain (no-debug) run still fails: capturing the edge into
  pendingReadablePipes only helps if something later re-subscribes the pipe,
  and in the quiet config the reader apparently never re-polls. Next probe:
  rerun with SRK_PIPE_DEBUG only (no POLL_DEBUG) and check whether `stray p50`
  now logs promptly (empty-branch drain working) and whether a
  `deliver-pending p50` ever follows. If prompt capture + no delivery: the
  reader's re-poll is the missing leg — look at how the parent reads child
  stdio pipes when the io driver has zero subs (uv_compat pipe read path /
  deno resource reads; libs/core/uv_compat/pipe.rs, ext/io read wiring), and
  consider a kernel-side re-kick: on _pipeWrite with buffered data and no
  pollers/pending, re-complete a captured-edge notification or wake the
  proc's park word so the reader re-polls.
- Repro assets unchanged (werr11url/werr12url in session scratchpad; ~7min/run).

## RESOLVED (2026-08-06, fourth session) — two fixes, suite green

Final root cause, established with per-poll instrumentation (sub/adopt/submit/
expire/stray/deliver-pending traces plus a pend-wait probe):

1. **Stash consulted too late in poll_oneoff.** The readiness completion the
   kernel emits at write time gets swallowed by whatever blocking awaitOp the
   parent happens to be in, and lands in the per-realm stray stash. poll_oneoff
   only drained that stash AFTER collecting subscriptions — so the captured
   edge could never deliver in the same cycle, and worse, the 2s
   adoption-expiry sweep deleted the submittedPolls entry microseconds before
   the drain saw the completion (observed as `stray-noinfo`), destroying the
   edge entirely. Fix: wasi.js now consumes the stash + reactor CQ at the TOP
   of poll_oneoff, before sub collection; a captured edge is delivered
   ready-now by the same call (`stray pN` immediately followed by
   `deliver-pending pN` in the traces). The per-branch drains this replaces
   are gone.

2. **Child exit systematically outruns child stderr.** The exit watch rides a
   ring socket whose readiness is visible guest-side at every poll; pipe
   readiness rides a completion record that can be swallowed (see 1). next's
   build parent also grinds synchronously for many SECONDS during the export
   phase (srk-pc showed `calls+0` windows with ~3s of yields) — so worker
   death and worker stderr both queue up, and at grind-end whichever the JS
   layer processes first wins. When exit won, next's parent process.exit(1)'d
   from its exit handler with the error text still unread in the sink pipe.
   Fix: kernel.js `_reap` now defers exit-watch delivery (`_exitGateArm`)
   until every stdio sink pipe that still buffers bytes, still has an open
   read end, AND has demonstrably been read/polled before (`_readerSeen`) is
   drained or loses its reader. The `_readerSeen` condition keeps plain
   "await status without reading stdout" reaping instantly; a 30s cap (far
   above any realistic parent grind — an early 3s cap expired mid-grind and
   re-created the race) covers a reader that stops reading forever. Only the
   watch path is gated; the sys_wait syscall path (shells) is untouched.

Verification: `app-dynamic-error` + `gsp-build-errors` — Test Suites: 2
passed, Tests: 8 passed, exit 0 — in the plain (no debug env) configuration
that failed on every previous attempt, after all investigation probes were
stripped. All strapkit-rust changes live in os/web/runtime (wasi.js,
kernel.js), uncommitted for review. The SRK_PIPE_DEBUG flag and every
[pipedbg]/[stdw]/[piperd]/[pipoll]/[pidrn] probe were removed; the exit gate
keeps two lines gated behind __SRK_SPAWN_DEBUG ([exitgate] hold / timeout).
