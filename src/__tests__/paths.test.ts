import { describe, expect, it } from 'vitest';
import { createDoc, makeShape, normalizeDoc } from '../model/doc';
import { flipItems, rotateShapeBy } from '../model/ops';
import {
  convertToPath,
  cubicAt,
  dragHandle,
  ellipseNodes,
  flattenPath,
  insertNode,
  isSmooth,
  nearestOnPath,
  packPath,
  pathBounds,
  pathD,
  pathHit,
  pathNodes,
  pathSegs,
  removeNode,
  setNodeKind,
  setPathNodes,
  shapeOutline,
  splitCubic,
  type PathNode,
} from '../model/path';
import { getPreset, makePresetShape } from '../model/shapePresets';
import { parsePathData, subpathNodes } from '../io/svgImport';
import type { CircuitDoc, Point, ShapeItem } from '../model/types';

const SQUARE: PathNode[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];
/** An arch: two nodes with handles pulled up, the curve peaks at y = -75. */
const ARCH: PathNode[] = [
  { x: 0, y: 0, out: { x: 0, y: -100 } },
  { x: 100, y: 0, in: { x: 100, y: -100 } },
];

function withPath(nodes: PathNode[], open?: boolean, extra: Partial<ShapeItem> = {}) {
  const doc = createDoc();
  const s = makeShape(doc, 'polygon', 0, 0, 1, 1);
  setPathNodes(s, nodes, open);
  Object.assign(s, extra);
  doc.items[s.id] = s;
  return { doc, s };
}

const near = (a: Point, b: Point, tol = 1e-6) => {
  expect(a.x).toBeCloseTo(b.x, -Math.log10(tol));
  expect(a.y).toBeCloseTo(b.y, -Math.log10(tol));
};

