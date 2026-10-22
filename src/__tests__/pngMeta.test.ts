import { describe, expect, it } from 'vitest';
import { crc32, extractPngText, insertPngText, isPng } from '../io/pngMeta';
import { SCENE_TYPE, pngWithScene, sceneFromFile, sceneFromPng, sceneFromSvgText, sceneJson, svgWithScene } from '../io/embeddedScene';
import { exportSvg } from '../io/export';
import { createDoc, makeComponent, normalizeDoc } from '../model/doc';

// a 1×1 PNG
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

function circuit() {
  const doc = createDoc('Embedded µ circuit');
  const r = makeComponent(doc, 'resistor', 100, 100);
  doc.items[r.id] = r;
  return doc;
}

describe('pngMeta', () => {
  it('computes PNG CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('round-trips UTF-8 text and keeps the image valid', () => {
    const text = '{"name":"Ω µ — ünïcode"}';
    const out = insertPngText(PNG, 'application/vnd.nodal+json', text);
    expect(isPng(out)).toBe(true);
    expect(extractPngText(out, 'application/vnd.nodal+json')).toBe(text);
    // the original bytes are untouched and still end in IEND
    expect(extractPngText(PNG, 'application/vnd.nodal+json')).toBeNull();
    expect([...out.subarray(-12)]).toEqual([...PNG.subarray(-12)]);
    expect(out.length).toBeGreaterThan(PNG.length);
    // every chunk's CRC in the output checks out
    const dv = new DataView(out.buffer);
    for (let at = 8; at < out.length; ) {
      const len = dv.getUint32(at);
      expect(crc32(out.subarray(at + 4, at + 8 + len))).toBe(dv.getUint32(at + 8 + len));
      at += 12 + len;
    }
    // writing again replaces the chunk instead of adding a second one
    const again = insertPngText(out, 'application/vnd.nodal+json', 'second');
    expect(extractPngText(again, 'application/vnd.nodal+json')).toBe('second');
    expect(again.length).toBe(out.length - new TextEncoder().encode(text).length + 6);
    // other keywords are not confused with ours
    expect(extractPngText(out, 'Comment')).toBeNull();
  });

  it('returns null for images without the chunk, non-PNGs and damaged chunks', () => {
    expect(extractPngText(PNG, 'k')).toBeNull();
    expect(extractPngText(new TextEncoder().encode('<svg/>'), 'k')).toBeNull();
    expect(extractPngText(new Uint8Array(), 'k')).toBeNull();
    const out = insertPngText(PNG, 'k', 'hello world');
    // flip a byte of the text: the CRC no longer matches
    const bad = out.slice();
    bad[bad.length - 12 - 4 - 2] ^= 0xff;
    expect(extractPngText(bad, 'k')).toBeNull();
    // cut off mid-chunk
    expect(extractPngText(out.slice(0, out.length - 20), 'k')).toBeNull();
    expect(() => insertPngText(new Uint8Array([1, 2, 3]), 'k', 'x')).toThrow();
  });
});

describe('embedded circuits', () => {
  it('round-trips a circuit through an exported PNG', async () => {
    const doc = circuit();
    const blob = await pngWithScene(new Blob([PNG], { type: 'image/png' }), sceneJson(doc));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const json = sceneFromPng(bytes);
    expect(json).not.toBeNull();
    expect(normalizeDoc(JSON.parse(json!)).items).toEqual(doc.items);
    expect(await sceneFromFile(new File([bytes], 'x.png', { type: 'image/png' }))).toBe(json);
    // a chunk under our keyword that is not a circuit is ignored
    expect(sceneFromPng(insertPngText(PNG, SCENE_TYPE, '{"format":"other"}'))).toBeNull();
    expect(sceneFromPng(insertPngText(PNG, SCENE_TYPE, 'not json'))).toBeNull();
  });

  it('round-trips a circuit through an exported SVG', async () => {
    const doc = circuit();
    const { svg } = exportSvg(doc, { theme: 'light', background: true, padding: 20 });
    expect(sceneFromSvgText(svg)).toBeNull();
    const out = svgWithScene(svg, sceneJson(doc));
    // still one well-formed svg element, the payload is plain base64 text
    expect(out.match(/<svg\b/g)?.length).toBe(1);
    expect(out).toMatch(/<metadata id="nodal-scene" data-type="application\/vnd\.nodal\+json">[A-Za-z0-9+/=]+<\/metadata>/);
    const json = sceneFromSvgText(out);
    const back = normalizeDoc(JSON.parse(json!));
    expect(back.name).toBe('Embedded µ circuit');
    expect(back.items).toEqual(doc.items);
    expect(await sceneFromFile(new File([out], 'x.svg', { type: 'image/svg+xml' }))).toBe(json);
    // damaged or foreign payloads are ignored, never thrown
    expect(sceneFromSvgText(out.replace(/(nodal\+json">)[A-Za-z0-9]{8}/, '$1!!!!!!!!'))).toBeNull();
    expect(sceneFromSvgText(svgWithScene(svg, '{"format":"nodal-library"}'))).toBeNull();
    expect(sceneFromSvgText('<svg><metadata id="nodal-scene">%%%</metadata></svg>')).toBeNull();
  });
});
