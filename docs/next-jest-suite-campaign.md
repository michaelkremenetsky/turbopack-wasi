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

## The big blocker: deno node:vm under jest (1 of 2 fixed)

jest runs every test file inside `vm` contexts. Two failure signatures, both
around strapkit's v8-on-wasm sandbox proxy (`v8-149/v8/mod.rs`,
SANDBOX_GLOBAL):

1. FIXED (strapkit side, uncommitted there): `TypeError: Cannot redefine
   property: Array` (~10 suites, jsdom + edge-runtime environments). Root
   cause, reproduced byte-for-byte in plain node by extracting SANDBOX_GLOBAL
   + EVAL_IN_REALM out of mod.rs and replaying
   @edge-runtime/jest-environment's bootstrap: `globalThis.Array = x`
   (patchInstanceOf) makes OrdinarySet consult the RECEIVER's own descriptor,
   our gopd trap reports the intrinsic fallback, so OrdinarySet issues a
   VALUE-ONLY [[DefineOwnProperty]]; the defineProperty trap forwarded that
   partial descriptor to a fresh define on the sandbox, defaulting
   writable/enumerable/configurable to FALSE. revealPrimitives' subsequent
   `Object.defineProperty(this,'Array',{configurable:false,...})` then died
   with "Cannot redefine". Fix: the defineProperty trap materializes the
   intrinsic onto the sandbox (writable, non-enumerable, configurable — what
   a real context global owns) before defining, so native merge semantics
   apply. Verified in-guest: the redefine signature is gone and the edge
   environment constructs.
2. STILL OPEN: `TypeError: Cannot read properties of undefined (reading
   'error')` at `addEventListener (<anonymous>:29:53)` invoked from
   process.emit, reached from next's unhandled-rejection.external.tsx wrapping
   process listeners (~46 suites, all environments; with --runInBand it kills
   every next-importing suite). Chasing it with SRK_EVDBG=1 instrumentation in
   deno's _events.mjs (REGISTER/INVOKE probes with _rawDebug — jest's console
   capture swallows console.error inside suites — plus a throw-site probe
   around emit's listener apply). Note the "ext:...:LINE" numbers in guest
   stacks do NOT map 1:1 to polyfill sources (runtime lowering shifts them),
   and an `eval at <anonymous>` frame may be any runtime-eval'd script whose
   name mapping was lost — don't trust the frame label, trust the probes.

## Smaller known items

- Unit tests that import monorepo sources or the e2e lib are excluded in the
  generated jest config (4 suites) — they can't run against a published next.
- eslint-plugin/config suites excluded (need the eslint workspace packages).
- `next-swc.test.ts` / `parse-page-static-info.test.ts` call
  `installBindings()` INSIDE the jest sandbox: jest's module registry
  re-evaluates `build/swc/index.js` fresh, outside auto.cjs's require patch,
  so loadBindings runs unwrapped there. Addressed (ebb719b, unverified until
  the vm blocker clears): loader.cjs now keys its init state off
  `Symbol.for('next-swc-wasi.loaderState')` on globalThis, so a fresh loader
  instance in another module registry shares the one instantiation and
  self-grafts synchronously at require time — binding.cjs's ready check then
  passes inside the sandbox and loadNative succeeds through the env-var
  custom-bindings path.
- The auto.cjs log-module warn filter also suppresses the *attempt detail*
  lines when loadBindings fails, which cost debugging time — consider letting
  attempts through when SRK_TURBOPACK_DEBUG is set.
