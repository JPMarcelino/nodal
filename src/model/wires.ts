import { eq, projectOnSegment, rotate, segmentIntersection, sideVector, simplify, toWorld } from './geometry';
import { getSymbol } from './registry';
import type { CircuitDoc, ComponentItem, Endpoint, Point, WireItem, WireStyle } from './types';

export interface PortPos {
  pt: Point;
  /** Unit vector pointing away from the component body. */
  dir: Point;
}

export function portPosition(doc: CircuitDoc, c: ComponentItem, portId: string): PortPos | null {
  const def = getSymbol(doc, c.symbol);
  const port = def.ports.find((p) => p.id === portId);
  if (!port) return null;
  return { pt: toWorld(c, def, port.x, port.y), dir: sideVector(c, port.side) };
}

export function endpointInfo(doc: CircuitDoc, ep: Endpoint): PortPos | null {
  switch (ep.kind) {
    case 'free':
      return { pt: { x: ep.x, y: ep.y }, dir: { x: 0, y: 0 } };
    case 'junction': {
      const j = doc.items[ep.id];
      return j && j.type === 'junction' ? { pt: { x: j.x, y: j.y }, dir: { x: 0, y: 0 } } : null;
    }
    case 'port': {
      const c = doc.items[ep.comp];
      return c && c.type === 'component' ? portPosition(doc, c, ep.port) : null;
    }
  }
}

/** Expands a polyline so every segment is horizontal or vertical. */
export function orthogonalize(pts: Point[], startDir?: Point, endDir?: Point): Point[] {
  if (pts.length < 2) return pts;
  const out: Point[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = out[out.length - 1];
    const q = pts[i];
    if (Math.abs(p.x - q.x) > 0.01 && Math.abs(p.y - q.y) > 0.01) {
      let horizontalFirst: boolean;
      if (i === 1 && startDir && (startDir.x || startDir.y)) horizontalFirst = startDir.x !== 0;
      else if (i === pts.length - 1 && endDir && (endDir.x || endDir.y)) horizontalFirst = endDir.x === 0;
      else if (out.length >= 2) {
        // continue alternating: previous segment horizontal → go vertical first
        const pp = out[out.length - 2];
        horizontalFirst = Math.abs(pp.y - p.y) > 0.01;
      } else horizontalFirst = Math.abs(q.x - p.x) >= Math.abs(q.y - p.y);
      out.push(horizontalFirst ? { x: q.x, y: p.y } : { x: p.x, y: q.y });
    }
    out.push(q);
  }
  return simplify(out);
}

/** Full world-space polyline of a wire, including automatic elbows. */
export function wirePolyline(doc: CircuitDoc, w: WireItem): Point[] {
  const a = endpointInfo(doc, w.a);
  const b = endpointInfo(doc, w.b);
  if (!a || !b) return [];
  const raw = [a.pt, ...w.pts, b.pt];
  if (w.routing === 'straight') return simplify(raw);
  return orthogonalize(raw, a.dir, b.dir);
}

export function wireStyle(doc: CircuitDoc, w: WireItem): WireStyle {
  return { ...doc.settings.wire, ...w.style };
}

/* ------------------------------------------------------------------ */
/* Hops                                                                */
/* ------------------------------------------------------------------ */

export interface Hop {
  seg: number;
  /** Distance from the segment start. */
  d: number;
}

interface Seg {
  wire: string;
  idx: number;
  a: Point;
  b: Point;
  horiz: boolean;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Finds wire crossings. At each crossing one wire hops over the other: an
 * explicit per-wire preference (hopOver, true = hop / false = stay flat) wins,
 * otherwise the more horizontal segment hops over the more vertical one (ties
 * broken by wire id), so every crossing is drawn exactly once.
 */
export function computeHops(polys: Map<string, Point[]>, hopSize: number, hopPref?: Map<string, boolean>): Map<string, Hop[]> {
  const segs: Seg[] = [];
  for (const [wire, pts] of polys) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      segs.push({
        wire,
        idx: i,
        a,
        b,
        horiz: Math.abs(b.x - a.x) >= Math.abs(b.y - a.y),
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxY: Math.max(a.y, b.y),
      });
    }
  }
  segs.sort((s, t) => s.minX - t.minX);
  const hops = new Map<string, Hop[]>();
  const margin = 0.5;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    for (let j = i + 1; j < segs.length && segs[j].minX <= s.maxX; j++) {
      const t = segs[j];
      if (s.wire === t.wire) continue;
      if (t.minY > s.maxY || t.maxY < s.minY) continue;
      const hit = segmentIntersection(s.a, s.b, t.a, t.b);
      if (!hit) continue;
      const ls = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
      const lt = Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y);
      const ds = hit.t * ls;
      const dt = hit.u * lt;
      // touching at an end is a connection or a corner, not a crossing
      if (ds < margin || ls - ds < margin || dt < margin || lt - dt < margin) continue;
      const ps = hopPref?.get(s.wire);
      const pt = hopPref?.get(t.wire);
      let hopper: Seg;
      let d: number;
      if (ps === true) [hopper, d] = [s, ds];
      else if (pt === true) [hopper, d] = [t, dt];
      else if (ps === false && pt === false) [hopper, d] = s.horiz !== t.horiz ? (s.horiz ? [s, ds] : [t, dt]) : s.wire > t.wire ? [s, ds] : [t, dt];
      else if (ps === false) [hopper, d] = [t, dt];
      else if (pt === false) [hopper, d] = [s, ds];
      else if (s.horiz !== t.horiz) [hopper, d] = s.horiz ? [s, ds] : [t, dt];
      else [hopper, d] = s.wire > t.wire ? [s, ds] : [t, dt];
      const hl = hopper === s ? ls : lt;
      if (d < hopSize || hl - d < hopSize) continue;
      const list = hops.get(hopper.wire) ?? [];
      list.push({ seg: hopper.idx, d });
      hops.set(hopper.wire, list);
    }
  }
  return hops;
}

