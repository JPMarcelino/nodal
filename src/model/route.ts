import { componentBounds } from './geometry';
import { instanceSymbol } from './registry';
import type { CircuitDoc, Point, Rect } from './types';
import { endpointInfo, wirePolyline } from './wires';

/**
 * Orthogonal wire router (Cadence "full" route method): finds the cheapest
 * horizontal/vertical path between two points that never crosses an instance
 * body, never touches a terminal it isn't meant to connect to, and stays off
 * existing wires. Cost = length + a penalty per bend, so a free L-shape always
 * wins and detours only appear when something is in the way.
 */

export interface RouteObstacles {
  /** Instance bodies (closed rectangles). */
  rects: Rect[];
  /** Terminals: pins of every instance. */
  pins: Point[];
  /** Existing wire vertices and junctions (passing through one would connect to it). */
  nodes: Point[];
  /** Existing horizontal wire runs, keyed by y. */
  hRuns: Map<number, [number, number][]>;
  /** Existing vertical wire runs, keyed by x. */
  vRuns: Map<number, [number, number][]>;
}

export interface RouteOptions {
  grid: number;
  /** Preferred axis of the first leg (the "posture"); only breaks ties. */
  hFirst: boolean;
  /** Outward direction of a pin the route starts on: the route leaves along it. */
  startDir?: Point;
  /** Outward direction of a pin the route ends on: the route arrives against it. */
  endDir?: Point;
  /** Direction of the leg drawn just before this one: the route never doubles back over it. */
  prevDir?: Point;
}

const EPS = 0.01;
const key = (v: number) => Math.round(v * 100) / 100;

/** Obstacles of a document, for routing new wires. */
export function routeObstacles(doc: CircuitDoc, excludeWires?: Set<string>): RouteObstacles {
  const rects: Rect[] = [];
  const pins: Point[] = [];
  const nodes: Point[] = [];
  const hRuns = new Map<number, [number, number][]>();
  const vRuns = new Map<number, [number, number][]>();
  const push = (m: Map<number, [number, number][]>, k: number, a: number, b: number) => {
    const list = m.get(key(k)) ?? [];
    list.push([Math.min(a, b), Math.max(a, b)]);
    m.set(key(k), list);
  };
  for (const it of Object.values(doc.items)) {
    if (it.hidden) continue;
    if (it.type === 'component') {
      const def = instanceSymbol(doc, it);
      rects.push(componentBounds(it, def));
      for (const p of def.ports) {
        const info = endpointInfo(doc, { kind: 'port', comp: it.id, port: p.id });
        if (info) pins.push(info.pt);
      }
    } else if (it.type === 'junction') nodes.push({ x: it.x, y: it.y });
    else if (it.type === 'wire' && !excludeWires?.has(it.id)) {
      const pts = wirePolyline(doc, it);
      for (let i = 0; i < pts.length; i++) {
        nodes.push(pts[i]);
        if (i === 0) continue;
        const a = pts[i - 1];
        const b = pts[i];
        if (Math.abs(a.y - b.y) < EPS) push(hRuns, a.y, a.x, b.x);
        else if (Math.abs(a.x - b.x) < EPS) push(vRuns, a.x, a.y, b.y);
      }
    }
  }
  return { rects, pins, nodes, hRuns, vRuns };
}

const inside = (p: Point, r: Rect) => p.x >= r.x - EPS && p.x <= r.x + r.w + EPS && p.y >= r.y - EPS && p.y <= r.y + r.h + EPS;
const strictlyInside = (p: Point, r: Rect) => p.x > r.x + EPS && p.x < r.x + r.w - EPS && p.y > r.y + EPS && p.y < r.y + r.h - EPS;
const near = (a: Point, b: Point) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

/** Sorted unique coordinates. */
function axis(values: number[]): number[] {
  const s = [...new Set(values.map(key))].sort((a, b) => a - b);
  return s;
}

const DIRS: Point[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];
const dirIndex = (d?: Point) => (!d || (!d.x && !d.y) ? -1 : d.x > 0 ? 0 : d.x < 0 ? 1 : d.y > 0 ? 2 : 3);

const MAX_AXIS = 320;
const MAX_EXPAND = 250_000;

