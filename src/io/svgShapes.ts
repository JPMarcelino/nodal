import type { SvgBox, SvgDrawing, SvgPolyline } from './svgImport';

/*
 * Tidies a raw SVG drawing the way a person would read it. CAD and PDF
 * exports draw a schematic as loose segments and outlines as plain paths:
 * strokes that simply continue one another are joined into one polyline,
 * points in the middle of a straight run are dropped, and closed outlines
 * that are really rectangles, circles or ellipses become those boxes.
 */

/** Two points closer than this (canvas units) are the same point. */
const EPS = 0.05;
/** How far an outline may stray from the ellipse it is read as, relative to its size. */
const ELLIPSE_TOL = 0.02;

type P = { x: number; y: number };
const same = (a: P, b: P) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
const pkey = (p: P) => `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`;
const styleKey = (l: SvgPolyline) => `${l.color}|${l.width}|${l.dashed}|${l.stroked !== false}`;
/** An open, unfilled, straight stroke that may be joined with others. */
const joinable = (l: SvgPolyline) => !l.closed && !l.nodes && (!l.fill || l.fill === 'none');

/** Drops repeated points and points in the middle of a straight run. */
export function simplifyPolyline(pts: P[], closed: boolean): P[] {
  let ps = pts.filter((p, i) => i === 0 || !same(p, pts[i - 1]));
  if (closed && ps.length > 1 && same(ps[0], ps[ps.length - 1])) ps = ps.slice(0, -1);
  const n = ps.length;
  if (n < 3) return closed && n ? [...ps, ps[0]] : ps;
  const keep: P[] = [];
  for (let i = 0; i < n; i++) {
    const end = !closed && (i === 0 || i === n - 1);
    if (end) {
      keep.push(ps[i]);
      continue;
    }
    const a = ps[(i - 1 + n) % n], b = ps[i], c = ps[(i + 1) % n];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
    const len = Math.hypot(c.x - a.x, c.y - a.y) || 1;
    // straight through (not doubling back): the point adds nothing
    if (Math.abs(cross) / len < EPS && dot > 0) continue;
    keep.push(b);
  }
  return closed && keep.length ? [...keep, keep[0]] : keep;
}

/** Spatial hash of segments, to ask "does any stroke pass through this point". */
function segmentIndex(lines: SvgPolyline[]) {
  const CELL = 32;
  const cells = new Map<string, [number, number][]>();
  lines.forEach((l, li) => {
    for (let i = 1; i < l.pts.length; i++) {
      const a = l.pts[i - 1], b = l.pts[i];
      const x0 = Math.floor((Math.min(a.x, b.x) - EPS) / CELL), x1 = Math.floor((Math.max(a.x, b.x) + EPS) / CELL);
      const y0 = Math.floor((Math.min(a.y, b.y) - EPS) / CELL), y1 = Math.floor((Math.max(a.y, b.y) + EPS) / CELL);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) continue; // a huge diagonal: not worth indexing
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          const k = `${x},${y}`;
          const list = cells.get(k);
          if (list) list.push([li, i]);
          else cells.set(k, [[li, i]]);
        }
    }
  });
  /** Whether a stroke passes through `p` other than at one of its own ends. */
  return (p: P) => {
    for (const [li, i] of cells.get(`${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`) ?? []) {
      const l = lines[li];
      const a = l.pts[i - 1], b = l.pts[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L2 = dx * dx + dy * dy;
      if (!L2) continue;
      const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
      if (t < -1e-9 || t > 1 + 1e-9) continue;
      if (Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y) >= EPS) continue;
      const atEnd = (i === 1 && same(p, l.pts[0])) || (i === l.pts.length - 1 && same(p, l.pts[l.pts.length - 1]));
      if (!atEnd) return true;
    }
    return false;
  };
}

/**
 * Joins open strokes of the same style that meet end to end, where nothing
 * else meets them (no third stroke, no stroke passing through, no dot).
 * A chain that comes back to its start becomes a closed outline.
 */
