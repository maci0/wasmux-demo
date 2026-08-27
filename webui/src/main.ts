/**
 * wasmux main: boots Linux (vmlinux.wasm) into its kernel-resident shell
 * and shows the terminal.  The kernel runs in a Web Worker (fault
 * * isolation); console output streams back, raw keystrokes are forwarded.
 * Network frames are bridged over WebSocket when the local bridge is
 * reachable; without it the kernel simply runs without ethernet.
 */
import { Console } from "./console.ts";

const out = document.getElementById("out")!;
const status = document.getElementById("status")!;

// --- console ----------------------------------------------------------------

let kernel: { sendInput(key: string): void } | null = null;
const term = new Console(out, (key) => kernel?.sendInput(key));

// --- kernel worker ----------------------------------------------------------

let worker: Worker | null = null;

function spawnKernelWorker(bytes: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    worker = new Worker("worker.js", { type: "module" });
    worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      if (m.type === "console") term.print(m.text);
      else if (m.type === "shell") {
        status.textContent = "shell ready — type commands";
        resolve();
      } else if (m.type === "exit") {
        term.print(`\n[wasmux: kernel exited with code ${m.code}]\n`);
        status.textContent = `kernel exited (${m.code})`;
      } else if (m.type === "trap") {
        term.print(`\n[kernel fault: ${m.error}]\n`);
        status.textContent = "kernel faulted (page kept alive by worker)";
        resolve();
      }
    };
    worker.onerror = (e) => {
      status.textContent = "kernel worker crashed";
      term.print(`\n[kernel worker crashed: ${e.message}]\n`);
      reject(new Error("worker crashed"));
    };
    worker.postMessage({ type: "boot", bytes }, [bytes]);
    kernel = {
      sendInput(key: string) {
        worker?.postMessage({ type: "input", key });
      },
    };
  });
}

// --- boot -------------------------------------------------------------------

async function main() {
  status.textContent = "loading vmlinux.wasm…";

  // Dev server exposes the kernel at /kernel.wasm; the static GH Pages
  // build ships it next to the bundle as ./vmlinux.wasm.
  const kernelUrls = ["/kernel.wasm", "./vmlinux.wasm"];
  let bytes: ArrayBuffer | null = null;
  for (const url of kernelUrls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue; // e.g. /kernel.wasm 404s on static GH Pages
      bytes = await res.arrayBuffer();
      if (bytes.byteLength > 0) break;
    } catch { /* try next */ }
  }
  if (!bytes) {
    status.textContent = "kernel: load error";
    term.print("failed to fetch the kernel image (tried /kernel.wasm, ./vmlinux.wasm)\n");
    return;
  }

  status.textContent = "booting kernel…";
  try {
    await spawnKernelWorker(bytes);
  } catch {
    /* status already set by the worker error handler */
  }
}

main();
