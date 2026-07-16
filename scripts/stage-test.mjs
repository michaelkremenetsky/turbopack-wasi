import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const nativeDir = path.join(import.meta.dirname, '..', 'vendor/next.js/packages/next-swc/native')
const require = createRequire(path.join(nativeDir, 'index.wasi.cjs'))

console.error('[stage] requiring @napi-rs/wasm-runtime')
const rt = require('@napi-rs/wasm-runtime')
console.error('[stage] wasm-runtime loaded:', Object.keys(rt).join(','))

console.error('[stage] reading wasm')
const bytes = fs.readFileSync(path.join(nativeDir, 'index.wasm32-wasi.wasm'))
console.error('[stage] read', bytes.length, 'bytes')

console.error('[stage] compiling module (sync)...')
const t0 = Date.now()
const mod = new WebAssembly.Module(bytes)
console.error('[stage] compiled in', Date.now() - t0, 'ms')

const imports = WebAssembly.Module.imports(mod)
const memImport = imports.find((i) => i.kind === 'memory')
console.error('[stage] memory import:', JSON.stringify(memImport))
console.error('[stage] import count:', imports.length, 'export count:', WebAssembly.Module.exports(mod).length)

console.error('[stage] instantiating napi module (sync)...')
const { WASI } = await import('node:wasi')
const { Worker } = await import('node:worker_threads')

const wasi = new WASI({ version: 'preview1', env: process.env, preopens: { '/': '/' } })
const t1 = Date.now()
const { napiModule } = rt.instantiateNapiModuleSync(bytes, {
  context: rt.getDefaultContext(),
  asyncWorkPoolSize: 4,
  wasi,
  onCreateWorker() {
    console.error('[stage] onCreateWorker called', Date.now() - t1, 'ms')
    const w = new Worker(path.join(nativeDir, 'wasi-worker.mjs'), { env: process.env })
    w.on('error', (e) => console.error('[stage] WORKER ERROR:', e))
    return w
  },
  overwriteImports(importObject) {
    importObject.env = {
      ...importObject.env,
      ...importObject.napi,
      ...importObject.emnapi,
      memory: new WebAssembly.Memory({ initial: 4096, maximum: 65536, shared: true }),
    }
    return importObject
  },
  beforeInit({ instance }) {
    console.error('[stage] beforeInit reached', Date.now() - t1, 'ms')
    for (const name of Object.keys(instance.exports)) {
      if (name.startsWith('__napi_register__')) {
        instance.exports[name]()
      }
    }
    console.error('[stage] napi registers done', Date.now() - t1, 'ms')
  },
})
console.error('[stage] instantiated in', Date.now() - t1, 'ms')
console.error('[stage] napi exports:', Object.keys(napiModule.exports).slice(0, 20).join(','))
console.error('[stage] getTargetTriple:', napiModule.exports.getTargetTriple?.())
console.error('[stage] projectNew present:', typeof napiModule.exports.projectNew)
process.exit(0)
