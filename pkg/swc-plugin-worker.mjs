// SWC plugin driver worker ("P" in docs/swc-plugin-host-bridge.md).
//
// The next-swc-wasi binding can't run SWC plugin wasm modules itself (no nested
// wasm engine), so it hands each plugin off to this worker, which owns a real
// `WebAssembly` engine. The binding's guest transform thread ("T") and this
// worker rendezvous through a fixed control block that lives in the binding's
// shared linear memory; we ping-pong with `Atomics.wait`/`notify`. This worker
// is a *dumb host*: it instantiates the plugin and runs its exports, and every
// host import the plugin calls is forwarded straight back to T's real
// swc_plugin_runner closures. It reimplements none of swc.
//
// One worker services channels sequentially. A transform blocks its T thread
// while it runs, so concurrent transforms from different T threads queue here
// (their signal messages wait in this worker's message queue until the current
// channel closes). That serializes plugin execution but never deadlocks;
// pooling is a later optimization.

import { workerData, parentPort } from 'node:worker_threads';
import fs from 'node:fs';

// The binding's shared linear memory ("G"). Views are re-derived from
// `memory.buffer` on every access because a threads-build shared memory can
// grow, leaving an old view seeing only the pre-grow length.
const memory = workerData.memory;
const g32 = () => new Int32Array(memory.buffer);
const g8 = () => new Uint8Array(memory.buffer);

// Opt-in tracing: set SRK_PLUGIN_DEBUG=1 in the host env before driving a
// transform. Off the hot path otherwise.
const DEBUG = !!process.env.SRK_PLUGIN_DEBUG;
// Synchronous stderr: the worker often blocks in Atomics.wait right after a log,
// which would strand a buffered console.error write.
const dbg = DEBUG ? (...a) => fs.writeSync(2, '[plugin-worker] ' + a.join(' ') + '\n') : () => {};
dbg('worker up; bytes =', memory.buffer.byteLength, 'shared =', memory.buffer instanceof SharedArrayBuffer);

// ---- protocol (must match turbopack/crates/swc-plugin-host-bridge/src/lib.rs) ----
const TURN_P = 0;
const TURN_T = 1;

const OP_INIT = 1;
const OP_TRANSFORM = 2;
const OP_CLOSE = 3;
const OP_IMPORT = 10;
const OP_CALLER_ALLOC = 20;
const OP_CALLER_FREE = 21;
const OP_CALLER_READ = 22;
const OP_CALLER_WRITE = 23;
const OP_DONE = 30;
const OP_ERROR = 31;

// Channel field offsets, as i32 indices relative to the channel base. Mirrors
// the `#[repr(C)]` layout of `Channel` in the Rust crate — keep in lockstep.
const F_TURN = 0;
const F_OP = 1;
const F_ARGS = 2; // args[8] -> 2..10
const F_RETS = 10; // rets[4] -> 10..14
const F_DATA_PTR = 14;
const F_DATA_LEN = 15;
const F_MODULE_PTR = 16;
const F_MODULE_LEN = 17;
const F_NAMES_PTR = 18;
const F_NAMES_LEN = 19;
const F_PROGRAM_PTR = 20;
const F_PROGRAM_LEN = 21;
const F_MARK = 22;
const F_COMMENTS_PROXY = 23;
const F_RESULT_CODE = 24;

const textDecoder = new TextDecoder();

