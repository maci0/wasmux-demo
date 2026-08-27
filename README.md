# wasmux: Linux on wasm32

Linux 6.19 compiled for a freestanding `wasm32` target and booted inside a
WebAssembly virtual machine: in a browser tab, or under bun, wasmtime,
or wasmer.

The kernel port lives in [`arch/wasm`](https://github.com/maci0/linux-wasm/tree/wasm/arch/wasm)
on the [`linux-wasm`](https://github.com/maci0/linux-wasm/tree/wasm) fork
(two commits on top of v6.19). This repository is the runtime around it:
the browser webui, the headless boot harness, native hosts, and the
prebuilt kernel.

```
┌────────────────────────────────────────────┐
│  vmlinux.wasm  (Linux 6.19, wasm32 module) │
│  imports (module "wasmux"):                │
│    wasm_console_write  wasm_time_ns        │
│    wasm_timer_arm      wasm_random         │
│    wasm_exit                               │
│  exports: start_kernel, wasm_raise_irq,    │
│           wasm_console_input, memory       │
└──────────────┬─────────────────────────────┘
               │
   ┌───────────┼───────────────┐
   │           │               │
 browser    wasmtime      wasmer
 (webui)   (Rust host)  (Rust host)
```

## What works

- **The kernel builds as a single wasm module.** The full Linux tree
  compiles with `zig cc` (`wasm32-freestanding`), the port is modeled on
  UML, with a host-OS layer (`arch/wasm/os-wasm/os.c`) implementing the
  UML `os_*` primitives against the wasm host ABI.
- **Early console.** The console is registered from `setup_arch`, so the
  boot log streams out from the very first `printk`, no late initcall
  required.
- **Booting is genuinely Linux.** The kernel runs `start_kernel`:
  memblock setup, paging/zones, the page allocator, SLUB, vmalloc, the
  scheduler, radix trees, housekeeping, and the workqueue pools all
  initialize (the boot log reaches `workqueue_init_early`). The module
  is post-processed by `scripts/patch-wasm.ts`, a post-link relocator
  that repairs wasm-ld's layout defects (see Limitations).
- **The initramfs is unpacked** by `populate_rootfs()` (the wasm port
  drives initcalls explicitly because wasm-ld cannot lay out the
  `.initcall*.init` sections). The demo ships an in-tree rootfs
  (`usr/wasm_rootfs` on the fork).
- **Runs on several engines**: the same `vmlinux.wasm` boots under the
  browser webui, the bun harness, a wasmtime host, and a wasmer
  host, see `host/`.

## Limitations (be truthful with yourself)

- **The kernel does not complete boot yet.** It traps inside
  `___slab_alloc()` while `workqueue_init_early()` creates the first
  system workqueue (the `pool_workqueue` cache allocation): the
  allocation walks a corrupted partial list. Root cause (diagnosed):
  wasm-ld lays out the kernel's custom sections badly -
  zero-initialized statics get addresses that overlap initialized data
  segments, and an initialized symbol's address can be split from its
  content. The wasm port now works around this three ways:
  1. `scripts/patch-wasm.ts` (post-link relocator) moves the late data
     segments to a safe area and rewrites every reference to them -
     `i32.const` immediates, load/store memarg offsets (LLVM folds
     symbol addresses into these, which is the part that used to be
     missed), data-to-data pointers, and segment offsets;
  2. boot-critical data that the relocator cannot safely move
     (`struct memblock`, the memblock region arrays, the pglist_data
     zone) is defined in early `arch/wasm` objects as initialized data
     so wasm-ld cannot misplace it;
  3. the per-cpu pageset is disabled (its statics overlap the boot
     parameter strings in the wasm-ld layout).
  With those fixes the kernel boots far past the original failure
  (which was in `paging_init`) and initializes the whole mm + sched +
  workqueue early path. The remaining fault is in SLUB's slab
  accounting: a slab is treated as fully consumed while its objects are
  still referenced, so its page is handed out again and the live
  `kmem_cache_node` structs get overwritten. The exact trigger is still
  under investigation; the demo shows the real boot log up to the trap,
  not a fake success.
- **No userspace.** wasm cannot capture its own call stack, so real
  context switches are impossible. `copy_thread()` can only start kernel
  threads, there is no syscall ABI, and `/init` cannot be executed. Even
  after the boot bug is fixed, the kernel ends with
  "No working init found" by design.
- **Single-threaded / cooperative.** `CONFIG_SMP=n`, one "CPU". Kernel
  "threads" run as nested calls; there is no mapping to web workers.
- **wasm-ld limitations.** The linker script cannot place custom sections
  or define symbols, so:
  - section-marker symbols (`_stext`, `_end`, `__initcall*_start`, ...)
    are stubs (`arch/wasm/kernel/markers.c`), and the kernel-image
    reservation is a fixed 16 MiB window;
  - the initcall levels are empty and the required initcalls are called
    explicitly (`init/main.c` `do_initcalls()`);
  - the `kallsyms` tables are empty stubs;
  - the 32-bit `jiffies` alias is defined in `arch/wasm/kernel/jiffies.c`
    (the linker cannot alias it to `jiffies_64`).
- **The network device** (`CONFIG_WASM_NET`) compiles but nothing
  configures an address, there is no user to run `ip`.
- **`__builtin_return_address()` is unavailable** on the wasm backend, so
  a handful of core call sites use `_RET_IP_` instead (identical on
  every other architecture).
- **Memory layout** is fixed at 256 MiB linear memory (64 MiB managed
  RAM + vmalloc area + a 16 MiB wasm stack). Browsers reserve this per
  tab.

## Getting the kernel

The prebuilt `vmlinux.wasm` (about 60 MB) is checked into this repository
for the demo. To build it yourself:

```sh
# needs zig (0.14+), make, git, and bun (for the post-link relocator)
scripts/build-linux.sh          # clones linux-wasm, builds + patches linux/vmlinux.wasm
```

## Running

### In the browser (demo)

```sh
bun run webui/server.ts         # serves the webui + kernel on :3000
open http://localhost:3000
```

### Headless boot log

```sh
bun run scripts/boot-linux.ts   # loads vmlinux.wasm and streams the console
```

### Under wasmtime

```sh
cd host/wasmtime-host && cargo run --release -- ../../vmlinux.wasm
```

### Under wasmer

```sh
cd host/wasmer-host && cargo run --release -- ../../vmlinux.wasm
```

## Layout

- `webui/`: browser runtime: kernel loader (`kernel.ts`), console
  (`console.ts`), page, dev server.
- `scripts/`: kernel build, demo build, headless boot harness, `zig cc`
  wrapper.
- `host/`: native wasmtime and wasmer hosts.
- `vmlinux.wasm`: prebuilt kernel (from the linux-wasm fork).

## The fork

- `torvalds/linux` v6.19 + three commits:
  - [`arch: add the wasm (WebAssembly) architecture port`](https://github.com/maci0/linux-wasm/commit/4d0abdd82)
  - [`kernel: make core code build with wasm-ld and zig cc`](https://github.com/maci0/linux-wasm/commit/64dcabcfe)
  - [`wasm: move boot-critical data to early arch objects`](https://github.com/maci0/linux-wasm/commit/bffc00286)
- Branch: `wasm`
- Defconfig: `arch/wasm/configs/wasm_defconfig` (run `make ARCH=wasm
  wasm_defconfig`).
- Build: `make ARCH=wasm CC=$PWD/scripts/zig-cc.sh vmlinux.wasm`, then
  `bun scripts/patch-wasm.ts vmlinux.wasm vmlinux.wasm` (the post-link
  relocator that repairs the wasm-ld layout overlaps).
