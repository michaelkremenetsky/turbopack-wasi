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

- ALL GREEN: 77/77 suites, 563 passed / 1 skipped of 564 tests, 112/112
  snapshots, jest exit 0 (4-worker in-guest run).
- Getting from 72 to 77 took two seed fixes and one runtime fix:
  - Seed gaps (4 suites): the generated standalone package.json was missing
    @babel/preset-typescript (babel-plugin-next-page-config) and
    @testing-library/react + jest-dom (next-dynamic, link-warnings,
    link-without-router). Note @testing-library/react must be 16.x — the
    monorepo pins 15.x under pnpm, which ignores its react-18-only peer
    range; plain npm against react 19 ERESOLVEs on it.
  - web-runtime/next-response (2 tests) was a real bug: undici's
    readableStreamClose() treats a double controller.close() as benign by
    string-matching node's error wording, and deno's 06_streams wording
    ("ReadableByteStreamController's stream is not in a readable state")
    doesn't match, so the benign teardown surfaced as a test failure. Fixed
    strapkit-side by giving the byte controller's close() node's wording
    ("Invalid state: Controller is already closed" / "Invalid state:
    ReadableStream is already closed") — would bite real deno running npm
    undici the same way, so it's an upstream candidate.
- Historical: best sweep before the vm fixes was 57 suites / 355 tests; the
  vm fixes alone got it to 72 suites / 555 tests.
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

## test/production tier (in progress)

With test/unit fully green, the campaign moved to test/production — real
createNext tests: each provisions a standalone app, runs `next build` /
`next start` in it, and asserts over HTTP. Status: the first ten suites are
GREEN (app-document-style-fragment, app-dynamic-error, auto-export-error-bail,
auto-export-query-error, build-warnings, config-evaluation-error,
config-promise-error [self-skips under IS_TURBOPACK_TEST], config-syntax-error,
config-validation, dedupes-scripts) — run in two chunks of ~5 suites, each a
fresh guest, both jest exit 0. IS_TURBOPACK_TEST=1 must be in the env or the
webpack-config-only tests run (and hard-fail against Turbopack's
webpack-config error) instead of self-skipping like on CI.

Second wave (2026-08-05): the slice grew from 10 to 59 suites — everything
in test/production that an Explore sweep vetted as browser-free, native-dep
free, and not turbopack-self-skipping, run in chunks of 4-7 with a fresh
guest per chunk. Result: 47 new suites GREEN, 3 legitimately skipped
(scss-invalid-module is describe.skip'd upstream, typescript-custom-tsconfig
and error-plugin-stack-overflow self-skip under IS_TURBOPACK_TEST), zero
unexplained failures. debug-build-path needs a solo run (16 sequential
`pnpm next build`s, 596s green). Three real bugs found and fixed on the way:

1. The PUBLISHED next-swc-wasi@16.3.0-build.1 npm artifact is missing
   wasm-link-sections.cjs — publish.sh's fail-loud guard for exactly this
   was added after that publish went out. Every build whose static
   generation spawns the turbo-tasks worker pool dies with "Cannot find
   module './wasm-link-sections.cjs'" in the wasi worker bootstrap. Runs now
   use ?swclocal=1 (the staged local pack has the file); the durable fix is
   republishing (`publish.sh v16.3.0` -> build.2), which is pending with the
   repo owner.
2. Upstream's buildTS helper spawns `node --no-deprecation tsc`; the
   strapkit /bin/node shim forwarded the flag to deno's CLI parser, which
   rejects it and killed the spawn (custom-server-types). Fixed in the
   kernel's arg translation (exec.js nodeTranslateRequire): the
   warning/deprecation-channel flag family is swallowed the same way
   --enable-source-maps already was.
3. build-nextprod-seed.mjs skipped node_modules everywhere while packing
   suites; typeof-window-replace ships a checked-in fixture package at
   app/node_modules/comps that the app imports. The seed now packs
   node_modules (the vendor checkout is pristine, so any node_modules in a
   suite dir is intentional fixture content) and only skips .next.

Memory: guest tabs were spiking 25GB+ and hammering memory pressure. Fixed
with the two knobs the runtime already had: DENO_WASM_NUM_CPUS=4 (shrinks
next's static-export worker-process pool — the actual multiplier — via
__SRK_NCPUS -> navigator.hardwareConcurrency) and SRK_MEM_MAX_PAGES=49152
(3GB per-process cap vs the 4GB wasm32 default). Measured across chunks:
the tab now adds ~2-3GB over the system baseline at peak, with no visible
build-time regression (suite times matched the uncapped runs).

Two findings from the long single-run attempts, both reported upstream to
the runtime owner rather than papered over:

- The guest slows roughly 2x over a ~10-suite sequential run:
  auto-export-query-error's build-in-test takes ~34s in a fresh guest but
  breaches e2e-utils' hard-coded 60s per-test cap when it runs sixth. That
  cap is not configurable (NEXT_E2E_TEST_TIMEOUT only raises setup hooks),
  so chunked runs are the honest gate shape until the degradation itself is
  fixed.
- clean-distdir is excluded: it asserts `.next/cache` survives a rebuild,
  and the current next-swc-wasi pack still forces the in-memory turbo-tasks
  store, so nothing lands on disk. Re-add once the binding is repacked with
  the on-disk store (vendor commits c54615da/16500b0a).

How it runs (all strapkit-side; `build-nextprod-seed.mjs` + the same
next-jest-harness page with `?seed=nextprod`):

- The seed packs test/lib + jest-setup-after-env + selected production suites,
  a synthesized package.json/jest.config.js (rootDir test, modulePaths
  <rootDir>/lib), the repo's pnpm-workspace.yaml security block
  (pnpm-security-settings.js throws without it; next-swc-wasi added to
  minimumReleaseAgeExclude since it's republished per next release), and a
  stub for the .github repo-setup module the vendored tree strips.
- Per-test installs use the test lib's own CI mechanism:
  `NEXT_TEST_PKG_PATHS='[["next","16.3.0"]]'` makes createNextInstall skip
  the monorepo turbo/pack step and write `next: 16.3.0` into the app's
  dependencies — pnpm then resolves next from the guest registry, where the
  packument mutation injects next-swc-wasi. Zero require-hook tricks.
- The NEXT_TEST_STARTER fs.cp fast path turned out to be dead code upstream:
  NextInstance defaults `dependencies`/`packageJson` to `{}`, so its
  `!this.dependencies` guard can never pass. CI evidently relies on
  NEXT_TEST_PKG_PATHS + a warm pnpm store, and so do we.

Fixed along the way:

1. deno node:vm exposed `SyntheticModule`/`SourceTextModule`/`Module`
   unconditionally; node gates them behind --experimental-vm-modules, and
   jest probes `typeof vm.SyntheticModule` to decide whether requiring .mjs
   is forbidden — so e2e-utils' `import '.../reset-project.mjs'` chain died
   with ERR_REQUIRE_ESM in the guest while passing on stock node. Fixed
   upstream-style: node_options.ts learned the flag, vm.js only attaches the
   classes when it's set, the node-compat bundle's Flags whitelist passes it
   through (test-vm-module-* get it via manifest NODE_OPTIONS now, like
   node's own runner), and the strapkit vm spec tests declare it in envs.
   Regression gate: 98 vm node-compat tests, zero regressions vs the real
   deno 2.9 linux baseline.
2. Guest exit statuses now keep only the low 8 bits (POSIX WEXITSTATUS): a
   guest calling process.exit(-44) was observed as -44, which execa reads as
   a -errno and feeds getSystemErrorName a positive number (throws
   ERR_OUT_OF_RANGE, masking the real failure). Linux reports 212; now so do
   we (kernel.js 'exit').
3. Kernel `/bin/ps` applet: teardown in the test lib (and anything else using
   npm's tree-kill) walks `ps -o pid --no-headers --ppid <pid>`; the guest
   had no ps, so every next.destroy() threw ENOENT and the following suite
   burned its hook timeout on the still-running server. The kernel now
   answers ps itself from its process table (spawn() intercepts the seeded
   /bin/ps marker; procps-compatible flags/exit status, tree-kill verified
   in-guest end to end). Also fixed: a reaped workerless applet pushed an
   undefined channel slot back to the pool, poisoning the next spawn.
4. create-next-install.js (vendored): the post-install "@next/env resolved
   from the npm registry" sanity check now only applies when NEXT_TEST_PKG_PATHS
   entries are tarball paths — a plain version/range means registry
   resolution is the expected outcome. (Upstreamable.)
5. strapkit's pnpm-workspace.yaml wasm-alias writer was a hand-rolled line
   editor that refused flow-style YAML and printed a two-line warning into
   every build's output — createNextInstall emits `overrides: {}` (js-yaml
   flow form for an empty map), so the warning polluted cliOutput and broke
   every output-matching assertion, and other YAML shapes kept biting the
   same way. Replaced wholesale: strapkit now vendors the `yaml` npm package
   (v2.8.1, bundled verbatim, provenance in the file header) and edits the
   file through its comment-preserving Document API, so anything pnpm parses
   is editable — flow or block, any indent — with the project's comments
   kept. The only remaining warn path is a file that doesn't parse at all
   (which pnpm would reject too). Verified by rerunning the config/dedupes
   chunk green on the rebuilt runtime.

Known cosmetic leftovers: killed coreutils `sleep` children die with a wasm
panic + exit 127 instead of 143, and spawn-failure error objects carry wasi
errno numbers (-44) where node uses uv/linux ones (-2) — error.code is right,
so nothing string-matching breaks; both noted, neither load-bearing.

### Third wave (2026-08-06): the server-start tier

The first two waves were build-then-assert; this one is the suites that
`next start` a real server and assert over HTTP (fetch/cheerio, ISR
revalidation, middleware, adapters). 41 new suites seeded (106 total in the
nextprod seed now), run in 8 chunks + a salvage pass. Result: **37 new green
suite files**, 6 legitimate self-skips (webpack-only or cache-components
`describe.skip`, same set CI skips under `IS_TURBOPACK_TEST`), and no
unexplained failures. Highlights: the whole ISR family (prerender-revalidate,
revalidate-as-path, root-catchall-cache), the adapter-config family,
app-dir-edge-runtime-with-wasm (an edge route loading a wasm module inside
the wasm guest), required-server-files, and the pure-next half of
deterministic-build — two builds with different deployment ids produce
byte-identical `.next` output in the sandbox.

Two real bugs surfaced and got fixed at the right layers:

1. **Binding the guest's own address failed.** `Deno.networkInterfaces()`
   deliberately reports a QEMU-style eth0 at 10.0.2.15 (so yarn's offline
   probe works), but the socket2 wasip1 backend rejected binds to anything
   but wildcard/127.0.0.1 with EADDRNOTAVAIL — correct for 127.0.0.2-style
   probes, wrong for the guest's own interface address, which every real
   host accepts. `get-port-please` walks networkInterfaces() and binds each
   address, so rewrite-request-smuggling's backend died in beforeAll. Fixed
   in the vendored socket2 (accept 10.0.2.15, alias onto the loopback
   fabric) and in kernel.js `_isLoopbackIp` (connects to 10.0.2.15 route to
   local listeners). Verified: rewrite-request-smuggling 6/6 on the rebuilt
   runtime.
2. **The registry's dist-tags endpoint is CORS-dark.**
   `/-/package/<name>/dist-tags` sends no `access-control-allow-origin`
   (packuments and tarballs send `*`), so the browser-native fetch inside
   strapkit's fetch-proxy can never serve it — and `pnpm dlx vercel@latest`
   resolves the tag through exactly that endpoint. The proxy now intercepts
   the path and answers from the abbreviated packument (same data, CORS-ok),
   run through the usual packument-mutation pipeline so synthesized
   next-swc-wasi tags stay consistent.

Documented limitations (not bugs), so nobody re-litigates them:

- turbopack-node-backend's childProcesses variant asserts loaderPid !=
  buildPid. The wasi build compiles without the process pool and normalizes
  `childProcesses` to the worker pool (`ChildProcessesUnsupported` in
  next-core), so the pids are equal by design. The workerThreads variant
  passes.
- deployment-id's "build output API" variants run `pnpm dlx vercel@latest
  build` — 2+ full builds per test — which cannot fit jest's 60s per-test
  cap at guest build speed. Structural, not flaky; retries don't apply.

Open runtime bug for a dedicated session: under cacheComponents,
static-prerender workers stall past next's own 60s-per-page limit (3
attempts, then the build fails) — adapter-content-hashes' cacheComponents
variant reproduces it every time while its standard variant passes.

Not yet run from the vetting sweep: suites with custom `dependencies:`
(they bypass the starter install path), css-features file-level selection,
and the app-dir/* eligibles.

### Fourth wave (2026-08-06): custom-dependencies suites + the webpack pivot

The hypothesis from the vetting sweep held: suites that declare their own
`dependencies:` work fine under NEXT_TEST_PKG_PATHS — the deps merge into
the per-test package.json and pnpm resolves them through the guest
registry; the stubbed linkPackages path is never reached. 17 suites ran in
three chunks, 15 green files:

- Chunk d1: tsconfig-verifier (380s — the slow one), edge-dynamic-code-eval,
  re-export-all-exports-from-page-disallowed, fallback-modules.
- Chunk d2: css-url-deployment-id, custom-error-500, critical-css,
  enoent-during-require, typescript-checked-side-effect-imports,
  supports-module-resolution-nodenext.
- Chunk d3: reading-request-body-in-middleware, edge-runtime-is-addressable,
  dependencies-can-use-env-vars-in-middlewares,
  typescript-paths-baseUrl-inherited, transpile-packages.

The two non-green:

- build-spinners needs node-pty (`build/Release/pty.node`), a native C
  addon with no wasm build. Documented limitation, same class as native
  sharp.
- graceful-shutdown fails exactly one test, deterministically ("development
  (next dev) › should shut down child immediately"): after SIGTERM to
  `next dev`, the in-flight 400ms request completes with a 200 instead of
  the connection being severed. Kill propagation isn't tearing down the
  child's open sockets promptly. Open kernel bug for a dedicated session.

Then the webpack pass started (user-directed). The switch that matters:
dropping IS_TURBOPACK_TEST is NOT enough — next 16 defaults to turbopack;
`IS_WEBPACK_TEST=1` (read in packages/next/src/lib/bundler.ts) is what
selects webpack. First results, all with full webpack production builds
in-guest through next-swc-wasi:

- webpack-config-mainjs, webpack-bun-externals, externals-esm-loose: PASS.
- turbotrace-with-webpack-worker: fails only because its image-import page
  makes the build load sharp (see below).
- css-customization: too big for one 540s window (~15 webpack builds), so
  it ran as -t halves. "Basic CSS|Correct CSS": 6 passed, 2 failed — both
  in the legacy "custom loader" block whose fixture next.config.js does
  `require('styled-jsx/webpack')`, a transitive-dep require that standard
  pnpm isolation shouldn't resolve anywhere; flagged for upstream-CI
  comparison rather than as a runtime bug.

The sharp probe (also user-requested) has a crisp verdict now:

- `process.platform/arch` in-guest is `linux/wasm32`; npm installs sharp's
  optional `@img/sharp-wasm32` + `@img/sharp-webcontainers-wasm32` (the
  latter is just an alias for the former) without any flags beyond
  `--include=optional`.
- `require('sharp')` works, instance creation works. Every actual pixel
  operation (`.png().toBuffer()`) hangs forever — the emscripten/emnapi
  pthread pool never runs the job. vips concurrency is already 1 in the
  wasm build and forcing it changes nothing.
- So: sharp-wasm32 is one runtime fix away (emscripten pthread dispatch
  inside proc workers), and it unlocks turbotrace-with-webpack-worker plus
  the image suites. Dedicated-session bug, same tier as the cacheComponents
  stall.

One more loose thread from the misconfigured first webpack attempt (builds
still ran turbopack): turbopack's node-code evaluation reported
`Invalid source map ... 'file://http://localhost:8755/...deno.js'` — we
prefix an http URL with file:// somewhere in the sourcemap plumbing.
Cosmetic in that run, but worth a look.

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
