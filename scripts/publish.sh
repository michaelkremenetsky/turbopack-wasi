#!/usr/bin/env bash
# Package dist/<tag> as an npm package and publish it.
#
# Usage: publish.sh v16.2.10 [--dry-run]
#
# The package version matches the next.js version exactly, so consumers pin
# `next-swc-wasi@<their next version>`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:?usage: publish.sh <tag, e.g. v16.2.10> [--dry-run]}"
DRY="${2:-}"
VERSION="${TAG#v}"
DIST="$ROOT/dist/$TAG"
PKG_NAME="next-swc-wasi"

[ -f "$DIST/index.wasm32-wasi.wasm" ] || { echo "no artifact in $DIST" >&2; exit 1; }

STAGE="$ROOT/dist/.publish-$VERSION"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$DIST"/index.wasm32-wasi.wasm "$DIST"/index.wasi.cjs "$DIST"/index.wasi-browser.js \
   "$DIST"/wasi-worker.mjs "$DIST"/wasi-worker-browser.mjs "$DIST"/index.d.ts \
   "$DIST"/index.js "$DIST"/browser.js "$STAGE"/ 2>/dev/null || true

cat > "$STAGE/package.json" <<EOF
{
  "name": "$PKG_NAME",
  "version": "$VERSION",
  "description": "next-swc (Turbopack included) built for wasm32-wasip1-threads. Version matches the next.js release it was built from.",
  "main": "index.wasi.cjs",
  "browser": "index.wasi-browser.js",
  "types": "index.d.ts",
  "license": "MIT",
  "engines": { "node": ">=20" },
  "dependencies": {
    "@napi-rs/wasm-runtime": "^1.1.6",
    "@emnapi/core": "^1.11.2",
    "@emnapi/runtime": "^1.11.2"
  }
}
EOF

cat > "$STAGE/README.md" <<EOF
# $PKG_NAME

Turbopack-enabled build of Next.js's native binding (\`next-swc\`) for
\`wasm32-wasip1-threads\`, matching **next@$VERSION**.

Built from vercel/next.js $TAG plus a small wasi patch series.
Requires a wasi-threads host (shared memory + workers) and async
instantiation; after instantiating call \`initTurbopackWasiRuntime(threads)\`
once before any turbopack call, and set
\`experimental.turbopackPluginRuntimeStrategy: 'workerThreads'\` in next.config.
EOF

if [ "$DRY" = "--dry-run" ]; then
  (cd "$STAGE" && npm publish --dry-run --access public)
else
  (cd "$STAGE" && npm publish --access public)
fi
