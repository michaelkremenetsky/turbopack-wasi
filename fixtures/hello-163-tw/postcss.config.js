// Tailwind v4 via its postcss plugin. Exercises the turbopack-node postcss
// evaluate pool (the worker_pool / workerThreads backend on wasi) AND tailwind
// v4's lightningcss engine, whose native binding has no wasm32 build and is
// substituted with lightningcss-wasm by the runtime's native-package registry.
module.exports = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}
