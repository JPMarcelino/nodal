import type { SvgDrawing } from '../io/svgImport';
import type { Point } from './types';

/*
 * Fitting an imported drawing to the grid. Either the grid is refined until
 * every line end, corner, box edge and dot of the drawing (and everything
 * already on the page) falls on a grid point, or the drawing is moved onto
 * the current grid point by point, keeping its paths and connections.
 */

/** How far (canvas units) a point may sit off the refined grid and still count as on it. */
export const FIT_TOL = 0.03;
/** Finest grid the refinement goes down to. */
export const MIN_PITCH = 0.01;

/** Points of the drawing that must land on the grid: line vertices, curve nodes, box corners, dots. */
export function drawingPoints(d: SvgDrawing): Point[] {
  const out: Point[] = [];
  for (const l of d.lines) {
    if (l.nodes) for (const n of l.nodes) out.push({ x: n.x, y: n.y });
    else out.push(...l.pts);
  }
  for (const b of d.boxes) out.push({ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h });
  for (const p of d.dots) out.push({ x: p.x, y: p.y });
  return out;
}

const uniq = (vs: number[]) => {
  const s = [...vs].sort((a, b) => a - b);
  return s.filter((v, i) => i === 0 || v - s[i - 1] > 1e-6);
};

/** Whether every value sits within `tol` of `ref + k·pitch`. */
const fits = (vals: number[], ref: number, pitch: number, tol: number) => vals.every((v) => Math.abs(v - ref - Math.round((v - ref) / pitch) * pitch) <= tol);

/**
 * The coarsest grid pitch on which every point lies (within `tol`), relative
 * to one another. With `divides`, the pitch also divides that grid (so what
 * is already on it stays on it); otherwise it is the drawing's own spacing.
 */
export function fitPitch(points: Point[], opts: { divides?: number; tol?: number } = {}): number {
  const tol = opts.tol ?? FIT_TOL;
  const xs = uniq(points.map((p) => p.x));
  const ys = uniq(points.map((p) => p.y));
  const ok = (p: number) => p >= MIN_PITCH - 1e-9 && fits(xs, xs[0] ?? 0, p, tol) && fits(ys, ys[0] ?? 0, p, tol);
  const g = opts.divides;
  if (g) {
    for (let n = 1; g / n >= MIN_PITCH - 1e-9; n++) if (ok(g / n)) return g / n;
    return MIN_PITCH;
  }
  // free: the spacing is a whole fraction of the smallest step between distinct coordinates
  const deltas = uniq([...xs.slice(1).map((v) => v - xs[0]), ...ys.slice(1).map((v) => v - ys[0])]).filter((d) => d > tol);
  if (!deltas.length) return 1;
  const ref = deltas[0];
  for (let n = 1; n <= 2000 && ref / n >= MIN_PITCH; n++) {
    let p = ref / n;
    // least-squares refinement over every step, so long spans don't drift
    let num = 0, den = 0;
    for (const d of deltas) {
      const k = Math.round(d / p);
      num += k * d;
      den += k * k;
    }
    if (den) p = num / den;
    // prefer the round number when it fits just as well
    const round = Math.round(p * 100) / 100;
    if (round >= MIN_PITCH && ok(round)) return round;
    if (ok(p)) return p;
  }
  return MIN_PITCH;
}

/** Shift (per axis) that brings the values closest to multiples of `pitch` overall (circular mean of their phases). */
function phaseShift(vals: number[], pitch: number): number {
  if (!vals.length) return 0;
  let s = 0, c = 0;
  for (const v of vals) {
    const a = (2 * Math.PI * v) / pitch;
    s += Math.sin(a);
    c += Math.cos(a);
  }
  return (-Math.atan2(s, c) / (2 * Math.PI)) * pitch;
}

/**
 * Moves the drawing (placed at `at`) so its points land on the grid of
 * `pitch` through the origin: the whole drawing is shifted to line up as
 * well as it can, then every point goes to its nearest grid point. Curve
 * handles move with their node; text only takes the overall shift. Returns
 * the drawing (still relative to `at`) and how far any point moved
 * relative to the rest (beyond the overall shift).
 */
export function snapDrawing(d: SvgDrawing, pitch: number, at: Point = { x: 0, y: 0 }): { drawing: SvgDrawing; maxShift: number } {
  const pts = drawingPoints(d);
  const tx = phaseShift(pts.map((p) => p.x + at.x), pitch);
  const ty = phaseShift(pts.map((p) => p.y + at.y), pitch);
  let maxShift = 0;
  const sn = (v: number, a: number, t: number) => Math.round((v + a + t) / pitch) * pitch - a;
  const S = (p: Point): Point => {
    const q = { x: sn(p.x, at.x, tx), y: sn(p.y, at.y, ty) };
    // the overall shift moves everything alike; only what changes the drawing's shape counts
    maxShift = Math.max(maxShift, Math.hypot(q.x - p.x - tx, q.y - p.y - ty));
    return q;
  };
  const dedupe = (ps: Point[]) => ps.filter((p, i) => i === 0 || Math.abs(p.x - ps[i - 1].x) > 1e-9 || Math.abs(p.y - ps[i - 1].y) > 1e-9);
  const lines: SvgDrawing['lines'] = [];
  for (const l of d.lines) {
    if (l.nodes) {
      const nodes = l.nodes.map((n) => {
        const q = S(n);
        const dx = q.x - n.x, dy = q.y - n.y;
        return { ...n, ...q, ...(n.in ? { in: { x: n.in.x + dx, y: n.in.y + dy } } : {}), ...(n.out ? { out: { x: n.out.x + dx, y: n.out.y + dy } } : {}) };
      });
      lines.push({ ...l, pts: l.pts.map((p) => ({ x: p.x + tx, y: p.y + ty })), nodes });
      continue;
    }
    const ps = dedupe(l.pts.map(S));
    if (ps.length >= 2) lines.push({ ...l, pts: ps });
  }
  const boxes = d.boxes.map((b) => {
    const p0 = S({ x: b.x, y: b.y });
    const p1 = S({ x: b.x + b.w, y: b.y + b.h });
    return { ...b, x: p0.x, y: p0.y, w: Math.max(pitch, p1.x - p0.x), h: Math.max(pitch, p1.y - p0.y) };
  });
  const dots = d.dots.map((p) => ({ ...p, ...S(p) }));
  const texts = d.texts.map((t) => ({ ...t, x: t.x + tx, y: t.y + ty }));
  return { drawing: { lines, boxes, dots, texts }, maxShift };
}

/** What each grid choice would do to a drawing, for the import dialog. */
export interface GridFitPreview {
  /** Current grid. */
  grid: number;
  /** Grid after refining (equal to `grid` when the drawing already fits). */
  refined: number;
  /** Largest move of any point when snapping to the current grid. */
  snapShift: number;
}

export function previewGridFit(d: SvgDrawing, grid: number, pageHasItems: boolean, at: Point = { x: 0, y: 0 }): GridFitPreview {
  const pts = drawingPoints(d);
  let refined = pts.length ? fitPitch(pts, pageHasItems ? { divides: grid } : {}) : grid;
  // a drawing spaced in whole grid steps already fits the grid as it is
  const steps = refined / grid;
  if (steps >= 1 && Math.abs(steps - Math.round(steps)) < 1e-6) refined = grid;
  return { grid, refined, snapShift: pts.length ? snapDrawing(d, grid, at).maxShift : 0 };
}
