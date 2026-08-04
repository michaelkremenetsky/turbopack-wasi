// Post-process the napi-cli-generated wasi loaders to provide the
// `env.read_custom_section` host import (see wasm-link-sections.cjs for why
// 16.3.0 needs it). The loaders are regenerated on every `napi build`, so this
// runs from build.sh after the build; it patches the node-side loaders that
// instantiate the module and drops the helper next to them so the `require`
// resolves in the published package.
//
// Usage: node scripts/inject-read-custom-section.mjs <native-dir>
//
// Idempotent; errors loudly if an expected anchor is missing (a napi-cli
// template change) rather than silently shipping a module that won't
// instantiate.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = process.argv[2]
if (!nativeDir) {
  console.error('usage: node inject-read-custom-section.mjs <native-dir>')
  process.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))

// Ship the helper alongside the loaders so `require('./wasm-link-sections.cjs')`
// resolves in the published package.
fs.copyFileSync(
  path.join(here, 'wasm-link-sections.cjs'),
  path.join(nativeDir, 'wasm-link-sections.cjs'),
)

function patch(file, edits) {
  const p = path.join(nativeDir, file)
  if (!fs.existsSync(p)) {
    console.error(`inject-read-custom-section: ${file} not found, skipping`)
    return
  }
  let src = fs.readFileSync(p, 'utf8')
  if (src.includes('wasm-link-sections')) {
    console.log(`inject-read-custom-section: ${file} already patched`)
    return
  }
  for (const [name, re, repl] of edits) {
    if (!re.test(src)) {
      console.error(`inject-read-custom-section: anchor "${name}" not found in ${file}`)
      process.exit(2)
    }
    src = src.replace(re, repl)
  }
  fs.writeFileSync(p, src)
  console.log(`inject-read-custom-section: patched ${file}`)
}

// Main-thread glue (CommonJS). Reads the wasm bytes via __wasmFilePath and owns
// __sharedMemory.
patch('index.wasi.cjs', [
  [
    'wasm-runtime require',
    /(\} = require\('@napi-rs\/wasm-runtime'\))/,
    "$1\nconst { makeReadCustomSection: __makeRCS } = require('./wasm-link-sections.cjs')",
  ],
  [
    'env memory (main)',
    /(memory: __sharedMemory,\n)(\s*)(\})/,
    '$1      read_custom_section: __makeRCS(__nodeFs.readFileSync(__wasmFilePath), () => __sharedMemory),\n$2$3',
  ],
])

// Worker thread (ESM, but has a createRequire). Receives the compiled
// wasmModule + wasmMemory in onLoad.
patch('wasi-worker.mjs', [
  [
    'createRequire',
    /(const require = createRequire\(import\.meta\.url\);)/,
    "$1\nconst { makeReadCustomSection: __makeRCS } = require('./wasm-link-sections.cjs');",
  ],
  [
    'env memory (worker)',
    /(memory: wasmMemory)(\n\s*\};)/,
    '$1,\n          read_custom_section: __makeRCS(wasmModule, () => wasmMemory)$2',
  ],
])
