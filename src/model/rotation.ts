import { measureTextShape } from './shapeText';
import type { Point, Rect, ShapeItem, ShapeKind } from './types';

/**
 * Free rotation of shapes.
 *
 * Boxy kinds (rect, zone, ellipse, text, image) keep their unrotated box in
 * x / y / w / h and store `rot`: degrees clockwise about the box centre, so
 * their title, picture or text turns with them and they can still be resized
 * in their own frame. Kinds made of points (line, arrow, polygon, ink) never
 * store it: rotating them rewrites the points, so they stay axis-free and
 * their hit-testing, bounds and export need nothing extra. Callouts (they point
 * at things) and frames (camera views) don't rotate.
 */
export const ROT_KINDS: ReadonlySet<ShapeKind> = new Set(['rect', 'zone', 'ellipse', 'text', 'image']);

/** Kinds offered the rotation handle (lines and arrows turn by their end handles). */
export const HANDLE_ROT_KINDS: ReadonlySet<ShapeKind> = new Set([...ROT_KINDS, 'polygon', 'ink']);

/** Degrees folded into [0, 360), with float noise rounded away. */
export function normDeg(d: number): number {
  const r = Math.round((((d % 360) + 360) % 360) * 1e4) / 1e4;
  return r >= 360 ? 0 : r;
}

/** The stored rotation of a shape (0 for kinds that bake it into their points). */
export const shapeRot = (s: Pick<ShapeItem, 'kind' | 'rot'>): number => (ROT_KINDS.has(s.kind) ? (s.rot ?? 0) : 0);

/** Rotates a point by any angle (degrees, clockwise on screen) about `o`. */
export function rotateDeg(p: Point, deg: number, o: Point = { x: 0, y: 0 }): Point {
  if (!deg) return { x: p.x, y: p.y };
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = p.x - o.x;
  const dy = p.y - o.y;
  return { x: o.x + dx * c - dy * s, y: o.y + dx * s + dy * c };
}

/** A shape's unrotated box; free text is sized by its content. */
export function shapeBox(s: ShapeItem): Rect {
  if (s.kind === 'text') return { x: s.x, y: s.y, ...measureTextShape(s) };
  return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) };
}

export const rectCentre = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Corners of a box turned `deg` about its centre (nw, ne, se, sw). */
export function rotatedCorners(r: Rect, deg: number): Point[] {
  const c = rectCentre(r);
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ].map((p) => rotateDeg(p, deg, c));
}

