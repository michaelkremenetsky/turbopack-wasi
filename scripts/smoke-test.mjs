// Smoke-test the wasi binding under plain Node.js (needs node >= 20).
// Usage: node scripts/smoke-test.mjs [path-to-native-dir]
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const nativeDir =
  process.argv[2] ??
  path.join(import.meta.dirname, '..', 'vendor/next.js/packages/next-swc/native')

const binding = require(path.join(nativeDir, 'index.wasi.cjs'))

console.log('exports:', Object.keys(binding).sort().join(', '))
console.log('getTargetTriple():', binding.getTargetTriple?.())

// SWC transform smoke test
const out = await binding.transform('const x: number = 1 as any;', true, Buffer.from(
  JSON.stringify({
    jsc: {
      parser: { syntax: 'typescript' },
      target: 'es2020',
    },
    filename: 'test.ts',
  })
))
console.log('transform output:', out.code?.trim() ?? out)

// The real prize: is createProject exported (turbopack enabled)?
if (typeof binding.projectNew === 'function' || typeof binding.createProject === 'function') {
  console.log('TURBOPACK PRESENT: projectNew/createProject is exported ✅')
} else {
  console.log('turbopack exports missing ❌ — keys:', Object.keys(binding).filter((k) => /roject/.test(k)))
}
