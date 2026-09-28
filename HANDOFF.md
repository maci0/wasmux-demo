# wasmux handoff

## Current objective

Rebase the wasm Linux port onto the real Linux 7.2.3 stable release,
boot it through the kernel-resident shell, run the in-kernel WASI
hello-world, then publish the rebuilt demo.

## Current status

The rebase source tree is `/tmp/linux723` on branch `wasm-7.2.3`.
It is based directly on the real stable release commit:

```
58e7295cfecaddec94629160386412e0f2b1e8fe  Linux 7.2.3
```

All ten wasm-port commits cherry-picked onto that base without conflicts.
The current tip is:

```
7dd885691 wasm: in-kernel wasm interpreter with WASI syscalls (BoxedWine-style)
```

`make ARCH=wasm wasm_defconfig` completed. The generated configuration
contains both `CONFIG_EXPERT=y` and `CONFIG_SLUB_TINY=y`.

The 7.2.3 kernel build has completed successfully:

```sh
cd /tmp/linux723
make ARCH=wasm \
  CC="/home/maci/Desktop/wasmux/scripts/zig-cc.sh --target=wasm32-freestanding" \
  vmlinux.wasm -j"$(nproc)"
```

The resulting `/tmp/linux723/vmlinux.wasm` is present (56,578,687 bytes
at the last verification).

## Work still required

1. Patch the freshly linked module. The relocator in the demo repo is
   already set for the 7.2.x layout (`CUTOFF = 0x1b44ac`):

   ```sh
   cd /tmp/linux723
   bun /home/maci/Desktop/wasmux-demo/scripts/patch-wasm.ts \
     vmlinux.wasm /tmp/vmlinux-7.2.3-patched.wasm
   ```

2. Boot-test it under wasmtime. Required observable output:
   - a `Linux 7.2.3-... on wasm32 - kernel-resident init shell` banner;
   - `version` output;
   - `run /hello.wasm` followed by `hello from wasi!`;
   - clean `reboot` exit.

   ```sh
   cd /home/maci/Desktop/wasmux-demo
   printf 'version\nrun /hello.wasm\nreboot\n' |
     timeout 90 ./host/wasmtime-host/target/release/wasmux-wasmtime \
       /tmp/vmlinux-7.2.3-patched.wasm
   ```

3. Once boot passes, force-push the rebased branch over the published
   fork branch. Use `--force-with-lease`, not raw `--force`:

   ```sh
   cd /tmp/linux723
   git push --force-with-lease origin wasm-7.2.3:wasm-7.2
   ```

4. Refresh the demo artifact and references:

   ```sh
   cd /home/maci/Desktop/wasmux-demo
   cp /tmp/linux723/vmlinux.wasm vmlinux.wasm
   ./scripts/build-demo.sh
   ```

   Update user-visible `7.2.1` references in `README.md`,
   `docs/FEATURES-AND-GAPS.md`, and `webui/public/index.html` to
   `7.2.3`. Then commit and push `main`; the existing Pages workflow
   rebuilds and deploys `dist/`.

5. Validate the updated live page in Chromium: wait for `shell ready`,
   run `run /hello.wasm`, and confirm the terminal renders
   `hello from wasi!`.

## Important port constraints

- The wasm port needs `CONFIG_SLUB_TINY=y`. Without it, slab accounting
  desynchronizes during early boot and workqueue allocation fails.
- Always use `scripts/zig-cc.sh` for kernel compilation. Zig 0.16 drops
  assembly output when a `-S` compile also receives `-Wp,-MD`; the
  wrapper splits that into compilation and dependency passes.
- The post-link relocator is mandatory. wasm-ld's layout places some
  zero-initialized symbols among initialized data and can split a
  symbol's address from its initializer content.
- The in-kernel wasm interpreter uses a boot-reserved 4 MiB guest area
  plus 16 KiB state at 56 MiB. Do not change this reservation without
  changing both `arch/wasm/kernel/setup.c` and
  `arch/wasm/kernel/wasm-exec.c`.
- `run /hello.wasm` is proven on the 7.2.1 port. The minimal interpreter
  handles an i32/WASI subset (`fd_write`, `proc_exit`, `fd_close`,
  `fd_seek`, `fd_fdstat_get`), not general wasi-sdk binaries or busybox.
- `kernel_read` of some initramfs text files can stall in this port;
  `/hello.wasm` is known good.

## Published state before this handoff

- `maci0/linux-wasm` branch `wasm-7.2` currently points at the Linux
  7.2.1-based port. It has not yet been replaced by the 7.2.3 branch.
- `maci0/wasmux-demo` currently contains the 7.2.1 demo artifact and
  the instrument-style terminal page.
