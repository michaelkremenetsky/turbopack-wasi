# Running next.js's own jest suite inside strapkit

Status as of 2026-08-05. The goal: run the actual Next.js test corpus (the
areweturboyet set) against the wasi binding inside strapkit, and fix whatever
falls out — in this repo or in strapkit.

## Harness (strapkit side, uncommitted there)

- `os/tests/build-nextunit-seed.mjs <next-checkout>` packs `test/unit/**`,
  `test/jest-setup-after-env.ts`, the image-optimizer e2e fixtures, and a
  synthesized standalone `package.json` + `jest.config.js` (published next +
  `next/jest`, versions matched to the checkout's devDependencies) into
  `os/web/tests/local-npm/nextunit-seed.json`.
- `os/web/tests/next-jest-harness.html?swclocal=1&workers=N[&filter=..]` boots
  the kernel, writes the seed into the guest, `npm install`s, and runs
  `npx jest --ci --forceExit`, streaming to serve-web's /progress.
  (`--forceExit` is required: the binding's wasi worker threads legitimately
  keep the event loop alive after the run.)
- `?swclocal=1` serves the locally packed next-swc-wasi
  (`publish.sh v16.3.0 --pack-only`) through the kernel fetch-proxy.

## What running the suite already fixed (committed here)

1. `946e6d0` publish.sh never shipped `wasm-link-sections.cjs` — every worker
   spawn died; broke all of `next build`.
2. `ab9bbe5` pkg/loader.cjs missing `env.read_custom_section` on the main
   instantiation — LinkError, silent fallback to stock bindings.
3. `14add6e` auto.cjs gated its loadBindings wrap on the specifier containing
   "swc"; install-bindings requires it as './index', so build workers ran
   unwrapped and raced the async init.
4. `ef47023` + jest-transformer.cjs (uncommitted at time of writing): next's
   jest transformer is sync-only (transformSync -> loadBindingsSync) and a
   fresh jest worker races its first transforms against instantiation.
   Interception inside the worker is impossible (the transformer's own load is
   what engages auto.cjs), so auto.cjs now rewrites the RESOLVED next/jest
   config's transform entries — in the jest main process, where interception
   works — to point at pkg/jest-transformer.cjs, which awaits ensureInit before
   delegating. Verified: zero "Failed to load bindings" across a 4-worker run.

## Current suite numbers (next@16.3.0, test/unit, 77 suites)

- Best full sweep: 57 suites / 355 tests passing, before the jsdom/edge-runtime
  environments were installed. With them installed the failures CHANGED SHAPE
  (see below) — the remaining mass-failures are one strapkit bug, not many.

## The one big remaining blocker: deno node:vm under jest

jest runs every test file inside `vm` contexts. Two failure signatures, both
in strapkit's v8-on-wasm sandbox proxy (`v8-149/v8/mod.rs`, SANDBOX_GLOBAL):

1. `TypeError: Cannot redefine property: Array` (jsdom + edge-runtime
   environments, ~10 suites): a script inside the context does
   `Object.defineProperty(this, 'Array', ...)` (jsdom snapshotting the
   context's intrinsics onto its window). In real V8 the context global owns
   fresh CONFIGURABLE intrinsics; in the shim the defineProperty trap forwards
   to the sandbox/mirror where the define conflicts. Fix lives in the
   defineProperty/gopd traps' mirroring strategy.
2. `TypeError: Cannot read properties of undefined (reading 'error')` inside
   `globalThis.addEventListener("error", ...)` reached from
   `process.emit('newListener'/'removeListener')` -> process.ts
   `synchronizeListeners()`, triggered by next's
   `unhandled-rejection.external.tsx` wrapping process listeners inside the
   jest sandbox (~46 suites). `listeners` destructured from
   `self[eventTargetData]` is undefined — the receiver seen by deno's
   EventTarget method inside the sandbox doesn't carry the event-target data.
   Same subsystem: symbol-keyed gets/sets through the sandbox proxy.

Repro without jest (probable): contextify a sandbox, run
`Object.defineProperty(this,'X',{value:1,configurable:false});` twice with
different values; and inside a context wrap `process.on`, then call
`process.removeAllListeners('uncaughtException')`.

## Smaller known items

- Unit tests that import monorepo sources or the e2e lib are excluded in the
  generated jest config (4 suites) — they can't run against a published next.
- eslint-plugin/config suites excluded (need the eslint workspace packages).
- `next-swc.test.ts` / `parse-page-static-info.test.ts` call
  `installBindings()` INSIDE the jest sandbox: jest's module registry
  re-evaluates `build/swc/index.js` fresh, outside auto.cjs's require patch,
  so loadBindings runs unwrapped there and takes the wasm-fallback/download
  path ("Failed to load SWC binary"). Needs either a sandbox-visible custom
  bindings path that is already-initialized, or jest moduleNameMapper glue.
- The auto.cjs log-module warn filter also suppresses the *attempt detail*
  lines when loadBindings fails, which cost debugging time — consider letting
  attempts through when SRK_TURBOPACK_DEBUG is set.
