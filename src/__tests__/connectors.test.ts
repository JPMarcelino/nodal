import { describe, expect, it } from 'vitest';
import { attachSpots, connectorD, curveThrough, elbowHop, findGlue, resolveConnector, settleConnectors } from '../model/connectors';
import { createDoc, itemBounds, makeComponent, makeShape } from '../model/doc';
import { deleteItems, extractFragment, flipItems, insertFragment, rotateShapeBy, translateDetached, translateItems } from '../model/ops';
import { BUILTIN_SYMBOLS } from '../model/symbols';
import type { CircuitDoc, Point, ShapeItem, ShapeKind } from '../model/types';

const near = (p: Point, q: Point, digits = 6) => {
  expect(p.x).toBeCloseTo(q.x, digits);
  expect(p.y).toBeCloseTo(q.y, digits);
};

function add(doc: CircuitDoc, kind: ShapeKind, x: number, y: number, w: number, h: number, extra: Partial<ShapeItem> = {}): ShapeItem {
  const s = { ...makeShape(doc, kind, x, y, w, h), ...extra };
  doc.items[s.id] = s;
  return s;
}

/** Two boxes side by side and an arrow between them, start pinned to A's right side, end floating on B. */
function twoBoxes(route?: ShapeItem['route']) {
  const doc = createDoc();
  const a = add(doc, 'rect', 0, 0, 100, 60);
  const b = add(doc, 'rect', 300, 0, 100, 60);
  const c = add(doc, 'arrow', 0, 0, 10, 10, { from: { id: a.id, fx: 1, fy: 0.5 }, to: { id: b.id }, route });
  return { doc, a, b, c };
}

describe('resolving glued ends', () => {
  it('pins a fixed end to its spot on a turned rectangle', () => {
    const doc = createDoc();
    const r = add(doc, 'rect', 0, 0, 100, 40, { rot: 90 });
    const c = add(doc, 'line', 0, 0, 0, 0, { from: { id: r.id, fx: 1, fy: 0.5 } });
    // centre (50, 20); the right side's middle turned a quarter clockwise lands below the centre
    near(resolveConnector(doc, c).start, { x: 50, y: 70 });
  });

  it('floats an end round a turned rectangle toward the next point', () => {
    const doc = createDoc();
    const r = add(doc, 'rect', -50, -20, 100, 40, { rot: 90 });
    const c = add(doc, 'line', 0, 0, 0, 200, { from: { id: r.id } });
    // turned upright the box is 40 wide and 100 tall: heading straight down it leaves at y = 50
    near(resolveConnector(doc, c).start, { x: 0, y: 50 });
  });

  it('floats an end round an ellipse', () => {
    const doc = createDoc();
    const e = add(doc, 'ellipse', -50, -25, 100, 50);
    const c = add(doc, 'line', 0, 0, 100, 100, { from: { id: e.id } });
    const p = resolveConnector(doc, c).start;
    // on the outline, along the diagonal toward (100, 100)
    expect((p.x / 50) ** 2 + (p.y / 25) ** 2).toBeCloseTo(1, 6);
    expect(p.x).toBeCloseTo(p.y, 6);
  });

  it('pins to a part pin through its turn', () => {
    const doc = createDoc();
    const sym = BUILTIN_SYMBOLS.find((d) => d.ports.length === 2)!;
    const part = makeComponent(doc, sym.id, 200, 200, 90);
    doc.items[part.id] = part;
    const pin = attachSpots(doc, part)[0];
    const c = add(doc, 'line', 0, 0, 10, 10, { to: { id: part.id, fx: pin.fx, fy: pin.fy } });
    near(resolveConnector(doc, c).end, pin.pt);
  });

  it('finds the connection point or the outline under the pointer', () => {
    const { doc, a } = twoBoxes();
    expect(findGlue(doc, { x: 101, y: 31 }, 5)?.attach).toEqual({ id: a.id, fx: 1, fy: 0.5 });
    expect(findGlue(doc, { x: 40, y: 20 }, 5)?.attach).toEqual({ id: a.id });
    expect(findGlue(doc, { x: 200, y: 200 }, 5)).toBeNull();
  });
});

describe('routes', () => {
  it('meets facing sides with a step in the middle', () => {
    expect(elbowHop({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 100, y: 40 }, { x: -1, y: 0 })).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 40 },
      { x: 100, y: 40 },
    ]);
  });

  it('turns once from a side into a top', () => {
    expect(elbowHop({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 100, y: 80 }, { x: 0, y: -1 })).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
    ]);
  });

  it('goes round when both sides face the same way', () => {
    const r = elbowHop({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 100, y: 50 }, { x: 1, y: 0 });
    expect(r).toEqual([
      { x: 0, y: 0 },
      { x: 120, y: 0 },
      { x: 120, y: 50 },
      { x: 100, y: 50 },
    ]);
  });

  it('routes a glued elbow connector square, side to side', () => {
    const { doc, c } = twoBoxes('elbow');
    const p = resolveConnector(doc, c);
    near(p.start, { x: 100, y: 30 });
    near(p.end, { x: 300, y: 30 });
    for (let i = 1; i < p.flat.length; i++) expect(p.flat[i].x === p.flat[i - 1].x || p.flat[i].y === p.flat[i - 1].y).toBe(true);
  });

  it('curves through every point, square to glued sides', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 50, y: 40 },
      { x: 100, y: 0 },
    ];
    const segs = curveThrough(pts);
    expect(segs).toHaveLength(2);
    near(segs[0].to, pts[1]);
    near(segs[1].to, pts[2]);
    // leaving along the given side direction
    const s = curveThrough([pts[0], pts[2]], { x: 0, y: -1 }, null)[0];
    expect(s.c1!.x).toBeCloseTo(0, 6);
    expect(s.c1!.y).toBeLessThan(0);
  });

  it('draws a curved connector as cubic pieces and orients the head along the last one', () => {
    const doc = createDoc();
    const c = add(doc, 'arrow', 0, 0, 100, 0, { pts: [{ x: 50, y: 50 }], route: 'curved' });
    const p = resolveConnector(doc, c);
    expect(connectorD(p)).toMatch(/^M0 0C.*C.*100 0$/);
    expect(p.endDir.y).toBeLessThan(0);
    expect(p.endDir.x).toBeGreaterThan(0);
  });

  it('keeps a plain line exactly as before', () => {
    const doc = createDoc();
    const c = add(doc, 'line', 10, 20, 30, 40);
    const p = resolveConnector(doc, c);
    expect(p.flat).toEqual([
      { x: 10, y: 20 },
      { x: 40, y: 60 },
    ]);
    expect(itemBounds(doc, c)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    expect(p.mid).toEqual({ x: 25, y: 40 });
  });
});

