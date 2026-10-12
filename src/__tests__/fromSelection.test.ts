import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, makeShape, uid } from '../model/doc';
import { replaceWithInstance, selectionToDrawing, type SelectionDrawing } from '../model/fromSelection';
import { BUILTIN } from '../model/symbols';
import { compileSource } from '../model/symbols/dsl';
import type { CircuitDoc, SymbolDef, WireItem } from '../model/types';
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

  it('bakes an arrow with both heads into a line plus two head polys', () => {
    let id = '';
    const doc = produce(createDoc(), (d) => {
      const s = makeShape(d as CircuitDoc, 'arrow', 100, 100, 60, 0);
      s.strokeWidth = 2;
      s.headStart = 'filled';
      s.headEnd = 'filled';
      d.items[s.id] = s;
      id = s.id;
    });
    const drawing = selectionToDrawing(doc, [id])!;
    expect(drawing.origin).toEqual({ x: 100, y: 100 });
    expect(drawing.w % 20).toBe(0);
    expect(drawing.h % 20).toBe(0);
    expect(drawing.prims.length).toBe(3);
    const [line, headEnd, headStart] = drawing.prims;
    expect(line).toEqual({ t: 'line', pts: [0, 0, 60, 0], w: 2 });
    // head size defaults to 4 + strokeWidth * 3 = 10, barbs 10 * 0.45 wide
    expect(headEnd).toEqual({ t: 'poly', pts: [60, 0, 50, 4.5, 50, -4.5], fill: 'solid' });
    expect(headStart).toEqual({ t: 'poly', pts: [0, 0, 10, -4.5, 10, 4.5], fill: 'solid' });
  });

  it('swaps ellipse rx/ry when the component is rotated 90 degrees', () => {
    const def: SymbolDef = {
      id: 'test-ellipse',
      name: 'Ellipse',
      category: 'test',
      w: 60,
      h: 20,
      prims: [{ t: 'ellipse', cx: 30, cy: 10, rx: 20, ry: 5, fill: 'none' }],
      ports: [],
      prefix: 'U',
    };
    let flat = '';
    let rotated = '';
    const doc = produce(createDoc(), (d) => {
      (d as CircuitDoc).symbols[def.id] = def;
      const a = makeComponent(d as CircuitDoc, def.id, 100, 100, 0);
      const b = makeComponent(d as CircuitDoc, def.id, 200, 100, 90);
      d.items[a.id] = a;
      d.items[b.id] = b;
      flat = a.id;
      rotated = b.id;
    });
    const plain = selectionToDrawing(doc, [flat])!;
    expect(plain.prims).toEqual([{ t: 'ellipse', cx: 30, cy: 10, rx: 20, ry: 5, fill: 'none' }]);
    const turned = selectionToDrawing(doc, [rotated])!;
    // centre maps to the middle of the 20x60 box, radii swap for the vertical rotation
    expect(turned.prims).toEqual([{ t: 'ellipse', cx: 10, cy: 30, rx: 5, ry: 20, fill: 'none' }]);
  });

  it('drops a path prim containing an unsupported command but keeps the rest', () => {
    const def: SymbolDef = {
      id: 'test-path',
      name: 'Paths',
      category: 'test',
      w: 40,
      h: 40,
      prims: [
        { t: 'path', d: 'M 0 0 L 10 0', fill: 'none' },
        { t: 'path', d: 'M 0 0 A 5 5 0 0 0 10 0', fill: 'none' },
      ],
      ports: [],
      prefix: 'U',
    };
    let cid = '';
    const doc = produce(createDoc(), (d) => {
      (d as CircuitDoc).symbols[def.id] = def;
      const c = makeComponent(d as CircuitDoc, def.id, 100, 100, 0);
      d.items[c.id] = c;
      cid = c.id;
    });
    const drawing = selectionToDrawing(doc, [cid])!;
    const paths = drawing.prims.filter((p) => p.t === 'path');
    expect(paths.length).toBe(1);
    expect(paths[0].t === 'path' && paths[0].d).toBe('M 0 0 L 10 0');
  });

  it('keeps shapes on fractional positions inside the rounded box', () => {
    let rectId = '';
    let ellipseId = '';
    const doc = produce(createDoc(), (d) => {
      const s = makeShape(d as CircuitDoc, 'rect', 103.3, 107.7, 33.3, 21.2);
      const e = makeShape(d as CircuitDoc, 'ellipse', 150.6, 112.4, 27.8, 18.9);
      d.items[s.id] = s;
      d.items[e.id] = e;
      rectId = s.id;
      ellipseId = e.id;
    });
    const drawing = selectionToDrawing(doc, [rectId, ellipseId])!;
    expect(drawing.origin.x % 10).toBe(0);
    expect(drawing.origin.y % 10).toBe(0);
    expect(drawing.w % 20).toBe(0);
    expect(drawing.h % 20).toBe(0);
    expectInsideBox(drawing);
  });

  it('emits text lines for shapes and skips blank lines', () => {
    let rectId = '';
    let textId = '';
    const doc = produce(createDoc(), (d) => {
      const s = makeShape(d as CircuitDoc, 'rect', 100, 100, 60, 40);
      s.text = 'hello';
      s.fontSize = 16;
      d.items[s.id] = s;
      const t = makeShape(d as CircuitDoc, 'text', 200, 100, 0, 0);
      t.text = 'one\n\n  \ntwo';
      t.fontSize = 16;
      d.items[t.id] = t;
      rectId = s.id;
      textId = t.id;
    });
    const drawing = selectionToDrawing(doc, [rectId, textId])!;
    const texts = drawing.prims.filter((p) => p.t === 'text');
    expect(texts.map((p) => p.t === 'text' && p.text)).toEqual(['hello', 'one', 'two']);
    // rect titles are capped at size 14; blank lines take up space but emit nothing
    expect(texts.map((p) => p.t === 'text' && p.size)).toEqual([14, 16, 16]);
    expect(texts.map((p) => p.t === 'text' && [p.x, p.y])).toEqual([
      [8, 16],
      [100, 16],
      [100, 78.5],
    ]);
  });
});

/** Every emitted coordinate lies inside the declared [0, w] x [0, h] box. */
function expectInsideBox(drawing: SelectionDrawing) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of drawing.prims) {
    if (p.t === 'line' || p.t === 'poly') {
      for (let i = 0; i < p.pts.length; i += 2) {
        xs.push(p.pts[i]);
        ys.push(p.pts[i + 1]);
      }
    } else if (p.t === 'rect') {
      xs.push(p.x, p.x + p.w);
      ys.push(p.y, p.y + p.h);
    } else if (p.t === 'circle') {
      xs.push(p.cx - p.r, p.cx + p.r);
      ys.push(p.cy - p.r, p.cy + p.r);
    } else if (p.t === 'ellipse') {
      xs.push(p.cx - p.rx, p.cx + p.rx);
      ys.push(p.cy - p.ry, p.cy + p.ry);
    } else if (p.t === 'text') {
      xs.push(p.x);
      ys.push(p.y);
    }
  }
  expect(xs.length).toBeGreaterThan(0);
  for (const x of xs) {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(drawing.w);
  }
  for (const y of ys) {
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(drawing.h);
  }
}
