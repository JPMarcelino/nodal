import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, uid } from '../model/doc';
import { cleanup, deleteItems, extractFragment, groupItems, insertFragment, rotateItems, splitWire, ungroupItems } from '../model/ops';
import { computeNets } from '../model/netlist';
import type { CircuitDoc, WireItem } from '../model/types';
import { buildWirePath, computeHops, orthogonalize, wirePolyline } from '../model/wires';

function freeWire(doc: CircuitDoc, ax: number, ay: number, bx: number, by: number): WireItem {
  const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: ax, y: ay }, b: { kind: 'free', x: bx, y: by }, pts: [] };
  doc.items[w.id] = w;
  return w;
}

describe('wire geometry', () => {
  it('inserts orthogonal elbows', () => {
    expect(orthogonalize([{ x: 0, y: 0 }, { x: 50, y: 30 }])).toEqual([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 30 }]);
  });

  it('draws a hop where a horizontal wire crosses a vertical one', () => {
    const polys = new Map([
      ['h', [{ x: 0, y: 50 }, { x: 100, y: 50 }]],
      ['v', [{ x: 50, y: 0 }, { x: 50, y: 100 }]],
    ]);
    const hops = computeHops(polys, 5);
    expect(hops.get('h')).toEqual([{ seg: 0, d: 50 }]);
    expect(hops.get('v')).toBeUndefined();
    expect(buildWirePath(polys.get('h')!, 0, hops.get('h'), 'arc', 5)).toContain('A5,5');
  });

  it('does not hop at T connections', () => {
    const polys = new Map([
      ['h', [{ x: 0, y: 50 }, { x: 100, y: 50 }]],
      ['v', [{ x: 50, y: 50 }, { x: 50, y: 100 }]],
    ]);
    expect(computeHops(polys, 5).size).toBe(0);
  });

  it('rounds corners when a radius is set', () => {
    const d = buildWirePath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 10);
    expect(d).toContain('Q100,0');
  });
});

describe('junctions', () => {
  it('splits a wire into two at a junction and merges back on delete', () => {
    const doc = createDoc();
    const w = freeWire(doc, 0, 0, 100, 0);
    const jid = splitWire(doc, w.id, 0, { x: 40, y: 0 });
    expect(Object.values(doc.items).filter((i) => i.type === 'wire')).toHaveLength(2);
    const branch = freeWire(doc, 40, 0, 40, 60);
    branch.a = { kind: 'junction', id: jid };
    cleanup(doc);
    expect(Object.values(doc.items).filter((i) => i.type === 'junction')).toHaveLength(1);
    deleteItems(doc, [branch.id]);
    const wires = Object.values(doc.items).filter((i): i is WireItem => i.type === 'wire');
    expect(wires).toHaveLength(1);
    expect(Object.values(doc.items).filter((i) => i.type === 'junction')).toHaveLength(0);
    expect(wirePolyline(doc, wires[0])).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });
});

describe('components & nets', () => {
  it('connects pins through wires and keeps wires attached when rotating', () => {
    const doc = createDoc();
    const r1 = makeComponent(doc, 'resistor', 100, 100);
    doc.items[r1.id] = r1;
    const r2 = makeComponent(doc, 'resistor', 300, 100);
    doc.items[r2.id] = r2;
    expect(r2.ref).toBe('R2');
    const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: r1.id, port: '2' }, b: { kind: 'port', comp: r2.id, port: '1' }, pts: [] };
    doc.items[w.id] = w;
    const nets = computeNets(doc).filter((n) => n.pins.length === 2);
    expect(nets).toHaveLength(1);
    rotateItems(doc, new Set([r1.id]), 90);
    expect((doc.items[r1.id] as { rot: number }).rot).toBe(90);
    const poly = wirePolyline(doc, doc.items[w.id] as WireItem);
    expect(poly[0]).toEqual({ x: 100, y: 140 });
    expect(poly[poly.length - 1]).toEqual({ x: 260, y: 100 });
  });

  it('groups, ungroups and copies with fresh ids and references', () => {
    const doc = createDoc();
    const a = makeComponent(doc, 'capacitor', 0, 0);
    doc.items[a.id] = a;
    const b = makeComponent(doc, 'capacitor', 100, 0);
    doc.items[b.id] = b;
    const g = groupItems(doc, [a.id, b.id]);
    expect(g).toBeTruthy();
    expect(doc.items[a.id].group).toBe(g);
    const frag = extractFragment(doc, new Set([a.id, b.id]));
    const ids = insertFragment(doc, frag, 20, 20);
    expect(ids).toHaveLength(2);
    expect(Object.keys(doc.groups)).toHaveLength(2);
    const refs = Object.values(doc.items).map((i) => (i.type === 'component' ? i.ref : ''));
    expect(new Set(refs).size).toBe(4);
    ungroupItems(doc, [a.id]);
    expect(doc.items[a.id].group).toBeUndefined();
  });
});
