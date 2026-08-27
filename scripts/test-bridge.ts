/**
 * Fake-kernel bridge test: sends ARP request + ICMP echo, prints replies.
 * Usage: bun run scripts/test-bridge.ts
 */
const BRIDGE = process.env.BRIDGE_URL ?? "ws://localhost:8080/ws";

const KERNEL_MAC = [0x52, 0x54, 0x00, 0x12, 0x34, 0x56];
const BRIDGE_MAC = [0x52, 0x54, 0x00, 0x12, 0x34, 0xff];
const IP_KERNEL = [10, 0, 2, 15];
const IP_GW = [10, 0, 2, 2];

const ws = new WebSocket(BRIDGE);
ws.binaryType = "arraybuffer";

function cksum(data: Uint8Array, start = 0, len = data.length - start): number {
  let sum = 0;
  for (let i = 0; i + 1 < len; i += 2) sum += (data[start + i] << 8) | data[start + i + 1];
  if (len & 1) sum += data[start + len - 1] << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

function arpRequest(): Uint8Array {
  const f = new Uint8Array(42);
  f.set(BRIDGE_MAC, 0); // broadcast-ish (dst ignored by bridge)
  f.set(KERNEL_MAC, 6);
  f[12] = 0x08; f[13] = 0x06;
  f.set([0, 1, 0x08, 0, 6, 4, 0, 1], 14);
  f.set(KERNEL_MAC, 22);
  f.set(IP_KERNEL, 28);
  f.set([0, 0, 0, 0, 0, 0], 32);
  f.set(IP_GW, 38);
  return f;
}

function icmpEcho(id: number, seq: number): Uint8Array {
  // ip+icmp
  const icmpLen = 8 + 16; // header + payload
  const total = 20 + icmpLen;
  const p = new Uint8Array(14 + total);
  p.set(BRIDGE_MAC, 0);
  p.set(KERNEL_MAC, 6);
  p[12] = 0x08; p[13] = 0x00;

  const ip = 14;
  p[ip] = 0x45; p[ip + 1] = 0;
  p[ip + 2] = total >> 8; p[ip + 3] = total & 0xff;
  p[ip + 8] = 64; p[ip + 9] = 1; // proto=ICMP
  p.set(IP_KERNEL, ip + 12);
  p.set(IP_GW, ip + 16);

  const t = ip + 20;
  p[t] = 8; // echo request
  p[t + 4] = id >> 8; p[t + 5] = id & 0xff;
  p[t + 6] = seq >> 8; p[t + 7] = seq & 0xff;
  for (let i = 0; i < 16; i++) p[t + 8 + i] = 0x61 + (i % 26);

  const ic = cksum(p, t, icmpLen);
  p[t + 2] = ic >> 8; p[t + 3] = ic & 0xff;
  const ipc = cksum(p, ip, 20);
  p[ip + 10] = ipc >> 8; p[ip + 11] = ipc & 0xff;
  return p;
}

let gotArp = false, gotPing = false;

ws.onopen = () => {
  console.log("connected to bridge");
  ws.send(arpRequest());
  setTimeout(() => ws.send(icmpEcho(0x1234, 1)), 300);
  setTimeout(() => {
    console.log(gotArp ? "PASS: arp reply" : "FAIL: no arp reply");
    console.log(gotPing ? "PASS: icmp echo reply" : "FAIL: no icmp echo reply");
    process.exit(gotArp && gotPing ? 0 : 1);
  }, 2500);
};

ws.onmessage = (ev) => {
  const f = new Uint8Array(ev.data as ArrayBuffer);
  if (f.length < 14) return;
  const etype = (f[12] << 8) | f[13];
  if (etype === 0x0806) {
    gotArp = true;
    const spa = f.subarray(28, 32);
    console.log(`<- arp reply from ${spa.join(".")}, mac ${[...f.slice(22, 28)].map(x => x.toString(16)).join(":")}`);
  } else if (etype === 0x0800) {
    const proto = f[14 + 9];
    if (proto === 1) {
      gotPing = true;
      console.log(`<- icmp echo reply, seq ${(f[14 + 20 + 6] << 8) | f[14 + 20 + 7]}`);
    }
  }
};

ws.onerror = () => { console.error("bridge connection failed"); process.exit(2); };
