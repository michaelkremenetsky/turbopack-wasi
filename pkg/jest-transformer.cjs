'use strict';
// Wrapper around next's swc jest transformer that finishes the ASYNC wasm
// init before jest can invoke the sync-only transform.
//
// Why a separate file: next's transformer calls transformSync ->
// loadBindingsSync, which has no seam to await instantiation. jest >= 28
// awaits an async createTransformer, but intercepting the transformer inside
// a jest WORKER is unreliable — its load is what first engages auto.cjs, so
// the Module._load patch never sees that in-flight require. Instead auto.cjs
// rewrites the resolved jest config's transform entries (in the MAIN process,
// where interception works) to point here; workers then require this file
// directly and the await happens before the first transform, every time.
//
// The original transformer's path travels in the options under __nextJtPath
// (jest serializes transform options to workers verbatim).
module.exports = {
  async createTransformer(options) {
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
    const { __nextJtPath, ...rest } = options || {};
    const t = require(__nextJtPath);
    return typeof t.createTransformer === 'function' ? t.createTransformer(rest) : t;
  },
};
