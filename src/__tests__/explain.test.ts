import { describe, expect, it } from 'vitest';
import { calloutAnchor, calloutLayout, makeAnchor, nextStep } from '../model/callout';
import { createDoc, itemBounds, makeShape } from '../model/doc';
import { inkHit, inkOutline, inkPoints, packInk, recognizeInk, type InkPoint } from '../model/ink';
import type { Net } from '../model/netlist';
import { netFlow, splitAt } from '../model/trace';
import type { ShapeItem } from '../model/types';

const P = (x: number, y: number): InkPoint => ({ x, y, p: 0.5 });

describe('ink', () => {
  it('packs points into a box and unpacks them unchanged', () => {
    const pts = [P(10, 20), P(30, 25), P(50, 60)];
    const packed = packInk(pts);
    expect(packed).toMatchObject({ x: 10, y: 20, w: 40, h: 40 });
    const back = inkPoints(packed);
    back.forEach((q, i) => {
      expect(q.x).toBeCloseTo(pts[i].x, 3);
      expect(q.y).toBeCloseTo(pts[i].y, 3);
    });
  });

  it('follows its box when moved or resized', () => {
    const packed = { ...packInk([P(0, 0), P(10, 10)]), x: 100, w: 20 };
    expect(inkPoints(packed)[1]).toMatchObject({ x: 120, y: 10 });
  });

  it('hit-tests along the stroke', () => {
    const doc = createDoc();
    const s = Object.assign(makeShape(doc, 'ink', 0, 0, 1, 1), packInk([P(0, 0), P(100, 0)]), { strokeWidth: 4 }) as ShapeItem;
    expect(inkHit(s, { x: 50, y: 3 }, 2)).toBe(true);
    expect(inkHit(s, { x: 50, y: 20 }, 2)).toBe(false);
    expect(itemBounds(doc, s)!.h).toBeGreaterThan(1);
  });

  it('builds a closed outline path', () => {
    const d = inkOutline([P(0, 0), P(10, 5), P(20, 0)], 4);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(d).not.toContain('NaN');
  });

  it('snaps an open scribble to a line and a loop to an ellipse or a box', () => {
    const wobbly = Array.from({ length: 20 }, (_, i) => P(i * 10, Math.sin(i) * 3));
    expect(recognizeInk(wobbly)?.kind).toBe('line');
    const loop = Array.from({ length: 41 }, (_, i) => P(50 + 50 * Math.cos((i / 40) * Math.PI * 2), 30 + 30 * Math.sin((i / 40) * Math.PI * 2)));
    expect(recognizeInk(loop)?.kind).toBe('ellipse');
    const box: InkPoint[] = [];
    for (let i = 0; i <= 10; i++) box.push(P(i * 10, 0));
    for (let i = 0; i <= 10; i++) box.push(P(100, i * 6));
    for (let i = 10; i >= 0; i--) box.push(P(i * 10, 60));
    for (let i = 10; i >= 0; i--) box.push(P(1, i * 6));
    expect(recognizeInk(box)?.kind).toBe('rect');
  });
});

describe('callouts', () => {
  it('sizes to the note and numbers steps in order', () => {
    const doc = createDoc();
    const a = makeShape(doc, 'callout', 0, 0, 24, 24);
    a.step = 1;
    doc.items[a.id] = a;
    expect(calloutLayout(a).card).toBeNull();
    expect(calloutLayout({ ...a, text: 'Charges C1' }).box.w).toBeGreaterThan(40);
    expect(nextStep(doc)).toBe(2);
  });

  it('keeps its leader on the part it points at', () => {
    const doc = createDoc();
    doc.items.j1 = { id: 'j1', type: 'junction', x: 200, y: 200 };
    const c = makeShape(doc, 'callout', 0, 0, 24, 24);
    c.anchor = makeAnchor(doc, doc.items.j1, { x: 200, y: 200 });
    doc.items[c.id] = c;
    expect(calloutAnchor(doc, c)).toEqual({ x: 200, y: 200 });
    (doc.items.j1 as { x: number }).x = 260;
    expect(calloutAnchor(doc, c)).toEqual({ x: 260, y: 200 });
  });
});

describe('trace flow', () => {
  it('orients every wire away from the click, nearest first', () => {
    const doc = createDoc();
    const polys = new Map([
      ['w1', [{ x: 0, y: 0 }, { x: 100, y: 0 }]],
      // drawn "backwards": from its far end to the shared node
      ['w2', [{ x: 100, y: 100 }, { x: 100, y: 0 }]],
    ]);
    const net: Net = { name: 'n', names: [], wires: ['w1', 'w2'], pins: [] };
    const f = netFlow(doc, net, polys, { x: 0, y: 0 });
    const w2 = f.wires.find((w) => w.id === 'w2')!;
    expect(w2.pts[0]).toEqual({ x: 100, y: 0 });
    expect(w2.start).toBeCloseTo(100);
    expect(f.reach).toBeCloseTo(200);
  });

  it('splits the clicked wire so the signal spreads both ways', () => {
    const [back, fwd] = splitAt([{ x: 0, y: 0 }, { x: 100, y: 0 }], { x: 40, y: 2 })!;
    expect(back).toEqual([{ x: 40, y: 0 }, { x: 0, y: 0 }]);
    expect(fwd).toEqual([{ x: 40, y: 0 }, { x: 100, y: 0 }]);
  });
});
