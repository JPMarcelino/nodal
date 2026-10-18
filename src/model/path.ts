import { projectOnSegment } from './geometry';
import type { Point, Rect, ShapeItem } from './types';

/*
 * Curved outlines (paths) for polygon shapes.
 *
 * A polygon keeps its nodes in `poly` (flat [x, y, …], fractions 0–1 of the
 * box) and may carry `curve`, parallel to it with four numbers per node:
 * [inDx, inDy, outDx, outDy], the node's incoming and outgoing Bézier handles
 * as offsets from the node, also in box fractions. A zero offset means "no
 * handle", so the segment from node i to node i + 1 is a cubic with control
 * points out(i) and in(i + 1), and a plain line when neither handle is set.
 * `open` leaves out the segment from the last node back to the first (an
 * SVG-style open path; a fill still closes it, as in SVG). With neither field
 * a polygon is the plain corner list it always was.
 *
 * Because handles are box fractions like the nodes, resizing the box scales
 * them too, and any point map (move, rotate, flip, scale) is exact: a cubic
 * mapped by an affine map is the cubic of the mapped control points. The box
 * is always the true bounds of the curve (extrema included), so bounds,
 * marquee and the resize handles need nothing extra; handles may stick out of
 * it. Node kinds are not stored: a node is smooth when its two handles point
 * in opposite directions, a corner otherwise.
 */

export interface PathNode {
  x: number;
  y: number;
  /** Absolute handle positions; unset = none. */
  in?: Point;
  out?: Point;
}

export type PathFields = Pick<ShapeItem, 'x' | 'y' | 'w' | 'h' | 'poly' | 'curve' | 'open'>;

/** One stretch of the outline: a cubic from `a` to `b` (`line` when it has no handles). */
export interface PathSeg {
  a: Point;
  c1: Point;
  c2: Point;
  b: Point;
  line: boolean;
}

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
const pt = (p: Point): Point => ({ x: p.x, y: p.y });
const same = (a: Point, b: Point, eps = 1e-6) => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;

/** Fewest nodes an outline keeps (two for an open path, three for a closed one). */
export const minNodes = (open: boolean | undefined) => (open ? 2 : 3);

/** Absolute nodes (with handles) of a polygon shape. */
export function pathNodes(s: Pick<ShapeItem, 'x' | 'y' | 'w' | 'h' | 'poly' | 'curve'>): PathNode[] {
  const a = s.poly ?? [];
  const c = s.curve;
  const out: PathNode[] = [];
  for (let i = 0, k = 0; i + 1 < a.length; i += 2, k++) {
    const n: PathNode = { x: s.x + a[i] * s.w, y: s.y + a[i + 1] * s.h };
    if (c && c.length >= 4 * k + 4) {
      const [ix, iy, ox, oy] = c.slice(4 * k, 4 * k + 4);
      if (ix || iy) n.in = { x: n.x + ix * s.w, y: n.y + iy * s.h };
      if (ox || oy) n.out = { x: n.x + ox * s.w, y: n.y + oy * s.h };
    }
    out.push(n);
  }
  return out;
}

/** Whether a shape's outline has any curved stretch. */
export const isCurved = (s: Pick<ShapeItem, 'curve'>) => !!s.curve?.some((v) => v !== 0);

/** Drops handles that sit on their node (they draw nothing). */
function tidy(n: PathNode): PathNode {
  const o: PathNode = { x: n.x, y: n.y };
  if (n.in && !same(n.in, n)) o.in = pt(n.in);
  if (n.out && !same(n.out, n)) o.out = pt(n.out);
  return o;
}

/** The stretches of an outline, in order (the closing one last unless open). */
export function pathSegs(nodes: PathNode[], open?: boolean): PathSeg[] {
  const n = nodes.length;
  const out: PathSeg[] = [];
  const count = open ? n - 1 : n;
  if (n < 2) return out;
  for (let i = 0; i < count; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % n];
    out.push({ a: pt(a), c1: a.out ? pt(a.out) : pt(a), c2: b.in ? pt(b.in) : pt(b), b: pt(b), line: !a.out && !b.in });
  }
  return out;
}

