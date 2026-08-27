#!/bin/sh
# Build vmlinux.wasm (Linux 6.19 with the wasm architecture port).
#
# The kernel source comes from the linux-wasm fork (branch "wasm"):
#   https://github.com/maci0/linux-wasm
# which is torvalds/linux v6.19 plus the arch/wasm patchset.
#
# Requires: zig (0.14+), make, git
# Output:   linux/vmlinux.wasm
set -e

cd "$(dirname "$0")/.."

FORK_URL=https://github.com/maci0/linux-wasm.git
BRANCH=wasm

if [ ! -d linux/.git ]; then
  echo "==> cloning linux-wasm (branch $BRANCH)..."
  git clone --depth 1 --branch "$BRANCH" "$FORK_URL" linux
fi

cd linux
echo "==> configuring (wasm_defconfig)..."
make ARCH=wasm CC="$PWD/../scripts/zig-cc.sh" wasm_defconfig
echo "==> building vmlinux.wasm (this takes a while)..."
make ARCH=wasm CC="$PWD/../scripts/zig-cc.sh" -j"$(nproc)" vmlinux.wasm
echo "==> done: $(pwd)/vmlinux.wasm"
