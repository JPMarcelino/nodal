import type { Net } from './netlist';
import type { CircuitDoc, Point } from './types';
import { portPosition } from './wires';

export interface TraceSeed {
  wire?: string;
  comp?: string;
  port?: string;
}

/** Net a trace was started from (a wire, or a pin). */
export function resolveNet(nets: Net[], seed: TraceSeed): Net | undefined {
  if (seed.wire) {
    const n = nets.find((n) => n.wires.includes(seed.wire!));
    if (n) return n;
  }
  if (seed.comp && seed.port) return nets.find((n) => n.pins.some((p) => p.comp === seed.comp && p.port === seed.port));
  return undefined;
}

export interface FlowWire {
  id: string;
  /** Polyline oriented away from the trace origin. */
  pts: Point[];
  /** Distance along the net from the origin to where this wire starts. */
  start: number;
  len: number;
}

export interface FlowPin {
  key: string;
  comp: string;
  pt: Point;
  at: number;
}

export interface NetFlow {
  wires: FlowWire[];
  pins: FlowPin[];
  /** Distance to the farthest point of the net. */
  reach: number;
}

const key = (p: Point) => `${Math.round(p.x * 2) / 2},${Math.round(p.y * 2) / 2}`;

function polyLen(pts: Point[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return l;
}

/**
 * How a signal would spread through a net from a point: each wire oriented
 * away from the origin, with the distance (along the copper) at which it is
 * reached. Sections joined only by a shared label start from their straight
 * distance, so they light up a beat later, like they would on paper.
 */
export function netFlow(doc: CircuitDoc, net: Net, polys: Map<string, Point[]>, origin: Point): NetFlow {
  const ws = net.wires.map((id) => ({ id, pts: polys.get(id) ?? [] })).filter((w) => w.pts.length >= 2);
  const d = new Map<string, number>();
  const relax = (k: string, v: number) => {
    if (v < (d.get(k) ?? Infinity)) {
      d.set(k, v);
      return true;
    }
    return false;
  };
  // the wire under the origin starts the flow, measured along it in both directions
  let best: { i: number; da: number; db: number; dd: number } | null = null;
  ws.forEach((w, i) => {
    let acc = 0;
    for (let s = 0; s < w.pts.length - 1; s++) {
      const a = w.pts[s];
      const b = w.pts[s + 1];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      const t = seg ? Math.max(0, Math.min(1, ((origin.x - a.x) * (b.x - a.x) + (origin.y - a.y) * (b.y - a.y)) / (seg * seg))) : 0;
      const dd = Math.hypot(a.x + (b.x - a.x) * t - origin.x, a.y + (b.y - a.y) * t - origin.y);
      if (!best || dd < best.dd) {
        const along = acc + seg * t;
        best = { i, da: along, db: polyLen(w.pts) - along, dd };
      }
      acc += seg;
    }
  });
  const lens = ws.map((w) => polyLen(w.pts));
  const seedWire = best as { i: number; da: number; db: number; dd: number } | null;
  if (seedWire) {
    const w = ws[seedWire.i];
    relax(key(w.pts[0]), seedWire.da + seedWire.dd);
    relax(key(w.pts[w.pts.length - 1]), seedWire.db + seedWire.dd);
  }
  const spread = () => {
    for (let pass = 0; pass <= ws.length; pass++) {
      let changed = false;
      ws.forEach((w, i) => {
        const ka = key(w.pts[0]);
        const kb = key(w.pts[w.pts.length - 1]);
        const da = d.get(ka) ?? Infinity;
        const db = d.get(kb) ?? Infinity;
        if (da + lens[i] < db) changed = relax(kb, da + lens[i]) || changed;
        if (db + lens[i] < da) changed = relax(ka, db + lens[i]) || changed;
      });
      if (!changed) break;
    }
  };
  spread();
  // islands joined by name only: start from their straight-line distance
  for (;;) {
    const lone = ws.find((w) => !d.has(key(w.pts[0])) && !d.has(key(w.pts[w.pts.length - 1])));
    if (!lone) break;
    for (const p of [lone.pts[0], lone.pts[lone.pts.length - 1]]) relax(key(p), Math.hypot(p.x - origin.x, p.y - origin.y));
    spread();
  }
  const wires: FlowWire[] = ws.flatMap((w, i): FlowWire[] => {
    const da = d.get(key(w.pts[0])) ?? 0;
    const db = d.get(key(w.pts[w.pts.length - 1])) ?? 0;
    if (seedWire && i === seedWire.i) {
      // the clicked wire flows both ways from the click
      const halves = splitAt(w.pts, origin);
      if (halves) return halves.filter((h) => polyLen(h) > 0.5).map((h, k) => ({ id: `${w.id}:${k}`, pts: h, start: seedWire.dd, len: polyLen(h) }));
    }
    return [db < da ? { id: w.id, pts: [...w.pts].reverse(), start: db, len: lens[i] } : { id: w.id, pts: w.pts, start: da, len: lens[i] }];
  });
  const pins: FlowPin[] = [];
  for (const p of net.pins) {
    const c = doc.items[p.comp];
    if (!c || c.type !== 'component') continue;
    const at = portPosition(doc, c, p.port);
    if (!at) continue;
    pins.push({ key: `${p.comp}:${p.port}`, comp: p.comp, pt: at.pt, at: d.get(key(at.pt)) ?? Math.hypot(at.pt.x - origin.x, at.pt.y - origin.y) });
  }
  const reach = Math.max(0, ...wires.map((w) => w.start + w.len), ...pins.map((p) => p.at));
  return { wires, pins, reach };
}

/** Splits a polyline at the point nearest `origin`; both halves start there. */
export function splitAt(pts: Point[], origin: Point): [Point[], Point[]] | null {
  let bestI = -1;
  let bestPt: Point | null = null;
  let bestD = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    const t = seg ? Math.max(0, Math.min(1, ((origin.x - a.x) * (b.x - a.x) + (origin.y - a.y) * (b.y - a.y)) / (seg * seg))) : 0;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const dd = Math.hypot(p.x - origin.x, p.y - origin.y);
    if (dd < bestD) {
      bestD = dd;
      bestI = i;
      bestPt = p;
    }
  }
  if (!bestPt) return null;
  const back = [bestPt, ...pts.slice(0, bestI + 1).reverse()];
  const fwd = [bestPt, ...pts.slice(bestI + 1)];
  return [back, fwd];
}
