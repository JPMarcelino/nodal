import { isConnector, resolveConnector } from './connectors';
import { instanceSymbol } from './registry';
import { rotatedBounds, shapeBox, shapeRot } from './rotation';
import { itemBounds } from './doc';
import { unionRects } from './geometry';
import type { CircuitDoc, Item, Point, Rect } from './types';
import { endpointInfo, wirePolyline } from './wires';

/**
 * Alignment guides for moving items: the moving items' key points (part
 * centres and pins, wire bends, junctions, shape corners and centres,
 * connector ends and bends) are
 * matched against the same points of everything that stays put.
 * Spacing guides match the gaps beside the moving box against the gaps
 * between the items in the same row or column.
 */

export interface AlignIndex {
  xs: number[];
  ys: number[];
  /** Static points per x (their ys) and per y (their xs), for drawing guide extents. */
  byX: Map<number, number[]>;
  byY: Map<number, number[]>;
}

export interface Guide {
  axis: 'x' | 'y';
  /** The shared coordinate. */
  v: number;
  from: number;
  to: number;
}

const k = (v: number) => Math.round(v * 100) / 100;

function itemPoints(doc: CircuitDoc, it: Item): Point[] {
  switch (it.type) {
    case 'component': {
      const def = instanceSymbol(doc, it);
      const pins = def.ports.map((p) => endpointInfo(doc, { kind: 'port', comp: it.id, port: p.id })?.pt).filter((p): p is Point => !!p);
      return [{ x: it.x, y: it.y }, ...pins];
    }
    case 'junction':
      return [{ x: it.x, y: it.y }];
    case 'wire':
      return wirePolyline(doc, it);
    case 'shape': {
      // lines and arrows line up by their ends and bends, as drawn
      if (isConnector(it)) return resolveConnector(doc, it).through;
      if (shapeRot(it)) {
        // a turned shape lines up by the box around it
        const b = rotatedBounds(shapeBox(it), shapeRot(it));
        return [
          { x: b.x, y: b.y },
          { x: b.x + b.w, y: b.y + b.h },
          { x: b.x + b.w / 2, y: b.y + b.h / 2 },
        ];
      }
      const s = it as Item & { x: number; y: number; w?: number; h?: number };
      if (typeof s.x !== 'number' || typeof s.y !== 'number') return [];
      const w = s.w ?? 0;
      const h = s.h ?? 0;
      return [
        { x: s.x, y: s.y },
        { x: s.x + w, y: s.y + h },
        { x: s.x + w / 2, y: s.y + h / 2 },
      ];
    }
    default:
      return [];
  }
}

/** Edges and centre of a box, as alignment points (top-left, bottom-right, centre). */
export function rectPoints(r: Rect): Point[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x + r.w / 2, y: r.y + r.h / 2 },
  ];
}

/** An index of static points to line things up with. */
export function alignIndex(points: Point[]): AlignIndex {
  const byX = new Map<number, number[]>();
  const byY = new Map<number, number[]>();
  for (const p of points) {
    const x = k(p.x);
    const y = k(p.y);
    (byX.get(x) ?? byX.set(x, []).get(x)!).push(p.y);
    (byY.get(y) ?? byY.set(y, []).get(y)!).push(p.x);
  }
  const xs = [...byX.keys()].sort((a, b) => a - b);
  const ys = [...byY.keys()].sort((a, b) => a - b);
  return { xs, ys, byX, byY };
}

/** Items whose boxes count for spacing: parts, junctions and boxy shapes (not wires or lines). */
const spaced = (it: Item) => it.type !== 'wire' && !isConnector(it);

/**
 * Key points of the moving items, and an index of the points that stay put.
 * `extra` adds boxes that travel with an item (a part's name and value text).
 * `box` and `others` are what spacing guides compare: the moving items'
 * bounds and the bounds of each item that stays put.
 */
