import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, uid } from '../model/doc';
import { replaceWithInstance, selectionToDrawing } from '../model/fromSelection';
import { BUILTIN } from '../model/symbols';
import { compileSource } from '../model/symbols/dsl';
import type { CircuitDoc, WireItem } from '../model/types';
import { portPosition } from '../model/wires';

const RESISTOR_PRIMS = BUILTIN.resistor.prims.length;

/** Two resistors in series, rotated differently, with a lead wire running off to the right. */
function circuit() {
  let r1 = '';
  let r2 = '';
  let inner = '';
  let lead = '';
  const doc = produce(createDoc(), (d) => {
    const a = makeComponent(d as CircuitDoc, 'resistor', 100, 100);
    const b = makeComponent(d as CircuitDoc, 'resistor', 200, 140, 90);
    d.items[a.id] = a;
    d.items[b.id] = b;
    r1 = a.id;
    r2 = b.id;
    const w1: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: a.id, port: '2' }, b: { kind: 'port', comp: b.id, port: '1' }, pts: [] };
    const w2: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: b.id, port: '2' }, b: { kind: 'free', x: 320, y: 180 }, pts: [] };
    d.items[w1.id] = w1;
    d.items[w2.id] = w2;
    inner = w1.id;
    lead = w2.id;
  });
  return { doc, r1, r2, inner, lead };
}

describe('create symbol from selection', () => {
  it('draws the selection on a grid-sized box anchored at its top-left', () => {
    const { doc, r1, r2, inner } = circuit();
    const drawing = selectionToDrawing(doc, [r1, r2, inner])!;
    expect(drawing.w % 20).toBe(0);
    expect(drawing.h % 20).toBe(0);
    expect(drawing.origin.x % 10).toBe(0);
    expect(drawing.origin.y % 10).toBe(0);
    // every prim of both resistors, plus the connecting wire
    expect(drawing.prims.length).toBe(2 * RESISTOR_PRIMS + 1);
    // everything lies inside the box
    for (const p of drawing.prims) {
      if (p.t !== 'line' && p.t !== 'poly') continue;
      for (let i = 0; i < p.pts.length; i += 2) {
        expect(p.pts[i]).toBeGreaterThanOrEqual(0);
        expect(p.pts[i]).toBeLessThanOrEqual(drawing.w);
        expect(p.pts[i + 1]).toBeGreaterThanOrEqual(0);
        expect(p.pts[i + 1]).toBeLessThanOrEqual(drawing.h);
      }
    }
  });

  it('replaces the selection with one instance and reconnects wires that end on a pin', () => {
    const { doc, r1, r2, inner, lead } = circuit();
    const ids = [r1, r2, inner];
    const drawing = selectionToDrawing(doc, ids)!;
    // a pin exactly where the outside lead wire meets the selection
    const pinAt = portPosition(doc, doc.items[r2] as never, '2')!.pt;
    const px = pinAt.x - drawing.origin.x;
    const py = pinAt.y - drawing.origin.y;
    const w = Math.max(drawing.w, px);
    const h = Math.max(drawing.h, py);
    const def = compileSource({ id: 'user-pair', name: 'Pair', category: 'My symbols', w, h, draw: 'L 0 0 10 0', ports: `OUT:${px},${py}`, prefix: 'U', value: '', fields: '', keywords: '' });

    let placed = '';
    const next = produce(doc, (d) => {
      placed = replaceWithInstance(d as CircuitDoc, ids, def, drawing.origin);
    });
    for (const id of ids) expect(next.items[id]).toBeUndefined();
    const comp = next.items[placed];
    expect(comp?.type === 'component' && comp.symbol).toBe('user-pair');
    expect(next.symbols['user-pair']).toBeTruthy();
    const wire = next.items[lead] as WireItem;
    const ends = [wire.a, wire.b];
    expect(ends).toContainEqual({ kind: 'port', comp: placed, port: 'OUT' });
    // and the pin lands exactly where the old connection was
    expect(portPosition(next, comp as never, 'OUT')!.pt).toEqual(pinAt);
  });
});
