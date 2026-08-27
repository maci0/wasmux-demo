/**
 * wasmux webui dev server (bun).
 * Serves static files from public/, /kernel.wasm from build/, and proxies
 * /ws to the network bridge. Bun-native WebSocket + Bun.file.
 */
const BRIDGE = process.env.BRIDGE_URL ?? "ws://localhost:8081/ws";
const PORT = Number(process.env.WEBUI_PORT ?? 3000);

// Resolve everything relative to this file, not the process CWD.
const DIR = import.meta.dir;
const PUB = `${DIR}/public`;
const KERNEL_CANDIDATES = [`${DIR}/../vmlinux.wasm`, `${DIR}/../linux/vmlinux.wasm`];

let workerBundlePromise: Promise<Uint8Array<ArrayBuffer>> | null = null;

function workerBundle(): Promise<Uint8Array<ArrayBuffer>> {
  const promise = workerBundlePromise ?? Bun.build({
    entrypoints: [`${DIR}/src/worker.ts`],
    format: "esm",
    target: "browser",
  }).then(async (r) => {
    const out = r.outputs[0];
    if (!out) throw new Error("worker bundle produced no output");
    return new Uint8Array(await out.arrayBuffer() as ArrayBuffer);
  });
  workerBundlePromise = promise;
  return promise;
}

interface Link { forward(d: Uint8Array<ArrayBuffer>): void; close(): void; }
interface WsData { link?: Link }

function proxyToBridge(browserWs: { send(d: Uint8Array): void; close(): void }): Link {
  const upstream = new WebSocket(BRIDGE);
  upstream.binaryType = "arraybuffer";
  const pending: Uint8Array<ArrayBuffer>[] = [];
  let open = false;
  upstream.onopen = () => {
    console.log("bridge link up");
    open = true;
    for (const f of pending) upstream.send(f);
    pending.length = 0;
  };
  upstream.onmessage = (ev) => browserWs.send(new Uint8Array(ev.data as ArrayBuffer));
  upstream.onclose = () => browserWs.close();
  upstream.onerror = () => browserWs.close();
  return {
    forward(data) {
      if (open) upstream.send(data);
      else if (pending.length < 64) pending.push(data);
    },
    close() { upstream.close(); },
  };
}

Bun.serve<WsData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: {} })) return;
      return new Response("upgrade failed", { status: 500 });
    }

    if (url.pathname === "/kernel.wasm" || url.pathname === "/vmlinux.wasm") {
      for (const p of KERNEL_CANDIDATES) {
        const f = Bun.file(p);
        if (await f.exists())
          return new Response(f.stream(), { headers: { "content-type": "application/wasm" } });
      }
      return new Response("kernel not built", { status: 404 });
    }

    if (url.pathname === "/worker.js") {
      return new Response(await workerBundle(), {
        headers: { "content-type": "text/javascript" },
      });
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`${PUB}${path}`);
    if (await file.exists()) return new Response(file.stream());

    // bun dev-style TS transform for /src/*.ts
    if (path.startsWith("/src/") && path.endsWith(".ts")) {
      try {
        const src = await Bun.file(`${DIR}${path}`).text();
        const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(src);
        return new Response(transpiled, {
          headers: { "content-type": "text/javascript" },
        });
      } catch { /* fall through */ }
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.data.link = proxyToBridge(ws);
    },
    message(ws, msg) {
      if (typeof msg !== "string" && ws.data?.link)
        ws.data.link.forward(new Uint8Array(msg));
    },
    close(ws) {
      ws.data?.link?.close();
    },
  },
});

console.log(`wasmux webui on http://localhost:${PORT} (bridge ${BRIDGE})`);
