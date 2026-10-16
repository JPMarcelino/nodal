import { eq, projectOnSegment, rotate, segmentIntersection, sideVector, simplify, toWorld } from './geometry';
import { wireStyleFor } from './bus';
import { instanceSymbol } from './registry';
import type { CircuitDoc, ComponentItem, Endpoint, LabelSide, Point, WireItem, WireStyle } from './types';

export interface PortPos {
  pt: Point;
  /** Unit vector pointing away from the component body. */
  dir: Point;
}

export function portPosition(doc: CircuitDoc, c: ComponentItem, portId: string): PortPos | null {
  const def = instanceSymbol(doc, c);
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
  return wireStyleFor(doc.settings, w);
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

/** One wire's side of a crossing. */
export interface CrossSide {
  wire: string;
  seg: number;
  /** Distance of the crossing from the segment start. */
  d: number;
  /** Segment length. */
  len: number;
  horiz: boolean;
}

export interface Crossing {
  pt: Point;
  a: CrossSide;
  b: CrossSide;
}

/** Every point where two different wires cross (touching at an end or corner is a connection, not a crossing). */
export function wireCrossings(polys: Map<string, Point[]>): Crossing[] {
  const segs = wireSegs(polys);
  segs.sort((s, t) => s.minX - t.minX);
  const out: Crossing[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    for (let j = i + 1; j < segs.length && segs[j].minX <= s.maxX; j++) {
      const t = segs[j];
      if (t.minY > s.maxY || t.maxY < s.minY) continue;
      const c = pairCrossing(s, t);
      if (c) out.push(c);
    }
  }
  return out;
}

/**
 * Crossings with at least one side in `changed`: every pair the full sweep
 * would report for those wires, without re-testing the unchanged remainder.
 */
export function wireCrossingsChanged(polys: Map<string, Point[]>, changed: Set<string>): Crossing[] {
  const targets = [...changed].filter((id) => polys.has(id)).sort();
  if (!targets.length) return [];
  const byWire = new Map<string, Seg[]>();
  for (const s of wireSegs(polys)) {
    const list = byWire.get(s.wire);
    if (list) list.push(s);
    else byWire.set(s.wire, [s]);
  }
  const ids = [...polys.keys()].sort();
  const out: Crossing[] = [];
  for (const w of targets) {
    const a = byWire.get(w) ?? [];
    for (const v of ids) {
      if (v === w) continue;
      if (changed.has(v) && v < w) continue;
      const b = byWire.get(v) ?? [];
      for (const s of a) {
        for (const t of b) {
          if (s.maxX < t.minX || t.maxX < s.minX || s.maxY < t.minY || t.maxY < s.minY) continue;
          const c = pairCrossing(s, t);
          if (c) out.push(c);
        }
      }
    }
  }
  return out;
}

function wireSegs(polys: Map<string, Point[]>): Seg[] {
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
  return segs;
}

function pairCrossing(s: Seg, t: Seg): Crossing | null {
  if (s.wire === t.wire) return null;
  const hit = segmentIntersection(s.a, s.b, t.a, t.b);
  if (!hit) return null;
  const margin = 0.5;
  const ls = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
  const lt = Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y);
  const ds = hit.t * ls;
  const dt = hit.u * lt;
  if (ds < margin || ls - ds < margin || dt < margin || lt - dt < margin) return null;
  return {
    pt: hit.pt,
    a: { wire: s.wire, seg: s.idx, d: ds, len: ls, horiz: s.horiz },
    b: { wire: t.wire, seg: t.idx, d: dt, len: lt, horiz: t.horiz },
  };
}

/**
 * Whether wire side `s` hops over `t`. A higher stacking layer (hopLayer,
 * default 0) hops over a lower one; on equal layers the more horizontal
 * segment hops over the more vertical one, then the wire id decides.
 * This is a strict total order, so a stack of wires always sorts cleanly.
 */
export function hopsOver(s: { wire: string; horiz: boolean }, t: { wire: string; horiz: boolean }, layers?: Map<string, number>): boolean {
  const ls = layers?.get(s.wire) ?? 0;
  const lt = layers?.get(t.wire) ?? 0;
  return ls !== lt ? ls > lt : s.horiz !== t.horiz ? s.horiz : s.wire > t.wire;
}

/** Hop arcs for a set of crossings; the wire that hops over gets the arc. */
export function hopsFromCrossings(crossings: Crossing[], hopSize: number, layers?: Map<string, number>): Map<string, Hop[]> {
  const hops = new Map<string, Hop[]>();
  for (const c of crossings) {
    const hopper = hopsOver(c.a, c.b, layers) ? c.a : c.b;
    if (hopper.d < hopSize || hopper.len - hopper.d < hopSize) continue;
    const list = hops.get(hopper.wire) ?? [];
    list.push({ seg: hopper.seg, d: hopper.d });
    hops.set(hopper.wire, list);
  }
  return hops;
}

/** Finds wire crossings and decides which wire hops at each one (see hopsOver). */
export function computeHops(polys: Map<string, Point[]>, hopSize: number, layers?: Map<string, number>): Map<string, Hop[]> {
  return hopsFromCrossings(wireCrossings(polys), hopSize, layers);
}

