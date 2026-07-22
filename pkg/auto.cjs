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
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const exportsObj = origLoad.apply(this, arguments);
    // Cheap gates before any resolution work: every specifier for the swc
    // module mentions "swc" ("./swc", "../../build/swc",
    // "next/dist/build/swc"); every specifier for the log module mentions
    // "log" ("../output/log", "next/dist/build/output/log").
    if (typeof request !== 'string' || exportsObj === null || typeof exportsObj !== 'object') {
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
                  args[0].indexOf('next-swc does not have native bindings') !== -1
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

    if (
      request.indexOf('swc') === -1 ||
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
    return wrapped;
  };
}