describe('following targets', () => {
  it('follows a moved target and writes the ends back when settled', () => {
    const { doc, a, c } = twoBoxes();
    translateItems(structuredClone(doc), doc, new Set([a.id]), 0, 100);
    near(resolveConnector(doc, c).start, { x: 100, y: 130 });
    const settled = settleConnectors(doc);
    const s = settled.items[c.id] as ShapeItem;
    expect(s.x).toBeCloseTo(100, 6);
    expect(s.y).toBeCloseTo(130, 6);
    // the floating end heads for A's pinned spot: B's left side, toward (100, 130)
    expect(s.x + s.w).toBeCloseTo(300, 6);
    expect(settleConnectors(settled)).toBe(settled);
  });

  it('lets go of a deleted target, keeping the end where it was', () => {
    const { doc, b, c } = twoBoxes();
    const before = resolveConnector(doc, c).end;
    deleteItems(doc, [b.id]);
    const s = doc.items[c.id] as ShapeItem;
    expect(s.to).toBeUndefined();
    expect(s.from).toBeDefined();
    near({ x: s.x + s.w, y: s.y + s.h }, before);
  });

  it('drops attachments to targets removed elsewhere (a peer) when settling', () => {
    const { doc, b, c } = twoBoxes();
    delete doc.items[b.id];
    const s = settleConnectors(doc).items[c.id] as ShapeItem;
    expect(s.to).toBeUndefined();
  });

  it('moves bends and free ends with the connector, glued ends stay', () => {
    const { doc, c } = twoBoxes();
    c.pts = [{ x: 200, y: 100 }];
    const base = structuredClone(doc);
    translateItems(base, doc, new Set([c.id]), 10, 10);
    const s = doc.items[c.id] as ShapeItem;
    expect(s.pts).toEqual([{ x: 210, y: 110 }]);
    near(resolveConnector(doc, s).start, { x: 100, y: 30 });
  });

  it('cuts glued ends on an Alt move', () => {
    const { doc, a, c } = twoBoxes();
    translateDetached(structuredClone(doc), doc, new Set([a.id]), 0, 50);
    const s = doc.items[c.id] as ShapeItem;
    expect(s.from).toBeUndefined();
    near({ x: s.x, y: s.y }, { x: 100, y: 30 });
  });
});

describe('copying', () => {
  it('re-glues to the copies when both targets are copied', () => {
    const { doc, a, b, c } = twoBoxes();
    const ids = insertFragment(doc, extractFragment(doc, new Set([a.id, b.id, c.id])), 0, 200);
    const copy = ids.map((id) => doc.items[id] as ShapeItem).find((s) => s.kind === 'arrow')!;
    expect(ids).toContain(copy.from!.id);
    expect(ids).toContain(copy.to!.id);
    expect(copy.from!.fx).toBe(1);
    near(resolveConnector(doc, copy).start, { x: 100, y: 230 });
  });

  it('lets go of targets left behind, frozen where they were', () => {
    const { doc, a, c } = twoBoxes();
    c.pts = [{ x: 200, y: 100 }];
    const was = resolveConnector(doc, c);
    const ids = insertFragment(doc, extractFragment(doc, new Set([a.id, c.id])), 5, 0);
    const copy = ids.map((id) => doc.items[id] as ShapeItem).find((s) => s.kind === 'arrow')!;
    expect(copy.from).toBeDefined();
    expect(copy.to).toBeUndefined();
    near({ x: copy.x + copy.w, y: copy.y + copy.h }, { x: was.end.x + 5, y: was.end.y });
    expect(copy.pts).toEqual([{ x: 205, y: 100 }]);
  });
});

describe('turning a free connector', () => {
  it('turns its ends and bends about the pivot', () => {
    const doc = createDoc();
    const c = add(doc, 'line', 0, 0, 100, 0, { pts: [{ x: 50, y: 20 }] });
    rotateShapeBy(structuredClone(doc), doc, c.id, 90, { x: 0, y: 0 });
    const s = doc.items[c.id] as ShapeItem;
    near({ x: s.x + s.w, y: s.y + s.h }, { x: 0, y: 100 });
    near(s.pts![0], { x: -20, y: 50 });
  });

  it('mirrors its bends on a flip', () => {
    const doc = createDoc();
    const c = add(doc, 'line', 0, 0, 100, 0, { pts: [{ x: 20, y: 30 }] });
    flipItems(doc, new Set([c.id]), 'x');
    const s = doc.items[c.id] as ShapeItem;
    // pivot: the middle of the bounds (50, 15), snapped to the grid (50, 20)
    expect(s.pts![0].x).toBeCloseTo(80, 6);
    expect(s.x).toBeCloseTo(100, 6);
    expect(s.x + s.w).toBeCloseTo(0, 6);
  });
});
