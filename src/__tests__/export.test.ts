import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, uid } from '../model/doc';
import type { WireItem } from '../model/types';
import { wirePolyline } from '../model/wires';
import { selectionDoc, exportSvg } from '../io/export';

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
});
