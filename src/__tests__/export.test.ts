import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, uid } from '../model/doc';
import type { WireItem } from '../model/types';
import { wirePolyline } from '../model/wires';
import { selectionDoc, exportSvg, exportDxf } from '../io/export';
import { makeShape } from '../model/doc';
import { scrubMathSvg } from '../model/latex';

function twoResistors() {
  const doc = createDoc();
  const c1 = makeComponent(doc, 'resistor', 100, 100);
  doc.items[c1.id] = c1;
  const c2 = makeComponent(doc, 'resistor', 300, 100);
  doc.items[c2.id] = c2;
  const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: c1.id, port: '2' }, b: { kind: 'port', comp: c2.id, port: '1' }, pts: [] };
  doc.items[w.id] = w;
  return { doc, c1, c2, w };
}

describe('selectionDoc', () => {
  it('keeps a wire-only selection renderable by re-anchoring dangling ends', () => {
    const { doc, w } = twoResistors();
    const before = wirePolyline(doc, w);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const d = selectionDoc(doc, [w.id]);
    const kept = d.items[w.id] as WireItem;
    expect(kept).toBeDefined();
    expect(kept.a.kind).toBe('free');
    expect(kept.b.kind).toBe('free');
    // original endpoints were at the ports, so the frozen wire matches the original shape
    expect(wirePolyline(d, kept)).toEqual(before);
    // original doc untouched
    expect((doc.items[w.id] as WireItem).a.kind).toBe('port');
  });

  it('pulls in wires connecting two selected components', () => {
    const { doc, c1, c2, w } = twoResistors();
    const d = selectionDoc(doc, [c1.id, c2.id]);
    expect(d.items[w.id]).toBeDefined();
    const kept = d.items[w.id] as WireItem;
    expect(kept.a).toEqual({ kind: 'port', comp: c1.id, port: '2' });
    expect(wirePolyline(d, kept).length).toBeGreaterThanOrEqual(2);
  });

  it('freezes only the unselected end of a partly-selected wire', () => {
    const { doc, c1, w } = twoResistors();
    const d = selectionDoc(doc, [w.id, c1.id]);
    const kept = d.items[w.id] as WireItem;
    expect(kept.a).toEqual({ kind: 'port', comp: c1.id, port: '2' });
    expect(kept.b.kind).toBe('free');
    expect(wirePolyline(d, kept).length).toBeGreaterThanOrEqual(2);
  });

  it('exportSvg({ids:[wire]}) keeps a wire connecting unselected items', () => {
    const { doc, w } = twoResistors();
    const { svg } = exportSvg(doc, { theme: 'light', background: false, padding: 10, ids: [w.id] });
    expect(svg).toContain(`data-id="${w.id}"`);
  });

  it('writes concrete colours for a dark export (no currentColor or CSS variables)', () => {
    const { doc } = twoResistors();
    const { svg } = exportSvg(doc, { theme: 'dark', background: true, padding: 10 });
    expect(svg).not.toMatch(/currentColor|--sym-bg|var\(/);
    expect(svg).toContain('stroke="#e6dfcf"');
  });

  it('keeps a part colour, and the light theme symbol colour, in the export', () => {
    const { doc, c1 } = twoResistors();
    c1.color = '#ff0000';
    const { svg } = exportSvg(doc, { theme: 'light', background: true, padding: 10 });
    expect(svg).toContain('stroke="#ff0000"');
    expect(svg).toContain('stroke="#1f1c16"');
    expect(svg).not.toMatch(/currentColor|color:/);
  });

  it('leaves symbol interiors and page-coloured fills see-through without a background', () => {
    const doc = createDoc();
    const op = makeComponent(doc, 'opamp', 100, 100);
    doc.items[op.id] = op;
    const box = makeShape(doc, 'rect', 300, 100, 60, 40);
    Object.assign(box, { fill: '#0f0e0c', fillOpacity: 1 });
    doc.items[box.id] = box;
    const solid = exportSvg(doc, { theme: 'light', background: true, padding: 10 }).svg;
    expect(solid).toContain('fill="#ffffff"');
    expect(solid).not.toContain('#0f0e0c');
    const clear = exportSvg(doc, { theme: 'dark', background: false, padding: 10 }).svg;
    expect(clear).not.toContain('#0f0e0c');
    expect(exportSvg(doc, { theme: 'dark', background: false, padding: 10, opaqueSymbols: true }).svg).toContain('#0f0e0c');
  });

  it('draws junction dots in an area export', () => {
    const doc = createDoc();
    const j = { id: uid('j'), type: 'junction', x: 100, y: 100 } as const;
    doc.items[j.id] = j as never;
    for (const [x, y] of [[0, 100], [200, 100], [100, 200]]) {
      const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'junction', id: j.id }, b: { kind: 'free', x, y }, pts: [] };
      doc.items[w.id] = w;
    }
    const page = exportSvg(doc, { theme: 'dark', background: false, padding: 10 }).svg;
    const area = exportSvg(doc, { theme: 'dark', background: false, padding: 10, clip: { x: 50, y: 50, w: 100, h: 100 } }).svg;
    const dots = (svg: string) => (svg.match(/<circle/g) ?? []).length;
    expect(dots(page)).toBeGreaterThan(0);
    expect(dots(area)).toBe(dots(page));
  });

  it('writes black as ACI 7 in DXF', () => {
    const doc = createDoc();
    const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: 0, y: 0 }, b: { kind: 'free', x: 50, y: 0 }, pts: [], style: { color: '#000000' } } as WireItem;
    doc.items[w.id] = w;
    expect(exportDxf(doc)).not.toMatch(/\n62\n8\n/);
  });

  it('escapes & and < in formula attributes so the SVG stays valid XML', () => {
    expect(scrubMathSvg('<a href="http://x/?a=1&b=2"><g data-x="1<2 &amp; ok">x</g></a>')).toBe('<a href="http://x/?a=1&amp;b=2"><g data-x="1&lt;2 &amp; ok">x</g></a>');
  });
});
