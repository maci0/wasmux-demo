/**
 * Post-link module patcher for the wasmux kernel.
 *
 * wasm-ld assigns the kernel's zero-initialized statics (bss) addresses
 * inside the range of the late initialized-data segments (.init.data,
 * __param, the boot-parameter strings, .note.Linux, .ref.data...), so the
 * runtime's segment application scribbles over live kernel structures
 * (the boot caches, the zone, the per-cpu page lists).
 *
 * This tool moves every data segment at or above CUTOFF to a safe base
 * (NEW_BASE) and rewrites:
 *   - the segment offset expressions,
 *   - every i32.const immediate in the code and global sections whose
 *     value falls in the moved range,
 *   - every load/store memarg offset immediate in the moved range (LLVM
 *     folds symbol addresses into the offset field),
 *   - every 4-byte little-endian word in ANY data segment that falls in
 *     the moved range (data-to-data pointers; unmoved early objects can
 *     hold pointers to moved late data, e.g. the sched-class table).
 *
 * The module is rebuilt with the edited sections, so the section sizes
 * and file layout stay consistent.
 *
 * Usage: bun patch-wasm.ts <in.wasm> <out.wasm>
 */

const CUTOFF = 0x1b44ac; // first late segment (the .init.data chunk) [7.2.1 layout]
const NEW_BASE = 0x00200000; // safe area: above the kernel image data, below RAM

// A reference into the moved range is only remapped when its target holds
// real initialized data (non-zero bytes in the covering segment).  Zero
// bytes are bss: wasm-ld assigned those statics addresses inside the late
// segments, and once the segments move their memory is zeroed - which is
// the correct bss state, so their references must keep the old address.
// This is build-adaptive (the old hardcoded exclude range was not).

// --- LEB128 --------------------------------------------------------------

