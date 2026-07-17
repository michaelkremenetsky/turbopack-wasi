// Drive next's own createProject path against the wasi turbopack binding,
// using a real Next.js app fixture.
//
// Usage: node scripts/real-app-test.mjs [fixture-dir]
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import util from 'node:util'
import { WASI } from 'node:wasi'
import { Worker } from 'node:worker_threads'

Error.stackTraceLimit = 120
process.on('unhandledRejection', (reason) => {
  console.error('[app-test] UNHANDLED REJECTION:', util.inspect(reason, { depth: 4 }))
  process.exit(3)
})
process.on('uncaughtException', (err) => {
  console.error('[app-test] UNCAUGHT EXCEPTION:', util.inspect(err, { depth: 4 }))
  process.exit(4)
})
const root = path.join(import.meta.dirname, '..')
const nativeDir = process.env.WASI_NATIVE_DIR ?? path.join(root, 'vendor/next.js/packages/next-swc/native')
const fixture = path.resolve(process.argv[2] ?? path.join(root, 'fixtures/hello-app'))
// monorepos: rootPath = repo root, projectPath = app dir relative to it
const projectSubdir = process.env.PROJECT_SUBDIR ?? '.'
const appDir = path.join(fixture, projectSubdir)

// ---- 1. instantiate the wasi binding ---------------------------------------
const sdkRequire = createRequire(path.join(root, 'sdk/package.json'))
const rt = sdkRequire('@napi-rs/wasm-runtime')

const bytes = fs.readFileSync(path.join(nativeDir, 'index.wasm32-wasi.wasm'))
const wasi = new WASI({ version: 'preview1', env: process.env, preopens: { '/': '/' } })

// Parse the module's imported-memory limits so our supplied memory always matches.
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
        if (kind === 0) leb() // func: typeidx
        else if (kind === 1) { off++; const f = buf[off - 1] & 1 ? (leb(), leb()) : leb() } // table
        else if (kind === 2) { // memory
          const flags = buf[off++]
          const min = leb()
          const max = flags & 1 ? leb() : undefined
          return { min, max, shared: !!(flags & 2) }
        } else if (kind === 3) off += 2 // global: type + mut
      }
    }
    off = end
  }
  return null
}
const limits = memoryLimits(bytes) ?? { min: 8192, max: 65536, shared: true }
console.error('[app-test] module memory limits:', JSON.stringify(limits))

const { napiModule } = await rt.instantiateNapiModule(bytes, {
  context: rt.getDefaultContext(),
  asyncWorkPoolSize: 8,
  reuseWorker: { size: 24, strict: false },
  wasi,
  onCreateWorker() {
    const worker = process.env.WASI_DEBUG_WORKER ? 'wasi-worker-debug.mjs' : 'wasi-worker.mjs'
    const execArgv = process.env.WASI_PROF_WORKERS ? ['--prof'] : []
    return new Worker(path.join(nativeDir, worker), { env: process.env, execArgv })
  },
  overwriteImports(importObject) {
    globalThis.__wasiStats = Object.create(null)
    for (const name of Object.keys(importObject.wasi_snapshot_preview1)) {
      const orig = importObject.wasi_snapshot_preview1[name]
      importObject.wasi_snapshot_preview1[name] = (...args) => {
        globalThis.__wasiStats[name] = (globalThis.__wasiStats[name] ?? 0) + 1
        const ret = orig(...args)
        if (process.env.WASI_TRACE_ERRNO && typeof ret === 'number' && ret !== 0) {
          console.error(`[wasi-errno] ${name}(${args.slice(0, 4).join(',')}) = ${ret}`)
        }
        return ret
      }
    }
    importObject.env = {
      ...importObject.env,
      ...importObject.napi,
      ...importObject.emnapi,
      memory: (globalThis.__wasiMemory = new WebAssembly.Memory({
        // Oversized initial: memory.grow on a shared memory races V8's cached
        // memory size in TurboFan-compiled bulk ops (spurious OOB traps), so
        // hosts should start with enough memory that growth never happens.
        initial: Math.max(limits.min, Number(process.env.WASI_MEM_INITIAL_PAGES ?? 8192)),
        // WASI_MEM_MAX_PAGES: supplying a smaller max than the module declares is a
        // valid import subtype; used to probe engine behavior at the 4GB boundary.
        maximum: Number(process.env.WASI_MEM_MAX_PAGES ?? (limits.max ?? 65536)),
        shared: limits.shared,
      })),
    }
    return importObject
  },
  beforeInit({ instance }) {
    // Must run before ANY napi call: installs the multi-threaded tokio runtime.
    const rc = instance.exports.init_turbopack_wasi_runtime_raw(8)
    console.error('[app-test] raw runtime install rc =', rc)
    for (const name of Object.keys(instance.exports)) {
      if (name.startsWith('__napi_register__')) instance.exports[name]()
    }
  },
})
globalThis.__WASI_BINDINGS__ = napiModule.exports
console.error('[app-test] wasi binding instantiated,', Object.keys(napiModule.exports).length, 'exports')

