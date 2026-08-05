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
- `&cmd=<shell>` replaces the jest invocation with an arbitrary command (still
  after `npm install`, still cd'd into the seeded project). Heredoc a probe
  script through it to poke at the installed node_modules directly — that is
  how the vm-leak repro below was isolated.
- `&env=SRK_EVDBG=1` turns on the (uncommitted, strapkit-side) vm/event
  instrumentation: sandbox-proxy trap probes, process listener register/invoke
  probes, and a listener-throw probe, all via `process._rawDebug`.
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

- With both vm bugs fixed (below): 72 suites / 555 tests / 112 snapshots
  passing, 5 suites failing (4-worker run, wall clock ~13s of jest time).
- Of the 5 remaining failures, 4 were seed gaps, not runtime bugs: the
  generated standalone package.json was missing @babel/preset-typescript
  (babel-plugin-next-page-config) and @testing-library/react + jest-dom
  (next-dynamic, link-warnings, link-without-router). Seed builder fixed,
  re-run pending.
- The 5th (web-runtime/next-response, 2 tests) was a real bug: undici's
  readableStreamClose() treats a double controller.close() as benign by
  string-matching node's error wording, and deno's 06_streams wording
  ("ReadableByteStreamController's stream is not in a readable state")
  doesn't match, so the benign teardown surfaced as a test failure. Fixed
  strapkit-side by giving the byte controller's close() node's wording
  ("Invalid state: Controller is already closed" / "Invalid state:
  ReadableStream is already closed") — would bite real deno running npm
  undici the same way, so it's an upstream candidate.
- Historical: best sweep before the vm fixes was 57 suites / 355 tests.
- vm regression gate after both fixes: the full parallel/test-vm-* node-compat
  set (98 tests) shows 70 pass / 18 fail / 8 ignore with ZERO regressions —
  every failure also fails (or is ignored) in real deno 2.9 on linux
  (node-test-viewer baseline 2026-07-01).

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
2. FIXED (strapkit side, uncommitted there): every top-level `function f(){}`
   in a vm script was being instantiated onto the HOST global at
   `new vm.Script(...)` COMPILE time. Symptom in the suite: `TypeError:
   Cannot read properties of undefined (reading 'error')` at
   `addEventListener`, thrown from deno's process.ts `synchronizeListeners()`
   -> `globalThis.addEventListener("error", processOnError)` — because
   `globalThis.addEventListener` had been replaced by @edge-runtime/vm's
   in-context `function addEventListener(type, handler)`, which dereferences
   `self.__listeners[...]` and finds nothing. ~46 suites; under --runInBand a
   single edge-environment suite poisoned the whole run.

   Root cause: the shim's compile-time syntax check (`validate_script_src`,
   v8-149/v8/mod.rs) validated vm-script source with

       (0,eval)('throw __srk_never_defined;\n' + src)

   Sloppy INDIRECT eval runs at host-global scope, and per spec
   EvalDeclarationInstantiation runs BEFORE the prefixed throw executes — so
   every top-level function declaration was instantiated through
   CreateGlobalFunctionBinding on the real global (no proxy, no trap), while
   plain statements (assignments) never ran. That explains every observation
   that made this look spooky: declarations leaked as fully compiled
   functions, assignments didn't, the poison landed BEFORE eval_in_realm's
   own (correctly sandboxed) evaluation, and no JS-visible set/defineProperty
   hook ever fired. The earlier "only leaks when the host owns the name"
   theory was instrumentation bias — a probe watching only addEventListener;
   fresh names leaked too (`function toString(){}` left an OWN toString on
   the host global).

   Fix: make the validation eval DIRECT (`eval(...)` inside the helper
   function instead of `(0,eval)(...)`). Same sloppy script grammar, same
   engine SyntaxError wording and compile-time timing, but declaration
   instantiation now targets the helper's own function scope, which is
   discarded on return. (`validate_fn_body`'s eval-throw is strict-mode and
   was never affected — strict eval declarations get their own environment.)

   The decisive probe: wrap `globalThis.__srk_vm_hoist` from guest code (it
   is called inside eval_in_realm right before the eval) and log host-global
   state there — the host was already poisoned at that point, proving the
   write predated the sandboxed eval and pointing at the compile path.

   Debugging notes for whoever ends up here again: the "ext:...:LINE"
   numbers in guest stacks do NOT map 1:1 to polyfill sources (runtime
   lowering shifts them); an `eval at <anonymous>` frame may be any
   runtime-eval'd script whose name mapping was lost; and jest's console
   capture swallows console.error inside a failing suite — use
   `process._rawDebug`.

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