export function cubicAt(s: PathSeg, t: number): Point {
  const u = 1 - t;
  const A = u * u * u, B = 3 * u * u * t, C = 3 * u * t * t, D = t * t * t;
  return { x: A * s.a.x + B * s.c1.x + C * s.c2.x + D * s.b.x, y: A * s.a.y + B * s.c1.y + C * s.c2.y + D * s.b.y };
}

/** Parameters in (0, 1) where one coordinate of a cubic turns (its extrema). */
function turns(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const q = Math.sqrt(disc);
      ts.push((-b + q) / (2 * a), (-b - q) / (2 * a));
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}

/** Exact bounds of an outline: nodes plus the extrema of every curve (not the handles). */
export function pathBounds(nodes: PathNode[], open?: boolean): Rect {
  if (!nodes.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Point) => {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  };
  nodes.forEach(add);
  for (const s of pathSegs(nodes, open)) {
    if (s.line) continue;
    for (const t of [...turns(s.a.x, s.c1.x, s.c2.x, s.b.x), ...turns(s.a.y, s.c1.y, s.c2.y, s.b.y)]) add(cubicAt(s, t));
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Box + normalized node and handle lists of an outline (the box is its true bounds). */
export function packPath(nodes: PathNode[], open?: boolean): PathFields {
  const b = pathBounds(nodes, open);
  // a flat outline still needs a box to scale with
  const w = Math.max(1, b.w);
  const h = Math.max(1, b.h);
  const ns = nodes.map(tidy);
  const out: PathFields = { x: b.x, y: b.y, w, h, poly: ns.flatMap((n) => [r5((n.x - b.x) / w), r5((n.y - b.y) / h)]) };
  if (ns.some((n) => n.in || n.out)) {
    out.curve = ns.flatMap((n) => [
      n.in ? r5((n.in.x - n.x) / w) : 0,
      n.in ? r5((n.in.y - n.y) / h) : 0,
      n.out ? r5((n.out.x - n.x) / w) : 0,
      n.out ? r5((n.out.y - n.y) / h) : 0,
    ]);
  }
  if (open) out.open = true;
  return out;
}

/** Writes an outline into a polygon shape (its box follows the curve). */
export function setPathNodes(s: ShapeItem, nodes: PathNode[], open = s.open) {
  const f = packPath(nodes, open);
  Object.assign(s, f);
  if (!f.curve) delete s.curve;
  if (!f.open) delete s.open;
}

const n2 = (v: number) => Math.round(v * 100) / 100;

/** SVG path data of an outline (`L` for straight stretches, `C` for curves). */
export function pathD(nodes: PathNode[], open?: boolean): string {
  if (!nodes.length) return '';
  const P = (p: Point) => `${n2(p.x)} ${n2(p.y)}`;
  let d = `M${P(nodes[0])}`;
  const segs = pathSegs(nodes, open);
  segs.forEach((s, i) => {
    // the closing stretch of a straight outline is drawn by Z
    if (!open && i === segs.length - 1 && s.line) return;
    d += s.line ? `L${P(s.b)}` : `C${P(s.c1)} ${P(s.c2)} ${P(s.b)}`;
  });
  return open ? d : `${d}Z`;
}

/** SVG path data of a polygon shape. */
export const polyPath = (s: Pick<ShapeItem, 'x' | 'y' | 'w' | 'h' | 'poly' | 'curve' | 'open'>): string => pathD(pathNodes(s), s.open);

/** Pieces a curve needs so the polyline strays at most `tol` from it (Wang's bound). */
function pieces(s: PathSeg, tol: number): number {
  const dx = Math.max(Math.abs(s.a.x - 2 * s.c1.x + s.c2.x), Math.abs(s.c1.x - 2 * s.c2.x + s.b.x));
  const dy = Math.max(Math.abs(s.a.y - 2 * s.c1.y + s.c2.y), Math.abs(s.c1.y - 2 * s.c2.y + s.b.y));
  return Math.min(100, Math.max(1, Math.ceil(Math.sqrt((0.75 * Math.hypot(dx, dy)) / tol))));
}

/**
 * The outline as a polyline, curves flattened to within `tol`. A closed
 * outline doesn't repeat its first point; `ts` (when given) receives, per
 * point, the stretch index + parameter it came from.
 */
export function flattenPath(nodes: PathNode[], open?: boolean, tol = 0.25, ts?: number[]): Point[] {
  if (!nodes.length) return [];
  const out: Point[] = [pt(nodes[0])];
  ts?.push(0);
  const segs = pathSegs(nodes, open);
  segs.forEach((s, i) => {
    const last = !open && i === segs.length - 1;
    const n = s.line ? 1 : pieces(s, tol);
    for (let k = 1; k <= n; k++) {
      if (last && k === n) break;
      out.push(k === n ? pt(s.b) : cubicAt(s, k / n));
      ts?.push(i + k / n);
    }
  });
  return out;
}

/** A polygon shape's outline as a polyline (curves flattened). */
export const shapeOutline = (s: Pick<ShapeItem, 'x' | 'y' | 'w' | 'h' | 'poly' | 'curve' | 'open'>, tol = 0.25): Point[] => flattenPath(pathNodes(s), s.open, tol);

export function pointInPolygon(p: Point, pts: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Whether `p` touches a polygon shape: its outline, or anywhere inside when it is filled (an open path's fill closes it). */
export function pathHit(s: ShapeItem, p: Point, tol: number): boolean {
  const pts = shapeOutline(s, 0.5);
  if (pts.length < 2) return false;
  if (s.fillOpacity > 0 && pointInPolygon(p, pts)) return true;
  const reach = tol + s.strokeWidth / 2;
  const n = s.open ? pts.length - 1 : pts.length;
  for (let i = 0; i < n; i++) if (projectOnSegment(p, pts[i], pts[(i + 1) % pts.length]).d < reach) return true;
  return false;
}

/** Nearest point of the outline to `p`: which stretch, where along it (`t`) and how far. */
export function nearestOnPath(nodes: PathNode[], open: boolean | undefined, p: Point): { seg: number; t: number; pt: Point; d: number } | null {
  const ts: number[] = [];
  const pts = flattenPath(nodes, open, 0.1, ts);
  if (pts.length < 2) return null;
  if (!open) {
    pts.push(pt(nodes[0]));
    ts.push(nodes.length);
  }
  let best: { seg: number; t: number; pt: Point; d: number } | null = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const h = projectOnSegment(p, pts[i], pts[i + 1]);
    if (best && h.d >= best.d) continue;
    const u = ts[i] + (ts[i + 1] - ts[i]) * h.t;
    const seg = Math.min(Math.floor(u), (open ? nodes.length - 1 : nodes.length) - 1);
    best = { seg, t: Math.max(0, Math.min(1, u - seg)), pt: h.pt, d: h.d };
  }
  return best;
}

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** De Casteljau split of a cubic at `t`: the two halves, each as [a, c1, c2, b]. */
export function splitCubic(s: PathSeg, t: number): [Point[], Point[]] {
  const ab = lerp(s.a, s.c1, t), bc = lerp(s.c1, s.c2, t), cd = lerp(s.c2, s.b, t);
  const abc = lerp(ab, bc, t), bcd = lerp(bc, cd, t);
  const m = lerp(abc, bcd, t);
  return [
    [s.a, ab, abc, m],
    [m, bcd, cd, s.b],
  ];
}

/** The outline with a new node on stretch `seg` at `t`; the curve keeps its exact shape. Returns the nodes and the new node's index. */
export function insertNode(nodes: PathNode[], open: boolean | undefined, seg: number, t: number): { nodes: PathNode[]; index: number } {
  const ns = nodes.map(tidy);
  const s = pathSegs(ns, open)[seg];
  if (!s) return { nodes: ns, index: -1 };
  const i = seg;
  const j = (seg + 1) % ns.length;
  if (s.line) {
    ns.splice(i + 1, 0, lerp(s.a, s.b, t));
    return { nodes: ns, index: i + 1 };
  }
  const [L, R] = splitCubic(s, t);
  ns[i] = tidy({ ...ns[i], out: L[1] });
  ns[j] = tidy({ ...ns[j], in: R[2] });
  ns.splice(i + 1, 0, tidy({ x: L[3].x, y: L[3].y, in: L[2], out: R[1] }));
  return { nodes: ns, index: i + 1 };
}

/** Removes node `index` (keeping at least two open / three closed). Returns null when it can't. */
export function removeNode(nodes: PathNode[], open: boolean | undefined, index: number): PathNode[] | null {
  if (nodes.length <= minNodes(open) || index < 0 || index >= nodes.length) return null;
  return nodes.filter((_, i) => i !== index);
}

/** Removes one node of a polygon shape. Returns whether it changed. */
export function deletePathNode(s: ShapeItem, index: number): boolean {
  const ns = removeNode(pathNodes(s), s.open, index);
  if (!ns) return false;
  setPathNodes(s, ns);
  return true;
}

/** Smooth: both handles set and pointing in opposite directions. */
export function isSmooth(n: PathNode): boolean {
  if (!n.in || !n.out) return false;
  const ax = n.in.x - n.x, ay = n.in.y - n.y, bx = n.out.x - n.x, by = n.out.y - n.y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (!la || !lb) return false;
  return (ax * bx + ay * by) / (la * lb) < -0.999;
}

/** Neighbours of node `i` (none past the ends of an open path). */
function neighbours(nodes: PathNode[], open: boolean | undefined, i: number): [PathNode | null, PathNode | null] {
  const n = nodes.length;
  const prev = i > 0 ? nodes[i - 1] : open ? null : nodes[n - 1];
  const next = i < n - 1 ? nodes[i + 1] : open ? null : nodes[0];
  return [prev, next];
}

/**
 * Makes node `i` a corner (no handles: straight stretches meet there) or
 * smooth (handles along the line through its neighbours, a third of the way to each).
 */
export function setNodeKind(nodes: PathNode[], open: boolean | undefined, i: number, kind: 'corner' | 'smooth'): PathNode[] {
  const ns = nodes.map(tidy);
  const n = ns[i];
  if (!n) return ns;
  if (kind === 'corner') {
    ns[i] = { x: n.x, y: n.y };
    return ns;
  }
  const [prev, next] = neighbours(ns, open, i);
  const dx = (next ?? n).x - (prev ?? n).x;
  const dy = (next ?? n).y - (prev ?? n).y;
  const len = Math.hypot(dx, dy);
  if (!len) return ns;
  const ux = dx / len, uy = dy / len;
  const o: PathNode = { x: n.x, y: n.y };
  if (prev) {
    const l = Math.hypot(prev.x - n.x, prev.y - n.y) / 3;
    o.in = { x: n.x - ux * l, y: n.y - uy * l };
  }
  if (next) {
    const l = Math.hypot(next.x - n.x, next.y - n.y) / 3;
    o.out = { x: n.x + ux * l, y: n.y + uy * l };
  }
  ns[i] = tidy(o);
  return ns;
}

/**
 * Node `i` with handle `which` dragged to `p`. A smooth node stays smooth (the
 * other handle swings round to stay opposite, and keeps equal length when it
 * had it) unless `free` (Alt) breaks the pair.
 */
export function dragHandle(nodes: PathNode[], i: number, which: 'in' | 'out', p: Point, free = false): PathNode[] {
  const ns = nodes.map((n) => ({ ...n }));
  const n = ns[i];
  if (!n) return ns;
  const other = which === 'in' ? 'out' : 'in';
  const o = n[other];
  const mine = n[which];
  if (!free && o && mine && isSmooth(n)) {
    const lo = Math.hypot(o.x - n.x, o.y - n.y);
    const lm = Math.hypot(mine.x - n.x, mine.y - n.y);
    const lp = Math.hypot(p.x - n.x, p.y - n.y);
    const symmetric = Math.abs(lo - lm) < 0.02 * Math.max(lo, lm);
    if (lp) {
      const l = symmetric ? lp : lo;
      n[other] = { x: n.x - ((p.x - n.x) / lp) * l, y: n.y - ((p.y - n.y) / lp) * l };
    }
  }
  n[which] = pt(p);
  ns[i] = tidy(n);
  return ns;
}

/** Node `i` moved by `d`, its handles with it. */
export function moveNode(nodes: PathNode[], i: number, d: Point): PathNode[] {
  return nodes.map((n, k) => (k === i ? mapNode(n, (q) => ({ x: q.x + d.x, y: q.y + d.y })) : { ...n }));
}

export function mapNode(n: PathNode, map: (p: Point) => Point): PathNode {
  const o: PathNode = { ...map(n) };
  if (n.in) o.in = map(n.in);
  if (n.out) o.out = map(n.out);
  return o;
}

/** Every node and handle through a point map (exact for affine maps). */
export const mapNodes = (nodes: PathNode[], map: (p: Point) => Point): PathNode[] => nodes.map((n) => mapNode(n, map));

/* ------------------------------ building outlines ------------------------------ */

/**
 * An elliptical arc from `a0` to `a1` (degrees, clockwise from +x on screen) as
 * nodes with handles, one cubic per quarter turn at most. The ends carry only
 * their inward handle.
 */
export function arcNodes(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): PathNode[] {
  const sweep = a1 - a0;
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / 90 - 1e-9));
  const step = ((sweep / n) * Math.PI) / 180;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: PathNode[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (a0 * Math.PI) / 180 + i * step;
    const c = Math.cos(a), s = Math.sin(a);
    const node: PathNode = { x: cx + rx * c, y: cy + ry * s };
    // derivative of the arc, scaled for this piece
    const tx = -rx * s * k, ty = ry * c * k;
    if (i > 0) node.in = { x: node.x - tx, y: node.y - ty };
    if (i < n) node.out = { x: node.x + tx, y: node.y + ty };
    out.push(node);
  }
  return out;
}

/** Runs of nodes joined into one outline; where one run starts on the last node of the one before, the two become one node. */
export function joinNodes(...runs: PathNode[][]): PathNode[] {
  const out: PathNode[] = [];
  for (const run of runs)
    for (const n of run) {
      const last = out[out.length - 1];
      if (last && same(last, n, 1e-9)) out[out.length - 1] = { x: last.x, y: last.y, ...(last.in ? { in: last.in } : {}), ...(n.out ? { out: n.out } : {}) };
      else out.push({ ...n });
    }
  return out;
}

/** A closed outline whose last node lands on its first: the two become one node. */
export function closeLoop(nodes: PathNode[]): PathNode[] {
  const ns = nodes.map((n) => ({ ...n }));
  if (ns.length > 1 && same(ns[0], ns[ns.length - 1], 1e-9)) {
    const last = ns.pop()!;
    if (last.in) ns[0].in = last.in;
    else delete ns[0].in;
  }
  return ns;
}

/** A full ellipse in its box: four quarter arcs, starting at the top. */
export const ellipseNodes = (r: Rect): PathNode[] => closeLoop(arcNodes(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, -90, 270));

/** A rectangle with corner radius `radius`, drawn as SVG draws `rx` (each side clamps it to half the box). */
export function roundedRectNodes(r: Rect, radius: number): PathNode[] {
  const rx = Math.max(0, Math.min(radius, r.w / 2));
  const ry = Math.max(0, Math.min(radius, r.h / 2));
  const { x, y, w, h } = r;
  if (!rx || !ry)
    return [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
  return closeLoop(
    joinNodes(
      arcNodes(x + w - rx, y + ry, rx, ry, -90, 0),
      arcNodes(x + w - rx, y + h - ry, rx, ry, 0, 90),
      arcNodes(x + rx, y + h - ry, rx, ry, 90, 180),
      arcNodes(x + rx, y + ry, rx, ry, 180, 270),
      [{ x: x + w - rx, y }],
    ),
  );
}

/** An outline fitted to the unit box, as preset fields (`poly`, `curve`, `open`). */
export function unitPath(nodes: PathNode[], open?: boolean): Pick<ShapeItem, 'poly' | 'curve' | 'open'> {
  const b = pathBounds(nodes, open);
  // blown up first: packPath never lets a box side drop below 1
  const k = 1000 / Math.max(b.w, b.h, 1e-9);
  const f = packPath(mapNodes(nodes, (p) => ({ x: p.x * k, y: p.y * k })), open);
  return { poly: f.poly, ...(f.curve ? { curve: f.curve } : {}), ...(f.open ? { open: true } : {}) };
}

/* ------------------------------ convert to path ------------------------------ */

/** Kinds "Convert to path" handles: boxes, ellipses, and lines / arrows not glued to anything. */
export const canConvertToPath = (s: ShapeItem): boolean =>
  s.kind === 'rect' || s.kind === 'zone' || s.kind === 'ellipse' || ((s.kind === 'line' || s.kind === 'arrow') && !s.from && !s.to);

/**
 * Turns a shape into an editable polygon outline that draws the same: a
 * rectangle (rounded corners as quarter ellipses), an ellipse (four cubic
 * arcs) or a loose line / arrow (`conn`: its drawn path, bends and curves
 * kept; the heads are dropped). A turn is baked into the nodes. The id stays,
 * so connectors glued to it stay glued. Returns whether it changed.
 */
export function convertToPath(s: ShapeItem, conn?: { start: Point; segs: { to: Point; c1?: Point; c2?: Point }[] }): boolean {
  if (!canConvertToPath(s)) return false;
  const box = { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) };
  let nodes: PathNode[];
  let open = false;
  if (s.kind === 'ellipse') nodes = ellipseNodes(box);
  else if (s.kind === 'rect' || s.kind === 'zone') nodes = roundedRectNodes(box, s.radius);
  else {
    if (!conn) return false;
    nodes = [{ x: conn.start.x, y: conn.start.y }];
    for (const g of conn.segs) {
      const last = nodes[nodes.length - 1];
      if (g.c1) last.out = pt(g.c1);
      nodes.push({ x: g.to.x, y: g.to.y, ...(g.c2 ? { in: pt(g.c2) } : {}) });
    }
    nodes = joinNodes(nodes);
    open = true;
  }
  const rot = s.kind === 'line' || s.kind === 'arrow' ? 0 : s.rot ?? 0;
  if (rot) {
    const a = (rot * Math.PI) / 180;
    const c = Math.cos(a), sn = Math.sin(a);
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    nodes = mapNodes(nodes, (p) => ({ x: cx + (p.x - cx) * c - (p.y - cy) * sn, y: cy + (p.x - cx) * sn + (p.y - cy) * c }));
  }
  if (nodes.length < 2) return false;
  // a box's title sat top left; keep it there
  if (s.text && (s.kind === 'rect' || s.kind === 'zone')) {
    s.align ??= 'start';
    s.valign ??= 'top';
  }
  // the old kind's line ends and corners (polygons default to round joins)
  if (s.kind === 'line' || s.kind === 'arrow') s.cap ??= 'round';
  s.join ??= 'miter';
  if (open) {
    s.fill = 'none';
    s.fillOpacity = 0;
  }
  s.kind = 'polygon';
  s.radius = 0;
  for (const k of ['rot', 'container', 'header', 'pts', 'from', 'to', 'route', 'headStart', 'headEnd', 'headSize'] as const) delete s[k];
  setPathNodes(s, nodes, open);
  return true;
}
