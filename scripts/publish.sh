#!/usr/bin/env bash
# Package dist/<tag> as an npm package and publish it.
#
# Usage: publish.sh v16.2.10 [--dry-run]
#        publish.sh v16.2.10 --pack-only [outdir]
#
# --pack-only never touches the registry: it stages the same package layout,
# `npm pack`s it as <next-version>-local.0, and writes a manifest.json next to
# the tarball (version, integrity, shasum, the staged package.json). strapkit's
# ?swclocal=1 fetch-proxy override consumes that pair to serve the local build
# to a guest install, so a binding fix can be tested end-to-end in the browser
# before anything is published.
#
# Versioning: npm versions are immutable, so publishing plain `16.2.10` would
# make our own layer's fixes unshippable for that next version forever.
# Instead every publish is `<next-version>-build.N` (N auto-incremented from
# the registry), and a moving dist-tag `next-<next-version>` always points at
# the newest build for that next release. Consumers install via the tag:
#
#   npm install next-swc-wasi@next-16.2.10
#
# The newest build for the highest stable next version is also tagged `latest`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:?usage: publish.sh <tag, e.g. v16.2.10> [--dry-run]}"
DRY="${2:-}"
NEXT_VERSION="${TAG#v}"
DIST="$ROOT/dist/$TAG"
PKG_NAME="next-swc-wasi"

[ -f "$DIST/index.wasm32-wasi.wasm" ] || { echo "no artifact in $DIST" >&2; exit 1; }

if [ "$DRY" = "--pack-only" ]; then
  VERSION="$NEXT_VERSION-local.0"
  PACK_OUT="${3:-$ROOT/dist/local}"
else

# Next build number = 1 + highest existing -build.N for this next version.
PUBLISHED="$(npm view "$PKG_NAME" versions --json 2>/dev/null || echo '[]')"
BUILD_NUM="$(printf '%s' "$PUBLISHED" | python3 - "$NEXT_VERSION" <<'PYEOF'
import json, re, sys

next_version = sys.argv[1]
try:
    versions = json.load(sys.stdin)
except Exception:
    versions = []
if isinstance(versions, str):
    versions = [versions]
best = 0
for v in versions:
    m = re.fullmatch(re.escape(next_version) + r"-build\.(\d+)", v)
    if m:
        best = max(best, int(m.group(1)))
print(best + 1)
PYEOF
)"
# Guard against a stale version list (registry read lag, or `npm view` failing
# and defaulting to []): bump until the exact version is genuinely free, so we
# never 403 on an already-published immutable version.
while npm view "$PKG_NAME@$NEXT_VERSION-build.$BUILD_NUM" version >/dev/null 2>&1; do
  BUILD_NUM=$((BUILD_NUM + 1))
done
VERSION="$NEXT_VERSION-build.$BUILD_NUM"
fi
DIST_TAG="next-$NEXT_VERSION"
[ "$DRY" = "--pack-only" ] || echo "publishing $PKG_NAME@$VERSION (dist-tag: $DIST_TAG)"

STAGE="$ROOT/dist/.publish-$NEXT_VERSION"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$DIST"/index.wasm32-wasi.wasm "$DIST"/index.wasi.cjs "$DIST"/index.wasi-browser.js \
   "$DIST"/wasi-worker.mjs "$DIST"/wasi-worker-browser.mjs "$DIST"/index.d.ts \
   "$DIST"/index.js "$DIST"/browser.js "$STAGE"/ 2>/dev/null || true
# The napi-generated loaders create the shared memory with maximum: 10240
# pages (640MB) — a napi-rs template default, way under the module's declared
# 4GB max. Our pkg/loader.cjs path builds its own memory from the module's
# limits so it never hits this, but anyone loading the package through the
# stock index.wasi.cjs / index.wasi-browser.js entrypoints would OOM a real
# `next build` at 640MB. Lift the generated cap to the module's 65536.
sed -i.bak 's/maximum: 10240/maximum: 65536/' "$STAGE"/index.wasi.cjs "$STAGE"/index.wasi-browser.js \
  && rm -f "$STAGE"/index.wasi.cjs.bak "$STAGE"/index.wasi-browser.js.bak
# wasm-link-sections.cjs is REQUIRED by the wasi-worker loaders (inject-read-custom-section.mjs
# rewrites them to `require('./wasm-link-sections.cjs')` for the env.read_custom_section host
# import). Without it every worker-thread spawn throws "Cannot find module
# './wasm-link-sections.cjs'", which breaks `next build` (turbo-tasks worker pool) on wasi. It
# must ship with the workers — copy it explicitly and fail loudly if it's absent from the build.
cp "$DIST"/wasm-link-sections.cjs "$STAGE"/ \
  || { echo "FATAL: $DIST/wasm-link-sections.cjs missing — the wasi workers can't load without it" >&2; exit 1; }
# The self-contained loader set (pkg/): auto.cjs (one-require engagement for
# host runtimes), binding.cjs (next's custom-bindings entry), loader.cjs (the
# async instantiation + pool-worker RPC bridge), jest-transformer.cjs (the
# init-awaiting wrapper auto.cjs points jest configs at). Version-matched to
# next by living in this package.
cp "$ROOT"/pkg/auto.cjs "$ROOT"/pkg/binding.cjs "$ROOT"/pkg/loader.cjs \
   "$ROOT"/pkg/jest-transformer.cjs "$STAGE"/

