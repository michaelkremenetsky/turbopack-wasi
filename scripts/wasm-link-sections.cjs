// Host side of the `link-section` / `linktime` custom-section protocol.
//
// As of next 16.3.0, turbo-tasks registers `#[turbo_tasks::function]`s (and
// trait impls, value types, etc.) through `scattered-collect` -> `linktime` ->
// `link-section`. On wasm that machinery keeps its registries in named *custom
// sections* of the module (e.g. `.data.link_section.FUNCTIONS_<hash>`): the
// guest emits one counting byte per registered item into the section, then at
// startup asks the host how big each section is so it can size the heap buffer
// its `.init_array` constructors fill in.
//
// The guest imports a single function to do that:
//
//   env.read_custom_section(name_ptr, name_len, target_ptr, target_len) -> size
//
// It reads `name` (a UTF-8 string in guest memory), finds the module custom
// section with that exact name, and returns the section's byte length. If a
// non-empty target buffer is given it also copies up to `target_len` bytes of
// the section into guest memory (link-section only ever queries the size, but
// we honor the copy form too). Custom sections aren't reachable from inside the
// module at runtime, so this has to be a host import; without it the module
// fails to instantiate (`LinkError: "env" "read_custom_section" ... requires a
// callable`).

'use strict'

/**
 * Parse the WebAssembly module's custom sections into a name -> Uint8Array map.
 * @param {Uint8Array|Buffer} bytes the raw .wasm bytes
 * @returns {Map<string, Uint8Array>}
 */
function parseCustomSections(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const sections = new Map()
  // magic (4) + version (4)
  if (u8.length < 8) return sections
  let o = 8
  const readVarU32 = () => {
    let result = 0
    let shift = 0
    let byte
    do {
      byte = u8[o++]
      result |= (byte & 0x7f) << shift
      shift += 7
    } while (byte & 0x80)
    return result >>> 0
  }
  while (o < u8.length) {
    const id = u8[o++]
    const size = readVarU32()
    const sectionEnd = o + size
    if (id === 0) {
      // custom section: name is a length-prefixed UTF-8 string, rest is payload
      const nameStart = o
      const nameLen = readVarU32()
      const name = Buffer.from(u8.buffer, u8.byteOffset + o, nameLen).toString('utf8')
      o += nameLen
      const payload = u8.subarray(o, sectionEnd)
      // A name can legally appear more than once; concatenate to match the
      // linker's view of the merged section.
      const prev = sections.get(name)
      if (prev) {
        const merged = new Uint8Array(prev.length + payload.length)
        merged.set(prev)
        merged.set(payload, prev.length)
        sections.set(name, merged)
      } else {
        sections.set(name, payload.slice())
      }
      void nameStart
    }
    o = sectionEnd
  }
  return sections
}

/**
 * Look up a custom section's bytes by name.
 * @param {Map<string,Uint8Array>|WebAssembly.Module} source parsed section map,
 *        or a compiled module (uses the standard
 *        `WebAssembly.Module.customSections`, e.g. in worker threads that only
 *        receive the module, not the raw bytes)
 * @returns {(name:string) => Uint8Array|null}
 */
function makeSectionLookup(source) {
  if (typeof WebAssembly !== 'undefined' && source instanceof WebAssembly.Module) {
    return (name) => {
      const arrs = WebAssembly.Module.customSections(source, name)
      if (!arrs.length) return null
      if (arrs.length === 1) return new Uint8Array(arrs[0])
      let total = 0
      for (const a of arrs) total += a.byteLength
      const merged = new Uint8Array(total)
      let off = 0
      for (const a of arrs) {
        merged.set(new Uint8Array(a), off)
        off += a.byteLength
      }
      return merged
    }
  }
  const sections = source instanceof Map ? source : parseCustomSections(source)
  return (name) => sections.get(name) ?? null
}

/**
 * Build the `read_custom_section` host import.
 * @param {Uint8Array|Buffer|WebAssembly.Module} source raw module bytes or a
 *        compiled module (to resolve the section table)
 * @param {() => WebAssembly.Memory} getMemory returns the instance's memory
 *        (deferred: memory may not exist until the import object is built)
 * @returns {(namePtr:number, nameLen:number, targetPtr:number, targetLen:number) => number}
 */
function makeReadCustomSection(source, getMemory) {
  const lookup = makeSectionLookup(source)
  return function read_custom_section(namePtr, nameLen, targetPtr, targetLen) {
    const memory = getMemory()
    const mem = new Uint8Array(memory.buffer)
    const name = Buffer.from(mem.buffer, mem.byteOffset + namePtr, nameLen).toString('utf8')
    const section = lookup(name)
    if (!section) return 0
    if (targetPtr !== 0 && targetLen > 0) {
      const n = Math.min(targetLen, section.length)
      mem.set(section.subarray(0, n), targetPtr)
    }
    return section.length
  }
}

module.exports = { parseCustomSections, makeSectionLookup, makeReadCustomSection }
