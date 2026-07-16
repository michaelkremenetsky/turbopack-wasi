import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { WASI } from 'node:wasi'
import { Worker } from 'node:worker_threads'

const nativeDir = path.join(import.meta.dirname, '..', 'vendor/next.js/packages/next-swc/native')
const require = createRequire(path.join(nativeDir, 'index.wasi.cjs'))
const rt = require('@napi-rs/wasm-runtime')

const bytes = fs.readFileSync(path.join(nativeDir, 'index.wasm32-wasi.wasm'))
const wasi = new WASI({ version: 'preview1', env: process.env, preopens: { '/': '/' } })
const t0 = Date.now()

const { napiModule } = await rt.instantiateNapiModule(bytes, {
  context: rt.getDefaultContext(),
  asyncWorkPoolSize: 4,
  wasi,
  onCreateWorker() {
    console.error('[async] onCreateWorker', Date.now() - t0, 'ms')
    const w = new Worker(path.join(nativeDir, 'wasi-worker.mjs'), { env: process.env })
    w.on('error', (e) => console.error('[async] WORKER ERROR:', e))
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
    console.error('[async] beforeInit', Date.now() - t0, 'ms')
    console.error('[async] exports:', Object.keys(instance.exports).filter((k) => !k.startsWith('__napi')).join(','))
    if (instance.exports.__wasm_call_ctors) {
      console.error('[async] calling __wasm_call_ctors...')
      instance.exports.__wasm_call_ctors()
      console.error('[async] ctors returned', Date.now() - t0, 'ms')
    } else if (instance.exports._initialize) {
      console.error('[async] calling _initialize...')
      instance.exports._initialize()
      console.error('[async] _initialize returned', Date.now() - t0, 'ms')
    } else {
      console.error('[async] WARNING: no ctor entry export found')
    }
    for (const name of []) {
      if (name.startsWith('__napi_register__')) {
        instance.exports[name]()
      }
    }
    console.error('[async] registers done', Date.now() - t0, 'ms')
  },
})
console.error('[async] instantiated', Date.now() - t0, 'ms')
console.error('[async] getTargetTriple:', napiModule.exports.getTargetTriple?.())
console.error('[async] projectNew type:', typeof napiModule.exports.projectNew)
console.error('[async] export count:', Object.keys(napiModule.exports).length)
process.exit(0)
