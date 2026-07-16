// Returned by require() when next's loadNative() follows
// __INTERNAL_CUSTOM_TURBOPACK_BINDINGS.
//
// Two personalities:
//
// 1. Main thread: the driver instantiates the wasi module (async) BEFORE
//    loading next, and parks the exports on globalThis.__WASI_BINDINGS__.
//    We hand those out, but wrap registerWorkerScheduler so WE create the
//    turbopack-node pool workers (next's loaderWorkerPool is a trivial
//    Worker-per-creation map; we reimplement it) and own the Worker objects.
//
// 2. turbopack-node pool worker (spawned with workerData.bindingPath = this
//    file): there is no wasm instance in this thread. Native builds share the
//    dylib's process statics across worker_threads for free; for wasm we
//    bridge instead: the worker's binding is a proxy that forwards the three
//    calls the pool protocol uses (workerCreated / sendTaskMessage /
//    recvTaskMessageInWorker — all backed by global Rust state) to the main
//    thread over parentPort, where they run against the real instance.
const {
  isMainThread,
  parentPort,
  workerData,
  Worker,
} = require('node:worker_threads')

const IN_POOL_WORKER =
  !isMainThread && workerData && typeof workerData === 'object' && 'bindingPath' in workerData

if (IN_POOL_WORKER) {
  // ---------------- worker-thread side: RPC proxy ----------------
  let nextId = 1
  const pending = new Map()
  parentPort.on('message', (msg) => {
    const reply = msg && msg.__wasiRpcReply
    if (!reply) return
    const entry = pending.get(reply.id)
    if (!entry) return
    pending.delete(reply.id)
    if (reply.ok) entry.resolve(reply.value)
    else entry.reject(Object.assign(new Error(reply.error.message), { stack: reply.error.stack }))
  })

  const rpc = (method, args) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      parentPort.postMessage({ __wasiRpc: { id, method, args } })
    })

  const binding = {
    // called synchronously (no await) by evaluate.ts; port ordering keeps it
    // ahead of the first recvTaskMessageInWorker on the main side
    workerCreated: (workerId) => {
      rpc('workerCreated', [workerId]).catch((err) =>
        console.error('[wasi-shim:worker] workerCreated failed:', err)
      )
    },
    sendTaskMessage: (message) => rpc('sendTaskMessage', [message]),
    recvTaskMessageInWorker: (workerId) => rpc('recvTaskMessageInWorker', [workerId]),
  }

  module.exports = new Proxy(binding, {
    get(target, prop) {
      if (prop in target || typeof prop !== 'string') return target[prop]
      // signal clearly which method a future pool module needs bridged
      return (...args) => {
        throw new Error(`[wasi-shim:worker] binding.${prop} is not bridged to pool workers`)
      }
    },
  })
} else {
  // ---------------- main-thread side ----------------
  if (!globalThis.__WASI_BINDINGS__) {
    throw new Error(
      'wasi bindings not instantiated yet — driver must set globalThis.__WASI_BINDINGS__ first'
    )
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

  // Only pool-protocol methods run on behalf of workers; they all operate on
  // global Rust state, not per-env state, so proxying them is sound.
  const RPC_METHODS = new Set(['workerCreated', 'sendTaskMessage', 'recvTaskMessageInWorker'])

  // NapiTaskMessage.data is a napi Buffer: coerce inbound Uint8Arrays (from
  // structured clone) to Buffer, and copy outbound buffers (which may view
  // wasm memory) before transferring.
  const toNapiArg = (arg) =>
    arg && typeof arg === 'object' && arg.data instanceof Uint8Array && !Buffer.isBuffer(arg.data)
      ? { ...arg, data: Buffer.from(arg.data) }
      : arg
  const toCloneable = (value) =>
    value && typeof value === 'object' && value.data instanceof Uint8Array
      ? { ...value, data: new Uint8Array(value.data) }
      : value

  async function handleRpc(worker, { id, method, args }) {
    try {
      if (!RPC_METHODS.has(method)) {
        throw new Error(`binding method not bridged to pool workers: ${method}`)
      }
      const value = toCloneable(await raw[method](...args.map(toNapiArg)))
      worker.postMessage({ __wasiRpcReply: { id, ok: true, value } })
    } catch (err) {
      worker.postMessage({
        __wasiRpcReply: {
          id,
          ok: false,
          error: { message: String((err && err.message) || err), stack: err && err.stack },
        },
      })
    }
  }

  const poolWorkers = new Map() // threadId -> Worker
  wrapped.registerWorkerScheduler = (_creator, _terminator) =>
    raw.registerWorkerScheduler(
      (creation) => {
        const { filename, cwd } = creation.options
        const worker = new Worker(filename, {
          workerData: { bindingPath: __filename, cwd },
        })
        worker.on('message', (msg) => {
          if (msg && msg.__wasiRpc) handleRpc(worker, msg.__wasiRpc)
        })
        worker.on('error', (err) => console.error('[wasi-shim] pool worker error:', err))
        worker.on('exit', () => poolWorkers.delete(worker.threadId))
        poolWorkers.set(worker.threadId, worker)
      },
      (termination) => {
        const worker = poolWorkers.get(termination.workerId)
        poolWorkers.delete(termination.workerId)
        if (worker) void worker.terminate()
      }
    )

  module.exports = wrapped
}