// A tiny wasi_snapshot_preview1 shim. SWC plugins are wasm32-wasi reactors, but
// at transform time they touch almost nothing of wasi — a panic path writes to
// fd 2, and some read the clock or randomness. We provide just enough; anything
// unexpected traps loudly rather than corrupting state. (Kept self-contained so
// this worker runs on both plain Node and a node-compatible wasi runtime,
// neither of which is guaranteed to expose `node:wasi` inside a worker.)
function makeWasiImport(getInstance) {
  const WASI_ESUCCESS = 0;
  const WASI_ENOSYS = 52;
  const memU8 = () => new Uint8Array(getInstance().exports.memory.buffer);
  const memDV = () => new DataView(getInstance().exports.memory.buffer);
  const notImpl = () => WASI_ENOSYS;
  return {
    proc_exit: (code) => {
      throw new Error('swc plugin called proc_exit(' + code + ')');
    },
    fd_write: (fd, iovsPtr, iovsLen, nwrittenPtr) => {
      // Gather the iovec and surface it on the host console (fd 1/2). Plugins
      // only reach here on a panic/log, so correctness of the byte count is all
      // that matters to the guest.
      const dv = memDV();
      const u8 = memU8();
      let total = 0;
      let text = '';
      for (let i = 0; i < iovsLen; i++) {
        const base = dv.getUint32(iovsPtr + i * 8, true);
        const len = dv.getUint32(iovsPtr + i * 8 + 4, true);
        text += textDecoder.decode(u8.subarray(base, base + len));
        total += len;
      }
      dv.setUint32(nwrittenPtr, total, true);
      if (text) (fd === 2 ? console.error : console.log)('[swc-plugin] ' + text.replace(/\n$/, ''));
      return WASI_ESUCCESS;
    },
    fd_read: notImpl,
    fd_close: () => WASI_ESUCCESS,
    fd_seek: notImpl,
    fd_fdstat_get: () => WASI_ESUCCESS,
    fd_fdstat_set_flags: () => WASI_ESUCCESS,
    fd_prestat_get: () => 8 /* WASI_EBADF: no preopens */,
    fd_prestat_dir_name: notImpl,
    environ_get: () => WASI_ESUCCESS,
    environ_sizes_get: (countPtr, sizePtr) => {
      const dv = memDV();
      dv.setUint32(countPtr, 0, true);
      dv.setUint32(sizePtr, 0, true);
      return WASI_ESUCCESS;
    },
    args_get: () => WASI_ESUCCESS,
    args_sizes_get: (countPtr, sizePtr) => {
      const dv = memDV();
      dv.setUint32(countPtr, 0, true);
      dv.setUint32(sizePtr, 0, true);
      return WASI_ESUCCESS;
    },
    clock_time_get: (_id, _prec, outPtr) => {
      // Coarse monotonic-ish nanoseconds; plugins use this for timers/telemetry.
      const dv = memDV();
      const now = BigInt(Math.round(performance.now() * 1e6));
      dv.setBigUint64(outPtr, now, true);
      return WASI_ESUCCESS;
    },
    clock_res_get: (_id, outPtr) => {
      memDV().setBigUint64(outPtr, 1000n, true);
      return WASI_ESUCCESS;
    },
    random_get: (bufPtr, bufLen) => {
      const u8 = memU8();
      for (let i = 0; i < bufLen; i++) u8[bufPtr + i] = (Math.random() * 256) & 0xff;
      return WASI_ESUCCESS;
    },
    poll_oneoff: notImpl,
    sched_yield: () => WASI_ESUCCESS,
  };
}

// ---- rendezvous helpers ---------------------------------------------------
function handToT(base) {
  Atomics.store(g32(), base + F_TURN, TURN_T);
  Atomics.notify(g32(), base + F_TURN, 1);
}
function waitForP(base) {
  // Check-then-wait so a notify delivered before we parked isn't missed.
  for (;;) {
    if (Atomics.load(g32(), base + F_TURN) === TURN_P) return;
    dbg('waitForP parking; turn =', Atomics.load(g32(), base + F_TURN), 'want =', TURN_P);
    Atomics.wait(g32(), base + F_TURN, TURN_T);
    dbg('waitForP woke; turn =', Atomics.load(g32(), base + F_TURN));
  }
}
function reportDone(base) {
  Atomics.store(g32(), base + F_OP, OP_DONE);
  handToT(base);
}
function reportError(base) {
  Atomics.store(g32(), base + F_OP, OP_ERROR);
  handToT(base);
}

