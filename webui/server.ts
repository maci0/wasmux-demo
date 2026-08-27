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

interface Link { forward(d: Uint8Array): void; close(): void; }

function proxyToBridge(browserWs: { send(d: Uint8Array): void; close(): void }): Link {
  const upstream = new WebSocket(BRIDGE);
  upstream.binaryType = "arraybuffer";
  const pending: Uint8Array[] = [];
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

Bun.serve({
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
          return new Response(f, { headers: { "content-type": "application/wasm" } });
      }
      return new Response("kernel not built", { status: 404 });
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`${PUB}${path}`);
    if (await file.exists()) return new Response(file);

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
      ws.data.link = proxyToBridge(ws as any);
    },
    message(ws, msg) {
      if (typeof msg !== "string" && ws.data?.link)
        (ws.data.link as Link).forward(new Uint8Array(msg));
    },
    close(ws) {
      (ws.data?.link as Link | undefined)?.close();
    },
  },
});

console.log(`wasmux webui on http://localhost:${PORT} (bridge ${BRIDGE})`);
