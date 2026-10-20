import { produce } from 'immer';
import { drawOrderCached } from './doc';
import { dist, polylineBounds, simplify, toWorld } from './geometry';
import { pointInPolygon, shapeOutline } from './path';
import { instanceSymbol } from './registry';
import { rectCentre, rotateDeg, shapeBox, shapeRot } from './rotation';
import type { Attach, CircuitDoc, ConnectorRoute, Item, Point, Rect, ShapeItem } from './types';

/**
 * Connectors: lines and arrows with bends that can be glued to shapes and
 * parts, draw.io style.
 *
 * A connector keeps x / y as its start and x + w / y + h as its end, `pts` as
 * the bends in between and `from` / `to` as what each end is glued to. Where a
 * glued end actually is depends on its target, so everything that draws,
 * hit-tests, bounds or exports a line goes through `resolveConnector`, which
 * works it out from the document as it is. `settleConnectors` (run when an
 * edit is committed) writes the resolved ends back into x / y / w / h and lets
 * go of targets that are gone, so the stored numbers stay a faithful fallback
 * (a pasted or exported piece without the target, an older reader). Peers in a
 * live session resolve the same data the same way, so they always agree.
 */

export const isConnector = (it: Item | undefined): it is ShapeItem & { kind: 'line' | 'arrow' } => it?.type === 'shape' && (it.kind === 'line' || it.kind === 'arrow');

/** Whether a connector end can be glued to this item: parts, and shapes with an outline. */
export function canAttach(it: Item | undefined): boolean {
  if (!it) return false;
  if (it.type === 'component') return true;
  return it.type === 'shape' && it.kind !== 'line' && it.kind !== 'arrow' && it.kind !== 'frame' && it.kind !== 'callout';
}

/** Whether an attachment pins the end to a spot (rather than letting it float round the outline). */
export const isFixed = (a: Attach): boolean => a.fx !== undefined && a.fy !== undefined;

/* ------------------------------------------------------------------ */
/* Target frames                                                       */
/* ------------------------------------------------------------------ */

/**
 * A target's own box as an affine frame: centre `c`, and `u` / `v` the world
 * vectors from the centre to the middle of its right and bottom sides. Local
 * coordinates (a, b) run -1…1 across the box, so turned shapes and turned or
 * mirrored parts all work the same. `outline` is the box itself, an ellipse
 * filling it, or a polygon in local coordinates.
 */
export interface TargetFrame {
  c: Point;
  u: Point;
  v: Point;
  outline: 'rect' | 'ellipse' | Point[];
}

export function targetFrame(doc: Pick<CircuitDoc, 'items' | 'symbols'>, it: Item | undefined): TargetFrame | null {
  if (!it || !canAttach(it)) return null;
  if (it.type === 'component') {
    const def = instanceSymbol(doc, it);
    const c = toWorld(it, def, def.w / 2, def.h / 2);
    const r = toWorld(it, def, def.w, def.h / 2);
    const b = toWorld(it, def, def.w / 2, def.h);
    return { c, u: { x: r.x - c.x, y: r.y - c.y }, v: { x: b.x - c.x, y: b.y - c.y }, outline: 'rect' };
  }
  if (it.type !== 'shape') return null;
  const box = shapeBox(it);
  const rot = shapeRot(it);
  const f: TargetFrame = { c: rectCentre(box), u: rotateDeg({ x: box.w / 2, y: 0 }, rot), v: rotateDeg({ x: 0, y: box.h / 2 }, rot), outline: 'rect' };
  if (it.kind === 'ellipse') f.outline = 'ellipse';
  // curved outlines glue to their flattened curve
  else if (it.kind === 'polygon' && it.poly && it.poly.length >= (it.curve ? 4 : 6)) f.outline = shapeOutline(it, 0.5).map((p) => toLocal(f, p));
  return f;
}

export const fromLocal = (f: TargetFrame, a: number, b: number): Point => ({ x: f.c.x + a * f.u.x + b * f.v.x, y: f.c.y + a * f.u.y + b * f.v.y });

