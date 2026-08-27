// webui/src/kernel.ts
class KernelExit extends Error {
  code;
  constructor(code) {
    super(`kernel exited with code ${code}`);
    this.code = code;
    this.name = "KernelExit";
  }
}
var PAGE = 64 * 1024;
var MIN_MEM_BYTES = 256 * 1024 * 1024;

class LinuxKernel {
  cb;
  exports;
  memory;
  frames = [];
  entered = false;
  constructor(cb) {
    this.cb = cb;
  }
  pushFrame(frame) {
    this.frames.push(frame);
  }
  async load(bytes) {
    const imports = this.buildImports();
    const module = await WebAssembly.compile(bytes);
    const instance = await WebAssembly.instantiate(module, { wasmux: imports, env: imports });
    this.exports = instance.exports;
    const mem = this.exports.memory;
    if (!mem)
      throw new Error("vmlinux.wasm does not export memory");
    this.memory = mem;
    const want = Math.ceil(MIN_MEM_BYTES / PAGE);
    if (mem.buffer.byteLength < MIN_MEM_BYTES) {
      const delta = want - Math.ceil(mem.buffer.byteLength / PAGE);
      if (mem.grow(delta) < 0)
        throw new Error("could not grow kernel memory");
    }
  }
  start() {
    this.entered = true;
    this.exports.start_kernel();
  }
  get exited() {
    return this.entered;
  }
  bytes() {
    return new Uint8Array(this.memory.buffer);
  }
  buildImports() {
    const self2 = this;
    return {
      wasm_console_write(ptr, len) {
        self2.cb.onConsole(new TextDecoder().decode(self2.bytes().subarray(ptr, ptr + len)));
      },
      wasm_net_send(ptr, len) {
        self2.cb.onFrame?.(self2.bytes().slice(ptr, ptr + len));
      },
      wasm_net_recv(ptr, maxLen) {
        const frame = self2.frames.shift();
        if (!frame)
          return 0;
        const n = Math.min(frame.length, maxLen);
        self2.bytes().set(frame.subarray(0, n), ptr);
        return n;
      },
      wasm_exit(code) {
        self2.cb.onExit?.(code);
        throw new KernelExit(code);
      },
      wasm_time_ms() {
        return BigInt(Math.floor(self2.cb.getTimeMs()));
      },
      wasm_time_ns() {
        return BigInt(Math.floor(self2.cb.getTimeMs() * 1e6));
      },
      wasm_timer_arm(_ns) {},
      wasm_random(ptr, len) {
        const dst = self2.bytes().subarray(ptr, ptr + len);
        if (typeof crypto !== "undefined" && crypto.getRandomValues) {
          crypto.getRandomValues(dst);
        } else {
          for (let i = 0;i < len; i++)
            dst[i] = Math.random() * 256 | 0;
        }
        return len;
      }
    };
  }
}

// webui/src/worker.ts
var kernel = new LinuxKernel({
  onConsole: (t) => postMessage({ type: "console", text: t }),
  onExit: (code) => postMessage({ type: "exit", code }),
  getTimeMs: () => performance.now()
});
self.onmessage = async (ev) => {
  if (ev.data?.type !== "boot")
    return;
  try {
    const bytes = ev.data.bytes;
    await kernel.load(bytes);
    postMessage({ type: "console", text: "" });
    kernel.start();
    postMessage({ type: "trap", error: "start_kernel returned unexpectedly" });
  } catch (e) {
    if (e instanceof KernelExit) {
      postMessage({ type: "exit", code: e.code });
    } else {
      postMessage({ type: "trap", error: String(e) });
    }
  }
};
