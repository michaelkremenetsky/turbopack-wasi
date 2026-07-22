'use strict';
// next-swc-wasi binding entry: the module next's
// __INTERNAL_CUSTOM_TURBOPACK_BINDINGS points at (set pre-eval by auto.cjs —
// next captures that env var in a module-level const, so it must be in place
// before next/dist/build/swc/index.js runs).
//
// next's loadNative() requires this at the top of every call, possibly BEFORE
// the async instantiation has run or after it failed: in any not-ready state
// this module throws, which next's loadBindings catches and falls through to
// its stock trickle-down. A throwing CJS module is evicted from the require
// cache, so the require retries fresh on the next loadNative() call — by
// which time auto.cjs's loadBindings wrap has awaited ensureInit() and the
// loader's exports carry the live napi bindings.
//
// In a turbopack-node pool worker (workerData.bindingPath === this file) the
// loader takes its RPC-proxy personality, which is always "ready" — the
// isMainThread guard skips the readiness check there.
const { isMainThread } = require('node:worker_threads');
const loader = require('./loader.cjs');
if (isMainThread && !loader.ready) {
  throw new Error('next-swc-wasi bindings not initialized yet (ensureInit pending or failed)');
}
module.exports = loader;
