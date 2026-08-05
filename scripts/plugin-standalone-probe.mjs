// Isolation probe: run an SWC plugin's __transform_plugin_process_impl directly
// under Node's WebAssembly, bypassing the host-plugin bridge entirely. Feeds a
// serialized program (dumped from a real transform) and trivial JS env stubs.
// If this hangs, the plugin doesn't execute under V8 at all (not a bridge bug).
//
// Usage: node scripts/plugin-standalone-probe.mjs <plugin.wasm> <program.bin>
import fs from 'node:fs'

const pluginWasm = process.argv[2]
const programFile = process.argv[3]
const wasmBytes = fs.readFileSync(pluginWasm)
const program = fs.readFileSync(programFile)
const log = (...a) => fs.writeSync(2, '[standalone] ' + a.join(' ') + '\n')

const module = new WebAssembly.Module(wasmBytes)
const importedEnv = WebAssembly.Module.imports(module).filter((i) => i.module === 'env').map((i) => i.name)
log('env imports:', importedEnv.join(', '))

let inst = null
let resultPtr = 0
let resultLen = 0

// Trivial env: record the transform result, no-op everything else. Enough to let
// the plugin run its deserialize -> (identity) -> serialize path.
const env = {}
for (const name of importedEnv) {
  if (name === '__set_transform_result') env[name] = (p, l) => { resultPtr = p; resultLen = l; log('set_transform_result', p, l) }
  else env[name] = (...args) => { log('env call', name, JSON.stringify(args)); return 0 }
}

const memDV = () => new DataView(inst.exports.memory.buffer)
const memU8 = () => new Uint8Array(inst.exports.memory.buffer)
const wasi = new Proxy({}, {
  get: (_t, k) => (...args) => {
    if (k === 'proc_exit') { throw new Error('proc_exit(' + args[0] + ')') }
    if (k === 'fd_write') {
      const [fd, iovs, iovsLen, nwritten] = args
      const dv = memDV(); let total = 0
      for (let i = 0; i < iovsLen; i++) total += dv.getUint32(iovs + i * 8 + 4, true)
      dv.setUint32(nwritten, total, true)
      return 0
    }
    if (k === 'random_get') { const [p, n] = args; const u8 = memU8(); for (let i = 0; i < n; i++) u8[p + i] = 0; return 0 }
    if (String(k).endsWith('_sizes_get')) { const dv = memDV(); dv.setUint32(args[0], 0, true); dv.setUint32(args[1], 0, true); return 0 }
    log('wasi', String(k), JSON.stringify(args))
    return 0
  },
})

inst = new WebAssembly.Instance(module, { env, wasi_snapshot_preview1: wasi, wasi_unstable: wasi })
if (typeof inst.exports._initialize === 'function') { log('_initialize'); inst.exports._initialize() }
if (typeof inst.exports.__get_transform_plugin_core_pkg_diag === 'function') { log('core_pkg_diag'); inst.exports.__get_transform_plugin_core_pkg_diag() }

const ptr = inst.exports.__alloc(program.length)
memU8().set(program, ptr)
log('calling __transform_plugin_process_impl ptr =', ptr, 'len =', program.length)
const t0 = Date.now()
const ret = inst.exports.__transform_plugin_process_impl(ptr, program.length, 1, 1)
log('RETURNED', ret, 'in', Date.now() - t0, 'ms; result at', resultPtr, resultLen)
if (resultLen > 0) {
  const out = Buffer.from(memU8().subarray(resultPtr, resultPtr + Math.min(resultLen, 64)))
  log('result head:', JSON.stringify(Array.from(out.subarray(0, 16))))
}
log('DONE')
