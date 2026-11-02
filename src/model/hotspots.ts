import { eq, projectOnSegment, toWorld } from './geometry';
import { instanceSymbol } from './registry';
import type { CircuitDoc, Point } from './types';
import type { Crossing } from './wires';

/** What a loose wire end is resting on without being connected to it. */
export type TouchTarget =
  | { kind: 'wire'; wire: string; seg: number }
  | { kind: 'end'; wire: string; end: 'a' | 'b' }
  | { kind: 'junction'; id: string }
  | { kind: 'port'; comp: string; port: string };

/** A point on the canvas that offers a hover menu. */
export type HotSpot =
  | { kind: 'crossing'; pt: Point }
  | { kind: 'junction'; pt: Point; id: string }
  | { kind: 'touch'; pt: Point; wire: string; end: 'a' | 'b'; target: TouchTarget }
  | { kind: 'end'; pt: Point; wire: string; end: 'a' | 'b' }
  /** A component pin lying on a wire without being connected to it. */
  | { kind: 'pinTouch'; pt: Point; comp: string; port: string; wire: string }
  /** A component pin with wires connected. */
  | { kind: 'pin'; pt: Point; comp: string; port: string; ends: number };

export const hotSpotKey = (h: HotSpot) => `${h.kind}:${h.pt.x},${h.pt.y}`;

/**
 * Every hover-menu spot: wire crossings, solder junctions, loose wire ends,
 * loose ends that touch something (a wire, end, junction or pin) without
 * being connected to it, pins lying on a wire, and pins with wires on them.
 */
export function computeHotSpots(doc: CircuitDoc, polys: Map<string, Point[]>, crossings: Crossing[]): HotSpot[] {
  const out: HotSpot[] = crossings.map((c) => ({ kind: 'crossing', pt: c.pt }));
  const items = Object.values(doc.items).filter((it) => !it.hidden);
  for (const it of items) if (it.type === 'junction') out.push({ kind: 'junction', pt: { x: it.x, y: it.y }, id: it.id });

  const ports: { comp: string; port: string; pt: Point }[] = [];
  for (const it of items) {
    if (it.type !== 'component') continue;
    const def = instanceSymbol(doc, it);
    for (const p of def.ports) ports.push({ comp: it.id, port: p.id, pt: toWorld(it, def, p.x, p.y) });
  }
  // every lookup below goes through these spatial indexes: a big drawing would otherwise
  // compare each wire end and pin against every other item (seconds per edit at ~1000 parts)
  const ix = indexDoc(doc, polys, ports);

  const touchedAt = new Set<string>();
  for (const w of items) {
    if (w.type !== 'wire') continue;
    for (const end of ['a', 'b'] as const) {
      const ep = w[end];
      if (ep.kind !== 'free') continue;
      const pt = { x: ep.x, y: ep.y };
      const target = touchTarget(ix, w.id, pt);
      if (!target) {
        out.push({ kind: 'end', pt, wire: w.id, end });
        continue;
      }
      // two loose ends on the same spot form one touch, not two
      const k = `${pt.x},${pt.y}`;
      if (touchedAt.has(k)) continue;
      touchedAt.add(k);
      out.push({ kind: 'touch', pt, wire: w.id, end, target });
    }
  }

  // pins: lying on a wire (solder), or with wires connected (unsolder)
  const endsAt = new Map<string, number>();
  for (const it of items) {
    if (it.type !== 'wire') continue;
    for (const ep of [it.a, it.b]) if (ep.kind === 'port') endsAt.set(`${ep.comp}\0${ep.port}`, (endsAt.get(`${ep.comp}\0${ep.port}`) ?? 0) + 1);
  }
  const taken = new Set(out.map((h) => `${h.pt.x},${h.pt.y}`));
  for (const p of ports) {
    if (taken.has(`${p.pt.x},${p.pt.y}`)) continue;
    const ends = endsAt.get(`${p.comp}\0${p.port}`) ?? 0;
    const over = wireThroughPoint(doc, ix, p.pt, p.comp, p.port);
    if (over) out.push({ kind: 'pinTouch', pt: p.pt, comp: p.comp, port: p.port, wire: over });
    else if (ends > 0) out.push({ kind: 'pin', pt: p.pt, comp: p.comp, port: p.port, ends });
  }
  return out;
}

