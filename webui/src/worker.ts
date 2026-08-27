/**
 * wasmux kernel worker: runs vmlinux.wasm in a Web Worker so that a
 * kernel fault (or an engine bug triggered by one) cannot take down the
 * page.  The worker owns the wasm instance, provides the wasmux host ABI
 * and streams console output back to the main thread.
 *
 * The kernel boots to its resident shell: the shell's wasm_shell_wait
 * import throws ShellWait, the worker catches it and tells the main
 * thread "shell ready".  From then on the main thread sends input lines
 * that are staged in the kernel's scratch buffer and passed to the
 * exported wasm_shell_input.
 *
 * Messages in:  { type: "boot", bytes } | { type: "input", line }
 * Messages out: { type: "console", text }
 *               { type: "exit", code }
 *               { type: "trap", error }
 *               { type: "shell" }
 */
import { LinuxKernel, KernelExit, ShellWait } from "./kernel.ts";

const kernel = new LinuxKernel({
  onConsole: (t) => postMessage({ type: "console", text: t }),
  onExit: (code) => postMessage({ type: "exit", code }),
  getTimeMs: () => performance.now(),
});

let booted = false;

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type === "boot" && !booted) {
    booted = true;
    try {
      const bytes = m.bytes as ArrayBuffer;
      await kernel.load(bytes);
      kernel.start(); // boots; the shell's wasm_shell_wait unwinds via ShellWait
      postMessage({ type: "trap", error: "start_kernel returned unexpectedly" });
    } catch (e) {
      if (e instanceof ShellWait) {
        postMessage({ type: "shell" });
      } else if (e instanceof KernelExit) {
        postMessage({ type: "exit", code: e.code });
      } else {
        postMessage({ type: "trap", error: String(e) });
      }
    }
  } else if (m.type === "input") {
    kernel.sendInput(m.line as string);
  }
};
