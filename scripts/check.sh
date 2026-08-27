#!/bin/sh
# Type-check and lint the webui (bun + TS toolchain).
set -e
cd "$(dirname "$0")/.."
bunx tsc --noEmit -p webui/tsconfig.json
bunx oxlint webui/src scripts/*.ts --deny-warnings
