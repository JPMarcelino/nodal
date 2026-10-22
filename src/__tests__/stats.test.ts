import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, makeShape, uid } from '../model/doc';
import { addPage, viewDoc } from '../model/pages';
import { countItems, docStats, polylineLength, selectionStats } from '../model/stats';
import type { CircuitDoc, WireItem } from '../model/types';

function freeWire(doc: CircuitDoc, a: [number, number], b: [number, number], extra: Partial<WireItem> = {}) {
  const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: a[0], y: a[1] }, b: { kind: 'free', x: b[0], y: b[1] }, pts: [], ...extra };
  doc.items[w.id] = w;
  return w;
}

function circuit() {
  const doc = createDoc();
  const r = makeComponent(doc, 'resistor', 0, 200, 90);
  doc.items[r.id] = r;
  const c = makeComponent(doc, 'capacitor', 200, 200);
  doc.items[c.id] = c;
  const gnd = makeComponent(doc, 'gnd', 400, 200);
  doc.items[gnd.id] = gnd;
  const label = makeComponent(doc, 'net-label', 600, 200);
  doc.items[label.id] = label;
  freeWire(doc, [0, 0], [30, 40], { routing: 'straight' }); // 50 long
  freeWire(doc, [200, 0], [300, 0]); // 100 long
  const box = makeShape(doc, 'rect', 10, 20, 30, 40);
  doc.items[box.id] = box;
  const p2 = addPage(doc, 'Power');
  const r2 = makeComponent(doc, 'resistor', 0, 800);
  r2.page = p2;
  doc.items[r2.id] = r2;
  freeWire(doc, [0, 1000], [0, 1100], { page: p2 }); // 100 long
  return { doc, r, box, p2 };
}

describe('stats', () => {
  it('measures polylines', () => {
    expect(polylineLength([])).toBe(0);
    expect(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 14 }])).toBe(15);
  });

  it('counts parts apart from power symbols and labels, and adds up wire length', () => {
    const { doc } = circuit();
    const page1 = countItems(viewDoc(doc, undefined));
    expect(page1).toEqual({ parts: 2, markers: 2, wires: 2, wireLength: 150, shapes: 1 });
  });

  it('gives the page in view and the whole circuit', () => {
    const { doc, p2 } = circuit();
    const s = docStats(doc, p2);
    expect(s.page).toEqual({ parts: 1, markers: 0, wires: 1, wireLength: 100, shapes: 0 });
    expect(s.all).toMatchObject({ parts: 3, markers: 2, wires: 3, wireLength: 250, shapes: 1, pages: 2 });
    // each wire is a net of its own; lone pins don't count
    expect(s.all.nets).toBe(3);
    // cached per document and page
    expect(docStats(doc, p2)).toBe(s);
    expect(docStats(doc, undefined)).not.toBe(s);
  });

  it('describes the selection: count, bounding box and a lone part’s rotation', () => {
    const { doc, r, box } = circuit();
    const view = viewDoc(doc, undefined);
    expect(selectionStats(view, [box.id])).toEqual({ count: 1, bounds: { x: 10, y: 20, w: 30, h: 40 }, rotation: 0 });
    const part = selectionStats(view, [r.id]);
    expect(part.rotation).toBe(90);
    expect(part.bounds).not.toBeNull();
    const both = selectionStats(view, [r.id, box.id, 'gone']);
    expect(both.count).toBe(2);
    expect(both.rotation).toBeUndefined();
    expect(selectionStats(view, [])).toEqual({ count: 0, bounds: null });
  });
});