export function alignAnchors(
  doc: CircuitDoc,
  ids: Set<string>,
  extra?: (it: Item) => Rect[],
): { moving: Point[]; index: AlignIndex; box: Rect | null; others: Rect[] } {
  // wires hanging off a moving part stretch, so neither side can use their points
  const touched = (it: Item) =>
    it.type === 'wire' &&
    [it.a, it.b].some((e) => (e.kind === 'port' && ids.has(e.comp)) || (e.kind === 'junction' && ids.has(e.id)));
  const moving: Point[] = [];
  const statics: Point[] = [];
  const boxes: Rect[] = [];
  const others: Rect[] = [];
  for (const it of Object.values(doc.items)) {
    if (it.hidden) continue;
    const pts = [...itemPoints(doc, it), ...(extra?.(it) ?? []).flatMap(rectPoints)];
    if (ids.has(it.id)) {
      if (it.type !== 'wire' || !touched(it)) moving.push(...pts);
      const r = spaced(it) && itemBounds(doc, it);
      if (r) boxes.push(r);
      continue;
    }
    if (touched(it)) continue;
    statics.push(...pts);
    const r = spaced(it) && itemBounds(doc, it);
    if (r) others.push(r);
  }
  return { moving, index: alignIndex(statics), box: unionRects(boxes), others };
}

/** Nearest value of a sorted array to v. */
function nearest(sorted: number[], v: number): number | null {
  if (!sorted.length) return null;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  const a = sorted[lo];
  const b = lo > 0 ? sorted[lo - 1] : a;
  return Math.abs(a - v) <= Math.abs(b - v) ? a : b;
}

/**
 * Guides for a move by (dx, dy). With `magnet`, an offset within `tol` of an
 * alignment is pulled onto it; otherwise only exact alignments show.
 */
export function alignMove(moving: Point[], index: AlignIndex, dx: number, dy: number, tol: number, magnet: boolean): { dx: number; dy: number; guides: Guide[] } {
  const pull = (axis: 'x' | 'y', d: number) => {
    const sorted = axis === 'x' ? index.xs : index.ys;
    let best: number | null = null;
    for (const p of moving) {
      const v = (axis === 'x' ? p.x : p.y) + d;
      const n = nearest(sorted, v);
      if (n === null) continue;
      const delta = n - v;
      if (Math.abs(delta) <= (magnet ? tol : 0.01) && (best === null || Math.abs(delta) < Math.abs(best))) best = delta;
    }
    return best ?? 0;
  };
  if (magnet) {
    dx += pull('x', dx);
    dy += pull('y', dy);
  }
  const guides: Guide[] = [];
  const seen = new Set<string>();
  for (const p of moving) {
    const x = k(p.x + dx);
    const y = k(p.y + dy);
    const statX = index.byX.get(x);
    if (statX && !seen.has(`x${x}`)) {
      seen.add(`x${x}`);
      const span = [...statX, ...moving.filter((q) => k(q.x + dx) === x).map((q) => q.y + dy)];
      guides.push({ axis: 'x', v: x, from: Math.min(...span), to: Math.max(...span) });
    }
    const statY = index.byY.get(y);
    if (statY && !seen.has(`y${y}`)) {
      seen.add(`y${y}`);
      const span = [...statY, ...moving.filter((q) => k(q.y + dy) === y).map((q) => q.x + dx)];
      guides.push({ axis: 'y', v: y, from: Math.min(...span), to: Math.max(...span) });
    }
  }
  return { dx, dy, guides };
}

/** One measured gap of a spacing guide: from `from` to `to` along the axis, drawn at `at` across it. */
export interface SpaceGap {
  from: number;
  to: number;
  at: number;
}

/** Equal gaps along one axis: the moving box sits as far from its neighbour as the neighbours sit from each other. */
export interface SpaceGuide {
  axis: 'x' | 'y';
  gaps: SpaceGap[];
}

const flipRect = (r: Rect): Rect => ({ x: r.y, y: r.x, w: r.h, h: r.w });

/** Far edge of where two boxes overlap across the axis (or between their centres if they don't), so marks clear the leads. */
function across(a: Rect, b: Rect): number {
  const lo = Math.max(a.y, b.y);
  const hi = Math.min(a.y + a.h, b.y + b.h);
  return lo <= hi ? hi : (a.y + a.h / 2 + b.y + b.h / 2) / 2;
}

