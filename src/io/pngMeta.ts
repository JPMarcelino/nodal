/**
 * Text chunks in PNG files, so an exported picture can carry the circuit it
 * shows. Pure byte work, no DOM: chunks are added as uncompressed `iTXt`
 * (UTF-8) just before IEND, and read back only when their CRC checks out.
 */

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let table: Uint32Array | null = null;

/** CRC-32 (ISO 3309, as PNG uses it) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

interface Chunk {
  type: string;
  /** Offset of the length field. */
  at: number;
  data: Uint8Array;
  crcOk: boolean;
}

/** The file's chunks in order; stops at the first truncated one. */
function chunks(bytes: Uint8Array): Chunk[] {
  const out: Chunk[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  while (at + 12 <= bytes.length) {
    const len = dv.getUint32(at);
    if (at + 12 + len > bytes.length) break;
    const typed = bytes.subarray(at + 4, at + 8 + len);
    const type = String.fromCharCode(...typed.subarray(0, 4));
    out.push({ type, at, data: typed.subarray(4), crcOk: crc32(typed) === dv.getUint32(at + 8 + len) });
    at += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** The PNG with an uncompressed iTXt chunk `keyword` = `text` added (replacing any earlier one of that keyword). */
export function insertPngText(png: Uint8Array, keyword: string, text: string): Uint8Array {
  if (!isPng(png)) throw new Error('Not a PNG image');
  const list = chunks(png);
  const end = list.find((c) => c.type === 'IEND');
  if (!end) throw new Error('Truncated PNG image');
  // keyword, NUL, compression flag 0, method 0, empty language tag + NUL, empty translated keyword + NUL, text
  const body = new Uint8Array([...latin1(keyword), 0, 0, 0, 0, 0, ...new TextEncoder().encode(text)]);
  const chunk = new Uint8Array(12 + body.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, body.length);
  chunk.set(latin1('iTXt'), 4);
  chunk.set(body, 8);
  dv.setUint32(8 + body.length, crc32(chunk.subarray(4, 8 + body.length)));
  // copy everything but an older chunk of the same keyword, then ours before IEND
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  for (const c of list) {
    if (c.type === 'IEND') break;
    if (c.type === 'iTXt' && readItxt(c.data)?.keyword === keyword) continue;
    parts.push(png.subarray(c.at, c.at + 12 + c.data.length));
  }
  parts.push(chunk, png.subarray(end.at));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function readItxt(data: Uint8Array): { keyword: string; compressed: boolean; text: Uint8Array } | null {
  const k = data.indexOf(0);
  // keywords are 1–79 bytes
  if (k < 1 || k > 79 || k + 3 > data.length) return null;
  const keyword = String.fromCharCode(...data.subarray(0, k));
  const compressed = data[k + 1] === 1;
  const lang = data.indexOf(0, k + 3);
  if (lang < 0) return null;
  const trans = data.indexOf(0, lang + 1);
  if (trans < 0) return null;
  return { keyword, compressed, text: data.subarray(trans + 1) };
}

/** The text of the uncompressed iTXt (or tEXt) chunk `keyword`; null when there is none, the image is not a PNG, or the chunk is damaged. */
export function extractPngText(png: Uint8Array, keyword: string): string | null {
  if (!isPng(png)) return null;
  for (const c of chunks(png)) {
    if (c.type === 'iTXt') {
      const t = readItxt(c.data);
      if (!t || t.keyword !== keyword) continue;
      if (!c.crcOk || t.compressed) return null;
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(t.text);
      } catch {
        return null;
      }
    }
    if (c.type === 'tEXt') {
      const k = c.data.indexOf(0);
      if (k < 1 || k > 79 || String.fromCharCode(...c.data.subarray(0, k)) !== keyword) continue;
      return c.crcOk ? new TextDecoder('latin1').decode(c.data.subarray(k + 1)) : null;
    }
  }
  return null;
}