/** Builds the hopOver map for a set of items. */
export function hopPrefMap(items: Iterable<{ type: string; id: string; hopOver?: boolean }>): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const it of items) if (it.type === 'wire' && it.hopOver !== undefined) m.set(it.id, it.hopOver);
  return m;
}

/* ------------------------------------------------------------------ */
/* Path building                                                       */
/* ------------------------------------------------------------------ */

const f = (n: number) => +n.toFixed(2);

export function buildWirePath(pts: Point[], radius: number, hops: Hop[] = [], hopStyle: 'arc' | 'gap' | 'none' = 'arc', hopSize = 6): string {
  if (pts.length < 2) return '';
  const n = pts.length;
  const lens: number[] = [];
  for (let i = 0; i < n - 1; i++) lens.push(Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y));
  const cornerR = (i: number) => (i <= 0 || i >= n - 1 ? 0 : Math.min(radius, lens[i - 1] / 2, lens[i] / 2));
  let d = `M${f(pts[0].x)},${f(pts[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const L = lens[i];
    if (L === 0) continue;
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    const at = (s: number) => `${f(a.x + ux * s)},${f(a.y + uy * s)}`;
    const rs = cornerR(i);
    const re = cornerR(i + 1);
    if (hopStyle !== 'none') {
      const segHops = hops.filter((h) => h.seg === i).sort((p, q) => p.d - q.d);
      let last = rs;
      for (const h of segHops) {
        if (h.d - hopSize < last || h.d + hopSize > L - re) continue;
        d += `L${at(h.d - hopSize)}`;
        if (hopStyle === 'arc') {
          const sweep = Math.abs(ux) >= Math.abs(uy) ? (ux > 0 ? 1 : 0) : uy > 0 ? 0 : 1;
          d += `A${hopSize},${hopSize} 0 0 ${sweep} ${at(h.d + hopSize)}`;
        } else {
          d += `M${at(h.d + hopSize)}`;
        }
        last = h.d + hopSize;
      }
    }
    d += `L${at(L - re)}`;
    if (re > 0) {
      const c = pts[i + 2];
      const L2 = lens[i + 1];
      const nx = b.x + ((c.x - b.x) / L2) * re;
      const ny = b.y + ((c.y - b.y) / L2) * re;
      d += `Q${f(b.x)},${f(b.y)} ${f(nx)},${f(ny)}`;
    }
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* Editing helpers                                                     */
/* ------------------------------------------------------------------ */

export interface WireHit {
  wire: string;
  seg: number;
  pt: Point;
  d: number;
}

export function hitWire(polys: Map<string, Point[]>, p: Point, tol: number, exclude?: Set<string>): WireHit | null {
  let best: WireHit | null = null;
  for (const [wire, pts] of polys) {
    if (exclude?.has(wire)) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const pr = projectOnSegment(p, pts[i], pts[i + 1]);
      if (pr.d <= tol && (!best || pr.d < best.d)) best = { wire, seg: i, pt: pr.pt, d: pr.d };
    }
  }
  return best;
}

/** Snaps a point on a wire segment to the grid along the segment direction. */
export function snapOnSegment(pt: Point, a: Point, b: Point, grid: number): Point {
  if (Math.abs(a.y - b.y) < 0.01) {
    const x = Math.min(Math.max(Math.round(pt.x / grid) * grid, Math.min(a.x, b.x)), Math.max(a.x, b.x));
    return { x, y: a.y };
  }
  if (Math.abs(a.x - b.x) < 0.01) {
    const y = Math.min(Math.max(Math.round(pt.y / grid) * grid, Math.min(a.y, b.y)), Math.max(a.y, b.y));
    return { x: a.x, y };
  }
  return pt;
}

/** Translation of a wire whose endpoints moved by the given offsets; keeps segments orthogonal. */
export function adjustWireForMove(full: Point[], moveA: Point | null, moveB: Point | null, ortho: boolean): Point[] {
  const pts = full.map((p) => ({ ...p }));
  const n = pts.length;
  if (n < 2) return pts;
  if (moveA && moveB && eq(moveA, moveB)) return pts.map((p) => ({ x: p.x + moveA.x, y: p.y + moveA.y }));
  const shiftEnd = (endIdx: number, nextIdx: number, m: Point) => {
    const e = pts[endIdx];
    const nb = pts[nextIdx];
    const wasHoriz = Math.abs(e.y - nb.y) < 0.01;
    const wasVert = Math.abs(e.x - nb.x) < 0.01;
    e.x += m.x;
    e.y += m.y;
    if (!ortho || nextIdx === (endIdx === 0 ? n - 1 : 0)) return;
    if (wasHoriz && !wasVert) nb.y += m.y;
    else if (wasVert && !wasHoriz) nb.x += m.x;
  };
  if (moveA) shiftEnd(0, 1, moveA);
  if (moveB) shiftEnd(n - 1, n - 2, moveB);
  return pts;
}

export function rotateVec(p: Point, rot: number) {
  return rotate(p, rot);
}
