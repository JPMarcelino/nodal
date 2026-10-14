import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent } from '../model/doc';
import { marqueeHits } from '../model/marquee';
import { computeNets } from '../model/netlist';
import { settleEdit } from '../model/settle';
import type { CircuitDoc, Endpoint, Item, Point, WireItem } from '../model/types';
import { moveWireSegment } from '../model/wireCommit';
import { wirePolyline } from '../model/wires';

const F = (x: number, y: number): Endpoint => ({ kind: 'free', x, y });
const J = (id: string): Endpoint => ({ kind: 'junction', id });
const wire = (id: string, a: Endpoint, b: Endpoint, pts: Point[] = []): WireItem => ({ id, type: 'wire', a, b, pts });

function docWith(items: Item[]): CircuitDoc {
  const d = createDoc();
  for (const it of items) d.items[it.id] = it;
  return d;
}
const wires = (d: CircuitDoc) => Object.values(d.items).filter((i): i is WireItem => i.type === 'wire');
const polys = (d: CircuitDoc) => new Map(wires(d).map((w) => [w.id, wirePolyline(d, w)]));
const joined = (d: CircuitDoc) => computeNets(d).filter((n) => n.pins.length > 1).map((n) => n.pins.map((p) => `${p.ref}.${p.port}`).sort().join('+'));

/** Total length of wire drawn over each unit of the x axis on row y (counts overlaps twice). */
function coverage(d: CircuitDoc, y: number, x0: number, x1: number) {
  let n = 0;
  for (const pts of polys(d).values())
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      if (a.y === y && b.y === y) n += Math.max(0, Math.min(x1, Math.max(a.x, b.x)) - Math.max(x0, Math.min(a.x, b.x)));
    }
  return n;
}

describe('crossing selection', () => {
  it('only picks wires where they are drawn, not anywhere in their box', () => {
    const d = docWith([wire('L', F(50, 50), F(200, 200), [{ x: 200, y: 50 }])]);
    const r = { x: 70, y: 120, w: 50, h: 60 }; // inside the L's empty corner
    expect(marqueeHits(d, polys(d), r, true)).toEqual([]);
    expect(marqueeHits(d, polys(d), { x: 190, y: 100, w: 20, h: 20 }, true)).toEqual(['L']);
  });
});

describe('dragging a segment that ends at a junction', () => {
  it('brings the junction along and keeps the other wires attached', () => {
    const base = docWith([
      { id: 'j1', type: 'junction', x: 150, y: 150 },
      wire('wA', F(50, 150), J('j1')),
      wire('wB', J('j1'), F(250, 150)),
      wire('wC', J('j1'), F(150, 60)),
    ]);
    const next = produce(base, (d) => void moveWireSegment(d as CircuitDoc, 'wA', wirePolyline(base, base.items.wA as WireItem), 0, 0, 40, base));
    expect(next.items.j1).toMatchObject({ x: 150, y: 190 });
    expect(wirePolyline(next, next.items.wA as WireItem)).toEqual([{ x: 50, y: 190 }, { x: 150, y: 190 }]);
    for (const id of ['wB', 'wC']) {
      const pts = wirePolyline(next, next.items[id] as WireItem);
      expect(pts[0]).toEqual({ x: 150, y: 190 });
      // still orthogonal
      for (let i = 1; i < pts.length; i++) expect(pts[i].x === pts[i - 1].x || pts[i].y === pts[i - 1].y).toBe(true);
    }
  });
});

describe('parts landing on wires', () => {
  const R = (d: CircuitDoc, x: number, y: number) => {
    const c = makeComponent(d, 'resistor', x, y);
    d.items[c.id] = c;
    return c;
  };

  it('a pin set down on a loose wire end connects to it', () => {
    const prev = docWith([wire('w', F(200, 100), F(260, 100))]);
    const r2 = R(prev, 300, 100);
    const moved = produce(prev, (d) => void Object.assign(d.items[r2.id], { x: 160, y: 100 })); // pins now at x 120 and 200
    const out = settleEdit(prev, moved);
    expect((out.items.w as WireItem).a).toEqual({ kind: 'port', comp: r2.id, port: expect.any(String) });
  });

  it('a part dropped across a wire sits in series instead of being shorted', () => {
    const prev = docWith([wire('w', F(0, 100), F(400, 100))]);
    const r1 = R(prev, 100, 100);
    const r2 = R(prev, 300, 200);
    const moved = produce(prev, (d) => void Object.assign(d.items[r2.id], { y: 100 }));
    const out = settleEdit(prev, moved);
    // the wire now runs 0 → R2 and R2 → 400; nothing left between R2's pins
    expect(coverage(out, 100, 260, 340)).toBe(0);
    const nets = computeNets(out).map((n) => n.pins.length);
    expect(nets.filter((n) => n === 1).length).toBeGreaterThanOrEqual(2);
    expect(r1.id).toBeTruthy();
  });

  it('a wire dragged over a pin does not connect to it', () => {
    const prev = docWith([wire('w', F(0, 50), F(400, 50))]);
    const r = R(prev, 100, 100);
    const next = produce(prev, (d) => void Object.assign(d.items.w, { a: F(0, 100), b: F(400, 100) }));
    const out = settleEdit(prev, next);
    expect(wires(out).every((w) => w.a.kind === 'free' && w.b.kind === 'free')).toBe(true);
    expect(joined(out)).toEqual([]);
    expect(r).toBeTruthy();
  });
});

describe('wires never lie on top of each other', () => {
  it('a wire drawn along another merges into it with junctions', () => {
    const prev = docWith([wire('old', F(0, 100), F(300, 100))]);
    const next = produce(prev, (d) => void (d.items.new = wire('new', F(100, 0), F(200, 0), [{ x: 100, y: 100 }, { x: 200, y: 100 }])));
    const out = settleEdit(prev, next);
    expect(coverage(out, 100, 0, 300)).toBe(300); // drawn once
    const js = Object.values(out.items).filter((i) => i.type === 'junction');
    expect(js.map((j) => (j.type === 'junction' ? `${j.x},${j.y}` : '')).sort()).toEqual(['100,100', '200,100']);
    expect(computeNets(out).filter((n) => n.wires.length).length).toBe(1);
  });

  it('a segment dragged onto a parallel wire merges', () => {
    const prev = docWith([wire('a', F(0, 100), F(300, 100)), wire('b', F(100, 0), F(200, 0), [{ x: 100, y: 60 }, { x: 200, y: 60 }])]);
    const base = wirePolyline(prev, prev.items.b as WireItem);
    const next = produce(prev, (d) => void moveWireSegment(d as CircuitDoc, 'b', base, 1, 0, 40, prev));
    const out = settleEdit(prev, next);
    expect(coverage(out, 100, 0, 300)).toBe(300);
  });

  it('leaves wires that only cross or touch alone', () => {
    const prev = docWith([wire('a', F(0, 100), F(300, 100))]);
    const next = produce(prev, (d) => void (d.items.c = wire('c', F(150, 0), F(150, 200))));
    expect(settleEdit(prev, next)).toBe(next);
  });
});
