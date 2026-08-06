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

## Remaining suspects (next session starts here)

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