/** Things filed by grid cell; each entry keeps its original order so lookups return the same first match as a full scan. */
class Grid<T> {
  private cells = new Map<string, { n: number; v: T }[]>();
  private n = 0;
  constructor(private size: number) {}
  /** Files `v` under every cell the box touches. */
  add(x0: number, y0: number, x1: number, y1: number, v: T) {
    const n = this.n++;
    const s = this.size;
    for (let cx = Math.floor(x0 / s); cx <= Math.floor(x1 / s); cx++)
      for (let cy = Math.floor(y0 / s); cy <= Math.floor(y1 / s); cy++) {
        const k = `${cx},${cy}`;
        const c = this.cells.get(k);
        if (c) c.push({ n, v });
        else this.cells.set(k, [{ n, v }]);
      }
  }
  /** Entries filed near `pt`, in the order they were added. */
  near(pt: Point): T[] {
    const s = this.size;
    const cx = Math.floor(pt.x / s);
    const cy = Math.floor(pt.y / s);
    const hits: { n: number; v: T }[] = [];
    const seen = new Set<number>();
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const e of this.cells.get(`${cx + dx},${cy + dy}`) ?? []) if (!seen.has(e.n)) seen.add(e.n), hits.push(e);
    return hits.sort((a, b) => a.n - b.n).map((e) => e.v);
  }
}

/** One wire segment, with its wire's two ends. */
type Seg = { wire: string; i: number; a: Point; b: Point; first: Point; last: Point };
type DocIndex = {
  ports: Grid<{ comp: string; port: string; pt: Point }>;
  junctions: Grid<{ id: string; pt: Point }>;
  ends: Grid<{ wire: string; end: 'a' | 'b'; pt: Point }>;
  segs: Grid<Seg>;
};

function indexDoc(doc: CircuitDoc, polys: Map<string, Point[]>, ports: { comp: string; port: string; pt: Point }[]): DocIndex {
  const ix: DocIndex = { ports: new Grid(16), junctions: new Grid(16), ends: new Grid(16), segs: new Grid(64) };
  for (const p of ports) ix.ports.add(p.pt.x, p.pt.y, p.pt.x, p.pt.y, p);
  for (const it of Object.values(doc.items)) {
    if (it.hidden) continue;
    if (it.type === 'junction') ix.junctions.add(it.x, it.y, it.x, it.y, { id: it.id, pt: it });
    if (it.type === 'wire')
      for (const end of ['a', 'b'] as const) {
        const ep = it[end];
        if (ep.kind === 'free') ix.ends.add(ep.x, ep.y, ep.x, ep.y, { wire: it.id, end, pt: ep });
      }
  }
  for (const [wire, pts] of polys) {
    if (doc.items[wire]?.hidden) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      ix.segs.add(Math.min(a.x, b.x) - 1, Math.min(a.y, b.y) - 1, Math.max(a.x, b.x) + 1, Math.max(a.y, b.y) + 1, { wire, i, a, b, first: pts[0], last: pts[pts.length - 1] });
    }
  }
  return ix;
}

/** A wire passing through `pt` (not just ending there) that is not attached to this pin. */
function wireThroughPoint(doc: CircuitDoc, ix: DocIndex, pt: Point, comp: string, port: string): string | null {
  for (const s of ix.segs.near(pt)) {
    const w = doc.items[s.wire];
    if (!w || w.type !== 'wire') continue;
    if ([w.a, w.b].some((ep) => ep.kind === 'port' && ep.comp === comp && ep.port === port)) continue;
    if (eq(s.first, pt) || eq(s.last, pt)) continue;
    if (projectOnSegment(pt, s.a, s.b).d < 0.5) return s.wire;
  }
  return null;
}

function touchTarget(ix: DocIndex, self: string, pt: Point): TouchTarget | null {
  for (const p of ix.ports.near(pt)) if (eq(p.pt, pt)) return { kind: 'port', comp: p.comp, port: p.port };
  for (const j of ix.junctions.near(pt)) if (eq(j.pt, pt)) return { kind: 'junction', id: j.id };
  for (const e of ix.ends.near(pt)) if (e.wire !== self && eq(e.pt, pt)) return { kind: 'end', wire: e.wire, end: e.end };
  for (const s of ix.segs.near(pt)) {
    if (s.wire === self) continue;
    if (projectOnSegment(pt, s.a, s.b).d < 0.5) return { kind: 'wire', wire: s.wire, seg: s.i };
  }
  return null;
}
