import { describe, expect, it } from 'vitest';
import { createDoc, itemBounds, makeShape } from '../model/doc';
import { marqueeHits } from '../model/marquee';
import { flipItems, matchSizes, rotateItems, rotateShapeBy, selectionPivot } from '../model/ops';
import { polyPoints } from '../model/polygon';
import { dragRotation, mapShapeFrame, normDeg, resizeInFrame, rotatedBounds, rotateDeg, setShapeSize, toShapeFrame } from '../model/rotation';
import type { CircuitDoc, Rect, ShapeItem, ShapeKind } from '../model/types';

function withShape(kind: ShapeKind, x: number, y: number, w: number, h: number, extra: Partial<ShapeItem> = {}) {
  const doc = createDoc();
  const s = { ...makeShape(doc, kind, x, y, w, h), ...extra };
  doc.items[s.id] = s;
  return { doc, id: s.id };
}

const shape = (doc: CircuitDoc, id: string) => doc.items[id] as ShapeItem;
const close = (a: Rect, b: Rect) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
  expect(a.w).toBeCloseTo(b.w, 6);
  expect(a.h).toBeCloseTo(b.h, 6);
};

describe('rotation math', () => {
  it('folds angles into [0, 360)', () => {
    expect(normDeg(-90)).toBe(270);
    expect(normDeg(450)).toBe(90);
    expect(normDeg(359.99999)).toBe(0);
  });

  it('turns points clockwise on screen (y down)', () => {
    const p = rotateDeg({ x: 10, y: 0 }, 90);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(10, 9);
  });

  it('bounds a turned box', () => {
    close(rotatedBounds({ x: 0, y: 0, w: 100, h: 40 }, 90), { x: 30, y: -30, w: 40, h: 100 });
    const d = 50 * Math.SQRT2;
    close(rotatedBounds({ x: -50, y: -50, w: 100, h: 100 }, 45), { x: -d, y: -d, w: 2 * d, h: 2 * d });
  });

  it('snaps a handle drag to 15° with a step', () => {
    const c = { x: 0, y: 0 };
    expect(dragRotation(c, { x: 0, y: -10 }, { x: 10, y: 0 }, 0)).toBeCloseTo(90, 6);
    expect(dragRotation(c, { x: 0, y: -10 }, rotateDeg({ x: 0, y: -10 }, 37), 10, 15)).toBe(45);
  });
});

describe('turned shapes', () => {
  it('report the bounds of their turned box', () => {
    const { doc, id } = withShape('rect', 0, 0, 100, 40, { rot: 90 });
    close(itemBounds(doc, shape(doc, id))!, { x: 30, y: -30, w: 40, h: 100 });
  });

  it('hit-test in their own frame', () => {
    const { doc, id } = withShape('rect', 0, 0, 100, 20, { rot: 45 });
    const s = shape(doc, id);
    // a point along the turned long axis lies inside the box once taken back to its frame
    const q = toShapeFrame(s, rotateDeg({ x: 95, y: 10 }, 45, { x: 50, y: 10 }));
    expect(q.x).toBeCloseTo(95, 6);
    expect(q.y).toBeCloseTo(10, 6);
  });

  it('are picked by a crossing marquee only where they are drawn', () => {
    const { doc, id } = withShape('rect', 0, 0, 100, 10, { rot: 45 });
    // inside the turned box's bounding square, but off the thin turned bar
    expect(marqueeHits(doc, new Map(), { x: 20, y: 30, w: 4, h: 4 }, true)).not.toContain(id);
    expect(marqueeHits(doc, new Map(), { x: 48, y: 3, w: 4, h: 4 }, true)).toContain(id);
  });
});