export function toLocal(f: TargetFrame, p: Point): Point {
  const det = f.u.x * f.v.y - f.u.y * f.v.x;
  if (Math.abs(det) < 1e-9) return { x: 0, y: 0 };
  const dx = p.x - f.c.x;
  const dy = p.y - f.c.y;
  return { x: (dx * f.v.y - dy * f.v.x) / det, y: (f.u.x * dy - f.u.y * dx) / det };
}

/** How far along local direction `d` from the centre the outline lies (the hit is at t·d). */
function rayHit(f: TargetFrame, d: Point): number {
  if (f.outline === 'rect') return 1 / Math.max(Math.abs(d.x), Math.abs(d.y), 1e-9);
  if (f.outline === 'ellipse') return 1 / Math.max(Math.hypot(d.x, d.y), 1e-9);
  // a polygon: the outermost crossing, so the line never runs into the shape
  const pts = f.outline;
  let best = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const den = d.x * ey - d.y * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (p.x * ey - p.y * ex) / den;
    const s = (p.x * d.y - p.y * d.x) / den;
    if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.max(best, t);
  }
  return best || 1 / Math.max(Math.abs(d.x), Math.abs(d.y), 1e-9);
}

const unit = (p: Point): Point => {
  const l = Math.hypot(p.x, p.y);
  return l ? { x: p.x / l, y: p.y / l } : { x: 0, y: 0 };
};

/** Outward direction of the side a local point is on (the larger of its two coordinates), in the world. */
function sideNormal(f: TargetFrame, l: Point): Point | null {
  if (Math.abs(l.x) < 1e-9 && Math.abs(l.y) < 1e-9) return null;
  const n = Math.abs(l.x) >= Math.abs(l.y) ? { x: f.u.x * Math.sign(l.x), y: f.u.y * Math.sign(l.x) } : { x: f.v.x * Math.sign(l.y), y: f.v.y * Math.sign(l.y) };
  return unit(n);
}

/* ------------------------------------------------------------------ */
/* Connection points                                                   */
/* ------------------------------------------------------------------ */

export interface AttachSpot {
  fx: number;
  fy: number;
  pt: Point;
}

const SIDES: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
const CORNERS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/**
 * The connection points offered on a target: a part's pins and the middles of
 * its sides; a shape's side middles where they meet its outline, plus the
 * corners of boxy shapes.
 */
export function attachSpots(doc: Pick<CircuitDoc, 'items' | 'symbols'>, it: Item | undefined): AttachSpot[] {
  const f = targetFrame(doc, it);
  if (!f || !it) return [];
  const out: AttachSpot[] = [];
  const add = (a: number, b: number) => {
    const fx = Math.round(((a + 1) / 2) * 1e4) / 1e4;
    const fy = Math.round(((b + 1) / 2) * 1e4) / 1e4;
    if (out.some((s) => Math.abs(s.fx - fx) < 1e-3 && Math.abs(s.fy - fy) < 1e-3)) return;
    out.push({ fx, fy, pt: fromLocal(f, a, b) });
  };
  if (it.type === 'component') {
    const def = instanceSymbol(doc, it);
    for (const p of def.ports) if (def.w && def.h) add((2 * p.x) / def.w - 1, (2 * p.y) / def.h - 1);
  }
  for (const [a, b] of SIDES) {
    const t = rayHit(f, { x: a, y: b });
    add(a * t, b * t);
  }
  if (f.outline === 'rect' && !(it.type === 'shape' && it.kind === 'text')) for (const [a, b] of CORNERS) add(a, b);
  return out;
}

export interface GlueHit {
  attach: Attach;
  /** Where the end lands (a spot, or the pointer for a floating end). */
  pt: Point;
}

/**
 * What an end dropped at `p` glues to: the frontmost attachable item under it
 * (`tol` around its outline counts; areas only take ends along their edge).
 * Within `tol` of a connection point it is pinned there; elsewhere inside it
 * floats. `exclude` skips the connector itself.
 */
