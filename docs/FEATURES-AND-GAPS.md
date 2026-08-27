# wasmux: features and gaps (complete audit)

This is the full, honest inventory of what the wasmux port of Linux 6.19
does and does not do.  "Verified" means exercised at boot or in a shell
session; "port decision" means an intentional choice for the target;
"platform limit" means wasm32/WebAssembly physically cannot do it.

Audit basis: the `wasm` branch of
[maci0/linux-wasm](https://github.com/maci0/linux-wasm/tree/wasm)
(4 commits on top of v6.19), the webui and hosts in this repository, and
the boot log / shell session produced by the live demo.

---

## 1. What works (verified)

### 1.1 The kernel boots to completion

`start_kernel()` runs the real boot path:

| Phase | Evidence in boot log |
|---|---|
| early console | first `printk` streams immediately (`setup_arch` registers the console) |
| memory setup | zone ranges, `Initmem setup node 0`, `Memory: 96900K available` |
| page allocator / zones | `Built 1 zonelists... Total pages: 16384` |
| SLUB | cache creation, `SLUB: HWalign=32...` |
| vmalloc / VFS | mount-cache setup, `devtmpfs: initialized` |
| scheduler | `sched_init`, class table (`arch/wasm/kernel/sched.c`) |
| initramfs | `populate_rootfs()` unpacks the built-in cpio rootfs |
| `kernel_init()` | runs to the resident shell (never panics) |

### 1.2 An interactive shell

`kernel_init()` calls `wasm_shell()` (arch/wasm/kernel/shell.c) instead
of exec'ing `/init`.  Commands (all verified): `help`, `version`, `free`
(si_meminfo), `uptime` (host clock), `tasks` (task list), `echo`,
`clear` (ANSI), `reboot`/`exit` (returns to the host).  Input is driven
by the runtime through the `wasm_shell_wait` import + exported
`wasm_shell_input`.

### 1.3 Same module, four engines

The identical patched `vmlinux.wasm` boots under:
- browser (Web Worker, verified headless with real Chromium against the
  deployed site — boots to the shell, commands execute, OCR-confirmed)
- bun (scripted shell session, `scripts/boot-linux.ts`)
- wasmtime (interactive stdin)
- wasmer (interactive stdin)

### 1.4 The post-link relocator

`scripts/patch-wasm.ts` repairs wasm-ld's layout defects: it moves the
late data segments to a safe area and rewrites every reference —
segment offset expressions, `i32.const` immediates, load/store memarg
offsets (LLVM folds symbol addresses into these), 4-byte data-to-data
pointers — with a build-adaptive bss-vs-initialized test (16-byte
window) so zero-initialized statics keep their addresses.

### 1.5 Port design points that work

- modeled on UML (`arch/wasm/os-wasm/os.c` implements the UML `os_*`
  layer against the wasm host ABI);
- early data for boot-critical statics (`struct memblock`, the SLUB boot
  caches) so wasm-ld cannot split them from their initializers;
- scheduler classes chained through an explicit table
  (`arch/wasm/kernel/sched.c`) because wasm-ld cannot order the
  `__*_sched_class` sections;
- `jiffies` alias as a real symbol (wasm-ld ignores linker-script
  symbol assignments);
- explicit initcall driving (`do_initcalls()`) because the
  `.initcall*.init` sections are empty.

---

## 2. Gaps — why each one exists and what would close it

Legend: **[platform]** = wasm32/WebAssembly cannot do this;
**[decision]** = chosen behavior for this port; **[incomplete]** = a
known TODO; **[inert]** = present but never exercised.

### 2.1 No userspace at all [platform]

`copy_thread()` can only start kernel threads; `sys_call_table` is all
`sys_ni_syscall`; there is no fork/exec, no ELF loading, no libc, no
signal delivery.  The wasm call stack cannot be captured or restored,
so a real context switch (save/restore registers + stack) is impossible
in pure wasm32.

Would close it: a userspace ABI needs an executable-format + syscall
layer + context switching.  The wasm threads proposal + a custom
linking scheme could eventually support it, but it is a large project.
The rootfs `/init` is a documentation-only placeholder.

### 2.2 The shell is kernel-resident, not busybox [platform/decision]

Because there is no userspace, the shell runs inside the kernel.  It is
not a POSIX shell: no pipes, no redirection, no job control, no
environment, no scripts.  A "real" busybox would require 2.1 first.

### 2.3 Cooperative single-threaded scheduler [platform]

`CONFIG_SMP=n`, one CPU, no preemption, no timer-driven tick.
`__switch_to()` runs the first scheduled kernel thread as a nested
function call that never returns; later switches are identity.
`calibrate_delay_is_known()` reports a fixed lpj; the host timer import
is a stub; `uptime` reads the host clock (jiffies never advances).

### 2.4 Kernel threads cannot run [platform]

No kthreadd, no workqueue workers/rescuers, no devtmpfs daemon, no
khelper.  The port guards these under `CONFIG_WASM` (workqueue.c,
devtmpfs.c, init/main.c) and runs the boot-time work inline
(populate_rootfs runs directly instead of on the async workqueue;
`flush_delayed_fput()` drains the list directly instead of waiting on a
workqueue that can never run).

### 2.5 Atomics are plain load-compare-store [decision]

LLVM's `-mthread-model single` lowering of `__atomic_compare_exchange_n`
compiles cmpxchg into `*p = *p ? *p : new` with the expected value
folded to zero — `arch_xchg` would never install the new value and would
spin forever.  The port therefore implements arch cmpxchg/xchg and the
atomic_t variants as plain volatile load-compare-store, which is exactly
correct for a single-threaded, non-preemptible target.  If the kernel
ever runs on multiple wasm threads this must be revisited.

### 2.6 wasm-ld linker limitations [platform]

- custom sections cannot be laid out: section markers are stubs
  (`arch/wasm/kernel/markers.c`), initcall levels are empty, kallsyms
  tables are stubs;
- zero-initialized statics can get addresses overlapping initialized
  data, and an initialized symbol's address can be split from its
  content — worked around by the relocator (1.4) and early-data objects;
- the kernel-image reservation is a fixed 16 MiB window.

### 2.7 No `__builtin_return_address()` [platform]

The wasm backend cannot return the caller address; a handful of core
call sites use `_RET_IP_` instead (identical on every other arch).

### 2.8 Network compiles but nothing configures it [incomplete]

`CONFIG_WASM_NET` provides an etherstub device; the webui/hosts have
bridge plumbing (WebSocket) and the demo repo has a test bridge, but
there is no user to run `ip`/`ifconfig`, so no address is ever assigned.
A future userspace (2.1) or a kernel-side `ip` equivalent would close
this.

### 2.9 No `/dev/console` node [incomplete]

devtmpfs has no daemon on wasm, so the rootfs gets no device nodes;
`console_on_rootfs()` warns "unable to open an initial console".  The
shell talks to the console driver directly.  A kernel-side devtmpfs
node creation for the wasm console would close this.

### 2.10 Kconfig capability flags are inert [inert]

The Kconfig selects (KASAN, kmemleak, audit, seccomp, syscall
tracepoints, LTO, GCC plugins, UID16, ...) are selected but never
exercised; without userspace there is nothing for them to act on.  They
do not affect the working configuration.

### 2.11 Fixed memory layout, large module [decision]

256 MiB linear memory (64 MiB managed RAM, vmalloc area, 16 MiB wasm
stack); `vmlinux.wasm` is about 60 MB.  Browsers reserve the memory per
tab/worker.  A slimmer config (fewer drivers) would shrink the module;
memory size is a build constant.

### 2.12 The idle loop is never reached [platform]

`cpu_startup_entry()`'s idle loop would spin forever; the shell's
`wasm_shell_wait` loop (or the runtime driving `wasm_shell_input`)
takes its place.  Nothing blocks in the kernel except the shell.

### 2.13 Build warnings [minor]

11 warnings remain, all benign arch-header macro redefinitions
(`HZ`, `USER_DS`/`KERNEL_DS`, `virt_to_page`, `current_thread_info`,
`__pud`/`__pmd`).  These are the standard pattern of an arch overriding
generic defaults.

### 2.14 Timer/timekeeping stubs [platform]

`time_init` arms a one-shot timer import that the hosts currently
ignore; the port runs with `lpj=1000000` on the command line and no
ticking clock.  `ktime`/`jiffies` advance only via host calls made by
the shell's `uptime`.

---

## 3. Per-file audit (arch/wasm)

| File | Status |
|---|---|
| `kernel/setup.c` | memory setup, early data (memblock, boot caches), early console |
| `kernel/process.c` | cooperative `__switch_to`, thread stubs (no fork) |
| `kernel/sched.c` | explicit sched-class table |
| `kernel/shell.c` | the init shell (2.2) |
| `kernel/console.c` | console driver (output only) |
| `kernel/irq.c` | dummy IRQ actions, `wasm_raise_irq` for the timer |
| `kernel/time.c` | fixed lpj calibration (2.3) |
| `kernel/jiffies.c` | `jiffies` alias |
| `kernel/syscall.c` | empty syscall table (2.1) |
| `kernel/traps.c` | trap reporting to the console |
| `kernel/markers.c` | section-marker stubs (2.6) |
| `kernel/kallsyms.c` | empty kallsyms (2.6) |
| `kernel/init.c` | `machine_restart/halt/power_off` -> `wasm_exit` |
| `kernel/netdev.c` | etherstub device (2.8) |
| `os-wasm/os.c` | UML `os_*` layer: file/timer/random real, process/IPI/futex stubs |
| `include/asm/*` | mm, irqflags (compile-time constants), atomics (2.5), spinlocks (UP), etc. |

Generic-tree changes are all under `CONFIG_WASM` guards (workqueue,
devtmpfs, file_table, initramfs, main, printk, timer, memblock,
page_alloc, slub, sched.h, export.h, spinlock) or `_RET_IP_`
substitutions (2.7); each has a comment explaining why.

## 4. Known rough edges

- `tasks` shows pid 2 with comm `swapper/0` (kthreadd never runs to set
  its own comm).
- `version` prints the UTS version string as-is (`Linux wasmux # ...`).
- The webui terminal is a canvas with minimal ANSI (clear screen +
  home); other escapes render literally.
- `uptime` reports whole seconds from the host clock.
- Browser keyboard input is line-buffered: the kernel sees a whole line
  after Enter (no per-keystroke echo from the kernel; the terminal
  echoes).
