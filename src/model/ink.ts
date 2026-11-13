import { projectOnSegment } from './geometry';
import type { Point, ShapeItem } from './types';

/** A sampled pen point: position plus pen pressure (0–1; mice report 0.5). */
export interface InkPoint {
  x: number;
  y: number;
  p: number;
}

/** Colours offered by the explain tools; the first one is the theme-aware "ink" (black on paper). */
export const EXPLAIN_COLORS = ['#000000', '#f03e3e', '#fd7e14', '#fab005', '#2fb344', '#228be6', '#ae3ec9'];
export const HIGHLIGHTER_COLOR = '#fab005';

/* ------------------------------------------------------------------ */
/* Storage: points live as fractions of the shape box                  */
/* ------------------------------------------------------------------ */

/** Turns absolute points into an ink shape's box + normalized point list. */
export function packInk(pts: InkPoint[]): Pick<ShapeItem, 'x' | 'y' | 'w' | 'h' | 'ink'> {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  // a perfectly straight stroke still needs a box to scale with
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  const ink: number[] = [];
  for (const p of pts) ink.push(r((p.x - x0) / w), r((p.y - y0) / h), r(p.p));
  return { x: x0, y: y0, w, h, ink };
}

/** Absolute points of an ink shape (follows the box when it is moved or resized). */
export function inkPoints(s: Pick<ShapeItem, 'x' | 'y' | 'w' | 'h' | 'ink'>): InkPoint[] {
  const a = s.ink ?? [];
  const out: InkPoint[] = [];
  for (let i = 0; i + 2 < a.length; i += 3) out.push({ x: s.x + a[i] * s.w, y: s.y + a[i + 1] * s.h, p: a[i + 2] });
  return out;
}

/** Whether `p` touches the stroke (within `tol` of its centre line, plus half the stroke width). */
export function inkHit(s: ShapeItem, p: Point, tol: number): boolean {
  const pts = inkPoints(s);
  const reach = tol + s.strokeWidth / 2;
  if (pts.length === 1) return Math.hypot(pts[0].x - p.x, pts[0].y - p.y) < reach;
  for (let i = 1; i < pts.length; i++) if (projectOnSegment(p, pts[i - 1], pts[i]).d < reach) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Rendering: tapered, pressure-sensitive outline                      */
/* ------------------------------------------------------------------ */

/** Light smoothing that removes mouse jitter but keeps corners readable. */
function smooth(pts: InkPoint[], minGap: number): InkPoint[] {
  const out: InkPoint[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= minGap) out.push({ ...p });
  }
  if (pts.length > 1 && out.length) {
    const end = pts[pts.length - 1];
    const last = out[out.length - 1];
    if (last.x !== end.x || last.y !== end.y) out.push({ ...end });
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < out.length - 1; i++) {
      out[i].x = (out[i - 1].x + out[i].x * 2 + out[i + 1].x) / 4;
      out[i].y = (out[i - 1].y + out[i].y * 2 + out[i + 1].y) / 4;
    }
  }
  return out;
}

const f = (n: number) => Math.round(n * 100) / 100;