describe('path data', () => {
  it('draws corners as lines and closes with Z', () => {
    expect(pathD(SQUARE)).toBe('M0 0L10 0L10 10L0 10Z');
    expect(pathD(SQUARE, true)).toBe('M0 0L10 0L10 10L0 10');
  });

  it('draws handles as cubics, the closing stretch too', () => {
    expect(pathD(ARCH, true)).toBe('M0 0C0 -100 100 -100 100 0');
    const closed = pathD([{ x: 0, y: 0, in: { x: -5, y: 5 } }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    expect(closed).toBe('M0 0L10 0L10 10C10 10 -5 5 0 0Z');
  });

  it('round-trips nodes and handles through the box fractions', () => {
    const f = packPath(ARCH, true);
    expect(f.open).toBe(true);
    expect(f.curve).toHaveLength(8);
    const back = pathNodes(f);
    // fractions keep five decimals
    near(back[0].out!, ARCH[0].out!, 1e-2);
    near(back[1].in!, ARCH[1].in!, 1e-2);
    expect(back[0].in).toBeUndefined();
    // all corners: no curve list
    expect(packPath(SQUARE).curve).toBeUndefined();
  });
});

describe('curve geometry', () => {
  it('bounds take the curve extrema, not the handles', () => {
    const b = pathBounds(ARCH, true);
    expect(b.x).toBeCloseTo(0);
    expect(b.w).toBeCloseTo(100);
    expect(b.y).toBeCloseTo(-75);
    expect(b.h).toBeCloseTo(75);
    // the shape's box is those bounds
    expect(packPath(ARCH, true)).toMatchObject({ x: 0, w: 100, h: 75 });
  });

  it('splits a cubic at t without changing it', () => {
    const seg = pathSegs(ARCH, true)[0];
    const t = 0.3;
    const [L, R] = splitCubic(seg, t);
    const at = (q: Point[], u: number) => cubicAt({ a: q[0], c1: q[1], c2: q[2], b: q[3], line: false }, u);
    for (const u of [0, 0.25, 0.5, 0.9, 1]) {
      near(at(L, u), cubicAt(seg, u * t));
      near(at(R, u), cubicAt(seg, t + u * (1 - t)));
    }
  });

  it('inserts a node on a curve keeping the outline', () => {
    const { nodes, index } = insertNode(ARCH, true, 0, 0.5);
    expect(index).toBe(1);
    expect(nodes).toHaveLength(3);
    near(nodes[1], { x: 50, y: -75 });
    expect(isSmooth(nodes[1])).toBe(true);
    for (const p of flattenPath(nodes, true, 0.05)) expect(nearestOnPath(ARCH, true, p)!.d).toBeLessThan(0.2);
  });

  it('inserts a plain node on a straight stretch', () => {
    const { nodes, index } = insertNode(SQUARE, false, 3, 0.5);
    expect(index).toBe(4);
    expect(nodes[4]).toEqual({ x: 0, y: 5 });
  });

  it('finds the nearest stretch and parameter', () => {
    const n = nearestOnPath(ARCH, true, { x: 50, y: -80 })!;
    expect(n.seg).toBe(0);
    expect(n.t).toBeCloseTo(0.5, 1);
    expect(n.d).toBeCloseTo(5, 0);
  });

  it('flattens for hit-testing: inside a filled circle, not its box corners', () => {
    const { s } = withPath(ellipseNodes({ x: 0, y: 0, w: 100, h: 100 }), false, { fillOpacity: 1 });
    expect(pathHit(s, { x: 50, y: 50 }, 1)).toBe(true);
    expect(pathHit(s, { x: 5, y: 5 }, 1)).toBe(false);
    // on the outline of an unfilled one
    const { s: ring } = withPath(ellipseNodes({ x: 0, y: 0, w: 100, h: 100 }));
    expect(pathHit(ring, { x: 50, y: 50 }, 1)).toBe(false);
    expect(pathHit(ring, { x: 50 + 50 * Math.SQRT1_2, y: 50 + 50 * Math.SQRT1_2 }, 1)).toBe(true);
  });

  it('an open path has no closing stretch to hit', () => {
    const { s } = withPath(SQUARE, true);
    expect(pathHit(s, { x: 0, y: 5 }, 1)).toBe(false);
    expect(pathHit(s, { x: 10, y: 5 }, 1)).toBe(true);
  });
});

describe('node editing', () => {
  it('switches a node between corner and smooth', () => {
    const smooth = setNodeKind(SQUARE, false, 1, 'smooth');
    expect(isSmooth(smooth[1])).toBe(true);
    const corner = setNodeKind(smooth, false, 1, 'corner');
    expect(corner[1]).toEqual({ x: 10, y: 0 });
    // the ends of an open path get one handle
    const end = setNodeKind(SQUARE, true, 0, 'smooth');
    expect(end[0].in).toBeUndefined();
    expect(end[0].out).toBeDefined();
  });

  it('keeps a smooth node smooth (and symmetric) when a handle moves; Alt breaks it', () => {
    const n: PathNode[] = [{ x: 0, y: 0, in: { x: -10, y: 0 }, out: { x: 10, y: 0 } }, { x: 50, y: 50 }];
    const turned = dragHandle(n, 0, 'out', { x: 0, y: 20 });
    near(turned[0].in!, { x: 0, y: -20 });
    const free = dragHandle(n, 0, 'out', { x: 0, y: 20 }, true);
    near(free[0].in!, { x: -10, y: 0 });
    expect(isSmooth(free[0])).toBe(false);
  });

  it('keeps at least two nodes open, three closed', () => {
    expect(removeNode(SQUARE.slice(0, 3), false, 0)).toBeNull();
    expect(removeNode(SQUARE.slice(0, 3), true, 0)).toHaveLength(2);
    expect(removeNode(SQUARE.slice(0, 2), true, 0)).toBeNull();
  });
});

describe('convert to path', () => {
  it('turns an ellipse into four arcs on the same outline', () => {
    const doc = createDoc();
    const s = makeShape(doc, 'ellipse', 10, 20, 120, 60);
    expect(convertToPath(s)).toBe(true);
    expect(s.kind).toBe('polygon');
    expect(pathNodes(s)).toHaveLength(4);
    expect(s.x).toBeCloseTo(10);
    expect(s.y).toBeCloseTo(20);
    expect(s.w).toBeCloseTo(120);
    expect(s.h).toBeCloseTo(60);
    for (const p of shapeOutline(s, 0.05)) {
      const e = ((p.x - 70) / 60) ** 2 + ((p.y - 50) / 30) ** 2;
      expect(Math.abs(e - 1)).toBeLessThan(0.01);
    }
  });

  it('turns a rounded rectangle into lines and quarter arcs', () => {
    const doc = createDoc();
    const s = makeShape(doc, 'rect', 0, 0, 100, 60);
    s.radius = 10;
    convertToPath(s);
    expect(pathNodes(s)).toHaveLength(8);
    expect([s.x, s.y, s.w, s.h].map((v) => Math.round(v * 1e3) / 1e3 + 0)).toEqual([0, 0, 100, 60]);
    for (const p of shapeOutline(s, 0.05)) {
      // every point is on an edge or on a corner arc of radius 10
      const cx = Math.min(Math.max(p.x, 10), 90);
      const cy = Math.min(Math.max(p.y, 10), 50);
      const onArc = Math.abs(Math.hypot(p.x - cx, p.y - cy) - 10) < 0.05;
      const onEdge = Math.abs(p.x) < 1e-6 || Math.abs(p.x - 100) < 1e-6 || Math.abs(p.y) < 1e-6 || Math.abs(p.y - 60) < 1e-6;
      expect(onArc || onEdge).toBe(true);
    }
  });

  it('a stadium (radius past half the side) merges the meeting nodes', () => {
    const s = makeShape(createDoc(), 'rect', 0, 0, 100, 40);
    s.radius = 20;
    convertToPath(s);
    // the short sides vanish: half circles on the ends, lines along the long sides
    expect(pathNodes(s)).toHaveLength(6);
    expect(s.h).toBeCloseTo(40);
  });

  it('bakes a turn into the nodes', () => {
    const s = makeShape(createDoc(), 'rect', 0, 0, 100, 20);
    s.rot = 90;
    s.radius = 0;
    convertToPath(s);
    expect(s.rot).toBeUndefined();
    expect([s.x, s.y, s.w, s.h].map((v) => Math.round(v) + 0)).toEqual([40, -40, 20, 100]);
  });

  it('keeps a loose line open and leaves glued ones alone', () => {
    const doc = createDoc();
    const s = makeShape(doc, 'line', 0, 0, 100, 0);
    expect(convertToPath(s, { start: { x: 0, y: 0 }, segs: [{ to: { x: 50, y: 50 } }, { to: { x: 100, y: 0 } }] })).toBe(true);
    expect(s.open).toBe(true);
    expect(pathNodes(s)).toHaveLength(3);
    const g = makeShape(doc, 'arrow', 0, 0, 100, 0);
    g.to = { id: 'x', x: 0, y: 0 } as ShapeItem['to'];
    expect(convertToPath(g, { start: { x: 0, y: 0 }, segs: [] })).toBe(false);
    expect(g.kind).toBe('arrow');
  });
});

describe('transforms', () => {
  it('rotation turns nodes and handles alike', () => {
    const { doc, s } = withPath(ARCH, true);
    const before = pathNodes(s);
    const base = structuredClone(doc) as CircuitDoc;
    rotateShapeBy(base, doc, s.id, 90, { x: 0, y: 0 });
    const after = pathNodes(doc.items[s.id] as ShapeItem);
    const rot = (p: Point) => ({ x: -p.y, y: p.x });
    for (let i = 0; i < before.length; i++) {
      near(after[i], rot(before[i]), 1e-3);
      if (before[i].out) near(after[i].out!, rot(before[i].out!), 1e-3);
      if (before[i].in) near(after[i].in!, rot(before[i].in!), 1e-3);
    }
    expect((doc.items[s.id] as ShapeItem).open).toBe(true);
  });

  it('a flip mirrors the curve', () => {
    const { doc, s } = withPath(ARCH, true);
    flipItems(doc, new Set([s.id]), 'y');
    const t = doc.items[s.id] as ShapeItem;
    // the arch now bulges downwards: its box keeps its size
    expect(t.w).toBeCloseTo(100);
    expect(t.h).toBeCloseTo(75);
    const n = pathNodes(t);
    expect(n[0].out!.y).toBeGreaterThan(n[0].y);
  });
});

describe('curved presets', () => {
  it('build curved outlines', () => {
    for (const id of ['flow-document', 'flow-database', 'cloud', 'flow-delay', 'flow-display', 'flow-stored-data', 'circle-arrow']) {
      const p = getPreset(id);
      expect(p, id).toBeDefined();
      const s = makePresetShape(createDoc(), p!, 0, 0, 80, 60);
      expect(s.kind, id).toBe('polygon');
      expect(s.curve?.length, id).toBe(s.poly!.length * 2);
      expect(polyPathOk(s), id).toBe(true);
    }
  });
});

const polyPathOk = (s: ShapeItem) => /^M[-\d.]+ [-\d.]+([LC][-\d. ]+)+Z$/.test(pathD(pathNodes(s), s.open));

describe('loading and import', () => {
  it('drops broken curve lists', () => {
    const { doc, s } = withPath(ARCH, true);
    const raw = JSON.parse(JSON.stringify(doc));
    raw.items[s.id].curve = [1, 2, 'x'];
    raw.items[s.id].open = 'yes';
    raw.items[s.id].poly.push(0.5);
    const t = normalizeDoc(raw).items[s.id] as ShapeItem;
    expect(t.curve).toBeUndefined();
    expect(t.open).toBeUndefined();
    expect(t.poly!.length % 2).toBe(0);
  });

  it('keeps SVG curves as nodes with handles', () => {
    const subs = subpathNodes(parsePathData('M0 0C10 -10 20 -10 30 0L30 10Z M50 50 L60 60'));
    expect(subs).toHaveLength(2);
    expect(subs[1]).toBeNull();
    const c = subs[0]!;
    expect(c.closed).toBe(true);
    expect(c.nodes).toHaveLength(3);
    expect(c.nodes[0].out).toEqual({ x: 10, y: -10 });
    expect(c.nodes[1].in).toEqual({ x: 20, y: -10 });
  });
});
