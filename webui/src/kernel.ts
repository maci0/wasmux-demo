/**
 * wasmux Linux runtime — loads vmlinux.wasm and provides the wasm host ABI
 * (module "wasmux", falling back to "env") defined in
 * linux/arch/wasm/include/shared/os-wasm.h:
 *
 *   imports:  wasm_console_write, wasm_net_send, wasm_net_recv, wasm_exit,
 *             wasm_time_ms, wasm_time_ns, wasm_timer_arm, wasm_random,
 *             wasm_shell_wait
 *   exports:  start_kernel, wasm_shell_input, wasm_shell_scratch,
 *             wasm_raise_irq, memory
 *
 * The kernel runs cooperatively: the runtime calls start_kernel() once.  It
 * boots, prints the shell banner, and blocks in the wasm_shell_wait import
 * waiting for console input.  The browser cannot block, so wasm_shell_wait
 * throws ShellWait to unwind the in-flight call; the UI then feeds lines
 * through sendInput(), which stages the bytes in the kernel's scratch
 * buffer and calls the exported wasm_shell_input.
 */

/** Thrown by the wasm_exit import; unwinds the in-flight kernel call. */
export class KernelExit extends Error {
  constructor(public code: number) {
    super(`kernel exited with code ${code}`);
    this.name = "KernelExit";
  }
}

/** Thrown by wasm_shell_wait; the kernel wants console input. */
export class ShellWait extends Error {
  constructor() {
    super("kernel waiting for shell input");
    this.name = "ShellWait";
  }
}

export interface LinuxKernelCallbacks {
  onConsole: (text: string) => void;
  onExit?: (code: number) => void;
  onFrame?: (frame: Uint8Array) => void; // outbound ethernet frame
  getTimeMs: () => number;
}

const PAGE = 64 * 1024;
const MIN_MEM_BYTES = 256 * 1024 * 1024; // total linear memory
const SHELL_SCRATCH = 64; // matches SHELL_LINE_MAX-ish in the kernel

export class LinuxKernel {
  private exports!: WebAssembly.Exports;
  private memory!: WebAssembly.Memory;
  private frames: Uint8Array[] = [];
  private entered = false;

  constructor(public cb: LinuxKernelCallbacks) {}

  /** Queue an inbound ethernet frame (from the network bridge). */
  pushFrame(frame: Uint8Array) {
    this.frames.push(frame);
  }

  async load(bytes: ArrayBuffer): Promise<void> {
    const imports = this.buildImports();
    const module = await WebAssembly.compile(bytes);
    const instance = await WebAssembly.instantiate(
      module,
      { wasmux: imports, env: imports } as unknown as WebAssembly.Imports,
    );
    this.exports = instance.exports;
    const mem = this.exports.memory as WebAssembly.Memory | undefined;
    if (!mem) throw new Error("vmlinux.wasm does not export memory");
    this.memory = mem;

    // Grow to the size the kernel's memblock assumes (WASM_MEM_SIZE).
    const want = Math.ceil(MIN_MEM_BYTES / PAGE);
    if (mem.buffer.byteLength < MIN_MEM_BYTES) {
      const delta = want - Math.ceil(mem.buffer.byteLength / PAGE);
      if (mem.grow(delta) < 0) throw new Error("could not grow kernel memory");
    }
  }

  /** Run start_kernel. Returns only via KernelExit/ShellWait or a trap. */
  start(): void {
    this.entered = true;
    (this.exports.start_kernel as Function)();
  }

  /** Forward raw input bytes to the kernel-resident shell (the kernel
   *  echoes and does line editing).  Lines end with "\n"; backspace is
   *  "\x7f". */
  sendInput(data: string): void {
    if (this.entered && this.exports.wasm_shell_input) {
      const scratch = (this.exports.wasm_shell_scratch as Function)() as number;
      const bytes = new TextEncoder().encode(data);
      const n = Math.min(bytes.length, SHELL_SCRATCH - 1);
      this.bytes().set(bytes.subarray(0, n), scratch);
      (this.exports.wasm_shell_input as Function)(scratch, n);
    }
  }

  get exited(): boolean {
    return this.entered;
  }

  private bytes(): Uint8Array {
    return new Uint8Array(this.memory.buffer);
  }

  private buildImports(): Record<string, unknown> {
    const self = this;
    return {
      wasm_console_write(ptr: number, len: number) {
        self.cb.onConsole(new TextDecoder().decode(self.bytes().subarray(ptr, ptr + len)));
      },
      wasm_net_send(ptr: number, len: number) {
        self.cb.onFrame?.(self.bytes().slice(ptr, ptr + len));
      },
      wasm_net_recv(ptr: number, maxLen: number): number {
        const frame = self.frames.shift();
        if (!frame) return 0;
        const n = Math.min(frame.length, maxLen);
        self.bytes().set(frame.subarray(0, n), ptr);
        return n;
      },
      wasm_exit(code: number) {
        self.cb.onExit?.(code);
        throw new KernelExit(code);
      },
      wasm_time_ms(): bigint {
        return BigInt(Math.floor(self.cb.getTimeMs()));
      },
      wasm_time_ns(): bigint {
        return BigInt(Math.floor(self.cb.getTimeMs() * 1e6));
      },
      wasm_timer_arm(_ns: bigint) {
        // One-shot timer: with a cooperative kernel the runtime cannot
        // preempt an in-flight start_kernel() call, so ticks are dropped
        // until the kernel yields.  The boot path does not depend on them
        // (loops_per_jiffy is preset via the lpj= command line).
      },
      wasm_random(ptr: number, len: number): number {
        const dst = self.bytes().subarray(ptr, ptr + len);
        if (typeof crypto !== "undefined" && crypto.getRandomValues) {
          crypto.getRandomValues(dst as unknown as Uint8Array);
        } else {
          for (let i = 0; i < len; i++) dst[i] = (Math.random() * 256) | 0;
        }
        return len;
      },
      wasm_shell_wait(): number {
        // The browser cannot block a synchronous wasm call.  Unwind so the
        // UI can show the terminal; sendInput() drives the shell from then
        // on.  The throw unwinds the whole boot chain, which is fine: the
        // kernel state lives in linear memory and persists.
        throw new ShellWait();
      },
    };
  }
}