// Service one T→P plugin-memory op against the current plugin instance. Used
// both at the top level (the guest's alloc/write/free around a transform) and
// nested inside a forwarded import.
function serviceCaller(base, plugin, op) {
  const p = plugin.instance.exports;
  if (op === OP_CALLER_ALLOC) {
    const size = Atomics.load(g32(), base + F_ARGS);
    Atomics.store(g32(), base + F_RETS, p.__alloc(size) | 0);
  } else if (op === OP_CALLER_FREE) {
    const ptr = Atomics.load(g32(), base + F_ARGS);
    const size = Atomics.load(g32(), base + F_ARGS + 1);
    Atomics.store(g32(), base + F_RETS, p.__free(ptr, size) | 0);
  } else if (op === OP_CALLER_READ) {
    // plugin[ptr..ptr+len] -> guest[gptr..]
    const ptr = Atomics.load(g32(), base + F_ARGS);
    const gptr = Atomics.load(g32(), base + F_DATA_PTR);
    const len = Atomics.load(g32(), base + F_DATA_LEN);
    const src = new Uint8Array(p.memory.buffer, ptr, len);
    g8().set(src, gptr);
  } else if (op === OP_CALLER_WRITE) {
    // guest[gptr..gptr+len] -> plugin[ptr..]
    const ptr = Atomics.load(g32(), base + F_ARGS);
    const gptr = Atomics.load(g32(), base + F_DATA_PTR);
    const len = Atomics.load(g32(), base + F_DATA_LEN);
    const src = g8().slice(gptr, gptr + len);
    new Uint8Array(p.memory.buffer).set(src, ptr);
  } else {
    throw new Error('unknown caller op ' + op);
  }
  reportDone(base);
}

// Build the JS function the plugin imports as `env.<name>`. When the plugin
// calls it, we forward to T (which runs the real swc closure `idx`), servicing
// any plugin-memory ops the closure issues, until T reports the result.
function makeForwarder(base, plugin, idx) {
  return (...wasmArgs) => {
    dbg('import idx =', idx, 'args =', JSON.stringify(wasmArgs));
    const a = g32();
    Atomics.store(a, base + F_ARGS, idx);
    for (let k = 0; k < wasmArgs.length; k++) {
      Atomics.store(g32(), base + F_ARGS + 1 + k, wasmArgs[k] | 0);
    }
    Atomics.store(g32(), base + F_OP, OP_IMPORT);
    handToT(base);
    for (;;) {
      waitForP(base);
      const op = Atomics.load(g32(), base + F_OP);
      if (op === OP_DONE) return Atomics.load(g32(), base + F_RETS);
      if (op === OP_ERROR) throw new Error('guest closure reported an error for import #' + idx);
      serviceCaller(base, plugin, op); // OP_CALLER_* issued by the closure
    }
  };
}