/**
 * Equal spacing along x for box `m` among `others` (y is the cross axis; the
 * caller swaps axes for y). Candidates: centred between its two neighbours, or
 * one more step of the gap between a neighbour and the item beyond it.
 */
function spaceX(m: Rect, others: Rect[], tol: number): { delta: number; gaps: (x: number) => SpaceGap[] } | null {
  const row = others.filter((r) => r.y < m.y + m.h && r.y + r.h > m.y);
  const right = (r: Rect) => r.x + r.w;
  const mid = m.x + m.w / 2;
  let L: Rect | null = null;
  let R: Rect | null = null;
  for (const r of row) {
    if (right(r) <= m.x + tol && r.x + r.w / 2 < mid && (!L || right(r) > right(L))) L = r;
    if (r.x >= right(m) - tol && r.x + r.w / 2 > mid && (!R || r.x < R.x)) R = r;
  }
  const cands: { x: number; gaps: (x: number) => SpaceGap[] }[] = [];
  const at = (x: number): Rect => ({ ...m, x });
  if (L && R) {
    const l = L;
    const r = R;
    const x = (right(l) + r.x - m.w) / 2;
    if (x >= right(l)) cands.push({ x, gaps: (x) => [{ from: right(l), to: x, at: across(l, at(x)) }, { from: x + m.w, to: r.x, at: across(at(x), r) }] });
  }
  if (L) {
    const l = L;
    let L2: Rect | null = null;
    for (const r of row) if (r !== l && right(r) <= l.x && (!L2 || right(r) > right(L2))) L2 = r;
    const l2 = L2;
    if (l2 && l.x - right(l2) > 0.5) {
      const g = l.x - right(l2);
      cands.push({ x: right(l) + g, gaps: (x) => [{ from: right(l2), to: l.x, at: across(l2, l) }, { from: right(l), to: x, at: across(l, at(x)) }] });
    }
  }
  if (R) {
    const r = R;
    let R2: Rect | null = null;
    for (const o of row) if (o !== r && o.x >= right(r) && (!R2 || o.x < R2.x)) R2 = o;
    const r2 = R2;
    if (r2 && r2.x - right(r) > 0.5) {
      const g = r2.x - right(r);
      cands.push({ x: r.x - g - m.w, gaps: (x) => [{ from: x + m.w, to: r.x, at: across(at(x), r) }, { from: right(r), to: r2.x, at: across(r, r2) }] });
    }
  }
  let best: { delta: number; gaps: (x: number) => SpaceGap[] } | null = null;
  for (const c of cands) {
    const delta = c.x - m.x;
    if (Math.abs(delta) <= tol && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, gaps: c.gaps };
  }
  return best;
}

/**
 * Spacing guides for a move of `box` by (dx, dy). With `magnet`, an offset
 * within `tol` of an even spacing is pulled onto it (except along `hold`'s
 * axes); otherwise only exact matches show.
 */
export function spaceMove(
  box: Rect | null,
  others: Rect[],
  dx: number,
  dy: number,
  tol: number,
  magnet: boolean,
  hold: { x?: boolean; y?: boolean } = {},
): { dx: number; dy: number; guides: SpaceGuide[] } {
  if (!box) return { dx, dy, guides: [] };
  const guides: SpaceGuide[] = [];
  const exact = 0.01;
  const m = { ...box, x: box.x + dx, y: box.y + dy };
  const sx = spaceX(m, others, magnet && !hold.x ? tol : exact);
  if (sx) {
    dx += sx.delta;
    guides.push({ axis: 'x', gaps: sx.gaps(box.x + dx) });
  }
  const my = flipRect({ ...box, x: box.x + dx, y: box.y + dy });
  const sy = spaceX(my, others.map(flipRect), magnet && !hold.y ? tol : exact);
  if (sy) {
    dy += sy.delta;
    guides.push({ axis: 'y', gaps: sy.gaps(box.y + dy) });
  }
  return { dx, dy, guides };
}
