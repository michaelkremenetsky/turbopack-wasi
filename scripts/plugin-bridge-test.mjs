// End-to-end test for the SWC host-plugin bridge (docs/swc-plugin-host-bridge.md).
//
// Instantiates the wasi binding, registers the plugin driver worker, then runs a
// single `transform` with `experimental.plugins` pointing at the marker plugin
// (fixtures/plugin-marker) — which renames `__PLUGIN_MARKER_IN__` to
// `__PLUGIN_MARKER_OUT__`. If the bridge works, the transformed code contains the
// OUT marker and not the IN marker.
//
// Usage: node scripts/plugin-bridge-test.mjs
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import util from 'node:util'
import { WASI } from 'node:wasi'
import { Worker } from 'node:worker_threads'

Error.stackTraceLimit = 120
process.on('unhandledRejection', (r) => { console.error('[plugin-test] UNHANDLED:', util.inspect(r, { depth: 5 })); process.exit(3) })

const root = path.join(import.meta.dirname, '..')
const nativeDir = process.env.WASI_NATIVE_DIR ?? path.join(root, 'vendor/next.js/packages/next-swc/native')
const pluginWasm = process.env.PLUGIN_WASM ?? path.join(root, 'fixtures/plugin-marker/target/wasm32-wasip1/release/plugin_marker.wasm')
const pluginWorker = path.join(root, 'pkg/swc-plugin-worker.mjs')

const { makeReadCustomSection } = createRequire(import.meta.url)('./wasm-link-sections.cjs')
const sdkRequire = createRequire(path.join(root, 'sdk/package.json'))
const rt = sdkRequire('@napi-rs/wasm-runtime')

const bytes = fs.readFileSync(path.join(nativeDir, 'index.wasm32-wasi.wasm'))
const wasi = new WASI({ version: 'preview1', env: process.env, preopens: { '/': '/' } })

function memoryLimits(buf) {
  let off = 8
  const leb = () => { let r = 0, s = 0; for (;;) { const b = buf[off++]; r |= (b & 0x7f) << s; if (!(b & 0x80)) return r >>> 0; s += 7 } }
  while (off < buf.length) {
    const id = buf[off++], size = leb(), end = off + size
    if (id === 2) {
      const count = leb()
      for (let i = 0; i < count; i++) {
        const mlen = leb(); off += mlen
        const nlen = leb(); off += nlen
        const kind = buf[off++]
        if (kind === 0) leb()
        else if (kind === 1) { off++; buf[off - 1] & 1 ? (leb(), leb()) : leb() }
        else if (kind === 2) { const flags = buf[off++]; const min = leb(); const max = flags & 1 ? leb() : undefined; return { min, max, shared: !!(flags & 2) } }
        else if (kind === 3) off += 2
      }
    }
    off = end
  }
  return null
}
const limits = memoryLimits(bytes) ?? { min: 8192, max: 65536, shared: true }
console.error('[plugin-test] memory limits:', JSON.stringify(limits))

const { napiModule } = await rt.instantiateNapiModule(bytes, {
  context: rt.getDefaultContext(),
  asyncWorkPoolSize: 8,
  reuseWorker: { size: 24, strict: false },
  wasi,
  onCreateWorker() {
    return new Worker(path.join(nativeDir, 'wasi-worker.mjs'), { env: process.env })
  },
  overwriteImports(importObject) {
    importObject.env = {
      ...importObject.env,
      ...importObject.napi,
      ...importObject.emnapi,
      read_custom_section: makeReadCustomSection(bytes, () => globalThis.__wasiMemory),
      memory: (globalThis.__wasiMemory = new WebAssembly.Memory({
        initial: limits.min,
        maximum: limits.max ?? 65536,
        shared: limits.shared,
      })),
    }
    return importObject
  },
  beforeInit({ instance }) {
    instance.exports.init_turbopack_wasi_runtime_raw(8)
    for (const name of Object.keys(instance.exports)) {
      if (name.startsWith('__napi_register__')) instance.exports[name]()
    }
  },
})
const raw = napiModule.exports
console.error('[plugin-test] instantiated,', Object.keys(raw).length, 'exports')
raw.initTurbopackWasiRuntime(8)

if (typeof raw.initSwcPluginBridge !== 'function') {
  console.error('[plugin-test] FAIL: binding has no initSwcPluginBridge export')
  process.exit(2)
}

// Register the plugin bridge: spawn the driver worker on first signal, hand it
// the shared linear memory, and forward each channel address.
let driver = null
raw.initSwcPluginBridge((_err, channelAddr) => {
  if (!driver) {
    console.error('[plugin-test] spawning plugin driver worker')
    driver = new Worker(pluginWorker, { workerData: { memory: globalThis.__wasiMemory } })
    driver.on('error', (e) => console.error('[plugin-test] driver error:', (e && e.stack) || e))
    driver.on('message', (m) => console.error('[plugin-test] driver message:', util.inspect(m)))
  }
  console.error('[plugin-test] signal channel', channelAddr)
  driver.postMessage({ channelAddr })
})

const code = 'const __PLUGIN_MARKER_IN__ = 1; console.log(__PLUGIN_MARKER_IN__);\n'
const options = {
  jsc: {
    parser: { syntax: 'ecmascript', jsx: false },
    target: 'es2020',
    experimental: { plugins: [[pluginWasm, {}]] },
  },
  filename: '/input.js',
  sourceMaps: false,
}

console.error('[plugin-test] plugin wasm:', pluginWasm)
console.error('[plugin-test] calling transform...')

const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('transform TIMED OUT after 30s (coroutine likely deadlocked)')), 30000).unref())

try {
  const result = await Promise.race([raw.transform(code, true, Buffer.from(JSON.stringify(options))), timeout])
  const out = typeof result === 'string' ? result : (result && result.code)
  console.error('[plugin-test] transform output:\n' + out)
  const hasOut = out && out.includes('__PLUGIN_MARKER_OUT__')
  const hasIn = out && out.includes('__PLUGIN_MARKER_IN__')
  if (hasOut && !hasIn) {
    console.error('[plugin-test] PASS: plugin ran (marker renamed IN->OUT)')
    process.exit(0)
  }
  console.error(`[plugin-test] FAIL: hasOut=${hasOut} hasIn=${hasIn} (plugin did not transform as expected)`)
  process.exit(1)
} catch (err) {
  console.error('[plugin-test] FAIL:', (err && err.stack) || err)
  process.exit(1)
}
