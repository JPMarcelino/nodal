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

/**
 * Filled outline of a hand-drawn stroke: thinner where the pen moves fast,
 * tapered at both ends, following real pressure when a stylus provides it.
 */
export function inkOutline(raw: InkPoint[], size: number, opts: { taper?: boolean; pressure?: boolean } = {}): string {
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
  const taperLen = opts.taper === false ? 0 : Math.min(total * 0.22, size * 4);
  const realPressure = opts.pressure ?? pts.some((p) => Math.abs(p.p - 0.5) > 0.02);
  const radii: number[] = [];
  let prevR = R;
  for (let i = 0; i < pts.length; i++) {
    let r: number;
    if (realPressure) r = R * (0.3 + pts[i].p * 0.95);
    else {
      // simulated pressure: speed thins the line a little
      const speed = i ? len[i] - len[i - 1] : 0;
      const target = R * Math.max(0.55, 1 - Math.min(1, speed / (size * 5)) * 0.45);
      r = prevR + (target - prevR) * 0.35;
    }
    prevR = r;
    if (taperLen > 0) {
      const ease = (t: number) => 0.3 + 0.7 * Math.sin((Math.min(1, t) * Math.PI) / 2);
      r *= Math.min(ease(len[i] / taperLen), ease((total - len[i]) / taperLen) * 0.85 + 0.15);
    }
    radii.push(Math.max(0.2, r));
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

/* ------------------------------------------------------------------ */
/* Hold-to-snap shape recognition                                      */
/* ------------------------------------------------------------------ */

export type InkShape = 'line' | 'ellipse' | 'rect';

/**
 * Cleans up a scribble into the shape it most looks like: a closed loop
 * becomes an ellipse or a rectangle, anything else a straight line.
 */
export function recognizeInk(pts: InkPoint[]): { kind: InkShape; pts: InkPoint[] } | null {
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
  const p = 0.5;
  const closed = Math.hypot(a.x - b.x, a.y - b.y) < Math.max(12, diag * 0.28) && pathLen > diag * 1.6 && Math.min(w, h) > diag * 0.12;
  if (!closed) return { kind: 'line', pts: [{ ...a, p }, { ...b, p }] };
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
    const corners = [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
      { x: x0, y: y0 },
    ];
    // dense edges, so smoothing only softens the corners a touch
    const out: InkPoint[] = [];
    for (let i = 0; i < 4; i++) {
      for (let k = 0; k < 16; k++) {
        const t = k / 16;
        out.push({ x: corners[i].x + (corners[i + 1].x - corners[i].x) * t, y: corners[i].y + (corners[i + 1].y - corners[i].y) * t, p });
      }
    }
    out.push({ x: x0, y: y0, p });
    return { kind: 'rect', pts: out };
  }
  const out: InkPoint[] = [];
  // start where the user started, so the taper sits at their pen-down point
  const start = Math.atan2((a.y - cy) / ry, (a.x - cx) / rx);
  for (let i = 0; i <= 64; i++) {
    const t = start + (i / 64) * Math.PI * 2;
    out.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t), p });
  }
  return { kind: 'ellipse', pts: out };
}
