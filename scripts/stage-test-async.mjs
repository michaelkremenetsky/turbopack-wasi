import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { WASI } from 'node:wasi'
import { Worker } from 'node:worker_threads'

const nativeDir =
  process.argv[2] ?? path.join(import.meta.dirname, '..', 'vendor/next.js/packages/next-swc/native')
const require = createRequire(path.join(nativeDir, 'index.wasi.cjs'))
const rt = require('@napi-rs/wasm-runtime')

const bytes = fs.readFileSync(path.join(nativeDir, 'index.wasm32-wasi.wasm'))
const wasi = new WASI({ version: 'preview1', env: process.env, preopens: { '/': '/' } })
const t0 = Date.now()

const { napiModule } = await rt.instantiateNapiModule(bytes, {
  context: rt.getDefaultContext(),
  asyncWorkPoolSize: 4,
  reuseWorker: { size: 16, strict: true },
  wasi,
  onCreateWorker() {
    console.error('[async] onCreateWorker', Date.now() - t0, 'ms')
    const w = new Worker(path.join(nativeDir, 'wasi-worker.mjs'), { env: process.env })
    w.on('error', (e) => console.error('[async] WORKER ERROR:', e))
    return w
  },
  overwriteImports(importObject) {
    console.error('[async] import namespaces:', Object.keys(importObject).map((ns) => `${ns}(${Object.keys(importObject[ns]).length})`).join(' '))
    const origSpawn = importObject.wasi?.['thread-spawn']
    if (origSpawn) {
      importObject.wasi['thread-spawn'] = (...args) => {
        console.error('[async] thread-spawn called with', args)
        const r = origSpawn(...args)
        console.error('[async] thread-spawn returned', r)
        return r
      }
    } else {
      console.error('[async] NO wasi.thread-spawn import!')
    }
    for (const name of Object.keys(importObject.wasi_snapshot_preview1)) {
      const orig = importObject.wasi_snapshot_preview1[name]
      importObject.wasi_snapshot_preview1[name] = (...args) => {
        const r = orig(...args)
        if (globalThis.__traceWasi) console.error('[wasi]', name, '->', r)
        return r
      }
    }
    importObject.env = {
      ...importObject.env,
      ...importObject.napi,
      ...importObject.emnapi,
      memory: new WebAssembly.Memory({ initial: 4096, maximum: 65536, shared: true }),
    }
    return importObject
  },
  beforeInit({ instance }) {
    globalThis.__lastInstance = instance
    const rc = instance.exports.init_turbopack_wasi_runtime_raw?.(4)
    console.error('[async] beforeInit', Date.now() - t0, 'ms, runtime install rc =', rc)
    console.error('[async] exports:', Object.keys(instance.exports).filter((k) => !k.startsWith('__napi')).join(','))
    // _initialize (thread-pointer setup + ctors) is invoked automatically by wasi.initialize()
    console.error('[async] _initialize exported:', typeof instance.exports._initialize)
    for (const name of Object.keys(instance.exports)) {
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

napiModule.exports.initTurbopackWasiRuntime?.(4)
console.error('[async] timer probe: sleeping 250ms via tokio...')
const t2 = Date.now()
const slept = await Promise.race([
  napiModule.exports.debugSleep(250),
  new Promise((r) => setTimeout(() => r('TIMED OUT — tokio timer broken'), 5000)),
])
console.error('[async] timer probe result:', slept, 'after', Date.now() - t2, 'ms')

for (const [label, fn] of [
  ['spawn', () => napiModule.exports.debugSpawn(21)],
  ['readFile', () => napiModule.exports.debugReadFile('/etc/hosts')],
]) {
  const t3 = Date.now()
  const r = await Promise.race([fn(), new Promise((res) => setTimeout(() => res('TIMED OUT'), 8000))])
  console.error(`[async] ${label} probe:`, r, 'after', Date.now() - t3, 'ms')
}

{
  const t4 = Date.now()
  const got = []
  const tsfnDone = new Promise((res) => {
    napiModule.exports.debugTsfnEcho((err, v) => {
      got.push(err ?? v)
      if (got.length === 3) res(got)
    })
  })
  const r = await Promise.race([tsfnDone, new Promise((res) => setTimeout(() => res('TSFN TIMED OUT'), 8000))])
  console.error('[async] tsfn probe:', JSON.stringify(r), 'after', Date.now() - t4, 'ms')
}

const out = await napiModule.exports.transform(
  'const x: number = 1 as any; export default x;',
  true,
  Buffer.from(JSON.stringify({ jsc: { parser: { syntax: 'typescript' }, target: 'es2020' }, filename: 'test.ts' }))
)
console.error('[async] transform output:', JSON.parse(JSON.stringify(out)).code?.trim())
process.exit(0)
