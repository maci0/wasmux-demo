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
const led = document.getElementById("led")!;
const screenWrap = document.getElementById("screenWrap")!;

/** Drive the front-panel LED + status line from the kernel state. */
function setPanel(state: "off" | "booting" | "ready" | "error", text: string) {
  led.className = "led" + (state === "off" ? "" : ` ${state}`);
  status.className = state === "ready" ? "ready" : state === "error" ? "error" : "";
  status.textContent = text;
}

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
        setPanel("ready", "shell ready — type commands");
        resolve();
      } else if (m.type === "exit") {
        term.print(`\n[wasmux: kernel exited with code ${m.code}]\n`);
        setPanel("off", `kernel exited (${m.code})`);
      } else if (m.type === "trap") {
        term.print(`\n[kernel fault: ${m.error}]\n`);
        setPanel("error", "kernel faulted");
        resolve();
      }
    };
    worker.onerror = (e) => {
      setPanel("error", "kernel worker crashed");
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
  setPanel("booting", "loading vmlinux.wasm…");

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
    setPanel("error", "kernel load error");
    term.print("failed to fetch the kernel image (tried /kernel.wasm, ./vmlinux.wasm)\n");
    return;
  }

  setPanel("booting", "booting kernel…");
  screenWrap.classList.add("warming"); // the one authored power-on moment
  try {
    await spawnKernelWorker(bytes);
  } catch {
    /* status already set by the worker error handler */
  }
}

main();
