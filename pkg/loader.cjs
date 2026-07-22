'use strict';
// next-swc-wasi loader: instantiates the wasi binding in this package and
// exposes its napi exports. Shipped INSIDE the package so it is built and
// versioned against the exact next release the artifact matches — a host
// runtime (e.g. strapkit) only ever requires `next-swc-wasi/auto` and never
// needs updating when next internals move.
//
// Two personalities:
//
// 1. Main thread: exports.ensureInit() instantiates the wasm ASYNC (the sync
//    napi path cannot complete the worker-spawn handshake for the async work
//    pool) and calls the raw `init_turbopack_wasi_runtime_raw(threads)`
//    export BEFORE any napi call (a napi call first would install a starved
//    single-threaded tokio runtime). On success the napi exports are grafted
//    onto module.exports, with `registerWorkerScheduler` wrapped so WE own
//    the turbopack-node pool workers (they need the RPC bridge below).
//
// 2. turbopack-node pool worker (spawned with workerData.bindingPath =
//    binding.cjs): no wasm instance exists in that thread. Native builds
//    share the dylib's process statics across worker_threads for free; for
//    wasm we bridge instead: the worker's binding proxies the three
//    global-Rust-state pool calls (workerCreated / sendTaskMessage /
//    recvTaskMessageInWorker) to the main thread over parentPort.
//
// Env knobs: SRK_TURBOPACK_DEBUG=1 (logs), SRK_TURBOPACK_THREADS (default 4).
const {
  isMainThread,
  parentPort,
  workerData,
  Worker,
} = require('node:worker_threads');

const DEBUG = !!process.env.SRK_TURBOPACK_DEBUG;
const dbg = (...args) => { if (DEBUG) console.error('[next-swc-wasi pid=' + process.pid + ']', ...args); };

const IN_POOL_WORKER =
  !isMainThread && workerData && typeof workerData === 'object' && 'bindingPath' in workerData;