export function findGlue(doc: CircuitDoc, p: Point, tol: number, exclude?: string): GlueHit | null {
  const rank = drawOrderCached(doc);
  const cands = Object.values(doc.items)
    .filter((it) => it.id !== exclude && !it.hidden && canAttach(it))
    .sort((a, b) => rank.get(b.id)! - rank.get(a.id)!);
  // a connection point near the pointer wins, on whatever item it is
  let spot: { id: string; s: AttachSpot; d: number } | null = null;
  for (const it of cands) {
    for (const s of attachSpots(doc, it)) {
      const d = dist(s.pt, p);
      if (d <= tol && (!spot || d < spot.d)) spot = { id: it.id, s, d };
    }
  }
  if (spot) return { attach: { id: spot.id, fx: spot.s.fx, fy: spot.s.fy }, pt: spot.s.pt };
  for (const it of cands) {
    const f = targetFrame(doc, it)!;
    const l = toLocal(f, p);
    const pa = tol / Math.max(Math.hypot(f.u.x, f.u.y), 1e-9);
    const pb = tol / Math.max(Math.hypot(f.v.x, f.v.y), 1e-9);
    const inside =
      f.outline === 'rect'
        ? Math.abs(l.x) <= 1 + pa && Math.abs(l.y) <= 1 + pb
        : f.outline === 'ellipse'
          ? (l.x / (1 + pa)) ** 2 + (l.y / (1 + pb)) ** 2 <= 1
          : pointInPolygon(l, f.outline);
    // areas (zones, containers, pictures) hold things: only their edge takes an end, not their inside
    const area = it.type === 'shape' && (it.kind === 'zone' || it.kind === 'image' || !!it.container);
    if (inside && area && Math.abs(l.x) < 1 - pa && Math.abs(l.y) < 1 - pb) continue;
    if (inside) return { attach: { id: it.id }, pt: p };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

/** How far an elbow route steps out of a side before turning back round. */
export const ELBOW_STUB = 20;

/** A direction snapped to the nearer axis (null stays null). */
function axisDir(d: Point | null): Point | null {
  if (!d || (!d.x && !d.y)) return null;
  return Math.abs(d.x) >= Math.abs(d.y) ? { x: Math.sign(d.x), y: 0 } : { x: 0, y: Math.sign(d.y) };
}

const T = (p: Point): Point => ({ x: p.y, y: p.x });

/**
 * Square-cornered route from `p` to `q`, like draw.io's orthogonal edges.
 * `dp` is the way out of p's side and `dq` the way out of q's (the route
 * arrives travelling against it); null for a free end or a bend. Facing sides
 * meet with one or two bends; sides facing away step out first and go round.
 */
export function elbowHop(p: Point, dp0: Point | null, q: Point, dq0: Point | null): Point[] {
  const dp = axisDir(dp0);
  const dq = axisDir(dq0);
  if (!dp && dq) return elbowHop(q, dq, p, null).reverse();
  if (!dp) {
    // free on both sides: one bend, the longer run first
    const h = Math.abs(q.x - p.x) >= Math.abs(q.y - p.y);
    return simplify([p, h ? { x: q.x, y: p.y } : { x: p.x, y: q.y }, q]);
  }
  // work as if p leaves sideways (turn vertical cases on their side and back)
  if (!dp.x) return elbowHop(T(p), T(dp), T(q), dq && T(dq)).map(T);
  const sx = dp.x;
  const ahead = (q.x - p.x) * sx;
  const S = ELBOW_STUB;
  if (!dq) {
    if (ahead >= 0) return simplify([p, { x: q.x, y: p.y }, q]);
    const x = p.x + sx * S;
    return simplify([p, { x, y: p.y }, { x, y: q.y }, q]);
  }
  if (dq.x) {
    const tx = dq.x;
    if (tx === -sx && ahead > 0) {
      // facing each other: across at the middle
      const mx = (p.x + q.x) / 2;
      return simplify([p, { x: mx, y: p.y }, { x: mx, y: q.y }, q]);
    }
    if (tx === sx) {
      // both face the same way: round past the further one
      const x = sx > 0 ? Math.max(p.x, q.x) + S : Math.min(p.x, q.x) - S;
      return simplify([p, { x, y: p.y }, { x, y: q.y }, q]);
    }
    // back to back: out of both, across the middle
    const x1 = p.x + sx * S;
    const x2 = q.x + tx * S;
    const my = (p.y + q.y) / 2;
    return simplify([p, { x: x1, y: p.y }, { x: x1, y: my }, { x: x2, y: my }, { x: x2, y: q.y }, q]);
  }
  // q's side faces up or down
  const ty = dq.y;
  if (ahead > 0 && (p.y - q.y) * ty > 0) return simplify([p, { x: q.x, y: p.y }, q]);
  const x1 = p.x + sx * S;
  const y2 = q.y + ty * S;
  return simplify([p, { x: x1, y: p.y }, { x: x1, y: y2 }, { x: q.x, y: y2 }, q]);
}

/** One piece of a connector's path: a straight run, or a cubic curve with controls `c1` / `c2`. */
export interface Seg {
  to: Point;
  c1?: Point;
  c2?: Point;
}

/**
 * Smooth curve through points (Catmull-Rom as cubic Béziers). `d0` / `d1`
 * are the ways out of the end sides, if glued: the curve leaves and arrives
 * square to them.
 */
export function curveThrough(pts: Point[], d0: Point | null = null, d1: Point | null = null): Seg[] {
  const n = pts.length - 1;
  if (n < 1) return [];
  if (n === 1 && !d0 && !d1) return [{ to: pts[1] }];
  const tan = (i: number): Point => {
    if (i === 0) {
      const l = dist(pts[0], pts[1]);
      return d0 ? { x: d0.x * l, y: d0.y * l } : { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y };
    }
    if (i === n) {
      const l = dist(pts[n - 1], pts[n]);
      return d1 ? { x: -d1.x * l, y: -d1.y * l } : { x: pts[n].x - pts[n - 1].x, y: pts[n].y - pts[n - 1].y };
    }
    return { x: (pts[i + 1].x - pts[i - 1].x) / 2, y: (pts[i + 1].y - pts[i - 1].y) / 2 };
  };
  const out: Seg[] = [];
  for (let i = 0; i < n; i++) {
    const a = tan(i);
    const b = tan(i + 1);
    out.push({ c1: { x: pts[i].x + a.x / 3, y: pts[i].y + a.y / 3 }, c2: { x: pts[i + 1].x - b.x / 3, y: pts[i + 1].y - b.y / 3 }, to: pts[i + 1] });
  }
  return out;
}

/** Points along a cubic Bézier (`steps` pieces, the start left out). */
function sampleCubic(p0: Point, c1: Point, c2: Point, p3: Point, steps = 16): Point[] {
  const out: Point[] = [];
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const m = 1 - t;
    const A = m * m * m;
    const B = 3 * m * m * t;
    const C = 3 * m * t * t;
    const D = t * t * t;
    out.push({ x: A * p0.x + B * c1.x + C * c2.x + D * p3.x, y: A * p0.y + B * c1.y + C * c2.y + D * p3.y });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Resolving                                                           */
/* ------------------------------------------------------------------ */

export interface ConnectorPath {
  route: ConnectorRoute;
  start: Point;
  end: Point;
  /** What is drawn after `start`. */
  segs: Seg[];
  /** Start, bends, end: the points the path runs through. */
  through: Point[];
  /** The drawn path as a polyline (elbows in, curves flattened): for hit-testing, bounds and export. */
  flat: Point[];
  /** The drawn path between each pair of through points (where a new bend would go). */
  hops: Point[][];
  /** Unit directions the heads point: out of the start and out of the end. */
  startDir: Point;
  endDir: Point;
  /** Halfway along the path (the title sits here). */
  mid: Point;
}

interface End {
  pt: Point;
  /** Outward side direction when glued (for elbows and curves). */
  dir: Point | null;
}

/** The point the attachment pins to, or the target's centre for a floating one (null: not resolvable). */
function anchorOf(doc: Pick<CircuitDoc, 'items' | 'symbols'> | null, a: Attach | undefined): Point | null {
  if (!a || !doc) return null;
  const f = targetFrame(doc, doc.items[a.id]);
  if (!f) return null;
  return isFixed(a) ? fromLocal(f, 2 * a.fx! - 1, 2 * a.fy! - 1) : f.c;
}

function resolveEnd(doc: Pick<CircuitDoc, 'items' | 'symbols'> | null, a: Attach | undefined, free: Point, toward: Point, route: ConnectorRoute): End {
  const f = a && doc ? targetFrame(doc, doc.items[a.id]) : null;
  if (!a || !f) return { pt: free, dir: null };
  if (isFixed(a)) {
    const l = { x: 2 * a.fx! - 1, y: 2 * a.fy! - 1 };
    return { pt: fromLocal(f, l.x, l.y), dir: sideNormal(f, l) };
  }
  let d = toLocal(f, toward);
  if (Math.hypot(d.x, d.y) < 1e-9) d = { x: 1, y: 0 };
  // an elbow leaves floating ends from the middle of the side facing the way it goes
  if (route === 'elbow') d = Math.abs(d.x) >= Math.abs(d.y) ? { x: Math.sign(d.x), y: 0 } : { x: 0, y: Math.sign(d.y) };
  const t = rayHit(f, d);
  const l = { x: d.x * t, y: d.y * t };
  return { pt: fromLocal(f, l.x, l.y), dir: sideNormal(f, l) };
}

/** Polyline length and the point at `frac` of the way along it. */
function along(pts: Point[], frac: number): Point {
  if (!pts.length) return { x: 0, y: 0 };
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  let left = total * frac;
  for (let i = 1; i < pts.length; i++) {
    const l = dist(pts[i - 1], pts[i]);
    if (l >= left && l > 0) {
      const t = left / l;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
    }
    left -= l;
  }
  return pts[pts.length - 1];
}

const dirOr = (a: Point, b: Point, fallback: Point): Point => {
  const u = unit({ x: a.x - b.x, y: a.y - b.y });
  return u.x || u.y ? u : fallback;
};

/**
 * The path a line or arrow is drawn along, with its glued ends where their
 * targets are now. Without a document (or with the target gone) ends stay
 * where x / y / w / h put them.
 */
export function resolveConnector(doc: Pick<CircuitDoc, 'items' | 'symbols'> | null, s: ShapeItem): ConnectorPath {
  const route: ConnectorRoute = s.route ?? 'straight';
  const bends = s.pts ?? [];
  const A0 = { x: s.x, y: s.y };
  const B0 = { x: s.x + s.w, y: s.y + s.h };
  // a floating end heads for the next point along: the nearest bend, else the other end
  const refA = anchorOf(doc, s.from) ?? A0;
  const refB = anchorOf(doc, s.to) ?? B0;
  const a = resolveEnd(doc, s.from, A0, bends[0] ?? refB, route);
  const b = resolveEnd(doc, s.to, B0, bends[bends.length - 1] ?? refA, route);
  const through = [a.pt, ...bends.map((p) => ({ x: p.x, y: p.y })), b.pt];
  const hops: Point[][] = [];
  let segs: Seg[];
  if (route === 'curved') {
    segs = curveThrough(through, a.dir, b.dir);
    let prev = through[0];
    for (const sg of segs) {
      hops.push(sg.c1 ? [prev, ...sampleCubic(prev, sg.c1, sg.c2!, sg.to)] : [prev, sg.to]);
      prev = sg.to;
    }
  } else {
    for (let i = 0; i < through.length - 1; i++) {
      if (route !== 'elbow') hops.push([through[i], through[i + 1]]);
      else hops.push(elbowHop(through[i], i === 0 ? a.dir : null, through[i + 1], i === through.length - 2 ? b.dir : null));
    }
    const pts = route === 'elbow' ? simplify(hops.flatMap((h, i) => (i ? h.slice(1) : h))) : through;
    segs = pts.slice(1).map((to) => ({ to }));
  }
  const flat = hops.flatMap((h, i) => (i ? h.slice(1) : h));
  const start = through[0];
  const end = through[through.length - 1];
  const first = segs[0];
  const last = segs[segs.length - 1];
  const before = segs.length > 1 ? segs[segs.length - 2].to : start;
  const fallback = unit({ x: s.w || 1, y: s.h });
  const endDir = last ? dirOr(end, last.c2 ?? before, fallback) : fallback;
  const startDir = first ? dirOr(start, first.c1 ?? first.to, { x: -endDir.x, y: -endDir.y }) : { x: -fallback.x, y: -fallback.y };
  return { route, start, end, segs, through, flat, hops, startDir, endDir, mid: along(flat, 0.5) };
}

const n2 = (v: number) => Math.round(v * 100) / 100;

/** SVG path data of a connector, its ends pulled in by `trimStart` / `trimEnd` (to sit under arrowheads). */
export function connectorD(p: ConnectorPath, trimStart = 0, trimEnd = 0): string {
  const s = { x: p.start.x - p.startDir.x * trimStart, y: p.start.y - p.startDir.y * trimStart };
  const segs = p.segs.map((g, i) => (i === p.segs.length - 1 ? { ...g, to: { x: g.to.x - p.endDir.x * trimEnd, y: g.to.y - p.endDir.y * trimEnd } } : g));
  let d = `M${n2(s.x)} ${n2(s.y)}`;
  for (const g of segs) d += g.c1 && g.c2 ? `C${n2(g.c1.x)} ${n2(g.c1.y)} ${n2(g.c2.x)} ${n2(g.c2.y)} ${n2(g.to.x)} ${n2(g.to.y)}` : `L${n2(g.to.x)} ${n2(g.to.y)}`;
  return d;
}

/** Bounds of a connector's drawn path. */
export const connectorBounds = (doc: Pick<CircuitDoc, 'items' | 'symbols'> | null, s: ShapeItem): Rect => polylineBounds(resolveConnector(doc, s).flat);

/** Where on the path a new bend goes for each hop (its middle), with the index it takes in `pts`. */
export function bendSlots(p: ConnectorPath): { idx: number; pt: Point }[] {
  return p.hops.map((h, i) => ({ idx: i, pt: along(h, 0.5) }));
}

/* ------------------------------------------------------------------ */
/* Keeping the stored ends in step                                     */
/* ------------------------------------------------------------------ */

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/**
 * Lets go of one or both ends of a connector (a draft or a copy), leaving them
 * where they are now in `doc`.
 */
export function detachConnector(doc: Pick<CircuitDoc, 'items' | 'symbols'>, s: ShapeItem, ends: { from?: boolean; to?: boolean } = { from: true, to: true }) {
  const p = resolveConnector(doc, s);
  if (ends.from && s.from) {
    const endX = s.x + s.w;
    const endY = s.y + s.h;
    s.x = p.start.x;
    s.y = p.start.y;
    s.w = endX - s.x;
    s.h = endY - s.y;
    delete s.from;
  }
  if (ends.to && s.to) {
    s.w = p.end.x - s.x;
    s.h = p.end.y - s.y;
    delete s.to;
  }
}

/**
 * Brings every glued connector's stored ends up to date and drops attachments
 * whose target is gone (deleted here or by a peer). Returns `doc` itself when
 * nothing changed.
 */
export function settleConnectors(doc: CircuitDoc): CircuitDoc {
  const fixes: { id: string; x: number; y: number; w: number; h: number; dropFrom: boolean; dropTo: boolean }[] = [];
  for (const it of Object.values(doc.items)) {
    if (!isConnector(it) || (!it.from && !it.to)) continue;
    const dropFrom = !!it.from && !targetFrame(doc, doc.items[it.from.id]);
    const dropTo = !!it.to && !targetFrame(doc, doc.items[it.to.id]);
    const p = resolveConnector(doc, it);
    const w = p.end.x - p.start.x;
    const h = p.end.y - p.start.y;
    if (dropFrom || dropTo || !near(p.start.x, it.x) || !near(p.start.y, it.y) || !near(w, it.w) || !near(h, it.h)) fixes.push({ id: it.id, x: p.start.x, y: p.start.y, w, h, dropFrom, dropTo });
  }
  if (!fixes.length) return doc;
  return produce(doc, (d) => {
    for (const f of fixes) {
      const s = d.items[f.id] as ShapeItem;
      s.x = f.x;
      s.y = f.y;
      s.w = f.w;
      s.h = f.h;
      if (f.dropFrom) delete s.from;
      if (f.dropTo) delete s.to;
    }
  });
}

/** Connectors glued to any of `ids`. */
export function connectorsOf(doc: CircuitDoc, ids: Set<string>): ShapeItem[] {
  return Object.values(doc.items).filter((it): it is ShapeItem => isConnector(it) && ((!!it.from && ids.has(it.from.id)) || (!!it.to && ids.has(it.to.id))));
}
