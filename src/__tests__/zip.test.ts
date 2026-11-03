import { describe, expect, it } from 'vitest';
import { crc32, uniqueNames, zipFiles } from '../io/zip';

const enc = new TextEncoder();

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('writes stored entries a reader can walk', () => {
    const files = [
      { name: '1 Power.svg', data: enc.encode('<svg/>') },
      { name: '2 Ünïcode.png', data: new Uint8Array([1, 2, 3]) },
    ];
    const zip = zipFiles(files, new Date(2026, 10, 3, 12, 30, 10));
    const v = new DataView(zip.buffer);
    // end of central directory
    const end = zip.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    let at = v.getUint32(end + 16, true);
    const dec = new TextDecoder();
    for (const f of files) {
      expect(v.getUint32(at, true)).toBe(0x02014b50);
      const n = v.getUint16(at + 28, true);
      expect(dec.decode(zip.subarray(at + 46, at + 46 + n))).toBe(f.name);
      const local = v.getUint32(at + 42, true);
      expect(v.getUint32(local, true)).toBe(0x04034b50);
      expect(v.getUint32(local + 14, true)).toBe(crc32(f.data));
      const ln = v.getUint16(local + 26, true);
      const body = zip.subarray(local + 30 + ln, local + 30 + ln + f.data.length);
      expect([...body]).toEqual([...f.data]);
      at += 46 + n;
    }
  });

  it('keeps names unique', () => {
    expect(uniqueNames(['a.png', 'A.png', 'b.png', 'a.png'])).toEqual(['a.png', 'A (2).png', 'b.png', 'a (3).png']);
  });
});
