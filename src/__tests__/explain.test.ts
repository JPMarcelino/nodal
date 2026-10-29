import { describe, expect, it } from 'vitest';
import { CALLOUT_AUTO_WRAP, calloutAnchor, calloutLayout, makeAnchor, nextStep } from '../model/callout';
import { createDoc, itemBounds, makeComponent, makeShape } from '../model/doc';
import { inkAverageWidth, inkHit, inkOutline, inkPoints, inkShapePath, packInk, recognizeInk, recognizeShape, shapeCentre, shapePoints, type InkPoint } from '../model/ink';
import { deleteItems, extractFragment, insertFragment } from '../model/ops';
import type { Net } from '../model/netlist';
import { netFlow, splitAt } from '../model/trace';
import type { ComponentItem, ShapeItem } from '../model/types';

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

  it('remaps a callout anchor to the copied part when pasted together', () => {
    const doc = createDoc();
    const r = makeComponent(doc, 'resistor', 100, 100);
    doc.items[r.id] = r;
    const c = makeShape(doc, 'callout', 0, 0, 24, 24);
    c.anchor = makeAnchor(doc, r, { x: 100, y: 100 });
    doc.items[c.id] = c;
    const frag = extractFragment(doc, new Set([r.id, c.id]));
    const ids = insertFragment(doc, frag, 50, 60);
    expect(ids).toHaveLength(2);
    const pasted = ids.map((id) => doc.items[id]);
    const pc = pasted.find((i) => i.type === 'shape') as ShapeItem;
    const pr = pasted.find((i) => i.type === 'component') as ComponentItem;
    expect(pc.anchor?.id).toBe(pr.id);
    expect(pc.anchor).toMatchObject({ x: 150, y: 160 });
    expect({ x: pc.x, y: pc.y }).toEqual({ x: 50, y: 60 });
    pr.x += 10;
    expect(calloutAnchor(doc, pc)).toEqual({ x: 160, y: 160 });
    expect(calloutAnchor(doc, doc.items[c.id] as ShapeItem)).toEqual({ x: 100, y: 100 });
  });

  it('offsets a callout anchor fallback when pasted without its target', () => {
    const src = createDoc();
    const r = makeComponent(src, 'resistor', 100, 100);
    src.items[r.id] = r;
    const c = makeShape(src, 'callout', 0, 0, 24, 24);
    c.anchor = makeAnchor(src, r, { x: 100, y: 100 });
    src.items[c.id] = c;
    const frag = extractFragment(src, new Set([c.id]));
    const dst = createDoc();
    const ids = insertFragment(dst, frag, 50, 60);
    const pc = dst.items[ids[0]] as ShapeItem;
    expect(calloutAnchor(dst, pc)).toEqual({ x: 150, y: 160 });
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

describe('snapped ink', () => {
  const loop = (cx: number, cy: number, rx: number, ry: number, n = 60, p = 0.5): InkPoint[] =>
    Array.from({ length: n + 1 }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return { x: cx + rx * Math.cos(a) + Math.sin(i * 1.7) * 2, y: cy + ry * Math.sin(a), p };
    });

  it('keeps the weight the stroke was drawn with', () => {
    // a stylus pressing lightly draws thinner than its size; the snapped shape keeps that
    const light = inkAverageWidth(loop(0, 0, 80, 50, 60, 0.2), 4);
    const firm = inkAverageWidth(loop(0, 0, 80, 50, 60, 0.9), 4);
    expect(light).toBeLessThan(firm);
    expect(light).toBeGreaterThan(4 * 0.45 - 1e-9);
    expect(firm).toBeLessThanOrEqual(4 * 1.25);
  });

  it('scales, turns and squares up a recognised shape about its centre', () => {
    const sp = recognizeShape(loop(100, 100, 80, 40))!;
    expect(sp.kind).toBe('ellipse');
    const c = shapeCentre(sp);
    const far = (pts: InkPoint[]) => Math.max(...pts.map((q) => Math.hypot(q.x - c.x, q.y - c.y)));
    expect(far(shapePoints(sp, { scale: 2 }))).toBeCloseTo(far(shapePoints(sp)) * 2, 0);
    // a perfect circle: every point the same distance from the centre
    const circle = shapePoints(sp, { perfect: true, rot: 0.3 });
    const r = circle.map((q) => Math.hypot(q.x - c.x, q.y - c.y));
    expect(Math.max(...r) - Math.min(...r)).toBeLessThan(0.01);
    // a closed shape ends where it starts, so its stroke has no seam
    expect(circle[0].x).toBeCloseTo(circle[circle.length - 1].x, 6);
    expect(inkShapePath(circle, 'ellipse').endsWith('Z')).toBe(true);
  });

  it('draws a snapped shape as an even stroke, a scribble as a tapered outline', () => {
    expect(inkOutline([P(0, 0), P(100, 0)], 4, { uniform: true })).toMatch(/A2,2/);
  });
});

describe('callout notes', () => {
  it('puts the note on the side away from what it points at', () => {
    const doc = createDoc();
    const c = makeShape(doc, 'callout', 100, 100, 24, 24);
    c.text = 'Note';
    const right = calloutLayout(c, { x: 300, y: 110 }).card!;
    const left = calloutLayout(c, { x: 0, y: 110 }).card!;
    expect(right.x + right.w).toBeLessThanOrEqual(c.x);
    expect(left.x).toBeGreaterThanOrEqual(c.x + 24);
  });

  it('wraps long notes, at their own width when they have one', () => {
    const doc = createDoc();
    const c = makeShape(doc, 'callout', 0, 0, 24, 24);
    c.text = 'Limits the LED current to about fifteen milliamps so that it does not burn out';
    const auto = calloutLayout(c).card!;
    expect(auto.text).toContain('\n');
    expect(auto.w).toBeLessThanOrEqual(CALLOUT_AUTO_WRAP + 22);
    const narrow = calloutLayout({ ...c, wrapW: 120 }).card!;
    expect(narrow.w).toBe(142);
    expect(narrow.h).toBeGreaterThan(auto.h);
  });

  it('keeps pointing where its part was when the part is deleted', () => {
    const doc = createDoc();
    const r = makeComponent(doc, 'resistor', 200, 200);
    doc.items[r.id] = r;
    const c = makeShape(doc, 'callout', 0, 0, 24, 24);
    c.anchor = makeAnchor(doc, r, { x: 210, y: 205 });
    doc.items[c.id] = c;
    r.x = 400; // the part moved after the note was made
    const was = calloutAnchor(doc, c)!;
    deleteItems(doc, [r.id]);
    expect(calloutAnchor(doc, doc.items[c.id] as ShapeItem)).toEqual(was);
  });
});
