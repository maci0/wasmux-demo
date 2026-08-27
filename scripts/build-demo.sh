#!/bin/sh
# Build the static browser demo (used for GH Pages).
#
# Bundles the webui TypeScript into plain JS, copies the prebuilt
# vmlinux.wasm and rewrites index.html to reference the bundle.  The
# result in dist/ is fully static: no server needed.
set -e
cd "$(dirname "$0")/.."

OUT=dist
rm -rf "$OUT"
mkdir -p "$OUT"

bun build webui/src/main.ts --outdir "$OUT" --target browser --minify
bun build webui/src/worker.ts --outdir "$OUT" --format esm --target browser \
  --entry-naming worker.js
cp webui/public/index.html "$OUT/index.html"
cp vmlinux.wasm "$OUT/vmlinux.wasm"
touch "$OUT/.nojekyll"

# The dev server transpiles /src/*.ts on the fly; the static build uses
# the bundle.
sed -i 's#/src/main.ts#./main.js#' "$OUT/index.html"

echo "demo built in $OUT/ ($(du -sh "$OUT" | cut -f1))"