describe('resize in a turned frame', () => {
  it('matches a plain resize when not turned', () => {
    expect(resizeInFrame({ x: 0, y: 0, w: 100, h: 50 }, 0, 'se', { x: 120, y: 80 }, 10)).toEqual({ x: 0, y: 0, w: 120, h: 80 });
  });

  it('keeps the opposite corner fixed on screen', () => {
    const b = { x: 0, y: 0, w: 100, h: 50 };
    const rot = 30;
    const corner = (r: Rect, which: 'nw' | 'se') => rotateDeg(which === 'nw' ? { x: r.x, y: r.y } : { x: r.x + r.w, y: r.y + r.h }, rot, { x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const nw = corner(b, 'nw');
    // drag the se corner to where (150, 70) of the shape's own frame lands
    const p = rotateDeg({ x: 150, y: 70 }, rot, { x: 50, y: 25 });
    const out = resizeInFrame(b, rot, 'se', p, 10);
    expect(out.w).toBeCloseTo(150, 6);
    expect(out.h).toBeCloseTo(70, 6);
    const nw2 = corner(out, 'nw');
    expect(nw2.x).toBeCloseTo(nw.x, 6);
    expect(nw2.y).toBeCloseTo(nw.y, 6);
  });
});

describe('rotate commands on shapes', () => {
  it('turn a lone boxy shape about its centre', () => {
    const { doc, id } = withShape('rect', 0, 0, 100, 40);
    rotateItems(doc, new Set([id]), 90);
    const s = shape(doc, id);
    expect(s.rot).toBe(90);
    expect({ x: s.x, y: s.y, w: s.w, h: s.h }).toEqual({ x: 0, y: 0, w: 100, h: 40 });
    rotateItems(doc, new Set([id]), -90);
    expect(shape(doc, id).rot).toBeUndefined();
  });

  it('move the centre about the selection pivot and add to rot', () => {
    const { doc, id } = withShape('ellipse', 0, 0, 40, 20, { rot: 30 });
    const other = { ...makeShape(doc, 'rect', 200, 0, 40, 20) };
    doc.items[other.id] = other;
    const piv = selectionPivot(doc, [id, other.id]);
    rotateItems(doc, new Set([id, other.id]), 90);
    const s = shape(doc, id);
    expect(s.rot).toBeCloseTo(120, 6);
    expect(s.w).toBeCloseTo(40, 6);
    // the ellipse's centre (20, 10) swings a quarter turn about the pivot
    expect(s.x + s.w / 2).toBeCloseTo(piv.x - (10 - piv.y), 6);
    expect(s.y + s.h / 2).toBeCloseTo(piv.y + (20 - piv.x), 6);
  });

  it('bake a turn into polygon points', () => {
    const { doc, id } = withShape('polygon', 0, 0, 100, 100, { poly: [0, 0, 1, 0, 1, 1] });
    const base = structuredClone(doc);
    rotateShapeBy(base, doc, id, 90, { x: 50, y: 50 });
    const s = shape(doc, id);
    expect(s.rot).toBeUndefined();
    const pts = polyPoints(s).map((p) => ({ x: Math.round(p.x) + 0, y: Math.round(p.y) + 0 }));
    expect(pts).toEqual([
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ]);
  });

  it('turn by any angle from the handle', () => {
    const { doc, id } = withShape('image', 0, 0, 80, 40, { rot: 10 });
    const base = structuredClone(doc);
    rotateShapeBy(base, doc, id, 25, { x: 40, y: 20 });
    const s = shape(doc, id);
    expect(s.rot).toBeCloseTo(35, 6);
    expect(s.x).toBeCloseTo(0, 6);
    expect(s.w).toBeCloseTo(80, 6);
  });

  it('flip mirrors the turn and keeps text upright', () => {
    for (const axis of ['x', 'y'] as const) {
      const { doc, id } = withShape('rect', 0, 0, 100, 40, { rot: 30 });
      flipItems(doc, new Set([id]), axis);
      expect(shape(doc, id).rot).toBeCloseTo(330, 6);
    }
  });

  it('frame mapping is exact for plain moves', () => {
    const { doc, id } = withShape('rect', 0.1, 0.2, 10, 10);
    const f = mapShapeFrame(shape(doc, id), (p) => ({ x: p.x + 0.7, y: p.y }));
    expect([f.x, f.y, f.rot]).toEqual([0.1 + 0.7, 0.2, 0]);
  });
});

describe('make same size', () => {
  it('matches width, height or both to the first selected shape', () => {
    const doc = createDoc();
    const a = makeShape(doc, 'rect', 0, 0, 120, 60);
    const b = makeShape(doc, 'ellipse', 200, 0, 40, 30);
    const c = makeShape(doc, 'line', 0, 200, -50, 20);
    for (const s of [a, b, c]) doc.items[s.id] = s;
    matchSizes(doc, [a.id, b.id, c.id], 'width');
    expect([shape(doc, b.id).w, shape(doc, b.id).h]).toEqual([120, 30]);
    // a line keeps its direction
    expect([shape(doc, c.id).w, shape(doc, c.id).h]).toEqual([-120, 20]);
    matchSizes(doc, [a.id, b.id], 'height');
    expect([shape(doc, b.id).w, shape(doc, b.id).h]).toEqual([120, 60]);
    expect(shape(doc, b.id).x).toBe(200);
  });

  it('keeps a turned shape centred and skips text', () => {
    const doc = createDoc();
    const a = makeShape(doc, 'rect', 0, 0, 100, 100);
    const b = { ...makeShape(doc, 'rect', 200, 200, 20, 40), rot: 45 };
    const t = makeShape(doc, 'text', 0, 300, 10, 10);
    for (const s of [a, b, t]) doc.items[s.id] = s;
    expect(matchSizes(doc, [a.id, b.id, t.id], 'both')).toBe(1);
    const s = shape(doc, b.id);
    expect({ x: s.x, y: s.y, w: s.w, h: s.h }).toEqual({ x: 160, y: 170, w: 100, h: 100 });
  });
});

describe('sizing a turned shape', () => {
  it('keeps the centre fixed when the size is typed in', () => {
    const doc = createDoc();
    const s = Object.assign(makeShape(doc, 'rect', 100, 100, 80, 40), { rot: 30 });
    setShapeSize(s, { w: 120 });
    expect(s.x + s.w / 2).toBe(140);
    expect(s.y + s.h / 2).toBe(120);
    setShapeSize(s, { h: 100 });
    expect(s.y + s.h / 2).toBe(120);
    const flat = makeShape(doc, 'rect', 100, 100, 80, 40);
    setShapeSize(flat, { w: 120 });
    expect(flat.x).toBe(100);
  });

  it('snaps the dragged edge to the grid in its own frame', () => {
    const b = { x: 0, y: 0, w: 100, h: 50 };
    // east handle dragged to a point whose local x is about 133 -> 130 on a 10 grid
    const p = rotateDeg({ x: 133, y: 25 }, 30, { x: 50, y: 25 });
    const r = resizeInFrame(b, 30, 'e', p, 10, 10);
    expect(r.w).toBeCloseTo(130, 6);
    expect(r.h).toBeCloseTo(50, 6);
  });
});
