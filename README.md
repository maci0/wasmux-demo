# wasmux: Linux booting to a shell on wasm32

Linux 6.19 compiled for a freestanding `wasm32` target, booted inside a
WebAssembly virtual machine, and driven to an **interactive shell** — in a
browser tab, or under bun, wasmtime, or wasmer.

The kernel port lives in [`arch/wasm`](https://github.com/maci0/linux-wasm/tree/wasm/arch/wasm)
on the [`linux-wasm`](https://github.com/maci0/linux-wasm/tree/wasm) fork.
This repository is the runtime around it: the browser webui (kernel in a
Web Worker), native hosts, the build tooling, and the prebuilt kernel.

```
┌────────────────────────────────────────────────┐
│  vmlinux.wasm  (Linux 6.19, wasm32 module)     │
│  imports (module "wasmux"):                    │
│    wasm_console_write   wasm_time_ns           │
│    wasm_timer_arm       wasm_random            │
│    wasm_exit            wasm_shell_wait        │
│  exports: start_kernel, wasm_shell_input,      │
│           wasm_shell_scratch, wasm_raise_irq,  │
│           memory                               │
└──────────────┬─────────────────────────────────┘
               │
   ┌───────────┼───────────────┐
   │           │               │
 browser    wasmtime      wasmer
 (worker)  (Rust host)  (Rust host)
```

## What works (verified)

- **The kernel fully boots.** `start_kernel()` runs the real boot path:
  early console, memblock, paging/zones, page allocator, SLUB, vmalloc,
  the scheduler, the VFS, the built-in initramfs (unpacked by the real
  `populate_rootfs()`), then `kernel_init()`.
- **An interactive shell.** wasm32 cannot exec native binaries, so
  instead of `/init` the port runs a small kernel-resident shell
  (`arch/wasm/kernel/shell.c`). Commands: `help`, `version`, `free`
  (si_meminfo), `uptime` (host clock), `tasks`, `echo`, `clear`,
  `reboot`. The shell is host-driven: `wasm_shell_wait` blocks reading a
  line (native hosts) or unwinds control to the runtime (browser), and
  lines are fed back through the exported `wasm_shell_input`.
- **Early console.** The console registers from `setup_arch`, so the boot
  log streams out from the very first `printk`.
- **Runs on four engines.** The same patched `vmlinux.wasm` boots under
  the browser webui (Web Worker), a wasmtime host, a wasmer host, and
  bun's WebAssembly API.
- **A real post-link relocator.** The module is processed by
  `scripts/patch-wasm.ts`, which repairs wasm-ld's layout defects (see
  Limitations): it moves late data segments to a safe area and rewrites
  every reference — `i32.const` immediates, load/store memarg offsets,
  data-to-data pointers, and segment offsets — plus a build-adaptive
  bss-vs-initialized test so zero-initialized statics keep their
  addresses.

## Limitations (be truthful with yourself)

- **No userspace.** wasm cannot capture or restore its call stack, so
  real context switches are impossible. Kernel "threads" run as nested
  calls, `copy_thread()` can only start kernel threads, there is no
  syscall ABI, and `/init` cannot be executed. The shell is
  kernel-resident — it is *not* busybox, there is no ELF loading, no
  fork/exec, no processes in the userspace sense.
- **The scheduler is a formality.** `CONFIG_SMP=n`, one CPU, cooperative
  model: `__switch_to()` starts a kernel thread as a nested function call
  that never returns. There is no preemption and no timer-driven tick
  (the host timer import is a stub; `calibrate_delay_is_known()` reports
  a fixed lpj and `uptime` reads the host clock).
- **wasm-ld cannot lay out custom sections.** The linker script cannot
  place sections or define symbols, so:
  - section-marker symbols are stubs (`arch/wasm/kernel/markers.c`);
  - the initcall levels are empty and the required initcalls are called
    explicitly from `do_initcalls()`;
  - zero-initialized statics can get addresses that overlap initialized
    data, and an initialized symbol's address can be split from its
    content — the post-link relocator and the early-data trick
    (`struct memblock`, the SLUB boot caches) work around this;
  - the kallsyms tables are empty stubs.
- **Atomics had to be reimplemented.** LLVM's `-mthread-model single`
  lowering of the `__atomic_*` builtins compiles `cmpxchg` into
  `*p = *p ? *p : new` with the expected value folded to zero, so
  `arch_xchg` never installs the new value and spins. The port's
  `arch_cmpxchg`/`arch_xchg` are plain volatile load-compare-store
  instead — exactly correct for a single-threaded, non-preemptible
  target.
- **Several boot paths are stubbed under `CONFIG_WASM`.** kthreadd is
  never created, the workqueue skips its worker/rescuer/release kthreads,
  devtmpfs skips its daemon, `flush_delayed_fput()` drains the list
  directly instead of waiting on a workqueue that can never run, and
  `console_init()` skips the empty initcall section. These are honest
  adaptations to a model with no runnable kthreads.
- **The module is large and fixed-layout.** `vmlinux.wasm` is about
  60 MB; memory is a fixed 256 MiB linear memory (64 MiB managed RAM +
  vmalloc + a 16 MiB wasm stack). Browsers reserve this per tab/worker.
- **The network device** (`CONFIG_WASM_NET`) compiles and the bridge
  plumbing exists, but there is no user to configure an address.
- **`__builtin_return_address()` is unavailable** on the wasm backend, so
  a handful of core call sites use `_RET_IP_` instead (identical on every
  other architecture).

## Build

```sh
# needs zig (0.14+), make, git, and bun (for the webui and relocator)
scripts/build-linux.sh          # clone linux-wasm (wasm branch), build + patch
./scripts/build-demo.sh         # bundle the webui, patch the kernel into dist/
```

The prebuilt, already-patched `dist/vmlinux.wasm` is what the demo
serves. `vmlinux.wasm` at the repo root is the unpatched build (the
patch step is part of the build scripts).

## Run

### Browser (GitHub Pages)

Open the deployed demo (the `gh-pages` branch / Pages site of this repo).
The kernel boots in a Web Worker; type `help` at the shell.

Local dev server: `bun run webui/server.ts` (serves `./vmlinux.wasm`).

### wasmtime / wasmer

```sh
host/wasmtime-host/target/release/wasmux-wasmtime dist/vmlinux.wasm
host/wasmer-host/target/release/wasmux-wasmer   dist/vmlinux.wasm
# or:  printf 'help\nreboot\n' | host/.../wasmux-wasmtime dist/vmlinux.wasm
```

### bun harness

`scripts/boot-linux.ts` boots the module and drives a scripted session.

## Repository layout

- `webui/` — browser runtime: `kernel.ts` (wasm ABI + shell driver),
  `worker.ts` (kernel in a Web Worker), `console.ts` (canvas terminal),
  `main.ts` (worker protocol + optional WebSocket bridge).
- `host/wasmtime-host`, `host/wasmer-host` — native hosts.
- `scripts/` — build tooling, `patch-wasm.ts` relocator, `boot-linux.ts`.
- `dist/` — the static demo (built, not committed).