export function joinStrokes(lines: SvgPolyline[], dots: P[] = []): SvgPolyline[] {
  const passesThrough = segmentIndex(lines);
  const ends = new Map<string, number[]>();
  lines.forEach((l, i) => {
    if (l.closed || l.pts.length < 2) return;
    for (const p of [l.pts[0], l.pts[l.pts.length - 1]]) {
      const k = pkey(p);
      const list = ends.get(k);
      if (list) list.push(i);
      else ends.set(k, [i]);
    }
  });
  const dotKeys = new Set(dots.map(pkey));
  /** The other stroke continuing this one at `p`, if the meeting is a plain two-way joint. */
  const partner = (i: number, p: P): number | null => {
    const k = pkey(p);
    const list = ends.get(k) ?? [];
    if (list.length !== 2 || dotKeys.has(k)) return null;
    const j = list[0] === i ? list[1] : list[0];
    if (j === i || used[j] || !joinable(lines[i]) || !joinable(lines[j]) || styleKey(lines[i]) !== styleKey(lines[j])) return null;
    return passesThrough(p) ? null : j;
  };
  const used: boolean[] = lines.map(() => false);
  const out: SvgPolyline[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const l = lines[i];
    if (!joinable(l)) {
      out.push(l);
      continue;
    }
    let pts = [...l.pts];
    // grow forwards from the end, then backwards from the start
    for (const dir of [1, -1] as const) {
      for (;;) {
        const tip = dir === 1 ? pts[pts.length - 1] : pts[0];
        if (pts.length > 2 && same(pts[0], pts[pts.length - 1])) break;
        const j = partner(i, tip);
        if (j === null) break;
        used[j] = true;
        const q = lines[j].pts;
        const next = same(q[0], tip) ? q : [...q].reverse();
        pts = dir === 1 ? [...pts, ...next.slice(1)] : [...[...next].reverse().slice(0, -1), ...pts];
        // the joint is inside the chain now, and the far end of the joined stroke is the chain's
        ends.delete(pkey(tip));
        const far = pkey(next[next.length - 1]);
        ends.set(far, (ends.get(far) ?? []).map((x) => (x === j ? i : x)));
      }
    }
    const closed = pts.length > 3 && same(pts[0], pts[pts.length - 1]);
    out.push({ ...l, pts: simplifyPolyline(pts, closed), closed });
  }
  return out;
}

/** A closed straight outline that is an axis-aligned rectangle, as a box. */
export function rectOf(l: SvgPolyline): SvgBox | null {
  if (!l.closed || l.nodes) return null;
  const ps = simplifyPolyline(l.pts, true).slice(0, -1);
  if (ps.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const a = ps[i], b = ps[(i + 1) % 4];
    if (Math.abs(a.x - b.x) >= EPS && Math.abs(a.y - b.y) >= EPS) return null;
  }
  const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  const w = Math.max(...xs) - x, h = Math.max(...ys) - y;
  if (w < EPS || h < EPS) return null;
  return boxOf(l, 'rect', x, y, w, h);
}

/** A closed curved outline that traces an axis-aligned circle or ellipse, as a box. */
export function ellipseOf(l: SvgPolyline): SvgBox | null {
  if (!l.closed || !l.nodes || l.pts.length < 8) return null;
  const xs = l.pts.map((p) => p.x), ys = l.pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  if (rx < EPS || ry < EPS) return null;
  const cx = x0 + rx, cy = y0 + ry;
  for (const p of l.pts) {
    const r = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
    if (Math.abs(r - 1) > ELLIPSE_TOL) return null;
  }
  // the whole way round, not an arc closed by a chord
  const quad = new Set(l.pts.map((p) => `${p.x > cx + rx * 0.5 ? 1 : p.x < cx - rx * 0.5 ? -1 : 0},${p.y > cy + ry * 0.5 ? 1 : p.y < cy - ry * 0.5 ? -1 : 0}`));
  if (!['1,0', '-1,0', '0,1', '0,-1'].every((q) => quad.has(q))) return null;
  return boxOf(l, 'ellipse', x0, y0, 2 * rx, 2 * ry);
}

const r2 = (v: number) => Math.round(v * 100) / 100;

function boxOf(l: SvgPolyline, kind: SvgBox['kind'], x: number, y: number, w: number, h: number): SvgBox {
  const filled = !!l.fill && l.fill !== 'none';
  return {
    kind,
    x: r2(x),
    y: r2(y),
    w: r2(w),
    h: r2(h),
    rx: 0,
    stroke: l.color,
    strokeWidth: l.stroked === false ? 0 : l.width,
    fill: filled ? l.fill! : 'none',
    fillOpacity: filled ? (l.fillOpacity ?? 1) : 0,
    dashed: l.dashed,
  };
}

/** Joins strokes, straightens runs and reads rectangles, circles and ellipses out of the outlines. */
export function recognizeShapes(d: SvgDrawing): SvgDrawing {
  const joined = joinStrokes(d.lines, d.dots);
  const lines: SvgPolyline[] = [];
  const boxes = [...d.boxes];
  for (const l of joined) {
    const b = rectOf(l) ?? ellipseOf(l);
    if (b) boxes.push(b);
    else lines.push(l.nodes ? l : { ...l, pts: simplifyPolyline(l.pts, l.closed) });
  }
  return { ...d, lines, boxes };
}