if (IN_POOL_WORKER) {
  // ---------------- pool-worker side: RPC proxy ----------------
  let nextId = 1;
  const pending = new Map();
  parentPort.on('message', (msg) => {
    const reply = msg && msg.__nextSwcWasiRpcReply;
    if (!reply) return;
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    if (reply.ok) entry.resolve(reply.value);
    else entry.reject(Object.assign(new Error(reply.error.message), { stack: reply.error.stack }));
  });

  const rpc = (method, args) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      parentPort.postMessage({ __nextSwcWasiRpc: { id, method, args } });
    });

  const binding = {
    // called synchronously (no await) by turbopack-node's evaluate.ts; port
    // message ordering keeps it ahead of the first recvTaskMessageInWorker
    // dispatched on the main side
    workerCreated: (workerId) => {
      rpc('workerCreated', [workerId]).catch((err) =>
        console.error('[next-swc-wasi:worker] workerCreated failed:', err)
      );
    },
    sendTaskMessage: (message) => rpc('sendTaskMessage', [message]),
    recvTaskMessageInWorker: (workerId) => rpc('recvTaskMessageInWorker', [workerId]),
  };

  module.exports = new Proxy(binding, {
    get(target, prop) {
      if (prop in target || typeof prop !== 'string') return target[prop];
      // signal clearly which method a future pool module needs bridged
      return () => {
        throw new Error(`[next-swc-wasi:worker] binding.${prop} is not bridged to pool workers`);
      };
    },
  });
} else {
  // ---------------- main-thread side ----------------

  // Parse the module's imported-memory limits from the wasm import section so
  // the supplied memory always matches what the binding was linked against.
  // Start at the module's own minimum and let it grow.
  function memoryLimits(buf) {
    let off = 8;
    const leb = () => { let r = 0, s = 0; for (;;) { const b = buf[off++]; r |= (b & 0x7f) << s; if (!(b & 0x80)) return r >>> 0; s += 7; } };
    while (off < buf.length) {
      const id = buf[off++], size = leb(), end = off + size;
      if (id === 2) {
        const count = leb();
        for (let i = 0; i < count; i++) {
          const mlen = leb(); off += mlen;
          const nlen = leb(); off += nlen;
          const kind = buf[off++];
          if (kind === 0) leb(); // func: typeidx
          else if (kind === 1) { off++; if (buf[off - 1] & 1) { leb(); leb(); } else leb(); } // table
          else if (kind === 2) { // memory
            const flags = buf[off++];
            const min = leb();
            const max = flags & 1 ? leb() : undefined;
            return { min, max, shared: !!(flags & 2) };
          } else if (kind === 3) off += 2; // global: type + mut
        }
      }
      off = end;
    }
    return null;
  }

  // Only pool-protocol methods run on behalf of workers; they all operate on
  // global Rust state, not per-env state, so proxying them is sound.
  const RPC_METHODS = new Set(['workerCreated', 'sendTaskMessage', 'recvTaskMessageInWorker']);

  // NapiTaskMessage.data is a napi Buffer: coerce inbound Uint8Arrays (from
  // structured clone) to Buffer, and copy outbound buffers (which may view
  // wasm memory) before posting.
  const toNapiArg = (arg) =>
    arg && typeof arg === 'object' && arg.data instanceof Uint8Array && !Buffer.isBuffer(arg.data)
      ? { ...arg, data: Buffer.from(arg.data) }
      : arg;
  const toCloneable = (value) =>
    value && typeof value === 'object' && value.data instanceof Uint8Array
      ? { ...value, data: new Uint8Array(value.data) }
      : value;

  let initPromise = null;

  // Instantiate the wasi binding and graft its exports onto module.exports.
  // Idempotent; resolves true when the binding is live, false on failure
  // (callers fall back to stock next behavior).
  function ensureInit() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const path = require('node:path');
      const fs = require('node:fs');
      const { WASI } = require('node:wasi');

      const rt = require('@napi-rs/wasm-runtime');
      const bytes = fs.readFileSync(path.join(__dirname, 'index.wasm32-wasi.wasm'));
      const limits = memoryLimits(bytes) ?? { min: 8192, max: 65536, shared: true };
      dbg('module memory limits', JSON.stringify(limits));

      const threads = Math.max(2, parseInt(process.env.SRK_TURBOPACK_THREADS || '', 10) || 4);
      const wasi = new WASI({ version: 'preview1', env: process.env, preopens: { '/': '/' } });

      const { napiModule } = await rt.instantiateNapiModule(bytes, {
        context: rt.getDefaultContext(),
        asyncWorkPoolSize: threads,
        reuseWorker: { size: threads * 2, strict: false },
        wasi,
        onCreateWorker() {
          dbg('wasi worker spawn');
          const w = new Worker(path.join(__dirname, 'wasi-worker.mjs'), { env: process.env });
          w.on('error', (e) => console.error('[next-swc-wasi] wasi worker error:', e && e.message || e));
          return w;
        },
        overwriteImports(importObject) {
          importObject.env = {
            ...importObject.env,
            ...importObject.napi,
            ...importObject.emnapi,
            memory: new WebAssembly.Memory({
              initial: limits.min,
              maximum: limits.max ?? 65536,
              shared: limits.shared,
            }),
          };
          return importObject;
        },
        beforeInit({ instance }) {
          // Must run before ANY napi call: installs the multi-threaded tokio
          // runtime (see the host contract in the repo README).
          const rc = instance.exports.init_turbopack_wasi_runtime_raw(threads);
          dbg('raw runtime install rc =', rc);
          for (const name of Object.keys(instance.exports)) {
            if (name.startsWith('__napi_register__')) instance.exports[name]();
          }
        },
      });
      const raw = napiModule.exports;
      dbg('instantiated,', Object.keys(raw).length, 'exports');
      if (typeof raw.initTurbopackWasiRuntime === 'function') {
        raw.initTurbopackWasiRuntime(threads);
      }

      // Host fetch bridge: turbo-tasks-fetch has no HTTP client on wasm
      // (reqwest doesn't build), so the binding delegates fetches (next/font's
      // Google Fonts css/woff2 downloads) to this callback. Plain node
      // http/https so it works on any host; rejections surface as fetch
      // issues on the requesting route, same as a network error on native.
      // (CalleeHandled tsfn: first arg is a conversion error, always null in
      // practice.)
      if (typeof raw.initTurbopackFetchBridge === 'function') {
        const fetchOnce = (url, userAgent, redirectsLeft) =>
          new Promise((resolve, reject) => {
            let u;
            try {
              u = new URL(url);
            } catch (err) {
              return reject(err);
            }
            const mod = u.protocol === 'http:' ? require('http') : require('https');
            const req = mod.request(
              {
                protocol: u.protocol,
                hostname: u.hostname,
                port: u.port || undefined,
                path: u.pathname + u.search,
                method: 'GET',
                headers: userAgent ? { 'user-agent': userAgent } : {},
              },
              (res) => {
                const status = res.statusCode || 0;
                if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
                  res.resume();
                  return resolve(
                    fetchOnce(
                      new URL(res.headers.location, url).toString(),
                      userAgent,
                      redirectsLeft - 1
                    )
                  );
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
                res.on('error', reject);
              }
            );
            req.on('error', reject);
            req.end();
          });
        raw.initTurbopackFetchBridge((conversionError, url, userAgent) => {
          if (conversionError) return Promise.reject(conversionError);
          dbg('fetch bridge:', url);
          return fetchOnce(url, userAgent, 5);
        });
      }

      // Graft the bindings onto THIS module's exports (the CJS cache means
      // next's loadNative() require of binding.cjs sees the same object).
      Object.assign(module.exports, raw);

      // Wrap registerWorkerScheduler so we create the turbopack-node pool
      // workers ourselves (next's loaderWorkerPool would too, but we need to
      // own the Worker objects to service the pool RPC bridge).
      const poolWorkers = new Map(); // threadId -> Worker
      async function handleRpc(worker, { id, method, args }) {
        try {
          if (!RPC_METHODS.has(method)) {
            throw new Error(`binding method not bridged to pool workers: ${method}`);
          }
          const value = toCloneable(await raw[method](...args.map(toNapiArg)));
          worker.postMessage({ __nextSwcWasiRpcReply: { id, ok: true, value } });
        } catch (err) {
          worker.postMessage({
            __nextSwcWasiRpcReply: {
              id,
              ok: false,
              error: { message: String((err && err.message) || err), stack: err && err.stack },
            },
          });
        }
      }
      if (typeof raw.registerWorkerScheduler === 'function') {
        const bindingPath = path.join(__dirname, 'binding.cjs');
        module.exports.registerWorkerScheduler = (_creator, _terminator) =>
          raw.registerWorkerScheduler(
            (creation) => {
              const { filename, cwd } = creation.options;
              dbg('pool worker spawn', filename);
              const worker = new Worker(filename, {
                workerData: { bindingPath, cwd },
              });
              worker.on('message', (msg) => {
                if (msg && msg.__nextSwcWasiRpc) handleRpc(worker, msg.__nextSwcWasiRpc);
              });
              worker.on('error', (err) => console.error('[next-swc-wasi] pool worker error:', err));
              worker.on('exit', () => poolWorkers.delete(worker.threadId));
              poolWorkers.set(worker.threadId, worker);
            },
            (termination) => {
              const worker = poolWorkers.get(termination.workerId);
              poolWorkers.delete(termination.workerId);
              if (worker) void worker.terminate();
            }
          );
      }
      module.exports.ready = true;
      return true;
    })().catch((err) => {
      console.error('[next-swc-wasi] init failed, next falls back to stock bindings:', err && err.message || err);
      dbg(err && err.stack);
      return false;
    });
    return initPromise;
  }

  module.exports.ensureInit = ensureInit;
}