/** Axis-aligned bounds of a box turned `deg` about its centre. */
export function rotatedBounds(r: Rect, deg: number): Rect {
  if (!normDeg(deg)) return r;
  const pts = rotatedCorners(r, deg);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** A world point in a shape's own (unrotated) frame, for hit-testing against its box. */
export function toShapeFrame(s: ShapeItem, p: Point): Point {
  const r = shapeRot(s);
  return r ? rotateDeg(p, -r, rectCentre(shapeBox(s))) : p;
}

/** A point of a shape's own frame in the world. */
export function fromShapeFrame(s: ShapeItem, p: Point): Point {
  const r = shapeRot(s);
  return r ? rotateDeg(p, r, rectCentre(shapeBox(s))) : p;
}

/** SVG transform turning a shape about its centre (undefined when it isn't turned). */
export function shapeTransform(s: ShapeItem): string | undefined {
  const r = shapeRot(s);
  if (!r) return undefined;
  const c = rectCentre(shapeBox(s));
  return `rotate(${r} ${c.x} ${c.y})`;
}

export type BoxHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/**
 * Resizes a box turned `rot` about its centre by dragging `handle` to world
 * point `p`. The drag works in the box's own frame, and the result is placed so
 * the side or corner opposite the handle stays where it was on screen.
 * `aspect` keeps the box's proportions; `centre` grows it about its centre.
 */
export function resizeInFrame(b: Rect, rot: number, handle: BoxHandle, p: Point, min: number, snap = 0, opts: { aspect?: boolean; centre?: boolean } = {}): Rect {
  const c = rectCentre(b);
  const q = rotateDeg(p, -rot, c);
  // the dragged edges snap to the grid in the shape's own frame, where a turned shape's edges run
  if (snap) {
    if (handle.includes('w') || handle.includes('e')) q.x = Math.round(q.x / snap) * snap;
    if (handle.includes('n') || handle.includes('s')) q.y = Math.round(q.y / snap) * snap;
  }
  const dx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const dy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  // each dragged axis grows from its anchor: the opposite side, or the centre (Ctrl) where it grows both ways
  const span = (dir: number, lo: number, len: number, mid: number, at: number) => {
    if (!dir) return { anchor: mid, sign: 0, len };
    if (opts.centre) return { anchor: mid, sign: 0, len: 2 * Math.abs(at - mid) };
    const anchor = dir > 0 ? lo : lo + len;
    return { anchor, sign: Math.sign(at - anchor) || dir, len: Math.abs(at - anchor) };
  };
  const sx = span(dx, b.x, b.w, c.x, q.x);
  const sy = span(dy, b.y, b.h, c.y, q.y);
  let w = Math.max(min, sx.len);
  let h = Math.max(min, sy.len);
  if (opts.aspect && b.w > 0 && b.h > 0) {
    // Shift keeps the proportions: a corner follows whichever side moved further, an edge drags the other side along
    const k = dx && dy ? Math.max(w / b.w, h / b.h) : dx ? w / b.w : h / b.h;
    const kk = Math.max(k, min / b.w, min / b.h);
    w = b.w * kk;
    h = b.h * kk;
  }
  const at1 = (s: { anchor: number; sign: number }, len: number) => (s.sign ? (s.sign > 0 ? s.anchor : s.anchor - len) : s.anchor - len / 2);
  const local = { x: at1(sx, w) + w / 2, y: at1(sy, h) + h / 2 };
  // the box's centre moved within the old frame: carry that move into the world
  const at = rotateDeg(local, rot, c);
  return { x: at.x - w / 2, y: at.y - h / 2, w, h };
}

/** Gives a shape a new width and / or height; a turned one keeps its centre (its pivot) where it is, an upright one its top left. */
export function setShapeSize(s: ShapeItem, size: { w?: number; h?: number }) {
  const c = rectCentre(shapeBox(s));
  if (size.w !== undefined) s.w = size.w;
  if (size.h !== undefined) s.h = size.h;
  if (!shapeRot(s)) return;
  const b = shapeBox(s);
  s.x += c.x - (b.x + b.w / 2);
  s.y += c.y - (b.y + b.h / 2);
}

/**
 * Rotation for a rotation-handle drag: `base` turned by how far the pointer has
 * swung about `c` since `start`. `step` snaps the result (Shift: 15°).
 */
export function dragRotation(c: Point, start: Point, p: Point, base: number, step = 0): number {
  const ang = (q: Point) => (Math.atan2(q.y - c.y, q.x - c.x) * 180) / Math.PI;
  const r = base + ang(p) - ang(start);
  return normDeg(step ? Math.round(r / step) * step : r);
}

/**
 * Where a boxy shape lands under a point map (move, scale, rotate, mirror):
 * its centre and half-axes are mapped, so it keeps its own frame. A mirror
 * can't turn text or pictures inside out, so it takes the turn that reads the
 * right way up; `rotateBy` 180 marks a vertical flip (horizontal flip + half turn).
 */
export function mapShapeFrame(s: ShapeItem, map: (p: Point) => Point, rotateBy = 0): Rect & { rot: number } {
  const b = shapeBox(s);
  const r = shapeRot(s);
  const c = rectCentre(b);
  const u = rotateDeg({ x: c.x + b.w / 2, y: c.y }, r, c);
  const v = rotateDeg({ x: c.x, y: c.y + b.h / 2 }, r, c);
  const c2 = map(c);
  const u2 = map(u);
  const v2 = map(v);
  const ux = u2.x - c2.x,
    uy = u2.y - c2.y,
    vx = v2.x - c2.x,
    vy = v2.y - c2.y;
  const w = 2 * Math.hypot(ux, uy);
  const h = 2 * Math.hypot(vx, vy);
  const mirrored = ux * vy - uy * vx < 0;
  const rot = normDeg((Math.atan2(mirrored ? -uy : uy, mirrored ? -ux : ux) * 180) / Math.PI + (mirrored ? rotateBy : 0));
  if (!r && !rot) {
    // still square to the axes: map the corners, so plain moves stay exact
    const a = map({ x: b.x, y: b.y });
    const z = map({ x: b.x + b.w, y: b.y + b.h });
    return { x: Math.min(a.x, z.x), y: Math.min(a.y, z.y), w: Math.abs(z.x - a.x), h: Math.abs(z.y - a.y), rot };
  }
  return { x: c2.x - w / 2, y: c2.y - h / 2, w, h, rot };
}