/** Stacking layers of the wires that have one set. */
export function hopLayerMap(items: Iterable<{ type: string; id: string; hopLayer?: number }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) if (it.type === 'wire' && it.hopLayer) m.set(it.id, it.hopLayer);
  return m;
}

/** Wires crossing within `eps` of a point, top of the stack (hops over the rest) first. */
export function crossingStack(crossings: Crossing[], pt: Point, eps: number, layers?: Map<string, number>): CrossSide[] {
  const byWire = new Map<string, CrossSide>();
  for (const c of crossings) {
    if (Math.hypot(c.pt.x - pt.x, c.pt.y - pt.y) > eps) continue;
    for (const side of [c.a, c.b]) if (!byWire.has(side.wire)) byWire.set(side.wire, side);
  }
  return [...byWire.values()].sort((s, t) => (hopsOver(s, t, layers) ? -1 : 1));
}

/**
 * New stacking layers that put `order` (top first) in that exact order while
 * staying as close as possible to the wires' current layers.
 */
export function restack(order: string[], layers: Map<string, number>): Map<string, number> {
  const vals = order.map((w) => layers.get(w) ?? 0).sort((a, b) => b - a);
  for (let i = 1; i < vals.length; i++) vals[i] = Math.min(vals[i], vals[i - 1] - 1);
  return new Map(order.map((w, i) => [w, vals[i]]));
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

/**
 * Polyline with vertex `idx` moved to `p`. Unless `free`, the neighbouring
 * bends slide along so their segments stay horizontal / vertical; the wire's
 * end points never move (they are attached to pins or junctions).
 */
export function moveWireNode(base: Point[], idx: number, p: Point, free: boolean): Point[] {
  const pts = base.map((q) => ({ ...q }));
  const old = base[idx];
  if (!free) {
    for (const nb of [idx - 1, idx + 1]) {
      if (nb <= 0 || nb >= pts.length - 1) continue;
      const q = pts[nb];
      const horiz = Math.abs(old.y - q.y) < 0.01 && Math.abs(old.x - q.x) >= 0.01;
      const vert = Math.abs(old.x - q.x) < 0.01 && Math.abs(old.y - q.y) >= 0.01;
      if (horiz) q.y = p.y;
      else if (vert) q.x = p.x;
    }
  }
  pts[idx] = { ...p };
  return pts;
}

export function rotateVec(p: Point, rot: number) {
  return rotate(p, rot);
}

/** Point at fraction `t` (0…1) of a polyline's length, and whether that stretch runs horizontally. */
export function pointAlong(pts: Point[], t: number): { pt: Point; horiz: boolean } | null {
  if (pts.length < 2) return null;
  const lens = pts.slice(1).map((q, i) => Math.hypot(q.x - pts[i].x, q.y - pts[i].y));
  const total = lens.reduce((a, b) => a + b, 0);
  let left = Math.min(Math.max(t, 0), 1) * total;
  for (let i = 0; i < lens.length; i++) {
    if (left <= lens[i] || i === lens.length - 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const k = lens[i] ? Math.min(left / lens[i], 1) : 0;
      return { pt: { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }, horiz: Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) };
    }
    left -= lens[i];
  }
  return null;
}

/** Nearest spot on a polyline to `p`: its fraction along the length, distance, and the stretch direction. */
export function projectAlong(pts: Point[], p: Point): { t: number; d: number; pt: Point; horiz: boolean } | null {
  if (pts.length < 2) return null;
  let total = 0;
  let best: { t: number; d: number; pt: Point; horiz: boolean; at: number } | null = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const pr = projectOnSegment(p, a, b);
    if (!best || pr.d < best.d) best = { t: 0, d: pr.d, pt: pr.pt, horiz: Math.abs(b.x - a.x) >= Math.abs(b.y - a.y), at: total + pr.t * len };
    total += len;
  }
  if (!best) return null;
  return { t: total ? best.at / total : 0.5, d: best.d, pt: best.pt, horiz: best.horiz };
}

/** Where a wire's label is drawn: anchor point, text anchor and the side it ended up on. */
export function wireLabelSpot(
  w: Pick<WireItem, 'labelAt' | 'labelSide'>,
  pts: Point[],
  width: number,
): { x: number; y: number; anchor: 'start' | 'middle' | 'end'; side: LabelSide } | null {
  let at: { pt: Point; horiz: boolean } | null = null;
  if (w.labelAt === undefined) {
    // middle of the longest segment reads best
    let best = -1;
    for (let i = 0; i < pts.length - 1; i++) {
      const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      if (l > best) {
        best = l;
        at = { pt: { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 }, horiz: Math.abs(pts[i + 1].x - pts[i].x) >= Math.abs(pts[i + 1].y - pts[i].y) };
      }
    }
  } else at = pointAlong(pts, w.labelAt);
  if (!at) return null;
  const side: LabelSide = w.labelSide ?? (at.horiz ? 'above' : 'right');
  const { x, y } = at.pt;
  switch (side) {
    case 'above':
      return { x, y: y - width - 3, anchor: 'middle', side };
    case 'below':
      return { x, y: y + width + 10, anchor: 'middle', side };
    case 'left':
      return { x: x - width - 4, y: y + 3.5, anchor: 'end', side };
    case 'right':
      return { x: x + width + 4, y: y + 3.5, anchor: 'start', side };
  }
}
