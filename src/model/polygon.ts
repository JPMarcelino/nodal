import { deletePathNode, pathHit } from './path';
import type { Point, ShapeItem } from './types';

/* Polygon shapes keep their corners as fractions (0–1) of the shape box, like ink, so resizing the box reshapes them. Curved stretches and open paths: see model/path.ts. */

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

export { pointInPolygon } from './path';

/** Whether `p` touches a polygon shape: its outline (curves included), or anywhere inside when it is filled. */
export const polyHit = (s: ShapeItem, p: Point, tol: number): boolean => pathHit(s, p, tol);

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

/** Writes new corners into a polygon shape (its box follows them). */
export function setPolyPoints(s: ShapeItem, pts: Point[]) {
  Object.assign(s, packPoly(pts));
}

/** Removes one corner (node); a polygon keeps at least three, an open path two. Returns whether it changed. */
export const deletePolyCorner = (s: ShapeItem, index: number): boolean => deletePathNode(s, index);

/** Polygon corners after dragging corner `index` (or, with `edge`, the edge from `index` to the next corner) by `d`. */
export function dragPolyPart(base: Point[], index: number, edge: boolean, d: Point): Point[] {
  const pts = base.map((p) => ({ ...p }));
  const ids = edge ? [index, (index + 1) % pts.length] : [index];
  for (const i of ids) pts[i] = { x: base[i].x + d.x, y: base[i].y + d.y };
  return pts;
}
