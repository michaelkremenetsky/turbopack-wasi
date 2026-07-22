# turbopack-wasi

Next.js ships a wasi build of its native binding (`next-swc`, crate
`next-napi-bindings`), but Turbopack is compiled out of it. Try to use it and
you get `turbo.createProject is not supported by the wasm bindings`. This repo
is a patch series and a build pipeline that put Turbopack back in. The target
is `wasm32-wasip1-threads`, so the artifact runs under emnapi, in Node or in a
browser. The pipeline applies against any `vercel/next.js` release tag, which
matters because the binding has to match the exact next version a project
uses.

Prebuilt artifacts are on npm as
[`next-swc-wasi`](https://www.npmjs.com/package/next-swc-wasi), one dist-tag
per next version:

```sh
npm install next-swc-wasi@next-16.2.10
```

The loader ships inside the package. In a Node-compatible wasi-threads host,
`require('next-swc-wasi/auto.cjs')` once per process before any next code
loads (`NODE_OPTIONS=--require` is the easy way) and you're done: it hooks
next's custom-bindings escape hatch, does the async instantiation, and
bridges the worker pool. Stock next configs, no edits to next itself. This is
deliberate. Anything that knows about next internals lives in the
version-matched package, so when next changes, the fix ships as a new build
on the same dist-tag and the host never has to care.

Everything else is in [PATCHES.md](PATCHES.md): what each patch does, how to
build locally, CI and publishing, what runs today, the Node 26 story, and the
host contract if you're embedding the artifact by hand.
