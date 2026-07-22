#!/usr/bin/env bash
# Package dist/<tag> as an npm package and publish it.
#
# Usage: publish.sh v16.2.10 [--dry-run]
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
DIST_TAG="next-$NEXT_VERSION"
echo "publishing $PKG_NAME@$VERSION (dist-tag: $DIST_TAG)"

STAGE="$ROOT/dist/.publish-$NEXT_VERSION"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$DIST"/index.wasm32-wasi.wasm "$DIST"/index.wasi.cjs "$DIST"/index.wasi-browser.js \
   "$DIST"/wasi-worker.mjs "$DIST"/wasi-worker-browser.mjs "$DIST"/index.d.ts \
   "$DIST"/index.js "$DIST"/browser.js "$STAGE"/ 2>/dev/null || true

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
    "@napi-rs/wasm-runtime": "^1.1.6",
    "@emnapi/core": "^1.11.2",
    "@emnapi/runtime": "^1.11.2"
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
(https://github.com/michaelkremenetsky/turbopack-wasi). Requires a
wasi-threads host (shared memory + workers), async instantiation, Node >= 24
(Node 22's V8 has a shared-memory grow race), calling the raw wasm export
\`init_turbopack_wasi_runtime_raw(threads)\` before any napi call, and
\`experimental.turbopackPluginRuntimeStrategy: 'workerThreads'\` in next.config.
EOF

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
  npm dist-tag add "$PKG_NAME@$VERSION" latest
fi
