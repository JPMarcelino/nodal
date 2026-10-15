import { projectOnSegment } from './geometry';
import type { Point, ShapeItem } from './types';

/* Polygon shapes keep their corners as fractions (0–1) of the shape box, like ink, so resizing the box reshapes them. */

/** Box + normalized corner list of a polygon through `pts`. */
export function packPoly(pts: Point[]): Pick<ShapeItem, 'x' | 'y' | 'w' | 'h' | 'poly'> {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  // a flat polygon still needs a box to scale with
  const w = Math.max(1, Math.max(...xs) - x0);
  const h = Math.max(1, Math.max(...ys) - y0);
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  return { x: x0, y: y0, w, h, poly: pts.flatMap((p) => [r((p.x - x0) / w), r((p.y - y0) / h)]) };
}

/** Absolute corners of a polygon shape. */
export function polyPoints(s: Pick<ShapeItem, 'x' | 'y' | 'w' | 'h' | 'poly'>): Point[] {
  const a = s.poly ?? [];
  const out: Point[] = [];
  for (let i = 0; i + 1 < a.length; i += 2) out.push({ x: s.x + a[i] * s.w, y: s.y + a[i + 1] * s.h });
  return out;
}

export function pointInPolygon(p: Point, pts: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Whether `p` touches a polygon shape: its outline, or anywhere inside when it is filled. */
export function polyHit(s: ShapeItem, p: Point, tol: number): boolean {
  const pts = polyPoints(s);
  if (pts.length < 2) return false;
  if (s.fillOpacity > 0 && pointInPolygon(p, pts)) return true;
  const reach = tol + s.strokeWidth / 2;
  for (let i = 0; i < pts.length; i++) if (projectOnSegment(p, pts[i], pts[(i + 1) % pts.length]).d < reach) return true;
  return false;
}

/** `p` pulled onto the nearest 45° direction from `from` (Shift while drawing). */
export function constrain45(from: Point, p: Point): Point {
  const dx = p.x - from.x;
  const dy = p.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!len) return p;
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  // diagonals keep equal legs so they stay on the grid
  if (Math.abs(Math.cos(a)) > 0.1 && Math.abs(Math.sin(a)) > 0.1) {
    const d = (Math.abs(dx) + Math.abs(dy)) / 2;
    return { x: from.x + Math.sign(Math.cos(a)) * d, y: from.y + Math.sign(Math.sin(a)) * d };
  }
  return Math.abs(Math.cos(a)) > 0.5 ? { x: p.x, y: from.y } : { x: from.x, y: p.y };
}
