import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, uid } from '../model/doc';
import { clipPolylineToRect, simplify } from '../model/geometry';
import { cleanup, deleteItems, extractFragment, groupItems, insertFragment, rotateItems, splitWire, ungroupItems } from '../model/ops';
import { computeNets } from '../model/netlist';
import type { CircuitDoc, WireItem } from '../model/types';
import { buildWirePath, computeHops, hopPrefMap, moveWireNode, orthogonalize, wirePolyline } from '../model/wires';

function freeWire(doc: CircuitDoc, ax: number, ay: number, bx: number, by: number): WireItem {
  const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: ax, y: ay }, b: { kind: 'free', x: bx, y: by }, pts: [] };
  doc.items[w.id] = w;
  return w;
}

const idWire = (id: string, hopOver: boolean): { type: string; id: string; hopOver?: boolean } => ({ type: 'wire', id, hopOver });

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

  it('honours an explicit hop preference per wire', () => {
    const polys = new Map([
      ['h', [{ x: 0, y: 50 }, { x: 100, y: 50 }]],
      ['v', [{ x: 50, y: 0 }, { x: 50, y: 100 }]],
    ]);
    // vertical wire explicitly hops over the horizontal one
    expect(computeHops(polys, 5, hopPrefMap([idWire('v', true)])).get('v')).toEqual([{ seg: 0, d: 50 }]);
    expect(computeHops(polys, 5, hopPrefMap([idWire('v', true)])).get('h')).toBeUndefined();
    // horizontal wire told to stay flat: the vertical one must hop instead
    expect(computeHops(polys, 5, hopPrefMap([idWire('h', false)])).get('v')).toEqual([{ seg: 0, d: 50 }]);
    // both flat: falls back to the default rule
    expect(computeHops(polys, 5, hopPrefMap([idWire('h', false), idWire('v', false)])).get('h')).toEqual([{ seg: 0, d: 50 }]);
  });

  it('rounds corners when a radius is set', () => {
    const d = buildWirePath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 10);
    expect(d).toContain('Q100,0');
  });
});

describe('editing wire points', () => {
  // Z-shaped wire: two fixed ends and two bends
  const z = [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 50, y: 100 },
    { x: 100, y: 100 },
  ];

  it('moves a bend and slides its neighbour so segments stay orthogonal', () => {
    const out = moveWireNode(z, 1, { x: 70, y: 0 }, false);
    expect(out[1]).toEqual({ x: 70, y: 0 });
    expect(out[2]).toEqual({ x: 70, y: 100 });
  });

  it('never moves the attached wire ends', () => {
    const out = moveWireNode(z, 1, { x: 50, y: 20 }, false);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[3]).toEqual({ x: 100, y: 100 });
  });

  it('moves only the chosen point in free mode', () => {
    const out = moveWireNode(z, 1, { x: 70, y: 20 }, true);
    expect(out).toEqual([z[0], { x: 70, y: 20 }, z[2], z[3]]);
  });

  it('does not mutate the input polyline', () => {
    const copy = z.map((p) => ({ ...p }));
    moveWireNode(z, 2, { x: 10, y: 10 }, false);
    expect(z).toEqual(copy);
  });

  it('simplify removes spikes that double back on themselves', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }])).toEqual([
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 40 },
    ]);
  });
});

describe('polyline clipping', () => {
  const r = { x: 10, y: 10, w: 80, h: 80 };

  it('cuts a wire entering and leaving the rectangle', () => {
    const pieces = clipPolylineToRect([{ x: 0, y: 30 }, { x: 100, y: 30 }], r);
    expect(pieces).toEqual([[{ x: 10, y: 30 }, { x: 90, y: 30 }]]);
  });

  it('keeps wires fully inside', () => {
    const pieces = clipPolylineToRect([{ x: 20, y: 50 }, { x: 60, y: 50 }], r);
    expect(pieces).toEqual([[{ x: 20, y: 50 }, { x: 60, y: 50 }]]);
  });

  it('drops wires fully outside and keeps multiple disjoint pieces', () => {
    expect(clipPolylineToRect([{ x: 0, y: 0 }, { x: 5, y: 5 }], r)).toEqual([]);
    const zig = [
      { x: 0, y: 30 },
      { x: 50, y: 30 },
      { x: 50, y: -10 },
      { x: 80, y: -10 },
      { x: 80, y: 60 },
    ];
    const pieces = clipPolylineToRect(zig, r);
    expect(pieces.length).toBe(2);
    expect(pieces[0]).toEqual([{ x: 10, y: 30 }, { x: 50, y: 30 }, { x: 50, y: 10 }]);
    expect(pieces[1]).toEqual([{ x: 80, y: 10 }, { x: 80, y: 60 }]);
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