/**
 * Routes one orthogonal leg from `from` to `to`. Returns the full polyline
 * (both ends included, collinear points removed) or null when no clean route
 * exists in the search window.
 */
export function routeLeg(obs: RouteObstacles, from: Point, to: Point, opts: RouteOptions): Point[] | null {
  const g = Math.max(1, opts.grid);
  if (near(from, to)) return [from, to];

  // instance bodies the route may start or end inside (a click on a body, not a pin) don't block it
  const sDir = dirIndex(opts.startDir);
  const eDir = dirIndex(opts.endDir);
  const rects = obs.rects.filter((r) => !((sDir < 0 && strictlyInside(from, r)) || (eDir < 0 && strictlyInside(to, r))));

  // search window: the two ends plus every body in the way, with room to go around
  let x1 = Math.min(from.x, to.x) - 4 * g;
  let x2 = Math.max(from.x, to.x) + 4 * g;
  let y1 = Math.min(from.y, to.y) - 4 * g;
  let y2 = Math.max(from.y, to.y) + 4 * g;
  for (let pass = 0; pass < 3; pass++) {
    for (const r of rects) {
      if (r.x > x2 || r.x + r.w < x1 || r.y > y2 || r.y + r.h < y1) continue;
      x1 = Math.min(x1, r.x - 2 * g);
      x2 = Math.max(x2, r.x + r.w + 2 * g);
      y1 = Math.min(y1, r.y - 2 * g);
      y2 = Math.max(y2, r.y + r.h + 2 * g);
    }
  }
  if ((x2 - x1) / g > MAX_AXIS || (y2 - y1) / g > MAX_AXIS) return null;
  const gridLine = (lo: number, hi: number) => {
    const out: number[] = [];
    for (let v = Math.ceil(lo / g) * g; v <= hi + EPS; v += g) out.push(v);
    return out;
  };
  const xs = axis([...gridLine(x1, x2), from.x, to.x]);
  const ys = axis([...gridLine(y1, y2), from.y, to.y]);
  const W = xs.length;
  const H = ys.length;
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));
  const at = (i: number): Point => ({ x: xs[i % W], y: ys[Math.floor(i / W)] });
  const startCell = yi.get(key(from.y))! * W + xi.get(key(from.x))!;
  const endCell = yi.get(key(to.y))! * W + xi.get(key(to.x))!;

  // blocked cells: bodies (edges included) and every terminal / wire node that isn't an end of this route
  const blocked = new Uint8Array(W * H);
  const winRects = rects.filter((r) => !(r.x > x2 || r.x + r.w < x1 || r.y > y2 || r.y + r.h < y1));
  for (const r of winRects) {
    for (let j = 0; j < H; j++) {
      if (ys[j] < r.y - EPS || ys[j] > r.y + r.h + EPS) continue;
      for (let i = 0; i < W; i++) if (xs[i] >= r.x - EPS && xs[i] <= r.x + r.w + EPS) blocked[j * W + i] = 1;
    }
  }
  for (const p of [...obs.pins, ...obs.nodes]) {
    const i = xi.get(key(p.x));
    const j = yi.get(key(p.y));
    if (i !== undefined && j !== undefined) blocked[j * W + i] = 1;
  }
  // a pin escapes its own body along its outward direction
  const escape = (cell: number, d: number) => {
    blocked[cell] = 0;
    if (d < 0) return;
    let c = cell;
    for (let k = 0; k < 64; k++) {
      const p = at(c);
      if (!winRects.some((r) => inside(p, r))) break;
      blocked[c] = 0;
      const i = (c % W) + DIRS[d].x;
      const j = Math.floor(c / W) + DIRS[d].y;
      if (i < 0 || j < 0 || i >= W || j >= H) break;
      c = j * W + i;
    }
  };
  escape(startCell, sDir);
  escape(endCell, eDir);

  const onRun = (runs: [number, number][] | undefined, v: number) => !!runs && runs.some(([a, b]) => v > a + EPS && v < b - EPS);
  /** Extra cost of a step; Infinity when the step cuts through a body. */
  const stepCost = (a: Point, b: Point, d: number) => {
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    for (const r of winRects) if (strictlyInside(mid, r) && !(inside(from, r) && near(a, from)) && !(inside(to, r) && near(b, to))) return Infinity;
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    // running along an existing wire would short onto it
    const overlap = d < 2 ? onRun(obs.hRuns.get(key(a.y)), mid.x) : onRun(obs.vRuns.get(key(a.x)), mid.y);
    return overlap ? len * 20 + 10 * g : len;
  };

  const BEND = 2 * g;
  const POSTURE = 0.25 * g;
  const PIN_DIR = 3 * g;
  const pDir = dirIndex(opts.prevDir);
  const reverse = (d: number) => d ^ 1;

  const N = W * H * 4;
  const best = new Float64Array(N).fill(Infinity);
  const parent = new Int32Array(N).fill(-1);
  const heap: number[] = [];
  const fOf = new Float64Array(N);
  const closed = new Uint8Array(N);
  const hOf = (c: number) => Math.abs(xs[c % W] - to.x) + Math.abs(ys[Math.floor(c / W)] - to.y);
  const push = (s: number, f: number) => {
    fOf[s] = f;
    heap.push(s);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (fOf[heap[p]] <= f) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = s;
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      const f = fOf[last];
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && fOf[heap[c + 1]] < fOf[heap[c]]) c++;
        if (fOf[heap[c]] >= f) break;
        heap[i] = heap[c];
        i = c;
      }
      heap[i] = last;
    }
    return top;
  };

  // first steps out of the start cell
  for (let d = 0; d < 4; d++) {
    if (d === reverse(pDir)) continue;
    const i = (startCell % W) + DIRS[d].x;
    const j = Math.floor(startCell / W) + DIRS[d].y;
    if (i < 0 || j < 0 || i >= W || j >= H) continue;
    const c = j * W + i;
    if (blocked[c] && c !== endCell) continue;
    let cost = stepCost(from, at(c), d);
    if (!isFinite(cost)) continue;
    if ((d < 2) !== opts.hFirst) cost += POSTURE;
    if (sDir >= 0 && d !== sDir) cost += PIN_DIR;
    const s = c * 4 + d;
    if (cost < best[s]) {
      best[s] = cost;
      parent[s] = -2;
      push(s, cost + hOf(c));
    }
  }

  let found = -1;
  let expanded = 0;
  while (heap.length) {
    const s = pop();
    const c = s >> 2;
    const d = s & 3;
    const gS = best[s];
    if (closed[s]) continue; // stale duplicate
    closed[s] = 1;
    if (c === endCell) {
      found = s;
      break;
    }
    if (++expanded > MAX_EXPAND) break;
    for (let nd = 0; nd < 4; nd++) {
      if (nd === reverse(d)) continue;
      const i = (c % W) + DIRS[nd].x;
      const j = Math.floor(c / W) + DIRS[nd].y;
      if (i < 0 || j < 0 || i >= W || j >= H) continue;
      const n = j * W + i;
      if (blocked[n] && n !== endCell) continue;
      let cost = stepCost(at(c), at(n), nd);
      if (!isFinite(cost)) continue;
      if (nd !== d) cost += BEND;
      if (n === endCell && eDir >= 0 && nd !== reverse(eDir)) cost += PIN_DIR;
      const ns = n * 4 + nd;
      const ng = gS + cost;
      if (ng < best[ns] - EPS) {
        best[ns] = ng;
        parent[ns] = s;
        push(ns, ng + hOf(n));
      }
    }
  }
  if (found < 0) return null;

  const cells: Point[] = [];
  for (let s = found; s >= 0; s = parent[s]) cells.push(at(s >> 2));
  cells.push(from);
  cells.reverse();
  cells[cells.length - 1] = { ...to };
  // keep only the corners
  const out: Point[] = [cells[0]];
  for (let i = 1; i < cells.length - 1; i++) {
    const a = out[out.length - 1];
    const b = cells[i];
    const c = cells[i + 1];
    const collinear = (Math.abs(a.x - b.x) < EPS && Math.abs(b.x - c.x) < EPS) || (Math.abs(a.y - b.y) < EPS && Math.abs(b.y - c.y) < EPS);
    if (!collinear) out.push(b);
  }
  out.push(cells[cells.length - 1]);
  return out;
}