/** Smooth centre-line path (quadratic curves through the midpoints). */
export function inkCenterPath(raw: InkPoint[], minGap = 0.5): string {
  const pts = smooth(raw, minGap);
  if (!pts.length) return '';
  if (pts.length === 1) return `M${f(pts[0].x)},${f(pts[0].y)}l0.01,0`;
  let d = `M${f(pts[0].x)},${f(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    d += `Q${f(pts[i].x)},${f(pts[i].y)} ${f(mx)},${f(my)}`;
  }
  const last = pts[pts.length - 1];
  return d + `L${f(last.x)},${f(last.y)}`;
}

/** Whether a stroke carries real stylus pressure (mice and fingers report a flat 0.5). */
const hasPressure = (pts: InkPoint[]) => pts.some((p) => Math.abs(p.p - 0.5) > 0.02);

/**
 * Half-width of the stroke at each (smoothed) point, before the end tapers:
 * real pressure where a stylus gives it, otherwise a little thinner where
 * the pen moves fast.
 */
function strokeRadii(pts: InkPoint[], R: number, size: number, realPressure: boolean, startR = R): number[] {
  const radii: number[] = [];
  let prevR = startR;
  for (let i = 0; i < pts.length; i++) {
    let r: number;
    if (realPressure) r = R * (0.3 + pts[i].p * 0.95);
    else {
      const speed = i ? Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) : 0;
      const target = R * Math.max(0.55, 1 - Math.min(1, speed / (size * 5)) * 0.45);
      r = prevR + (target - prevR) * 0.35;
    }
    prevR = r;
    radii.push(r);
  }
  return radii;
}

/**
 * Width a hand-drawn stroke of pen size `size` looks like on average: what a
 * shape it snaps into keeps, so cleaning a scribble up doesn't change its weight.
 */
export function inkAverageWidth(raw: InkPoint[], size: number): number {
  const pts = smooth(raw, Math.max(0.35, size * 0.12));
  if (pts.length < 2) return size;
  const radii = strokeRadii(pts, size / 2, size, hasPressure(pts));
  // the middle of the stroke: its ends are still speeding up or slowing down
  const mid = radii.slice(Math.floor(radii.length * 0.15), Math.ceil(radii.length * 0.85));
  const mean = (mid.length ? mid : radii).reduce((a, b) => a + b, 0) / (mid.length || radii.length);
  return Math.max(size * 0.45, Math.min(size * 1.25, mean * 2));
}

/**
 * Filled outline of a hand-drawn stroke: thinner where the pen moves fast,
 * tapered at both ends, following real pressure when a stylus provides it.
 * A `uniform` stroke (a scribble snapped into a clean shape) is the same
 * width all along, with round ends.
 */
export function inkOutline(
  raw: InkPoint[],
  size: number,
  opts: {
    taper?: boolean;
    pressure?: boolean;
    uniform?: boolean;
    /** Pieces of a longer stroke (see LiveInkOutline): which ends taper, over what length, and the width carried in. */
    taperStart?: boolean;
    taperEnd?: boolean;
    taperLen?: number;
    startR?: number;
    /** Receives the width at the last point (before tapering), to carry into the next piece. */
    out?: { lastR: number };
  } = {},
): string {
  const pts = smooth(raw, Math.max(0.35, size * 0.12));
  const R = size / 2;
  if (!pts.length) return '';
  if (pts.length === 1) {
    const { x, y } = pts[0];
    return `M${f(x - R)},${f(y)}a${f(R)},${f(R)} 0 1,0 ${f(2 * R)},0a${f(R)},${f(R)} 0 1,0 ${f(-2 * R)},0Z`;
  }
  // cumulative length, for the end tapers
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = len[len.length - 1];
  const taperLen = opts.taper === false || opts.uniform ? 0 : (opts.taperLen ?? Math.min(total * 0.22, size * 4));
  const realPressure = opts.pressure ?? hasPressure(pts);
  const radii = opts.uniform ? pts.map(() => R) : strokeRadii(pts, R, size, realPressure, opts.startR);
  if (opts.out) opts.out.lastR = radii[radii.length - 1];
  const ease = (t: number) => 0.3 + 0.7 * Math.sin((Math.min(1, t) * Math.PI) / 2);
  const tStart = opts.taperStart !== false;
  const tEnd = opts.taperEnd !== false;
  for (let i = 0; i < pts.length; i++) {
    let r = radii[i];
    if (taperLen > 0) {
      r *= Math.min(tStart ? ease(len[i] / taperLen) : 1, tEnd ? ease((total - len[i]) / taperLen) * 0.85 + 0.15 : 1);
    }
    radii[i] = Math.max(0.2, r);
  }
  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    left.push({ x: pts[i].x - dy * radii[i], y: pts[i].y + dx * radii[i] });
    right.push({ x: pts[i].x + dy * radii[i], y: pts[i].y - dx * radii[i] });
  }
  const curve = (side: Point[]) => {
    let d = '';
    for (let i = 1; i < side.length - 1; i++) {
      const mx = (side[i].x + side[i + 1].x) / 2;
      const my = (side[i].y + side[i + 1].y) / 2;
      d += `Q${f(side[i].x)},${f(side[i].y)} ${f(mx)},${f(my)}`;
    }
    const last = side[side.length - 1];
    return d + `L${f(last.x)},${f(last.y)}`;
  };
  const rEnd = radii[radii.length - 1];
  const rStart = radii[0];
  const rr = [...right].reverse();
  return (
    `M${f(left[0].x)},${f(left[0].y)}` +
    curve(left) +
    `A${f(rEnd)},${f(rEnd)} 0 0,0 ${f(rr[0].x)},${f(rr[0].y)}` +
    curve(rr) +
    `A${f(rStart)},${f(rStart)} 0 0,0 ${f(left[0].x)},${f(left[0].y)}Z`
  );
}

/**
 * The outline of a stroke still being drawn, built in pieces so a long stroke
 * costs no more per frame than a short one: stretches well behind the pen
 * are frozen into their own paths once (round ends, overlapping, so the
 * joins don't show) and only the stretch near the pen is redrawn.
 */
export class LiveInkOutline {
  /** Finished pieces, oldest first. */
  frozen: string[] = [];
  private from = 0;
  private r: number | undefined;
  private len: number[] = [0];
  private pressure = false;
  constructor(private size: number) {}

  /** Outline of the stretch still changing; may first freeze a piece (`frozen` grows). */
  tail(pts: InkPoint[]): string {
    const len = this.len;
    for (let i = len.length; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const total = len[pts.length - 1] ?? 0;
    const taperLen = this.size * 4;
    this.pressure ||= hasPressure(pts.slice(this.from));
    // freeze once the full end taper is settled and there is a good stretch behind the pen
    if (total * 0.22 >= taperLen && pts.length - this.from > LIVE_PIECE * 2) {
      let to = pts.length - LIVE_PIECE;
      while (to > this.from && total - len[to] < taperLen * 1.5) to--;
      if (to - this.from > LIVE_PIECE) {
        const out = { lastR: 0 };
        const opts = { taperStart: this.from === 0, taperEnd: false, taperLen, startR: this.r, pressure: this.pressure, out };
        this.frozen.push(inkOutline(pts.slice(this.from, to + 1), this.size, opts));
        this.r = out.lastR;
        this.from = to - LIVE_OVERLAP;
      }
    }
    if (!this.from) return inkOutline(pts, this.size);
    return inkOutline(pts.slice(this.from), this.size, { taperStart: false, taperLen, startR: this.r, pressure: this.pressure });
  }
}
const LIVE_PIECE = 160;
const LIVE_OVERLAP = 6;

/** Snapped shapes drawn as a closed loop (no seam where the stroke meets itself). */
export const closedInkShape = (kind: InkShape) => kind === 'ellipse' || kind === 'rect' || kind === 'polygon';

/**
 * Centre line of a snapped shape, drawn with an even stroke: straight runs
 * between its points, closed for an ellipse, a box or a polygon so there is no seam.
 */
export function inkShapePath(pts: Point[], kind: InkShape): string {
  if (!pts.length) return '';
  const body = pts.map((p, i) => `${i ? 'L' : 'M'}${f(p.x)},${f(p.y)}`).join('');
  return closedInkShape(kind) ? body + 'Z' : body;
}

/* ------------------------------------------------------------------ */
/* Hold-to-snap shape recognition                                      */
/* ------------------------------------------------------------------ */

export type InkShape = NonNullable<ShapeItem['inkShape']>;

/** A recognised shape in its own terms, so it can be regenerated scaled, turned or made perfect. */
export type InkShapeParams =
  | { kind: 'line'; a: Point; b: Point }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; start: number; rot?: number }
  | { kind: 'rect'; cx: number; cy: number; rx: number; ry: number; start: number; rot?: number }
  /** Straight runs through `pts` (open), or a closed polygon through them (not repeating the first). */
  | { kind: 'polyline' | 'polygon'; pts: Point[] }
  /** Straight runs ending in an arrowhead `head` long at the last point. */
  | { kind: 'arrow'; pts: Point[]; head: number }
  /** Part of a circle: from angle `a0`, turning `sweep` radians (signed). */
  | { kind: 'arc'; cx: number; cy: number; r: number; a0: number; sweep: number };

const ARROW_HEAD_ANGLE = (28 * Math.PI) / 180;

function arcPoints(sp: Extract<InkShapeParams, { kind: 'arc' }>): Point[] {
  const n = Math.max(8, Math.ceil((Math.abs(sp.sweep) / (Math.PI * 2)) * 96));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = sp.a0 + (sp.sweep * i) / n;
    return { x: sp.cx + sp.r * Math.cos(a), y: sp.cy + sp.r * Math.sin(a) };
  });
}

function boxCentre(pts: Point[]): Point {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
}

/** Centre of a recognised shape (a line's middle, the middle of a polygon's or arc's box). */
export function shapeCentre(sp: InkShapeParams): Point {
  switch (sp.kind) {
    case 'line':
      return { x: (sp.a.x + sp.b.x) / 2, y: (sp.a.y + sp.b.y) / 2 };
    case 'ellipse':
    case 'rect':
      return { x: sp.cx, y: sp.cy };
    case 'arc':
      return boxCentre(arcPoints(sp));
    default:
      return boxCentre(sp.pts);
  }
}

/** Whether the shape's last point follows the pen while it is held after snapping (open runs), rather than scaling and turning. */
export const shapeEndFollows = (sp: InkShapeParams) => sp.kind === 'line' || sp.kind === 'polyline' || sp.kind === 'arrow';

/** The shape with its last point moved to `p` (lines, polylines and arrows). */
export function moveShapeEnd(sp: InkShapeParams, p: Point): InkShapeParams {
  if (sp.kind === 'line') return { ...sp, b: p };
  if (sp.kind === 'polyline' || sp.kind === 'arrow') return { ...sp, pts: [...sp.pts.slice(0, -1), p] };
  return sp;
}

/** The point before the last of an open shape (where its last run starts). */
export function shapeEndAnchor(sp: InkShapeParams): Point | null {
  if (sp.kind === 'line') return sp.a;
  if (sp.kind === 'polyline' || sp.kind === 'arrow') return sp.pts[sp.pts.length - 2] ?? null;
  return null;
}

/** A regular polygon (or a regular star, when the corners alternate in and out) through roughly the same corners. */
function regularize(pts: Point[]): Point[] {
  const n = pts.length;
  const c = { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
  const r = pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y));
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  const dir = area < 0 ? -1 : 1;
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
  let radii = pts.map(() => mean(r));
  if (n % 2 === 0 && n >= 6) {
    const even = mean(r.filter((_, i) => i % 2 === 0));
    const odd = mean(r.filter((_, i) => i % 2 === 1));
    if (Math.min(even, odd) < Math.max(even, odd) * 0.8) radii = pts.map((_, i) => (i % 2 ? odd : even));
  }
  const a0 = Math.atan2(pts[0].y - c.y, pts[0].x - c.x);
  return pts.map((_, i) => {
    const a = a0 + (dir * i * Math.PI * 2) / n;
    return { x: c.x + radii[i] * Math.cos(a), y: c.y + radii[i] * Math.sin(a) };
  });
}

/** Every run turned to the nearest 15°, keeping its length. */
function squareRuns(pts: Point[]): Point[] {
  const step = Math.PI / 12;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const a = Math.round(Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x) / step) * step;
    const last = out[i - 1];
    out.push({ x: last.x + Math.cos(a) * l, y: last.y + Math.sin(a) * l });
  }
  return out;
}

/** The two barbs of an arrowhead at `tip`, coming from `from`. */
export function arrowHead(from: Point, tip: Point, len: number): [Point, Point] {
  const a = Math.atan2(from.y - tip.y, from.x - tip.x);
  const at = (d: number) => ({ x: tip.x + Math.cos(a + d) * len, y: tip.y + Math.sin(a + d) * len });
  return [at(ARROW_HEAD_ANGLE), at(-ARROW_HEAD_ANGLE)];
}

/**
 * Points of a recognised shape, optionally scaled and turned about its centre;
 * `perfect` makes an ellipse a circle, a box a square, a polygon regular and
 * turns the runs of a polyline or arrow to 15° steps. Closed shapes end where
 * they start. An arrow's head is drawn as tip → barb → tip → barb after its shaft.
 */
export function shapePoints(sp: InkShapeParams, t: { scale?: number; rot?: number; perfect?: boolean } = {}): InkPoint[] {
  const p = 0.5;
  const k = t.scale ?? 1;
  const rot = t.rot ?? 0;
  const c = shapeCentre(sp);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const place = (x: number, y: number): InkPoint => ({ x: c.x + (x * cos - y * sin) * k, y: c.y + (x * sin + y * cos) * k, p });
  const placeAbs = (q: Point) => place(q.x - c.x, q.y - c.y);
  switch (sp.kind) {
    case 'line':
      return [placeAbs(sp.a), placeAbs(sp.b)];
    case 'polyline':
      return (t.perfect ? squareRuns(sp.pts) : sp.pts).map(placeAbs);
    case 'polygon': {
      const v = (t.perfect ? regularize(sp.pts) : sp.pts).map(placeAbs);
      return [...v, { ...v[0] }];
    }
    case 'arrow': {
      const shaft = (t.perfect ? squareRuns(sp.pts) : sp.pts).map(placeAbs);
      const tip = shaft[shaft.length - 1];
      const [h1, h2] = arrowHead(shaft[shaft.length - 2], tip, sp.head * k);
      return [...shaft, { ...h1, p }, { ...tip }, { ...h2, p }];
    }
    case 'arc':
      return arcPoints(sp).map(placeAbs);
  }
  const big = Math.max(sp.rx, sp.ry);
  const rx = t.perfect ? big : sp.rx;
  const ry = t.perfect ? big : sp.ry;
  // the shape's own tilt, then the turn and scale about its centre
  const own = sp.rot ?? 0;
  const oc = Math.cos(own);
  const os = Math.sin(own);
  const tilt = (x: number, y: number) => place(x * oc - y * os, x * os + y * oc);
  const out: InkPoint[] = [];
  if (sp.kind === 'ellipse') {
    // start where the user started, so the stroke closes where the pen went down
    for (let i = 0; i <= 96; i++) {
      const a = sp.start + (i / 96) * Math.PI * 2;
      out.push(tilt(rx * Math.cos(a), ry * Math.sin(a)));
    }
    return out;
  }
  const corners = [
    { x: -rx, y: -ry },
    { x: rx, y: -ry },
    { x: rx, y: ry },
    { x: -rx, y: ry },
  ];
  // dense edges, so smoothing only softens the corners a touch; start at the corner nearest the pen-down point
  const first = sp.start;
  for (let i = 0; i < 4; i++) {
    const from = corners[(first + i) % 4];
    const to = corners[(first + i + 1) % 4];
    for (let n = 0; n < 16; n++) out.push(tilt(from.x + ((to.x - from.x) * n) / 16, from.y + ((to.y - from.y) * n) / 16));
  }
  out.push(tilt(corners[first].x, corners[first].y));
  return out;
}

/* ----------------------------- fitting ----------------------------- */

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** `n` points evenly spaced along the stroke. */
function resample(pts: Point[], n: number): Point[] {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  const out: Point[] = [{ x: pts[0].x, y: pts[0].y }];
  if (!total) return out;
  const step = total / (n - 1);
  let prev: Point = pts[0];
  let acc = 0;
  let i = 1;
  while (i < pts.length && out.length < n - 1) {
    const cur = pts[i];
    const d = dist(prev, cur);
    if (d > 0 && acc + d >= step) {
      const t = (step - acc) / d;
      const q = { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t };
      out.push(q);
      prev = q;
      acc = 0;
    } else {
      acc += d;
      prev = cur;
      i++;
    }
  }
  const end = pts[pts.length - 1];
  out.push({ x: end.x, y: end.y });
  return out;
}

/** Ramer–Douglas–Peucker: indices of the corners that keep every point within `eps`. */
function rdp(pts: Point[], eps: number): number[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    let best = -1;
    let bd = eps;
    for (let i = i0 + 1; i < i1; i++) {
      const d = projectOnSegment(pts[i], pts[i0], pts[i1]).d;
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i0, best], [best, i1]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => k && out.push(i));
  return out;
}

/** Turn at `b` between the runs a→b and b→c (0 = straight on, π = straight back). */
function turnAt(a: Point, b: Point, c: Point): number {
  const a1 = Math.atan2(b.y - a.y, b.x - a.x);
  const a2 = Math.atan2(c.y - b.y, c.x - b.x);
  let d = Math.abs(a2 - a1);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

/** Drops corners where the stroke hardly turns or which sit right next to the one before. */
function pruneCorners(pts: Point[], idx: number[], closed: boolean, minGap: number): number[] {
  let out = idx.slice();
  for (let changed = true; changed && out.length > (closed ? 3 : 2); ) {
    changed = false;
    const n = out.length;
    for (let j = closed ? 0 : 1; j < (closed ? n : n - 1); j++) {
      const a = pts[out[(j - 1 + n) % n]];
      const b = pts[out[j]];
      const c = pts[out[(j + 1) % n]];
      // …or a short side between two half-turns: one rounded-off corner seen as two
      const shortSide = closed && n > 3 && dist(a, b) < minGap * 1.6 && dist(a, b) < 0.3 * Math.min(dist(pts[out[(j - 2 + n) % n]], a), dist(b, c));
      if (turnAt(a, b, c) < (20 * Math.PI) / 180 || dist(a, b) < minGap || shortSide) {
        out = out.filter((_, k) => k !== j);
        changed = true;
        break;
      }
    }
  }
  return out;
}

interface Line {
  c: Point;
  d: Point;
}

/** Best straight line through `pts`, its direction squared up when within 6° of level or upright. */
function fitLine(pts: Point[]): Line {
  const n = pts.length;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x / n;
    my += p.y / n;
  }
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  let a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(a - q) < (6 * Math.PI) / 180) a = q;
  return { c: { x: mx, y: my }, d: { x: Math.cos(a), y: Math.sin(a) } };
}

function intersect(l1: Line, l2: Line): Point | null {
  const cross = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
  if (Math.abs(cross) < Math.sin((12 * Math.PI) / 180)) return null;
  const t = ((l2.c.x - l1.c.x) * l2.d.y - (l2.c.y - l1.c.y) * l2.d.x) / cross;
  return { x: l1.c.x + l1.d.x * t, y: l1.c.y + l1.d.y * t };
}

const projectOnLine = (p: Point, l: Line): Point => {
  const t = (p.x - l.c.x) * l.d.x + (p.y - l.c.y) * l.d.y;
  return { x: l.c.x + l.d.x * t, y: l.c.y + l.d.y * t };
};

/**
 * Crisp corners: a straight line fitted to each run between corners (its
 * rounded-off ends left out), neighbouring lines meeting at the corner.
 */
function refineCorners(pts: Point[], idx: number[], closed: boolean, reach: number): Point[] {
  const n = idx.length;
  const runs = closed ? n : n - 1;
  const lines: Line[] = [];
  for (let k = 0; k < runs; k++) {
    const i0 = idx[k];
    let i1 = idx[(k + 1) % n];
    if (i1 <= i0) i1 += pts.length;
    const span = i1 - i0;
    const trim = Math.floor(span * 0.2);
    const run: Point[] = [];
    for (let i = i0 + trim; i <= i1 - trim; i++) run.push(pts[i % pts.length]);
    lines.push(fitLine(run.length >= 2 ? run : [pts[i0], pts[i1 % pts.length]]));
  }
  return idx.map((i, k) => {
    const raw = pts[i];
    if (!closed && k === 0) return projectOnLine(raw, lines[0]);
    if (!closed && k === n - 1) return projectOnLine(raw, lines[runs - 1]);
    const x = intersect(lines[(k - 1 + runs) % runs], lines[k % runs]);
    return x && dist(x, raw) < reach ? x : raw;
  });
}

/**
 * Whether the stroke runs straight between its corners rather than bowing
 * (a lumpy circle also fits a polygon, but each of its sides is a curve).
 */
function straightRuns(pts: Point[], idx: number[], closed: boolean): boolean {
  let bow = 0;
  const runs = closed ? idx.length : idx.length - 1;
  for (let k = 0; k < runs; k++) {
    const i0 = idx[k];
    let i1 = idx[(k + 1) % idx.length];
    if (i1 <= i0) i1 += pts.length;
    // the middle of each side: hand-drawn corners are rounded off
    const trim = Math.floor((i1 - i0) * 0.2);
    const a = pts[(i0 + trim) % pts.length];
    const b = pts[(i1 - trim) % pts.length];
    const len = dist(a, b) || 1;
    let sum = 0;
    let n = 0;
    for (let i = i0 + trim + 1; i < i1 - trim; i++) {
      const p = pts[i % pts.length];
      sum += Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / len;
      n++;
    }
    bow += n ? sum / n / len : 0;
  }
  return bow / runs < 0.03;
}

/** refineCorners, dropping any corner the clean lines barely turn at (and refitting without it). */
function cleanCorners(pts: Point[], idx: number[], closed: boolean, reach: number): { idx: number[]; v: Point[] } {
  for (;;) {
    const v = refineCorners(pts, idx, closed, reach);
    const n = v.length;
    if (n <= (closed ? 3 : 2)) return { idx, v };
    let drop = -1;
    for (let j = closed ? 0 : 1; j < (closed ? n : n - 1) && drop < 0; j++) {
      if (turnAt(v[(j - 1 + n) % n], v[j], v[(j + 1) % n]) < (22 * Math.PI) / 180) drop = j;
    }
    if (drop < 0) return { idx, v };
    idx = idx.filter((_, k) => k !== drop);
  }
}

/** Mean distance from the stroke's points to the straight runs through `v`. */
function runsError(pts: Point[], v: Point[], closed: boolean): number {
  const segs = closed ? v.length : v.length - 1;
  let sum = 0;
  for (const p of pts) {
    let best = Infinity;
    for (let k = 0; k < segs; k++) best = Math.min(best, projectOnSegment(p, v[k], v[(k + 1) % v.length]).d);
    sum += best;
  }
  return sum / pts.length;
}

/** Ellipse along the stroke's main axes (or level, whichever fits better), with its mean distance from the stroke. */
function fitEllipse(pts: Point[]): { cx: number; cy: number; rx: number; ry: number; rot: number; err: number } {
  const n = pts.length;
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x / n;
    cy += p.y / n;
  }
  const line = fitLine(pts);
  const tilted = Math.atan2(line.d.y, line.d.x);
  let best = { cx, cy, rx: 1, ry: 1, rot: 0, err: Infinity };
  for (const rot of tilted ? [0, tilted] : [0]) {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of pts) {
      const u = (p.x - cx) * c + (p.y - cy) * s;
      const v = -(p.x - cx) * s + (p.y - cy) * c;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const rx = (u1 - u0) / 2 || 1;
    const ry = (v1 - v0) / 2 || 1;
    const mu = (u0 + u1) / 2;
    const mv = (v0 + v1) / 2;
    const ex = cx + mu * c - mv * s;
    const ey = cy + mu * s + mv * c;
    let err = 0;
    for (const p of pts) {
      const u = (p.x - ex) * c + (p.y - ey) * s;
      const v = -(p.x - ex) * s + (p.y - ey) * c;
      err += Math.abs(Math.hypot(u / rx, v / ry) - 1) * ((rx + ry) / 2);
    }
    err /= n;
    if (err < best.err) best = { cx: ex, cy: ey, rx, ry, rot, err };
  }
  return best;
}

/** Least-squares circle (Kåsa) through the stroke, with its mean distance from it and how far round it turns. */
function fitArc(pts: Point[]): { cx: number; cy: number; r: number; a0: number; sweep: number; err: number } | null {
  // solve x² + y² + D x + E y + F = 0, shifted to the stroke's mean for precision
  const n = pts.length;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x / n;
    my += p.y / n;
  }
  let suu = 0;
  let svv = 0;
  let suv = 0;
  let suuu = 0;
  let svvv = 0;
  let suvv = 0;
  let svuu = 0;
  for (const p of pts) {
    const u = p.x - mx;
    const v = p.y - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const bu = (suuu + suvv) / 2;
  const bv = (svvv + svuu) / 2;
  const uc = (bu * svv - bv * suv) / det;
  const vc = (bv * suu - bu * suv) / det;
  const cx = uc + mx;
  const cy = vc + my;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  let err = 0;
  let sweep = 0;
  let prev = Math.atan2(pts[0].y - cy, pts[0].x - cx);
  const a0 = prev;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    err += Math.abs(Math.hypot(p.x - cx, p.y - cy) - r);
    if (i) {
      const a = Math.atan2(p.y - cy, p.x - cx);
      let d = a - prev;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      sweep += d;
      prev = a;
    }
  }
  return { cx, cy, r, a0, sweep, err: err / n };
}

/** An arrow: straight runs whose last one (or last three, there and back) are a short barb folded back at the tip. */
function asArrow(v: Point[]): { pts: Point[]; head: number } | null {
  const barb = (from: Point, tip: Point, end: Point) => {
    const shaft = dist(from, tip);
    const len = dist(tip, end);
    return len < shaft * 0.5 && turnAt(from, tip, end) > (115 * Math.PI) / 180 ? len : 0;
  };
  const m = v.length;
  // there and back: … tip, barb, tip, barb
  if (m >= 5) {
    const tip = v[m - 4];
    const b1 = barb(v[m - 5], tip, v[m - 3]);
    const b2 = barb(v[m - 5], tip, v[m - 1]);
    if (b1 && b2 && dist(v[m - 2], tip) < Math.max(b1, b2) * 0.45) return { pts: v.slice(0, m - 3), head: (b1 + b2) / 2 };
  }
  if (m >= 3) {
    const b = barb(v[m - 3], v[m - 2], v[m - 1]);
    if (b) return { pts: v.slice(0, m - 1), head: b };
  }
  return null;
}

/**
 * Cleans up a scribble into the shape it most looks like. A closed loop
 * becomes an ellipse, a box (level or turned) or a polygon (triangle,
 * diamond, pentagon, star, …); an open stroke a straight line, an arrow, a
 * run of straight lines or an arc. A loose scribble that fits none of them
 * well gives null.
 */
export function recognizeShape(raw: InkPoint[]): InkShapeParams | null {
  if (raw.length < 2) return null;
  const a = raw[0];
  const b = raw[raw.length - 1];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let pathLen = 0;
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
    if (i) pathLen += Math.hypot(p.x - raw[i - 1].x, p.y - raw[i - 1].y);
  }
  const w = x1 - x0;
  const h = y1 - y0;
  const diag = Math.hypot(w, h);
  if (diag < 4) return null;
  const line: InkShapeParams = { kind: 'line', a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
  const pts = resample(raw, 128);
  const eps = Math.max(1, diag * 0.045);
  // closed: it ends near where it began, or ran on past its start (overshoot)
  const near = Math.max(12, diag * 0.28);
  const overshot = pts.slice(0, Math.floor(pts.length * 0.3)).some((p) => dist(p, b) < Math.min(near, Math.max(12, diag * 0.12)));
  const closed = (Math.hypot(a.x - b.x, a.y - b.y) < near || overshot) && pathLen > diag * 1.6 && Math.min(w, h) > diag * 0.12;

  if (!closed) {
    const { idx, v } = cleanCorners(pts, pruneCorners(pts, rdp(pts, eps), false, diag * 0.06), false, diag * 0.25);
    const runsErr = runsError(pts, v, false);
    const arc = fitArc(pts);
    if (arc && arc.err < diag * 0.02 && (arc.err < runsErr * 0.7 || !straightRuns(pts, idx, false)) && Math.abs(arc.sweep) > (25 * Math.PI) / 180 && arc.r < diag * 4) {
      return { kind: 'arc', cx: arc.cx, cy: arc.cy, r: arc.r, a0: arc.a0, sweep: arc.sweep };
    }
    if (idx.length === 2) return line;
    if (v.length > 10 || runsErr > diag * 0.035) return null;
    const arrow = asArrow(v);
    if (arrow) return { kind: 'arrow', ...arrow };
    return { kind: 'polyline', pts: v };
  }

  // a closed loop: leave out where the pen ran on past its start
  let end = pts.length - 1;
  let bestD = Infinity;
  for (let i = Math.floor(pts.length * 0.75); i < pts.length; i++) {
    const d = dist(pts[i], pts[0]);
    if (d < bestD) {
      bestD = d;
      end = i;
    }
  }
  const loop = pts.slice(0, end + 1);
  const ell = fitEllipse(loop);

  // corners: start the search from the point furthest out, which is a corner on any polygon
  const cx = loop.reduce((s, p) => s + p.x, 0) / loop.length;
  const cy = loop.reduce((s, p) => s + p.y, 0) / loop.length;
  let far = 0;
  loop.forEach((p, i) => {
    if (Math.hypot(p.x - cx, p.y - cy) > Math.hypot(loop[far].x - cx, loop[far].y - cy)) far = i;
  });
  const ring = [...loop.slice(far), ...loop.slice(0, far)];
  const { idx, v } = cleanCorners(ring, pruneCorners(ring, rdp([...ring, ring[0]], eps).filter((i) => i < ring.length), true, diag * 0.1), true, diag * 0.25);
  if (idx.length >= 3 && idx.length <= 12) {
    const polyErr = runsError(loop, v, true);
    // many sides is close to round: ask for clearer corners
    if (polyErr < diag * 0.03 && polyErr < ell.err * (idx.length > 6 ? 0.4 : 0.6) && straightRuns(ring, idx, true)) {
      // a box: four right angles
      const right = v.length === 4 && v.every((p, i) => Math.abs(turnAt(v[(i + 3) % 4], p, v[(i + 1) % 4]) - Math.PI / 2) < (14 * Math.PI) / 180);
      if (!right) {
        // start at the corner nearest the pen-down point
        let s = 0;
        v.forEach((p, i) => {
          if (dist(p, a) < dist(v[s], a)) s = i;
        });
        return { kind: 'polygon', pts: [...v.slice(s), ...v.slice(0, s)] };
      }
      return boxFrom(v, a);
    }
  }
  // a round loop has no tilt worth keeping
  const lvl = Math.abs(ell.rx - ell.ry) < Math.max(ell.rx, ell.ry) * 0.12 ? { rot: 0, swap: false } : levelAngle(ell.rot);
  const rx = lvl.swap ? ell.ry : ell.rx;
  const ry = lvl.swap ? ell.rx : ell.ry;
  const rot = lvl.rot;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const u = (a.x - ell.cx) * c + (a.y - ell.cy) * s;
  const vv = -(a.x - ell.cx) * s + (a.y - ell.cy) * c;
  return { kind: 'ellipse', cx: ell.cx, cy: ell.cy, rx, ry, start: Math.atan2(vv / ry, u / rx), rot: rot || undefined };
}

/** A tilt brought into (-45°, 45°], or to 0 when within 5° of level/upright; `swap` when that turned it a quarter. */
function levelAngle(rot: number): { rot: number; swap: boolean } {
  const q = Math.round(rot / (Math.PI / 2));
  let r = rot - q * (Math.PI / 2);
  if (Math.abs(r) < (5 * Math.PI) / 180) r = 0;
  return { rot: r, swap: Math.abs(q) % 2 === 1 };
}

/** The box best fitting four corners, level or turned, its corners starting nearest the pen-down point. */
function boxFrom(v: Point[], penDown: Point): InkShapeParams {
  // the edges' common direction (averaged on a quarter turn)
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < 4; i++) {
    const p = v[i];
    const q = v[(i + 1) % 4];
    const ang = Math.atan2(q.y - p.y, q.x - p.x) * 4;
    const len = dist(p, q);
    sx += Math.cos(ang) * len;
    sy += Math.sin(ang) * len;
  }
  const rot = levelAngle(Math.atan2(sy, sx) / 4).rot;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of v) {
    const u = p.x * c + p.y * s;
    const w = -p.x * s + p.y * c;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, w);
    v1 = Math.max(v1, w);
  }
  const mu = (u0 + u1) / 2;
  const mv = (v0 + v1) / 2;
  const cx = mu * c - mv * s;
  const cy = mu * s + mv * c;
  const rx = (u1 - u0) / 2 || 1;
  const ry = (v1 - v0) / 2 || 1;
  // corners clockwise from top-left (in the box's own frame); begin at the one nearest the pen-down point
  const local = [
    { x: -rx, y: -ry },
    { x: rx, y: -ry },
    { x: rx, y: ry },
    { x: -rx, y: ry },
  ].map((q) => ({ x: cx + q.x * c - q.y * s, y: cy + q.x * s + q.y * c }));
  let start = 0;
  local.forEach((q, i) => {
    if (dist(q, penDown) < dist(local[start], penDown)) start = i;
  });
  return { kind: 'rect', cx, cy, rx, ry, start, rot: rot || undefined };
}

/** recognizeShape, as points. */
export function recognizeInk(pts: InkPoint[]): { kind: InkShape; pts: InkPoint[] } | null {
  const sp = recognizeShape(pts);
  return sp ? { kind: sp.kind, pts: shapePoints(sp) } : null;
}