// Install a real multi-threaded tokio runtime (wasm hosts must do this before turbopack calls).
napiModule.exports.initTurbopackWasiRuntime(8)
console.error('[app-test] tokio multi-thread runtime installed')
if (process.env.WASI_RUST_TRACE) {
  napiModule.exports.debugEnableTracing(process.env.WASI_RUST_TRACE)
  console.error('[app-test] rust tracing enabled:', process.env.WASI_RUST_TRACE)
}

// ---- 2. load next's own binding wrapper over our raw bindings ---------------
process.env.__INTERNAL_CUSTOM_TURBOPACK_BINDINGS = path.join(root, 'scripts/wasi-bindings-shim.cjs')
process.env.__NEXT_VERSION = process.env.NEXT_FIXTURE_VERSION ?? '16.2.10'

const appRequire = createRequire(path.join(appDir, 'package.json'))
const swc = appRequire('next/dist/build/swc')
const { PHASE_DEVELOPMENT_SERVER } = appRequire('next/dist/shared/lib/constants')
const loadConfig = appRequire('next/dist/server/config').default

// next dev always runs with cwd = the app dir; configs rely on it (e.g. require('./package.json'))
process.chdir(appDir)
const nextConfig = await loadConfig(PHASE_DEVELOPMENT_SERVER, appDir)
// our build compiles the workerThreads plugin backend only (option exists from 16.2)
const fixtureVersion = process.env.NEXT_FIXTURE_VERSION ?? '16.2.10'
if (!/^16\.[01]\./.test(fixtureVersion)) {
  nextConfig.experimental ??= {}
  nextConfig.experimental.turbopackPluginRuntimeStrategy = 'workerThreads'
}
console.error('[app-test] next config loaded')

const bindings = await swc.loadBindings()
console.error('[app-test] loadBindings ok, isWasm:', bindings.isWasm)

// ---- 3. createProject -------------------------------------------------------
const project = await bindings.turbo.createProject(
  {
    rootPath: fixture,
    projectPath: projectSubdir,
    distDir: '.next',
    nextConfig,
    watch: { enable: false },
    dev: true,
    env: { NODE_ENV: 'development' },
    defineEnv: swc.createDefineEnv({
      isTurbopack: true,
      clientRouterFilters: undefined,
      config: nextConfig,
      dev: true,
      distDir: '.next',
      projectPath: appDir,
      fetchCacheKeyPrefix: undefined,
      hasRewrites: false,
      middlewareMatchers: undefined,
      rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
    }),
    buildId: 'wasi-test',
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    previewProps: {
      previewModeId: 'aaaaaaaaaaaaaaaa',
      previewModeEncryptionKey: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      previewModeSigningKey: 'cccccccccccccccccccccccccccccccc',
    },
    browserslistQuery: 'last 1 Chrome versions',
    noMangling: false,
    writeRoutesHashesManifest: false,
    currentNodeJsVersion: process.versions.node,
    isPersistentCachingEnabled: false,
    nextVersion: process.env.NEXT_FIXTURE_VERSION ?? '16.2.10',
    serverHmr: false,
  },
  { isShortSession: true }
)
console.error('[app-test] ✅ createProject succeeded')

const statsTimer = setInterval(() => {
  const top = Object.entries(globalThis.__wasiStats ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6)
  const pages = globalThis.__wasiMemory ? globalThis.__wasiMemory.buffer.byteLength / 65536 : 0
  console.error('[wasi-stats]', `mem=${pages}p`, top.map(([k, v]) => `${k}=${v}`).join(' '))
}, 5000)
statsTimer.unref()

// ---- 4. entrypoints ---------------------------------------------------------
const subscription = project.entrypointsSubscribe()
const { value: entrypoints } = await subscription.next()
const routes = [...entrypoints.routes.keys()].sort()
console.error('[app-test] ✅ entrypoints received, routes:', JSON.stringify(routes))

// ---- 5. build one endpoint --------------------------------------------------
const page = entrypoints.routes.get(process.env.TEST_ROUTE ?? '/')
if (page) {
  console.error('[app-test] route', process.env.TEST_ROUTE ?? '/', 'type:', page.type)
  const candidates = [
    page.htmlEndpoint,
    page.rscEndpoint,
    page.endpoint,
    ...(page.pages ?? []).flatMap((p) => [p.htmlEndpoint, p.rscEndpoint, p.endpoint]),
  ].filter(Boolean)
  if (candidates.length) {
    const t = Date.now()
    const written = await candidates[0].writeToDisk()
    console.error(
      '[app-test] ✅ endpoint "/" COMPILED and written to disk in',
      Date.now() - t,
      'ms:',
      JSON.stringify(written).slice(0, 300)
    )
  } else {
    console.error('[app-test] no endpoint found; page:', JSON.stringify(page, null, 0).slice(0, 300))
  }
}
const finalPages = globalThis.__wasiMemory ? globalThis.__wasiMemory.buffer.byteLength / 65536 : 0
console.error('[app-test] DONE (memory now', finalPages, 'pages)')
process.exit(0)
