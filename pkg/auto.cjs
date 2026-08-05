'use strict';
// next-swc-wasi/auto: one-require engagement. A host runtime loads this ONCE
// per node process (before any next code evaluates) and nothing else — every
// next-version-specific detail lives here, inside the package that is built,
// tested, and dist-tagged against that exact next release. When next changes
// internals, the fix ships as a new -build.N and the moving `next-<version>`
// dist-tag picks it up; the host runtime never changes.
//
// What it does:
// 1. Sets __INTERNAL_CUSTOM_TURBOPACK_BINDINGS (next's own custom-bindings
//    escape hatch, read into a module-level const when
//    next/dist/build/swc/index.js EVALUATES — hence "before any next code")
//    to this package's binding.cjs. loadNative() then requires it and runs
//    next's untouched wrapper/bindingToApi/loaderWorkerPool code over the
//    wasi binding's raw exports, exactly as it would over a native .node.
// 2. Patches Module._load to wrap that module's async loadBindings(): the
//    wasm must instantiate ASYNC before next's sync loadNative() runs, so
//    the wrap awaits loader.ensureInit() first (and sets
//    NEXT_DISABLE_SWC_WASM so the turbopack-less wasm-swc fallback isn't
//    preferred on wasm-fallback-classified platforms). Failed init leaves
//    every stock next path untouched.
//
// Config note: no next.config munging happens here — the wasi build itself
// accepts stock configs (it normalizes the 'childProcesses' plugin-runtime
// default to its worker pool and forces the in-memory turbo-tasks store).
//
// Idempotent; safe to require in any process (pool workers, forked servers).
if (!globalThis.__nextSwcWasiAuto) {
  globalThis.__nextSwcWasiAuto = true;

  const path = require('node:path');
  const Module = require('node:module');

  const BINDING = path.join(__dirname, 'binding.cjs');
  if (!process.env.__INTERNAL_CUSTOM_TURBOPACK_BINDINGS) {
    process.env.__INTERNAL_CUSTOM_TURBOPACK_BINDINGS = BINDING;
  }

  const SWC_SUFFIX = ['next', 'dist', 'build', 'swc', 'index.js'].join('/');
  const LOG_SUFFIX = ['next', 'dist', 'build', 'output', 'log.js'].join('/');
  const JT_SUFFIX = ['next', 'dist', 'build', 'swc', 'jest-transformer.js'].join('/');
  const NEXT_JEST_SUFFIX = ['next', 'dist', 'build', 'jest', 'jest.js'].join('/');

  // In-place wrap of the jest transformer's createTransformer: await the wasm
  // init before handing jest a transformer whose process() is sync-only.
  const jtDbg = (...args) => {
    if (process.env.SRK_TURBOPACK_DEBUG) {
      console.error('[next-swc-wasi pid=' + process.pid + ' auto]', ...args);
    }
  };
  function wrapJestTransformer(exportsObj) {
    const origCreate = exportsObj.createTransformer;
    exportsObj.__nextSwcWasiWrapped = true;
    jtDbg('jest transformer wrapped');
    exportsObj.createTransformer = async function createTransformer(...args) {
      jtDbg('createTransformer called; awaiting init');
      try {
        const loader = require('./loader.cjs');
        if (typeof loader.ensureInit === 'function' && !loader.ready) {
          await loader.ensureInit();
        }
      } catch (err) {
        console.error(
          '[next-swc-wasi] init failed before jest transform, sync loads may race:',
          (err && err.message) || err
        );
      }
      return origCreate.apply(this, args);
    };
  }

  // First-file corner: in a jest worker the transformer module itself can be
  // the require that ENGAGES this file (via the runtime's pre-eval hook), so
  // the Module._load patch below never sees that in-flight load. Sweep the
  // require cache on the next microtask — jest awaits its transformer load,
  // so this runs before the transformer is used.
  queueMicrotask(() => {
    const cache = Module._cache || {};
    let hits = 0;
    for (const fn of Object.keys(cache)) {
      const mod = cache[fn];
      if (
        fn.endsWith(JT_SUFFIX) &&
        mod && mod.exports &&
        typeof mod.exports.createTransformer === 'function' &&
        !mod.exports.__nextSwcWasiWrapped
      ) {
        wrapJestTransformer(mod.exports);
        hits++;
      }
    }
    jtDbg('engage-time transformer sweep:', hits, 'wrapped;', Object.keys(cache).length, 'cached modules');
  });

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (typeof request === 'string' && request.indexOf('jest-transformer') !== -1) {
      jtDbg('_load saw jest-transformer request:', request);
    }
    const exportsObj = origLoad.apply(this, arguments);
    // Cheap gates before any resolution work. The log module can gate on its
    // specifier (every one mentions "log"); the swc module CANNOT — see the
    // exports-shape gate below.
    if (
      typeof request !== 'string' ||
      exportsObj === null ||
      (typeof exportsObj !== 'object' && typeof exportsObj !== 'function')
    ) {
      return exportsObj;
    }

    // next/jest: rewrite the RESOLVED jest config's transform entries to point
    // at this package's wrapper transformer (jest-transformer.cjs), which
    // awaits the wasm init before delegating to next's sync-only transformer.
    // This runs in the jest MAIN process — the only place interception is
    // reliable — and reaches the workers through the serialized config, so the
    // per-worker first-transform race can't happen at all. (The compiled
    // module's exports IS the nextJest function, with .default self-assigned.)
    if (
      typeof exportsObj === 'function' &&
      request.indexOf('jest') !== -1 &&
      !exportsObj.__nextSwcWasiWrapped
    ) {
      let njFilename;
      try {
        njFilename = Module._resolveFilename(request, parent, isMain);
      } catch {
        njFilename = null;
      }
      if (typeof njFilename === 'string' && njFilename.endsWith(NEXT_JEST_SUFFIX)) {
        const WRAPPER = path.join(__dirname, 'jest-transformer.cjs');
        const origFactory = exportsObj;
        const nextJestWrapped = function nextJest(...fargs) {
          const createJestConfig = origFactory.apply(this, fargs);
          return (customConfig) => {
            const resolver = createJestConfig(customConfig);
            return async () => {
              const cfg = await (typeof resolver === 'function' ? resolver() : resolver);
              try {
                for (const key of Object.keys((cfg && cfg.transform) || {})) {
                  const entry = cfg.transform[key];
                  if (
                    Array.isArray(entry) &&
                    typeof entry[0] === 'string' &&
                    entry[0].endsWith(JT_SUFFIX)
                  ) {
                    cfg.transform[key] = [
                      WRAPPER,
                      Object.assign({}, entry[1], { __nextJtPath: entry[0] }),
                    ];
                    jtDbg('rewrote jest transform entry to wrapper:', key);
                  }
                }
              } catch (err) {
                jtDbg('jest transform rewrite failed:', (err && err.message) || err);
              }
              return cfg;
            };
          };
        };
        nextJestWrapped.__nextSwcWasiWrapped = true;
        nextJestWrapped.default = nextJestWrapped;
        const cachedNj = Module._cache && Module._cache[njFilename];
        if (cachedNj) cachedNj.exports = nextJestWrapped;
        return nextJestWrapped;
      }
      return exportsObj;
    }

    // next's loadBindings() unconditionally warns "next-swc does not have
    // native bindings ... Turbopack will not be available" on wasm32 before
    // it ever consults the custom-bindings hook — false here, since this
    // package IS a Turbopack-enabled binding. The compiled log module's
    // exports are non-configurable getters, so filter through a Proxy swapped
    // into the require cache (callers read `_log.warn` per call).
    if (
      request.indexOf('log') !== -1 &&
      typeof exportsObj.warn === 'function' &&
      !exportsObj.__nextSwcWasiWrapped
    ) {
      let logFilename;
      try {
        logFilename = Module._resolveFilename(request, parent, isMain);
      } catch {
        logFilename = null;
      }
      if (typeof logFilename === 'string' && logFilename.endsWith(LOG_SUFFIX)) {
        const wrappedLog = new Proxy(exportsObj, {
          get(target, prop, receiver) {
            if (prop === '__nextSwcWasiWrapped') return true;
            if (prop === 'warn') {
              return function warn(...args) {
                if (
                  typeof args[0] === 'string' &&
                  (args[0].indexOf('next-swc does not have native bindings') !== -1 ||
                    args[0].indexOf('Trying to load next-swc for unsupported platforms') !== -1)
                ) {
                  return;
                }
                return target.warn(...args);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const cachedLog = Module._cache && Module._cache[logFilename];
        if (cachedLog) cachedLog.exports = wrappedLog;
        return wrappedLog;
      }
      return exportsObj;
    }

    // next's jest transformer runs the SYNC transform (transformSync ->
    // loadBindingsSync) with no seam to await the wasm init, so a fresh jest
    // worker races its first transforms against instantiation and dies with
    // "Failed to load bindings". jest >= 28 awaits an async createTransformer
    // when loading the transformer module — the one legitimate async moment
    // before any sync transform — so finish the init there. Wrapping MUTATES
    // the exports (see wrapJestTransformer) so it also covers the module
    // instance the microtask sweep below catches.
    if (
      typeof exportsObj.createTransformer === 'function' &&
      !exportsObj.__nextSwcWasiWrapped
    ) {
      let jtFilename;
      try {
        jtFilename = Module._resolveFilename(request, parent, isMain);
      } catch {
        jtFilename = null;
      }
      if (typeof jtFilename === 'string' && jtFilename.endsWith(JT_SUFFIX)) {
        wrapJestTransformer(exportsObj);
      }
      return exportsObj;
    }

    // No request-string gate here: the specifier for the swc module is NOT
    // guaranteed to mention "swc" — install-bindings.ts (the path every build
    // worker process takes) requires it as plain './index', which a
    // request.indexOf('swc') gate silently skips, leaving loadBindings
    // unwrapped exactly where the async init matters most. The exports-shape
    // check is nearly as cheap and can't be fooled by the specifier.
    if (
      typeof exportsObj.loadBindings !== 'function' ||
      exportsObj.__nextSwcWasiWrapped
    ) {
      return exportsObj;
    }
    let filename;
    try {
      filename = Module._resolveFilename(request, parent, isMain);
    } catch {
      return exportsObj;
    }
    if (typeof filename !== 'string' || !filename.endsWith(SWC_SUFFIX)) return exportsObj;

    // next's compiled `_export` getters are non-configurable, so wrap with a
    // Proxy and swap it into the require cache (all later requires see it).
    const wrapped = new Proxy(exportsObj, {
      get(target, prop, receiver) {
        if (prop === '__nextSwcWasiWrapped') return true;
        if (prop === 'loadBindings') {
          return async function loadBindings() {
            if (process.env.SRK_TURBOPACK_DEBUG) {
              console.error('[next-swc-wasi pid=' + process.pid + '] wrapped loadBindings called');
            }
            try {
              const loader = require('./loader.cjs');
              if (typeof loader.ensureInit === 'function' || loader.ready) {
                const ok = loader.ready || (await loader.ensureInit());
                if (ok) process.env.NEXT_DISABLE_SWC_WASM = '1';
              }
            } catch (err) {
              console.error(
                '[next-swc-wasi] init failed, using stock next bindings:',
                (err && err.message) || err
              );
            }
            return target.loadBindings(...arguments);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const cached = Module._cache && Module._cache[filename];
    if (cached) cached.exports = wrapped;
    if (process.env.SRK_TURBOPACK_DEBUG) {
      console.error('[next-swc-wasi pid=' + process.pid + '] loadBindings wrap installed for ' + filename);
    }
    return wrapped;
  };
}