cat > "$STAGE/package.json" <<EOF
{
  "name": "$PKG_NAME",
  "version": "$VERSION",
  "description": "next-swc (Turbopack included) built for wasm32-wasip1-threads. Install via the dist-tag matching your next.js version, e.g. next-swc-wasi@next-$NEXT_VERSION.",
  "nextVersion": "$NEXT_VERSION",
  "main": "index.wasi.cjs",
  "browser": "index.wasi-browser.js",
  "types": "index.d.ts",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/michaelkremenetsky/turbopack-wasi.git" },
  "engines": { "node": ">=20" },
  "dependencies": {
    "@napi-rs/wasm-runtime": "~1.1.6",
    "@emnapi/core": "~1.11.2",
    "@emnapi/runtime": "~1.11.2"
  }
}
EOF

cat > "$STAGE/README.md" <<EOF
# $PKG_NAME

Turbopack-enabled build of Next.js's native binding (\`next-swc\`) for
\`wasm32-wasip1-threads\`, matching **next@$NEXT_VERSION**.

Install via the dist-tag for your next.js version (the -build.N suffix only
increments when the wasi layer itself is fixed; the tag always points at the
newest build):

    npm install $PKG_NAME@$DIST_TAG

Built from vercel/next.js $TAG plus a small wasi patch series
(https://github.com/michaelkremenetsky/turbopack-wasi).

In a Node-compatible wasi-threads host, \`require('next-swc-wasi/auto.cjs')\`
once per process BEFORE any next code loads and everything is wired
automatically (next's custom-bindings hook, async instantiation, the
worker-pool bridge). Stock next configs work as-is: the build normalizes the
'childProcesses' plugin-runtime default to its worker pool and forces the
in-memory turbo-tasks store.

Embedding manually instead: async instantiation only, call the raw wasm
export \`init_turbopack_wasi_runtime_raw(threads)\` before any napi call.
Host needs shared memory + workers; on plain Node use Node >= 26 (older V8
has a shared-memory grow race).
EOF

if [ "$DRY" = "--pack-only" ]; then
  mkdir -p "$PACK_OUT"
  TARBALL="$(cd "$STAGE" && npm pack --silent | tail -1)"
  mv "$STAGE/$TARBALL" "$PACK_OUT/$TARBALL"
  INTEGRITY="sha512-$(openssl dgst -sha512 -binary "$PACK_OUT/$TARBALL" | base64)"
  SHASUM="$(shasum -a 1 "$PACK_OUT/$TARBALL" | awk '{print $1}')"
  python3 - "$PACK_OUT" "$TARBALL" "$VERSION" "$NEXT_VERSION" "$INTEGRITY" "$SHASUM" "$STAGE/package.json" <<'PYEOF'
import json, sys
out, tarball, version, next_version, integrity, shasum, pkg_path = sys.argv[1:8]
with open(pkg_path) as f:
    pkg = json.load(f)
manifest = {
    "name": pkg["name"],
    "version": version,
    "nextVersion": next_version,
    "filename": tarball,
    "integrity": integrity,
    "shasum": shasum,
    "packageJson": pkg,
}
with open(out + "/next-swc-wasi.manifest.json", "w") as f:
    json.dump(manifest, f, indent=2)
PYEOF
  echo "packed $PKG_NAME@$VERSION -> $PACK_OUT/$TARBALL"
  echo "manifest -> $PACK_OUT/next-swc-wasi.manifest.json"
  exit 0
fi

# In CI, attach provenance (requires OIDC trusted publishing or a
# provenance-capable token).
PROVENANCE=()
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  PROVENANCE=(--provenance)
fi

if [ "$DRY" = "--dry-run" ]; then
  (cd "$STAGE" && npm publish --dry-run --access public --tag "$DIST_TAG")
  exit 0
fi

(cd "$STAGE" && npm publish --access public --tag "$DIST_TAG" "${PROVENANCE[@]}")

# Promote to `latest` when this is the highest stable next version published.
# The just-published version is included explicitly: the registry's version
# list can lag the publish by a few seconds.
HIGHEST="$(npm view "$PKG_NAME" versions --json 2>/dev/null | python3 -c '
import json, re, sys
versions = json.load(sys.stdin)
if isinstance(versions, str):
    versions = [versions]
versions.append(sys.argv[1] + "-build.0")
best = (0, 0, 0)
for v in versions:
    m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)-build\.\d+", v)
    if m:
        best = max(best, tuple(int(x) for x in m.groups()))
print(".".join(map(str, best)))
' "$NEXT_VERSION")"
if [ "$HIGHEST" = "$NEXT_VERSION" ]; then
  # Best effort: OIDC trusted-publishing credentials cover the publish itself
  # (including its --tag) but not standalone dist-tag mutations, so in CI this
  # 401s unless a real token is configured. `latest` is cosmetic — everything
  # that matters resolves through the next-<version> tags — so don't fail the
  # run over it.
  npm dist-tag add "$PKG_NAME@$VERSION" latest \
    || echo "WARN: could not promote $VERSION to 'latest' (no dist-tag credentials?); next-* tags are set, continuing" >&2
fi
