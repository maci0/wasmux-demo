/**
 * wasmux Linux runtime: loads vmlinux.wasm and provides the wasm host ABI
 * (module "wasmux", falling back to "env") defined in
 * linux/arch/wasm/include/shared/os-wasm.h:
 *
 *   imports:  wasm_console_write, wasm_net_send, wasm_net_recv, wasm_exit,
 *             wasm_time_ms, wasm_time_ns, wasm_timer_arm, wasm_random
 *   exports:  start_kernel, wasm_console_input, wasm_raise_irq, memory
 *
 * The kernel runs cooperatively: the runtime calls start_kernel() once and
 * it executes until it exits (wasm_exit, e.g. after a panic) or traps.
 */

/** Thrown by the wasm_exit import; unwinds the in-flight kernel call. */
export class KernelExit extends Error {
  constructor(public code: number) {
    super(`kernel exited with code ${code}`);
    this.name = "KernelExit";
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
    const instance = await WebAssembly.instantiate(module, { wasmux: imports, env: imports });
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

  /** Run start_kernel to completion. Never returns normally: the kernel
   *  either traps, or unwinds through a KernelExit thrown by wasm_exit. */
  start(): void {
    this.entered = true;
    (this.exports.start_kernel as Function)();
  }

  get exited(): boolean {
    return this.entered;
  }

  private bytes(): Uint8Array {
    return new Uint8Array(this.memory.buffer);
  }

  private buildImports(): WebAssembly.ModuleImports {
    return {
      wasm_console_write: (ptr: number, len: number) => {
        this.cb.onConsole(new TextDecoder().decode(this.bytes().subarray(ptr, ptr + len)));
      },
      wasm_net_send: (ptr: number, len: number) => {
        this.cb.onFrame?.(this.bytes().slice(ptr, ptr + len));
      },
      wasm_net_recv: (ptr: number, maxLen: number): number => {
        const frame = this.frames.shift();
        if (!frame) return 0;
        const n = Math.min(frame.length, maxLen);
        this.bytes().set(frame.subarray(0, n), ptr);
        return n;
      },
      wasm_exit: (code: number) => {
        this.cb.onExit?.(code);
        throw new KernelExit(code);
      },
      wasm_time_ms: (): bigint => {
        return BigInt(Math.floor(this.cb.getTimeMs()));
      },
      wasm_time_ns: (): bigint => {
        return BigInt(Math.floor(this.cb.getTimeMs() * 1e6));
      },
      wasm_timer_arm: (_ns: bigint) => {
        // One-shot timer: with a cooperative kernel the runtime cannot
        // preempt an in-flight start_kernel() call, so ticks are dropped
        // until the kernel yields.  The boot path does not depend on them
        // (loops_per_jiffy is preset via the lpj= command line).
      },
      wasm_random: (ptr: number, len: number): number => {
        const dst = this.bytes().subarray(ptr, ptr + len);
        if (typeof crypto !== "undefined" && crypto.getRandomValues) {
          crypto.getRandomValues(dst);
        } else {
          for (let i = 0; i < len; i++) dst[i] = (Math.random() * 256) | 0;
        }
        return len;
      },
    };
  }
}
