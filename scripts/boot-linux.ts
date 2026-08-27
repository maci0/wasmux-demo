/**
 * Headless Linux boot test: loads vmlinux.wasm with the wasmux host ABI,
 * boots start_kernel to the resident shell, then drives a scripted shell
 * session and prints the transcript.
 *
 * Usage: bun run scripts/boot-linux.ts [path/to/vmlinux.wasm]
 *
 * The shell's wasm_shell_wait import cannot block in bun, so it unwinds
 * control (ShellWait); the script then feeds lines through
 * wasm_shell_input exactly like the browser worker does.
 */
import { LinuxKernel, KernelExit, ShellWait } from "../webui/src/kernel";

const WASM = process.argv[2] ?? "vmlinux.wasm";
const SCRIPT =
  process.env.SHELL_SCRIPT ?? "help\nversion\nfree\nuptime\ntasks\necho hello\nreboot\n";

const kernel = new LinuxKernel({
  onConsole: (t) => process.stdout.write(t),
  getTimeMs: () => performance.now(),
});

const bytes = await Bun.file(WASM).arrayBuffer();
await kernel.load(bytes);

console.log(`[wasmux] module loaded (${bytes.byteLength} bytes), starting kernel...\n`);
const t0 = performance.now();

try {
  kernel.start();
  console.log(`\n[wasmux] start_kernel returned after ${(performance.now() - t0).toFixed(0)}ms (unexpected)`);
  process.exit(2);
} catch (e) {
  if (e instanceof ShellWait) {
    // shell is up: drive the scripted session
    for (const line of SCRIPT.split("\n")) {
      if (!line) continue;
      kernel.sendInput(line);
    }
    console.log(`\n[wasmux] shell session done after ${(performance.now() - t0).toFixed(0)}ms`);
    process.exit(0);
  }
  if (e instanceof KernelExit) {
    console.log(`\n[wasmux] boot ended: wasm_exit(${e.code}) after ${(performance.now() - t0).toFixed(0)}ms`);
    process.exit(e.code === 0 ? 0 : 1);
  }
  console.log(`\n[wasmux] start_kernel trapped: ${e}`);
  process.exit(3);
}
