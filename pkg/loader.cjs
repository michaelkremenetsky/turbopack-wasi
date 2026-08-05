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

// Host side of the link-section custom-section protocol (env.read_custom_section).
// Lives next to this file in the published package; when running from the repo
// checkout (pkg/ next to scripts/) fall back to the source copy.
let makeReadCustomSection;
try {
  ({ makeReadCustomSection } = require('./wasm-link-sections.cjs'));
} catch (e) {
  ({ makeReadCustomSection } = require('../scripts/wasm-link-sections.cjs'));
}

const DEBUG = !!process.env.SRK_TURBOPACK_DEBUG;
const dbg = (...args) => { if (DEBUG) console.error('[next-swc-wasi pid=' + process.pid + ']', ...args); };
// Debug tag telling module INSTANCES apart: the same file evaluated twice in
// one process means two initPromises and two wasm instantiations — exactly the
// double-init class of bug — and pid alone can't show it.
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);
dbg('loader module evaluated, instance=' + INSTANCE_ID, 'file=' + __filename, 'isMainThread=' + isMainThread);

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

  // Process-global init state, keyed off globalThis so it is shared across
  // MODULE REGISTRIES, not just across requires in one registry. jest is the
  // motivating case: its sandboxed module system re-evaluates this file fresh
  // per test context (next-swc.test.ts calls installBindings() inside the
  // sandbox), and a per-module initPromise would mean a second 56MB wasm
  // instantiation racing the first. Every instance shares one init and grafts
  // the same surface (raw exports + the pool-owning registerWorkerScheduler
  // wrapper) onto its own module.exports.
  const G_KEY = Symbol.for('next-swc-wasi.loaderState');
  const G = globalThis[G_KEY] || (globalThis[G_KEY] = { initPromise: null, surface: null });

  function applyGraft(exp) {
    if (!G.surface) return;
    Object.assign(exp, G.surface.raw, G.surface.overrides);
    exp.ready = true;
  }

  // Instantiate the wasi binding and graft its exports onto module.exports.
  // Idempotent; resolves true when the binding is live, false on failure
  // (callers fall back to stock next behavior).
  function ensureInit() {
    if (initPromise) return initPromise;
    dbg('ensureInit starting, instance=' + INSTANCE_ID);
    if (G.initPromise) {
      initPromise = G.initPromise.then((ok) => {
        if (ok) applyGraft(module.exports);
        return ok;
      });
      return initPromise;
    }
    G.initPromise = (async () => {
      const path = require('node:path');
      const fs = require('node:fs');
      const { WASI } = require('node:wasi');

      const rt = require('@napi-rs/wasm-runtime');
      const bytes = fs.readFileSync(path.join(__dirname, 'index.wasm32-wasi.wasm'));
      const limits = memoryLimits(bytes) ?? { min: 8192, max: 65536, shared: true };
      dbg('module memory limits', JSON.stringify(limits));

      const threads = Math.max(2, parseInt(process.env.SRK_TURBOPACK_THREADS || '', 10) || 4);
      // std::thread::available_parallelism() returns Err on wasi (no CPU probe),
      // which collapses turbopack's JS evaluate pool (postcss / tailwind /
      // webpack-loaders / next-font) to a concurrency of 1 for the WHOLE
      // compilation, and leaves the turbo-tasks scope pool at its own default.
      // A hello-world has one CSS entry so it's invisible, but a real monorepo
      // then serializes every loader-evaluated module through a single worker.
      // Tie both parallelism knobs to the same thread budget. Must be set before
      // the WASI env and the pool workers are created (both capture process.env)
      // so the guest reads it; an explicit override by the host is respected.
      if (!process.env.TURBO_TASKS_AVAILABLE_PARALLELISM) {
        process.env.TURBO_TASKS_AVAILABLE_PARALLELISM = String(threads);
      }
      if (!process.env.TURBOPACK_PARALLELISM) {
        process.env.TURBOPACK_PARALLELISM = String(threads);
      }
      const wasi = new WASI({ version: 'preview1', env: process.env, preopens: { '/': '/' } });

      // Captured from overwriteImports below so the SWC-plugin bridge worker can
      // view the guest's shared linear memory (where its control blocks live).
      let pluginBridgeMemory = null;

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
          pluginBridgeMemory = new WebAssembly.Memory({
            initial: limits.min,
            maximum: limits.max ?? 65536,
            shared: limits.shared,
          });
          importObject.env = {
            ...importObject.env,
            ...importObject.napi,
            ...importObject.emnapi,
            memory: pluginBridgeMemory,
            // 16.3.0's turbo-tasks registries live in named custom sections and
            // the guest sizes them through this host import (see
            // wasm-link-sections.cjs). The napi-generated loaders get it via
            // inject-read-custom-section.mjs; this hand-written instantiation
            // needs it wired the same way. Harmless on pre-16.3 modules that
            // don't import it. The memory getter returns the imported memory —
            // that IS the instance's linear memory.
            read_custom_section: makeReadCustomSection(bytes, () => pluginBridgeMemory),
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

      // Host SWC-plugin bridge: experimental.swcPlugins modules can't run inside
      // the binding (no nested wasm engine), so they execute in a dedicated worker
      // that owns a real WebAssembly engine (swc-plugin-worker.mjs;
      // docs/swc-plugin-host-bridge.md). The binding signals the worker with the
      // address of a control block in the shared linear memory; the worker drives
      // the plugin and forwards its host imports back to the binding's swc
      // closures. Spawned lazily on the first signal — apps with no swcPlugins
      // never create it.
      if (typeof raw.initSwcPluginBridge === 'function' && pluginBridgeMemory) {
        let pluginWorker = null;
        raw.initSwcPluginBridge((_conversionError, channelAddr) => {
          if (!pluginWorker) {
            pluginWorker = new Worker(path.join(__dirname, 'swc-plugin-worker.mjs'), {
              workerData: { memory: pluginBridgeMemory },
            });
            // Don't keep the host process alive just for the plugin driver.
            pluginWorker.unref();
            pluginWorker.on('error', (e) =>
              console.error('[next-swc-wasi] swc plugin worker error:', (e && e.message) || e));
            pluginWorker.on('message', (m) => {
              if (m && m.type === 'plugin-error') dbg('swc plugin error:', m.message);
            });
          }
          dbg('swc plugin bridge: signal channel', channelAddr);
          pluginWorker.postMessage({ channelAddr });
        });
      }

      // Host process bridge: pre-16.2 turbopack evaluates JS (postcss,
      // webpack loaders) through a pool of `node <entrypoint>` children wired
      // up over loopback TCP — which plain wasi lacks but this host has
      // (plain Node's child_process/net, or a node-compatible wasi runtime's
      // guest syscalls). The binding delegates spawn/listen/stream traffic to
      // these callbacks; pool children are stock node processes running
      // turbopack's own ipc entrypoint and never load the binding. 16.2+
      // builds use the worker_threads pool instead and don't export this.
      if (typeof raw.initTurbopackProcessBridge === 'function') {
        const cp = require('node:child_process');
        const net = require('node:net');
        const procs = new Map(); // procId -> ChildProcess
        const conns = new Map(); // connId -> net.Socket
        const servers = new Map(); // listenerId -> net.Server
        // Rust allocates ids counting up from 1; host-side conn ids count
        // down from the top of the u32 range so they can never collide.
        let nextConnId = 0xffffffff;
        const push = (id, data) => {
          try {
            raw.turbopackPoolPushBytes(id, data);
          } catch (err) {
            dbg('pool push failed:', err && err.message || err);
          }
        };
        raw.initTurbopackProcessBridge(
          (convErr, req) => {
            if (convErr) return;
            dbg('pool spawn', req.program, req.args[req.args.length - 1]);
            let exited = false;
            const exit = (code) => {
              if (exited) return;
              exited = true;
              push(req.stdoutId, null);
              push(req.stderrId, null);
              procs.delete(req.procId);
              try {
                raw.turbopackPoolProcExit(req.procId, code);
              } catch (err) {
                dbg('pool exit report failed:', err && err.message || err);
              }
            };
            let child;
            try {
              child = cp.spawn(req.program, req.args, {
                cwd: req.cwd || undefined,
                env: req.env,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
            } catch (err) {
              push(req.stderrId, Buffer.from('spawn failed: ' + (err && err.message || err) + '\n'));
              return exit(127);
            }
            procs.set(req.procId, child);
            child.stdout.on('data', (b) => push(req.stdoutId, b));
            child.stderr.on('data', (b) => push(req.stderrId, b));
            child.on('error', (err) => {
              // ENOENT etc.; 'close' follows with code null and reports exit.
              push(req.stderrId, Buffer.from('spawn failed: ' + (err && err.message || err) + '\n'));
            });
            // 'close' (not 'exit') so stdio is fully drained before EOF+exit.
            child.on('close', (code, signal) => exit(code == null ? (signal ? 137 : 127) : code));
          },
          (convErr, streamId, data) => {
            if (convErr) return;
            const sock = conns.get(streamId);
            if (sock && !sock.destroyed) sock.write(Buffer.from(data));
          },
          (convErr, op, id) => {
            if (convErr) return;
            if (op === 'kill') {
              const child = procs.get(id);
              if (child) {
                try { child.kill('SIGKILL'); } catch { /* already gone */ }
              }
            } else if (op === 'closeWrite') {
              const sock = conns.get(id);
              if (sock) {
                try { sock.end(); } catch { /* already gone */ }
              }
            } else if (op === 'dropConn') {
              const sock = conns.get(id);
              conns.delete(id);
              if (sock) {
                try { sock.destroy(); } catch { /* already gone */ }
              }
            } else if (op === 'closeListener') {
              const server = servers.get(id);
              servers.delete(id);
              if (server) {
                try { server.close(); } catch { /* already gone */ }
              }
            }
          },
          (convErr, listenerId) => {
            if (convErr) return Promise.reject(convErr);
            return new Promise((resolve, reject) => {
              const server = net.createServer((sock) => {
                const connId = nextConnId--;
                conns.set(connId, sock);
                sock.on('error', () => { /* surfaced as EOF via close */ });
                // Register the Rust-side channel before any data can flow.
                try {
                  raw.turbopackPoolAccept(listenerId, connId);
                } catch (err) {
                  dbg('pool accept report failed:', err && err.message || err);
                  sock.destroy();
                  conns.delete(connId);
                  return;
                }
                sock.on('data', (b) => push(connId, b));
                sock.on('close', () => {
                  push(connId, null);
                  conns.delete(connId);
                });
              });
              server.on('error', reject);
              servers.set(listenerId, server);
              server.listen(0, '127.0.0.1', () => resolve(server.address().port));
            });
          }
        );
        dbg('host process bridge registered');
      }

      // Build the graft surface (raw exports + overrides). applyGraft copies
      // it onto each loader instance's module.exports -- for THIS instance
      // right below, and synchronously at require time for any instance a
      // later module registry (jest sandbox) evaluates after init completed.
      const overrides = {};

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
        overrides.registerWorkerScheduler = (_creator, _terminator) =>
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
      G.surface = { raw, overrides };
      return true;
    })().catch((err) => {
      console.error('[next-swc-wasi] init failed, next falls back to stock bindings:', err && err.message || err);
      dbg(err && err.stack);
      return false;
    });
    initPromise = G.initPromise.then((ok) => {
      if (ok) applyGraft(module.exports);
      return ok;
    });
    return initPromise;
  }

  module.exports.ensureInit = ensureInit;
  // A fresh module instance in a process whose init already finished (jest
  // sandbox registries) is live synchronously -- binding.cjs's ready check
  // must pass without anyone awaiting ensureInit on THIS instance.
  applyGraft(module.exports);
}
