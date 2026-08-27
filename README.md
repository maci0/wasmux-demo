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
  memblock setup, the page allocator, SLUB, vmalloc, scheduler
  initialization, workqueue pools, RCU, IRQ setup, timers, and the
  clocksource (`clocksource: wasm ...` appears in the log).
- **The initramfs is unpacked** by `populate_rootfs()` (the wasm port
  drives initcalls explicitly because wasm-ld cannot lay out the
  `.initcall*.init` sections). The demo ships an in-tree rootfs
  (`usr/wasm_rootfs` on the fork).
- **Runs on several engines**: the same `vmlinux.wasm` boots under the
  browser webui, the bun harness, a wasmtime host, and a wasmer
  host, see `host/`.

## Limitations (be truthful with yourself)

- **The kernel does not complete boot yet.** A memory-corruption bug in
  the late `start_kernel` path (after scheduler/workqueue/RCU/timer
  init, around `kmem_cache_init_late`/`console_init`) traps the module
  before `rest_init()`.  The corruption is layout-dependent (the boot
  distance varies with code layout) and is the main open problem.  The
  demo therefore shows the real boot log up to the trap, not a fake
  success.
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

The prebuilt `vmlinux.wasm` (about 60 MB, most of it debug info) is
checked into this repository for the demo. To build it yourself:

```sh
# needs zig (0.14+) and make
scripts/build-linux.sh          # clones linux-wasm, builds linux/vmlinux.wasm
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

- `torvalds/linux` v6.19 + two commits:
  - [`arch: add the wasm (WebAssembly) architecture port`](https://github.com/maci0/linux-wasm/commit/4d0abdd82)
  - [`kernel: make core code build with wasm-ld and zig cc`](https://github.com/maci0/linux-wasm/commit/64dcabcfe)
- Branch: `wasm`
- Defconfig: `arch/wasm/configs/wasm_defconfig` (run `make ARCH=wasm
  wasm_defconfig`).
- Build: `make ARCH=wasm CC=$PWD/scripts/zig-cc.sh vmlinux.wasm`
