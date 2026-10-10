import type { ComponentItem, Point, Rect, Side, SymbolDef } from './types';

export const snap = (v: number, g: number) => Math.round(v / g) * g;
export const snapPt = (p: Point, g: number, on = true): Point => (on ? { x: snap(p.x, g), y: snap(p.y, g) } : p);
export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const eq = (a: Point, b: Point, eps = 0.01) => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;

/** Transforms a symbol-local point into world coordinates for a placed component. */
export function toWorld(c: Pick<ComponentItem, 'x' | 'y' | 'rot' | 'flipX'>, def: Pick<SymbolDef, 'w' | 'h'>, lx: number, ly: number): Point {
  let x = lx - def.w / 2;
  const y = ly - def.h / 2;
  if (c.flipX) x = -x;
  return rotate({ x, y }, c.rot, c);
}

export function rotate(p: Point, rot: number, origin: Point = { x: 0, y: 0 }): Point {
  switch (((rot % 360) + 360) % 360) {
    case 90:
      return { x: origin.x - p.y, y: origin.y + p.x };
    case 180:
      return { x: origin.x - p.x, y: origin.y - p.y };
    case 270:
      return { x: origin.x + p.y, y: origin.y - p.x };
    default:
      return { x: origin.x + p.x, y: origin.y + p.y };
  }
}

const SIDE_VEC: Record<Side, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

export function sideVector(c: Pick<ComponentItem, 'rot' | 'flipX'>, side: Side): Point {
  let v = SIDE_VEC[side];
  if (c.flipX) v = { x: -v.x, y: v.y };
  const r = rotate(v, c.rot);
  return { x: Math.round(r.x), y: Math.round(r.y) };
}

export function componentBounds(c: ComponentItem, def: Pick<SymbolDef, 'w' | 'h'>): Rect {
  const vertical = c.rot === 90 || c.rot === 270;
  const w = vertical ? def.h : def.w;
  const h = vertical ? def.w : def.h;
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

export function rectFromPoints(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function rectsIntersect(a: Rect, b: Rect) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function rectContains(outer: Rect, inner: Rect) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function pointInRect(p: Point, r: Rect, pad = 0) {
  return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
}

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function polylineBounds(pts: Point[]): Rect {
  return unionRects(pts.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })))!;
}

/** Closest point on segment ab to p, with parameter t in [0,1]. */
export function projectOnSegment(p: Point, a: Point, b: Point): { pt: Point; t: number; d: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const pt = { x: a.x + t * dx, y: a.y + t * dy };
  return { pt, t, d: dist(p, pt) };
}

/** Segment/segment intersection (excluding parallel overlap). */
export function segmentIntersection(a: Point, b: Point, c: Point, d: Point): { pt: Point; t: number; u: number } | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { pt: { x: a.x + t * r.x, y: a.y + t * r.y }, t, u };
}

export function segmentIntersectsRect(a: Point, b: Point, r: Rect): boolean {
  if (pointInRect(a, r) || pointInRect(b, r)) return true;
  const c = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  for (let i = 0; i < 4; i++) if (segmentIntersection(a, b, c[i], c[(i + 1) % 4])) return true;
  return false;
}

/** Removes duplicate and collinear interior points. */
export function simplify(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    if (out.length && eq(out[out.length - 1], p)) continue;
    out.push({ x: p.x, y: p.y });
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
      if (Math.abs(cross) < 0.01 && dot >= 0) out.splice(out.length - 2, 1);
      else break;
    }
  }
  return out;
}

/**
 * Clips a polyline against a rectangle, returning every piece of the line
 * that lies inside (endpoints cut exactly on the rectangle boundary).
 */
export function clipPolylineToRect(pts: Point[], r: Rect): Point[][] {
  const EPS = 0.01;
  const inside = (p: Point) => pointInRect(p, r, EPS);
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  /** Boundary crossings of segment a→b, ordered along the segment. */
  const crossings = (a: Point, b: Point) => {
    const hits: { pt: Point; t: number }[] = [];
    for (let e = 0; e < 4; e++) {
      const hit = segmentIntersection(a, b, corners[e], corners[(e + 1) % 4]);
      if (hit) hits.push({ pt: hit.pt, t: hit.t });
    }
    return hits.sort((p, q) => p.t - q.t).map((h) => h.pt);
  };
  const runs: Point[][] = [];
  let run: Point[] = [];
  const finish = () => {
    if (run.length >= 2) runs.push(run);
    run = [];
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const aIn = inside(a);
    const bIn = inside(b);
    if (aIn && bIn) {
      if (!run.length) run.push({ ...a });
      run.push({ ...b });
    } else if (aIn) {
      // leaving: cut at the last boundary crossing
      if (!run.length) run.push({ ...a });
      const exit = crossings(a, b).pop();
      if (exit) run.push(exit);
      finish();
    } else if (bIn) {
      // entering: start a new run at the first boundary crossing
      const entry = crossings(a, b)[0];
      if (entry) run = [entry, { ...b }];
    } else {
      // passing straight through
      const hits = crossings(a, b);
      if (hits.length >= 2 && dist(hits[0], hits[hits.length - 1]) > EPS) runs.push([hits[0], hits[hits.length - 1]]);
    }
  }
  finish();
  return runs;
}
