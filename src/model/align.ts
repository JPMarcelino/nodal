import { instanceSymbol } from './registry';
import { rotatedBounds, shapeBox, shapeRot } from './rotation';
import type { CircuitDoc, Item, Point } from './types';
import { endpointInfo, wirePolyline } from './wires';

/**
 * Alignment guides for moving items: the moving items' key points (part
 * centres and pins, wire bends, junctions, shape corners and centres) are
 * matched against the same points of everything that stays put.
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

/** Key points of the moving items, and an index of the points that stay put. */
export function alignAnchors(doc: CircuitDoc, ids: Set<string>): { moving: Point[]; index: AlignIndex } {
  // wires hanging off a moving part stretch, so neither side can use their points
  const touched = (it: Item) =>
    it.type === 'wire' &&
    [it.a, it.b].some((e) => (e.kind === 'port' && ids.has(e.comp)) || (e.kind === 'junction' && ids.has(e.id)));
  const moving: Point[] = [];
  const byX = new Map<number, number[]>();
  const byY = new Map<number, number[]>();
  for (const it of Object.values(doc.items)) {
    if (it.hidden) continue;
    if (ids.has(it.id)) {
      if (it.type !== 'wire' || !touched(it)) moving.push(...itemPoints(doc, it));
      continue;
    }
    if (touched(it)) continue;
    for (const p of itemPoints(doc, it)) {
      const x = k(p.x);
      const y = k(p.y);
      (byX.get(x) ?? byX.set(x, []).get(x)!).push(p.y);
      (byY.get(y) ?? byY.set(y, []).get(y)!).push(p.x);
    }
  }
  const xs = [...byX.keys()].sort((a, b) => a - b);
  const ys = [...byY.keys()].sort((a, b) => a - b);
  return { moving, index: { xs, ys, byX, byY } };
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
