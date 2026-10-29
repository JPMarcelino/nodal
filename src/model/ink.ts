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
function strokeRadii(pts: InkPoint[], R: number, size: number, realPressure: boolean): number[] {
  const radii: number[] = [];
  let prevR = R;
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
export function inkOutline(raw: InkPoint[], size: number, opts: { taper?: boolean; pressure?: boolean; uniform?: boolean } = {}): string {
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
  const taperLen = opts.taper === false || opts.uniform ? 0 : Math.min(total * 0.22, size * 4);
  const realPressure = opts.pressure ?? hasPressure(pts);
  const radii = opts.uniform ? pts.map(() => R) : strokeRadii(pts, R, size, realPressure);
  for (let i = 0; i < pts.length; i++) {
    let r = radii[i];
    if (taperLen > 0) {
      const ease = (t: number) => 0.3 + 0.7 * Math.sin((Math.min(1, t) * Math.PI) / 2);
      r *= Math.min(ease(len[i] / taperLen), ease((total - len[i]) / taperLen) * 0.85 + 0.15);
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
 * Centre line of a snapped shape, drawn with an even stroke: straight runs
 * between its points, closed for an ellipse or a box so there is no seam.
 */
export function inkShapePath(pts: Point[], kind: InkShape): string {
  if (!pts.length) return '';
  const body = pts.map((p, i) => `${i ? 'L' : 'M'}${f(p.x)},${f(p.y)}`).join('');
  return kind === 'line' ? body : body + 'Z';
}

/* ------------------------------------------------------------------ */
/* Hold-to-snap shape recognition                                      */
/* ------------------------------------------------------------------ */

export type InkShape = 'line' | 'ellipse' | 'rect';

/** A recognised shape in its own terms, so it can be regenerated scaled, turned or made perfect. */
export type InkShapeParams =
  | { kind: 'line'; a: Point; b: Point }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; start: number }
  | { kind: 'rect'; cx: number; cy: number; rx: number; ry: number; start: number };

/** Centre of a recognised shape (a line's middle). */
export function shapeCentre(sp: InkShapeParams): Point {
  return sp.kind === 'line' ? { x: (sp.a.x + sp.b.x) / 2, y: (sp.a.y + sp.b.y) / 2 } : { x: sp.cx, y: sp.cy };
}

/**
 * Points of a recognised shape, optionally scaled and turned about its centre;
 * `perfect` makes an ellipse a circle and a box a square (the larger side wins).
 */
export function shapePoints(sp: InkShapeParams, t: { scale?: number; rot?: number; perfect?: boolean } = {}): InkPoint[] {
  const p = 0.5;
  const k = t.scale ?? 1;
  const rot = t.rot ?? 0;
  const c = shapeCentre(sp);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const place = (x: number, y: number): InkPoint => ({ x: c.x + (x * cos - y * sin) * k, y: c.y + (x * sin + y * cos) * k, p });
  if (sp.kind === 'line') return [place(sp.a.x - c.x, sp.a.y - c.y), place(sp.b.x - c.x, sp.b.y - c.y)];
  const big = Math.max(sp.rx, sp.ry);
  const rx = t.perfect ? big : sp.rx;
  const ry = t.perfect ? big : sp.ry;
  const out: InkPoint[] = [];
  if (sp.kind === 'ellipse') {
    // start where the user started, so the stroke closes where the pen went down
    for (let i = 0; i <= 96; i++) {
      const a = sp.start + (i / 96) * Math.PI * 2;
      out.push(place(rx * Math.cos(a), ry * Math.sin(a)));
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
    for (let n = 0; n < 16; n++) out.push(place(from.x + ((to.x - from.x) * n) / 16, from.y + ((to.y - from.y) * n) / 16));
  }
  out.push(place(corners[first].x, corners[first].y));
  return out;
}

/**
 * Cleans up a scribble into the shape it most looks like: a closed loop
 * becomes an ellipse or a rectangle, anything else a straight line.
 */
export function recognizeShape(pts: InkPoint[]): InkShapeParams | null {
  if (pts.length < 2) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let pathLen = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
    if (i) pathLen += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
  }
  const w = x1 - x0;
  const h = y1 - y0;
  const diag = Math.hypot(w, h);
  if (diag < 4) return null;
  const closed = Math.hypot(a.x - b.x, a.y - b.y) < Math.max(12, diag * 0.28) && pathLen > diag * 1.6 && Math.min(w, h) > diag * 0.12;
  if (!closed) return { kind: 'line', a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } };
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = w / 2 || 1;
  const ry = h / 2 || 1;
  let ellErr = 0;
  let rectErr = 0;
  for (const q of pts) {
    ellErr += Math.abs(Math.hypot((q.x - cx) / rx, (q.y - cy) / ry) - 1);
    // distance to the nearest edge of the box, relative to its size
    rectErr += Math.min(Math.abs(q.x - x0), Math.abs(q.x - x1), Math.abs(q.y - y0), Math.abs(q.y - y1)) / Math.min(rx, ry);
  }
  if (rectErr < ellErr * 0.8) {
    // corners clockwise from top-left; begin at the one nearest the pen-down point
    const cs = [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
    let start = 0;
    cs.forEach((c, i) => {
      if (Math.hypot(c.x - a.x, c.y - a.y) < Math.hypot(cs[start].x - a.x, cs[start].y - a.y)) start = i;
    });
    return { kind: 'rect', cx, cy, rx, ry, start };
  }
  return { kind: 'ellipse', cx, cy, rx, ry, start: Math.atan2((a.y - cy) / ry, (a.x - cx) / rx) };
}

/** recognizeShape, as points. */
export function recognizeInk(pts: InkPoint[]): { kind: InkShape; pts: InkPoint[] } | null {
  const sp = recognizeShape(pts);
  return sp ? { kind: sp.kind, pts: shapePoints(sp) } : null;
}
