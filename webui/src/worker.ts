/**
 * wasmux kernel worker: runs vmlinux.wasm in a Web Worker so that a
 * kernel fault (or an engine bug triggered by one) cannot take down the
 * page.  The worker owns the wasm instance, provides the wasmux host ABI
 * and streams console output back to the main thread.
 *
 * Messages in:  { type: "boot" }
 * Messages out: { type: "console", text }
 *               { type: "exit", code }
 *               { type: "trap", error }
 */
import { LinuxKernel, KernelExit } from "./kernel.ts";

const kernel = new LinuxKernel({
  onConsole: (t) => postMessage({ type: "console", text: t }),
  onExit: (code) => postMessage({ type: "exit", code }),
  getTimeMs: () => performance.now(),
});

self.onmessage = async (ev: MessageEvent) => {
  if (ev.data?.type !== "boot") return;
  try {
    const bytes = ev.data.bytes as ArrayBuffer;
    await kernel.load(bytes);
    postMessage({ type: "console", text: "" });
    kernel.start(); // runs the whole boot; only returns on a trap-free return
    postMessage({ type: "trap", error: "start_kernel returned unexpectedly" });
  } catch (e) {
    if (e instanceof KernelExit) {
      postMessage({ type: "exit", code: e.code });
    } else {
      postMessage({ type: "trap", error: String(e) });
    }
  }
};
