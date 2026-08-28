#!/bin/sh
# Build vmlinux.wasm (Linux 7.2.1 with the wasm architecture port).
#
# The kernel source comes from the linux-wasm fork (branch "wasm"):
#   https://github.com/maci0/linux-wasm
# which is torvalds/linux v7.2.1 plus the arch/wasm patchset.
#
# Requires: zig (0.14+), make, git
# Output:   linux/vmlinux.wasm
set -e

cd "$(dirname "$0")/.."

FORK_URL=https://github.com/maci0/linux-wasm.git
BRANCH=wasm-7.2

if [ ! -d linux/.git ]; then
  echo "==> cloning linux-wasm (branch $BRANCH)..."
  git clone --depth 1 --branch "$BRANCH" "$FORK_URL" linux
fi

cd linux
echo "==> configuring (wasm_defconfig)..."
make ARCH=wasm CC="$PWD/../scripts/zig-cc.sh" wasm_defconfig
echo "==> building vmlinux.wasm (this takes a while)..."
make ARCH=wasm CC="$PWD/../scripts/zig-cc.sh" -j"$(nproc)" vmlinux.wasm
echo "==> patching wasm-ld layout (post-link relocator)..."
bun ../scripts/patch-wasm.ts vmlinux.wasm vmlinux.wasm
echo "==> done: $(pwd)/vmlinux.wasm"