function instantiatePlugin(base) {
  const modPtr = Atomics.load(g32(), base + F_MODULE_PTR);
  const modLen = Atomics.load(g32(), base + F_MODULE_LEN);
  const moduleBytes = g8().slice(modPtr, modPtr + modLen);

  const namesPtr = Atomics.load(g32(), base + F_NAMES_PTR);
  const namesLen = Atomics.load(g32(), base + F_NAMES_LEN);
  const names = textDecoder.decode(g8().slice(namesPtr, namesPtr + namesLen));
  const nameToIdx = new Map();
  names.split('\n').forEach((n, i) => nameToIdx.set(n, i));

  dbg('instantiate: module bytes =', moduleBytes.length, 'names =', JSON.stringify(names.slice(0, 60)));
  const module = new WebAssembly.Module(moduleBytes);

  const plugin = { instance: null };
  const env = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module !== 'env') continue;
    const idx = nameToIdx.get(imp.name);
    if (idx === undefined) {
      // The plugin imports a host function this swc_core doesn't provide; give it
      // a trap so a genuinely-incompatible plugin fails loudly instead of silently.
      env[imp.name] = () => {
        throw new Error('swc plugin imports unknown host function env.' + imp.name);
      };
    } else {
      env[imp.name] = makeForwarder(base, plugin, idx);
    }
  }

  let wasiImport = makeWasiImport(() => plugin.instance);
  if (DEBUG) {
    const raw = wasiImport;
    wasiImport = new Proxy(raw, {
      get(t, k) {
        const f = t[k];
        if (typeof f !== 'function') return f;
        return (...args) => { dbg('wasi', String(k), JSON.stringify(args)); return f(...args); };
      },
    });
  }
  plugin.instance = new WebAssembly.Instance(module, {
    env,
    wasi_snapshot_preview1: wasiImport,
    wasi_unstable: wasiImport,
  });

  // Reactor init, then the mandated post-instantiation core-diag call — its
  // host imports (diagnostics) fire here and are forwarded to the guest, exactly
  // as the wasmtime backend does in `Runtime::init`.
  const ex = plugin.instance.exports;
  if (typeof ex._initialize === 'function') ex._initialize();
  if (typeof ex.__get_transform_plugin_core_pkg_diag === 'function') {
    ex.__get_transform_plugin_core_pkg_diag();
  }
  return plugin;
}

function runTransform(base, plugin) {
  // program_ptr is already a *plugin*-memory pointer: the guest placed the
  // serialized program there via caller().alloc()+write_buf() (OP_CALLER_* we
  // serviced just before this). We only invoke the export.
  const ptr = Atomics.load(g32(), base + F_PROGRAM_PTR);
  const len = Atomics.load(g32(), base + F_PROGRAM_LEN);
  const mark = Atomics.load(g32(), base + F_MARK);
  const commentsProxy = Atomics.load(g32(), base + F_COMMENTS_PROXY);
  if (DEBUG) {
    const pv = new Uint8Array(plugin.instance.exports.memory.buffer, ptr, Math.min(len, 16));
    dbg('runTransform: plugin mem @ptr first bytes =', JSON.stringify(Array.from(pv)));
  }
  dbg('runTransform: __transform_plugin_process_impl ptr =', ptr, 'len =', len, 'mark =', mark, 'commentsProxy =', commentsProxy);
  const ret = plugin.instance.exports.__transform_plugin_process_impl(ptr, len, mark, commentsProxy);
  dbg('runTransform: returned', ret);
  Atomics.store(g32(), base + F_RESULT_CODE, ret | 0);
  reportDone(base);
}

// Drive one channel from INIT to CLOSE. Blocks this worker (and thus queues any
// other channels' signals) until the guest closes it.
function serveChannel(channelAddr) {
  const base = channelAddr >> 2;
  dbg('serveChannel addr =', channelAddr, 'base =', base, 'turn =', Atomics.load(g32(), base + F_TURN), 'op =', Atomics.load(g32(), base + F_OP));
  let plugin = null;
  for (;;) {
    waitForP(base);
    const op = Atomics.load(g32(), base + F_OP);
    dbg('woke, op =', op);
    try {
      if (op === OP_INIT) {
        plugin = instantiatePlugin(base);
        reportDone(base);
      } else if (op === OP_TRANSFORM) {
        runTransform(base, plugin);
      } else if (op >= OP_CALLER_ALLOC && op <= OP_CALLER_WRITE) {
        serviceCaller(base, plugin, op);
      } else if (op === OP_CLOSE) {
        return;
      } else {
        reportError(base);
        return;
      }
    } catch (err) {
      // Surface the failure to the guest (its `serve()` turns OP_ERROR into an
      // anyhow error on the transform) and stop servicing this channel.
      try {
        parentPort?.postMessage({ type: 'plugin-error', message: String(err && err.stack ? err.stack : err) });
      } catch {}
      reportError(base);
      return;
    }
  }
}

parentPort.on('message', (msg) => {
  dbg('message', JSON.stringify(msg));
  if (msg && typeof msg.channelAddr === 'number') serveChannel(msg.channelAddr);
});