function decodeUleb(bytes: Uint8Array, pos: number): { value: number; len: number } {
  let value = 0, shift = 0, b: number;
  const start = pos;
  do {
    b = bytes[pos++];
    value |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return { value, len: pos - start };
}

function decodeSleb(bytes: Uint8Array, pos: number): { value: number; len: number } {
  let value = 0, shift = 0, b: number;
  const start = pos;
  do {
    b = bytes[pos++];
    value |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  if (shift < 32 && (b & 0x40)) value |= -1 << shift;
  return { value, len: pos - start };
}

function encodeUleb(v: number): number[] {
  const out: number[] = [];
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

// --- main ------------------------------------------------------------------

async function main() {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error("usage: bun patch-wasm.ts <in.wasm> <out.wasm>");
    process.exit(2);
  }
  const orig = new Uint8Array(await Bun.file(inPath).arrayBuffer());

  // The sections, as { id, bodyStart, bodyEnd } into the original buffer.
  const sections: { id: number; bodyStart: number; bodyEnd: number }[] = [];
  {
    let pos = 8;
    while (pos < orig.length) {
      const id = orig[pos++];
      const size = decodeUleb(orig, pos);
      pos += size.len;
      sections.push({ id, bodyStart: pos, bodyEnd: pos + size.value });
      pos += size.value;
    }
  }

  const findSection = (id: number) => sections.find((s) => s.id === id);

  // ---- gather edits ---------------------------------------------------------
  // Edits: { at: number, len: number, bytes: number[] } applied to a copy of
  // the original module.  `at` is an absolute offset into the original file.
  const edits: { at: number; len: number; bytes: number[] }[] = [];
  let codeEdits = 0;
  let segEdits = 0;
  let ptrEdits = 0;
  let movedTotal = 0;

  // 1. Data section: patch segment offsets, then scan the content of EVERY
  // segment (moved and unmoved alike) for 4-byte data-to-data pointers into
  // the moved range.  wasm-ld assigns the kernel's statics anywhere, so an
  // early (unmoved) object can hold pointers to late (moved) data -- e.g.
  // the sched-class table in arch/wasm/kernel/sched.c.
  const dataSec = findSection(11);
  if (!dataSec) { console.error("no DATA section"); process.exit(1); }
  const movedRanges: { off: number; size: number }[] = [];
  const allSegs: { contentStart: number; contentEnd: number; off: number }[] = [];
  {
    let pos = dataSec.bodyStart;
    const count = decodeUleb(orig, pos); pos += count.len; // segment count
    let seg = 0;
    while (seg < count.value && pos < dataSec.bodyEnd) {
      const memidx = decodeUleb(orig, pos); pos += memidx.len;
      let off: number;
      let offLebStart = -1;
      if (orig[pos] === 0x41) {
        const dec = decodeUleb(orig, pos + 1);
        off = dec.value;
        offLebStart = pos + 1;
        pos += 1 + dec.len + 1; // skip end(0x0b)
      } else {
        // global.get based offset expr: value unknown; record as unmoved
        const g = decodeUleb(orig, pos + 1);
        off = -1;
        pos += 1 + g.len + 1;
      }
      const size = decodeUleb(orig, pos); pos += size.len;
      const contentStart = pos;
      const contentEnd = pos + size.value;
      pos = contentEnd;

      if (off >= 0) allSegs.push({ contentStart, contentEnd, off });
      if (off >= CUTOFF) {
        const newOff = NEW_BASE + (off - CUTOFF);
        edits.push({ at: offLebStart, len: decodeUleb(orig, offLebStart).len, bytes: encodeUleb(newOff) });
        segEdits++;
        movedTotal += size.value;
        movedRanges.push({ off, size: size.value });
      }
      seg++;
    }
  }

  // content pointers: 4-byte LE words anywhere in the module's data that
  // point into the moved range.  A pointer whose target is zero-initialized
  // (bss) must keep its old address; only non-zero (initialized) targets move.
  // A target is only treated as bss when 16 bytes at the address are all
  // zero: a 4-byte window misclassifies live structures whose leading
  // members are NULL/zero (the idle sched_class starts with queue_mask=0 and
  // enqueue_task=NULL, and its first non-zero member sits at +8).
  const segByte = (addr: number): number => {
    for (const s of allSegs) {
      const size = s.contentEnd - s.contentStart;
      if (addr >= s.off && addr < s.off + size) {
        return orig[s.contentStart + (addr - s.off)];
      }
    }
    return 0; // in a gap: memory stays zero, treat as bss
  };
  const isZeroAt = (addr: number): boolean => {
    for (let k = 0; k < 16; k++) {
      if (segByte(addr + k) !== 0) return false;
    }
    return true;
  };

  for (const s of allSegs) {
    for (let p = s.contentStart; p + 4 <= s.contentEnd; p += 4) {
      const v = orig[p] | (orig[p + 1] << 8) | (orig[p + 2] << 16) | (orig[p + 3] << 24);
      if (movedRanges.some((r) => v >= r.off && v < r.off + r.size) && !isZeroAt(v)) {
        const nv = NEW_BASE + (v - CUTOFF);
        edits.push({
          at: p,
          len: 4,
          bytes: [nv & 0xff, (nv >> 8) & 0xff, (nv >> 16) & 0xff, (nv >>> 24) & 0xff],
        });
        ptrEdits++;
      }
    }
  }

  // 2. Code section: walk the instruction stream properly (no byte-scan
  // heuristics), patching i32.const immediates and load/store memarg offset
  // immediates in the moved range, and adjusting every function body's size
  // field for the LEB length changes.
  const codeSec = findSection(10);
  if (!codeSec) { console.error("no CODE section"); process.exit(1); }
  {
    let pos = codeSec.bodyStart;
    const fcount = decodeUleb(orig, pos); pos += fcount.len; // function count
    let funcs = 0;
    let memargEdits = 0;

    const inMovedRange = (v: number) =>
      movedRanges.some((r) => v >= r.off && v < r.off + r.size) &&
      !isZeroAt(v);

    // Walk one function body; patch addresses and accumulate the length
    // delta of the body (for the size field).
    const walkBody = (bodyStart: number, bodyEnd: number): { delta: number; ok: boolean } => {
      let i = bodyStart;
      let delta = 0;
      while (i < bodyEnd) {
        const op = orig[i];
        switch (op) {
          case 0x00: case 0x01: case 0x05: case 0x0b: case 0x0f: case 0x1a: case 0x1b: i += 1; break;
          case 0x02: case 0x03: case 0x04: { // block/loop/if: blocktype (0x40 or s33 leb)
            i += 1;
            if (orig[i] === 0x40) i += 1;
            else { const t = decodeSleb(orig, i); i += t.len; }
            break;
          }
          case 0x0c: case 0x0d: case 0x10: case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: {
            const d = decodeUleb(orig, i + 1); i += 1 + d.len; break;
          }
          case 0x0e: { // br_table
            i += 1;
            const n = decodeUleb(orig, i); i += n.len;
            for (let k = 0; k < n.value; k++) { const l = decodeUleb(orig, i); i += l.len; }
            const l = decodeUleb(orig, i); i += l.len;
            break;
          }
          case 0x11: { // call_indirect: table idx, type idx
            i += 1;
            const t = decodeUleb(orig, i); i += t.len;
            const t2 = decodeUleb(orig, i); i += t2.len;
            break;
          }
          case 0x1c: { // select_t: vec(typeidx)
            i += 1;
            const n = decodeUleb(orig, i); i += n.len;
            for (let k = 0; k < n.value; k++) { const t = decodeUleb(orig, i); i += t.len; }
            break;
          }
          case 0x28: case 0x29: case 0x2a: case 0x2b: case 0x2c: case 0x2d: case 0x2e: case 0x2f:
          case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35: case 0x36: case 0x37:
          case 0x38: case 0x39: case 0x3a: case 0x3b: case 0x3c: case 0x3d: case 0x3e: {
            const a = decodeUleb(orig, i + 1);
            const o = decodeUleb(orig, i + 1 + a.len);
            if (inMovedRange(o.value)) {
              const nv = NEW_BASE + (o.value - CUTOFF);
              const enc = encodeUleb(nv);
              edits.push({ at: i + 1 + a.len, len: o.len, bytes: enc });
              delta += enc.length - o.len;
              memargEdits++;
            }
            i += 1 + a.len + o.len;
            break;
          }
          case 0x41: { // i32.const
            const d = decodeSleb(orig, i + 1);
            const v = d.value >>> 0;
            if (inMovedRange(v)) {
              const nv = NEW_BASE + (v - CUTOFF);
              const enc = encodeUleb(nv);
              edits.push({ at: i + 1, len: d.len, bytes: enc });
              delta += enc.length - d.len;
              codeEdits++;
            }
            i += 1 + d.len;
            break;
          }
          case 0x42: { // i64.const
            let len = 0, b: number;
            do { b = orig[i + 1 + len++]; } while (b & 0x80 && len < 10);
            i += 1 + len;
            break;
          }
          case 0x43: i += 5; break;
          case 0x44: i += 9; break;
          case 0xfc: { // misc prefix
            i += 2;
            const sub = orig[i - 1];
            if (sub >= 0x08 && sub <= 0x0d) { // memory.init/copy/fill/discard
              const a = decodeUleb(orig, i); i += a.len;
              const b = decodeUleb(orig, i); i += b.len;
              if (sub === 0x08 || sub === 0x0a || sub === 0x0b || sub === 0x0c) {
                const c = decodeUleb(orig, i); i += c.len;
              }
            }
            break;
          }
          case 0xfd: { // SIMD prefix
            i += 1;
            const sub = decodeUleb(orig, i); i += sub.len;
            const s = sub.value;
            if (s <= 0x0b) { // v128.load/store variants: memarg
              const a = decodeUleb(orig, i); i += a.len;
              const o = decodeUleb(orig, i); i += o.len;
            } else if (s === 0x0c) { i += 16; }        // v128.const
            else if (s === 0x0d) { i += 16; }         // v8x16.shuffle
            else if (s >= 0x54 && s <= 0x5b) {        // load/store lane
              const a = decodeUleb(orig, i); i += a.len;
              const o = decodeUleb(orig, i); i += o.len;
              i += 1;                                  // lane index
            }
            break;
          }
          case 0xfe: { // atomic prefix: subopcode + memarg
            i += 2;
            const a = decodeUleb(orig, i); i += a.len;
            const o = decodeUleb(orig, i); i += o.len;
            break;
          }
          default: i += 1; break; // no-immediate numeric ops
        }
      }
      return { delta, ok: i === bodyEnd };
    };

    while (pos < codeSec.bodyEnd) {
      const sizeDec = decodeUleb(orig, pos);
      const sizeFieldAt = pos;
      pos += sizeDec.len;
      const bodyStart = pos;
      const bodyEnd = pos + sizeDec.value;
      const { delta: bodyDelta, ok } = walkBody(bodyStart, bodyEnd);
      if (!ok) {
        console.error(`VERIFY FAILED: instruction walk desynced in function ${funcs} (body [0x${bodyStart.toString(16)}, 0x${bodyEnd.toString(16)}))`);
        process.exit(1);
      }
      if (bodyDelta !== 0) {
        edits.push({ at: sizeFieldAt, len: sizeDec.len, bytes: encodeUleb(sizeDec.value + bodyDelta) });
      }
      pos = bodyEnd;
      funcs++;
    }
    console.log(`code functions scanned: ${funcs} (memarg offset edits: ${memargEdits})`);
  }

  // 3. Global section: patch i32.const init-expr immediates (safety).
  const globSec = findSection(6);
  if (globSec) {
    let pos = globSec.bodyStart;
    while (pos < globSec.bodyEnd) {
      pos += 2; // valtype + mutability
      if (orig[pos] === 0x41) {
        const dec = decodeUleb(orig, pos + 1);
        const v = dec.value;
        if (v >= CUTOFF && v <= 0x1b3de0) {
          edits.push({ at: pos + 1, len: dec.len, bytes: encodeUleb(NEW_BASE + (v - CUTOFF)) });
          codeEdits++;
        }
        pos += 1 + dec.len;
      } else {
        pos += 1;
      }
      pos += 1; // end
    }
  }

  console.log(`segments moved: ${segEdits} (${movedTotal} bytes), code immediates: ${codeEdits}, content pointers: ${ptrEdits}`);

  // ---- rebuild ---------------------------------------------------------------
  // Apply the edits with length changes: rebuild each section body by walking
  // the original bytes and splicing the edited ranges, then write the new
  // section sizes.  The edits never overlap.
  edits.sort((a, b) => a.at - b.at);
  const parts: Uint8Array[] = [new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])];
  for (const s of sections) {
    const inBody = edits.filter((e) => e.at >= s.bodyStart && e.at < s.bodyEnd);
    const bodyLen =
      (s.bodyEnd - s.bodyStart) +
      inBody.reduce((acc, e) => acc + e.bytes.length - e.len, 0);
    const body = new Uint8Array(bodyLen);
    let cur = s.bodyStart;
    let w = 0;
    for (const e of inBody) {
      body.set(orig.subarray(cur, e.at), w);
      w += e.at - cur;
      body.set(e.bytes, w);
      w += e.bytes.length;
      cur = e.at + e.len;
    }
    body.set(orig.subarray(cur, s.bodyEnd), w);
    const sizeEnc = encodeUleb(body.length);
    if (s.id === 10 || s.id === 11) {
      console.log(`section ${s.id}: bodyLen=0x${body.length.toString(16)} (orig 0x${(s.bodyEnd - s.bodyStart).toString(16)})`);
    }
    parts.push(new Uint8Array([s.id]), new Uint8Array(sizeEnc), body);
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }

  await Bun.write(outPath, out);
  console.log(`wrote ${outPath} (${out.length} bytes)`);

  // ---- verify: re-parse the output -------------------------------------------
  const check = new Uint8Array(out);
  let vpos = 8;
  let verr = null;
  try {
    while (vpos < check.length) {
      const id = check[vpos++];
      const size = decodeUleb(check, vpos); vpos += size.len;
      const bodyEnd = vpos + size.value;
      if (id === 10) {
        // code section: sum the function sizes
        let p = vpos;
        const fcount = decodeUleb(check, p); p += fcount.len;
        let sum = 0;
        for (let f = 0; f < fcount.value; f++) {
          if (p >= bodyEnd) { verr = `code: function ${f} header beyond section`; break; }
          const fs = decodeUleb(check, p); p += fs.len;
          sum += fs.len + fs.value;
          p += fs.value;
        }
        if (!verr && p !== bodyEnd) verr = `code: bodies sum ${p - vpos} != section ${bodyEnd - vpos}`;
        if (!verr) console.log(`verify: code OK (${fcount.value} functions, ${sum} body bytes)`);
      }
      if (id === 11) {
        let p = vpos;
        const scount = decodeUleb(check, p); p += scount.len;
        for (let s = 0; s < scount.value; s++) {
          if (p >= bodyEnd) { verr = `data: segment ${s} header beyond section`; break; }
          const mi = decodeUleb(check, p); p += mi.len;
          if (check[p] === 0x41) {
            const off = decodeUleb(check, p + 1); p += 1 + off.len + 1;
          } else {
            const g = decodeUleb(check, p + 1); p += 1 + g.len + 1;
          }
          const sz = decodeUleb(check, p); p += sz.len;
          p += sz.value;
        }
        if (!verr && p !== bodyEnd) verr = `data: segments sum ${p - vpos} != section ${bodyEnd - vpos}`;
        if (!verr) console.log(`verify: data OK (${scount.value} segments)`);
      }
      vpos = bodyEnd;
    }
  } catch (e) {
    verr = String(e);
  }
  if (verr) console.error(`VERIFY FAILED: ${verr}`);
  else console.log("verify: module structure OK");
}

main();
