// Returned by require() when next's loadNative() follows
// __INTERNAL_CUSTOM_TURBOPACK_BINDINGS. The driver instantiates the wasi
// module (async) BEFORE loading next, and parks the exports on globalThis.
if (!globalThis.__WASI_BINDINGS__) {
  throw new Error('wasi bindings not instantiated yet — driver must set globalThis.__WASI_BINDINGS__ first')
}

const raw = globalThis.__WASI_BINDINGS__
const wrapped = { ...raw }
if (process.env.WASI_TRACE_BINDINGS) {
  for (const key of Object.keys(raw)) {
    if (typeof raw[key] !== 'function') continue
    wrapped[key] = (...args) => {
      const cbIndex = args.findIndex((a) => typeof a === 'function')
      if (cbIndex >= 0) {
        const cb = args[cbIndex]
        args[cbIndex] = (...cbArgs) => {
          console.error(`[bindings] ${key} CALLBACK fired (${cbArgs.length} args, err=${cbArgs[0]?.message ?? cbArgs[0] ?? 'null'})`)
          return cb(...cbArgs)
        }
      }
      console.error(`[bindings] ${key} called${cbIndex >= 0 ? ' (with callback)' : ''}`)
      return raw[key](...args)
    }
  }
}
module.exports = wrapped
