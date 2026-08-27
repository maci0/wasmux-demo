/**
 * Headless Linux boot test: loads vmlinux.wasm with the wasmux host ABI
 * and drives start_kernel to completion, printing the kernel console.
 *
 * Usage: bun run scripts/boot-linux.ts [path/to/vmlinux.wasm]
 *
 * The kernel runs start_kernel() synchronously until it either traps,
 * exits via wasm_exit() (e.g. machine_restart after a panic), or never
 * returns (then the caller times out).
 */
import { LinuxKernel, KernelExit } from "../webui/src/kernel";

const WASM = process.argv[2] ?? "linux/vmlinux.wasm";
const TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT_MS ?? 30000);

const kernel = new LinuxKernel({
  onConsole: (t) => process.stdout.write(t),
  getTimeMs: () => performance.now(),
});
kernel.cb.onExit = (code) => console.log(`\n[wasmux: kernel exited with code ${code}]\n`);

const bytes = await Bun.file(WASM).arrayBuffer();
await kernel.load(bytes);

console.log(`[wasmux] module loaded (${bytes.byteLength} bytes), starting kernel...\n`);
const t0 = performance.now();

const result = await Promise.race([
  (async () => {
    try {
      kernel.start();
      return { kind: "returned" as const };
    } catch (e) {
      if (e instanceof KernelExit) return { kind: "exit" as const, code: e.code };
      return { kind: "trapped" as const, error: String(e) };
    }
  })(),
  (async () => {
    await Bun.sleep(TIMEOUT_MS);
    return { kind: "timeout" as const };
  })(),
]);

const dt = (performance.now() - t0).toFixed(0);
switch (result.kind) {
  case "exit":
    console.log(`\n[wasmux] boot ended: wasm_exit(${result.code}) after ${dt}ms`);
    process.exit(result.code === 0 ? 0 : 1);
  case "returned":
    console.log(`\n[wasmux] start_kernel returned after ${dt}ms (unexpected)`);
    process.exit(2);
  case "trapped":
    console.log(`\n[wasmux] start_kernel trapped after ${dt}ms: ${result.error}`);
    process.exit(3);
  case "timeout":
    console.log(`\n[wasmux] start_kernel did not return after ${TIMEOUT_MS}ms`);
    process.exit(4);
}
