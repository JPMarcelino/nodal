import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent } from '../model/doc';
import { cleanup, translateItems } from '../model/ops';
import { refreshTouching, touchingCells, touchingFromCells } from '../model/netlist';
import { settleEdit } from '../model/settle';
import type { CircuitDoc, Endpoint, WireItem } from '../model/types';
import { moveWireSegment } from '../model/wireCommit';
import { wirePolyline } from '../model/wires';

/** Directions the wire ends at each junction leave in. */
function junctionDirs(d: CircuitDoc): string[][] {
  const out: string[][] = [];
  for (const j of Object.values(d.items)) {
    if (j.type !== 'junction') continue;
    const ds: string[] = [];
    for (const w of Object.values(d.items)) {
      if (w.type !== 'wire') continue;
      const f = wirePolyline(d, w);
      const at = (ep: Endpoint) => ep.kind === 'junction' && ep.id === j.id;
      if (at(w.a)) ds.push(`${Math.sign(f[1].x - f[0].x)},${Math.sign(f[1].y - f[0].y)}`);
      if (at(w.b)) ds.push(`${Math.sign(f[f.length - 2].x - f[f.length - 1].x)},${Math.sign(f[f.length - 2].y - f[f.length - 1].y)}`);
    }
    out.push(ds);
  }
  return out;
}

describe('no solder dot where wires only run on top of each other', () => {
  it('re-checks the wire an overlap was joined to', () => {
    let d = createDoc();
    const c1 = makeComponent(d, 'capacitor', 160, 40);
    c1.rot = 90;
    const c2 = makeComponent(d, 'capacitor', 120, 80);
    c2.rot = 90;
    d.items[c1.id] = c1;
    d.items[c2.id] = c2;
    const wire = (id: string, a: Endpoint, pts: { x: number; y: number }[], b: Endpoint): WireItem => ({ id, type: 'wire', a, b, pts });
    d.items.o = wire('o', { kind: 'port', comp: c1.id, port: '1' }, [{ x: 140, y: 20 }, { x: 140, y: 40 }, { x: 120, y: 40 }], { kind: 'port', comp: c2.id, port: '1' });
    d.items.x = wire('x', { kind: 'free', x: 140, y: 20 }, [{ x: 140, y: 100 }], { kind: 'port', comp: c2.id, port: '2' });
    d.items.w = wire('w', { kind: 'port', comp: c1.id, port: '1' }, [], { kind: 'free', x: 160, y: 160 });
    const prev = d;
    const next = produce(prev, (draft) => {
      moveWireSegment(draft as CircuitDoc, 'w', wirePolyline(prev, prev.items.w as WireItem), 0, -20, 0, prev);
    });
    d = produce(settleEdit(prev, next), (draft) => cleanup(draft as CircuitDoc));
    for (const ds of junctionDirs(d)) {
      // every branch at a dot leaves in its own direction (two the same = wires drawn over each other)
      expect(new Set(ds).size).toBe(ds.length);
    }
  });
});

describe('refreshTouching', () => {
  it('matches a full recount when a pin moves from one changed cell to another', () => {
    const steps = [-80, -40, -20, 0, 20, 40, 80];
    for (const rot of [0, 90] as const) {
      for (const sx of steps) {
        for (const sy of steps) {
          const d = createDoc();
          const a = makeComponent(d, 'resistor', 100, 100);
          const b = makeComponent(d, 'resistor', 100 + sx, 100 + sy);
          b.rot = rot;
          d.items[a.id] = a;
          d.items[b.id] = b;
          const cells = touchingCells(d);
          for (const dx of steps) {
            for (const dy of steps) {
              const next = produce(d, (draft) => translateItems(d, draft as CircuitDoc, new Set([b.id]), dx, dy));
              const inc = refreshTouching(d, cells, touchingFromCells(cells), next, new Set([b.id]));
              expect([...inc.touching].sort(), `${rot} ${sx},${sy} by ${dx},${dy}`).toEqual([...touchingFromCells(touchingCells(next))].sort());
            }
          }
        }
      }
    }
  });
});
