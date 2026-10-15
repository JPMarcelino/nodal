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

  const touchedAt = new Set<string>();
  for (const w of items) {
    if (w.type !== 'wire') continue;
    for (const end of ['a', 'b'] as const) {
      const ep = w[end];
      if (ep.kind !== 'free') continue;
      const pt = { x: ep.x, y: ep.y };
      const target = touchTarget(doc, polys, ports, w.id, pt);
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
  const taken = new Set(out.map((h) => `${h.pt.x},${h.pt.y}`));
  for (const p of ports) {
    if (taken.has(`${p.pt.x},${p.pt.y}`)) continue;
    let ends = 0;
    for (const it of items) {
      if (it.type !== 'wire') continue;
      for (const ep of [it.a, it.b]) if (ep.kind === 'port' && ep.comp === p.comp && ep.port === p.port) ends++;
    }
    const over = wireThroughPoint(doc, polys, p.pt, p.comp, p.port);
    if (over) out.push({ kind: 'pinTouch', pt: p.pt, comp: p.comp, port: p.port, wire: over });
    else if (ends > 0) out.push({ kind: 'pin', pt: p.pt, comp: p.comp, port: p.port, ends });
  }
  return out;
}

/** A wire passing through `pt` (not just ending there) that is not attached to this pin. */
function wireThroughPoint(doc: CircuitDoc, polys: Map<string, Point[]>, pt: Point, comp: string, port: string): string | null {
  for (const [wire, pts] of polys) {
    const w = doc.items[wire];
    if (!w || w.type !== 'wire' || w.hidden || pts.length < 2) continue;
    if ([w.a, w.b].some((ep) => ep.kind === 'port' && ep.comp === comp && ep.port === port)) continue;
    if (eq(pts[0], pt) || eq(pts[pts.length - 1], pt)) continue;
    for (let i = 0; i < pts.length - 1; i++) if (projectOnSegment(pt, pts[i], pts[i + 1]).d < 0.5) return wire;
  }
  return null;
}

function touchTarget(doc: CircuitDoc, polys: Map<string, Point[]>, ports: { comp: string; port: string; pt: Point }[], self: string, pt: Point): TouchTarget | null {
  for (const p of ports) if (eq(p.pt, pt)) return { kind: 'port', comp: p.comp, port: p.port };
  for (const it of Object.values(doc.items)) if (it.type === 'junction' && !it.hidden && eq(it, pt)) return { kind: 'junction', id: it.id };
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire' || it.id === self || it.hidden) continue;
    for (const end of ['a', 'b'] as const) {
      const ep = it[end];
      if (ep.kind === 'free' && eq(ep, pt)) return { kind: 'end', wire: it.id, end };
    }
  }
  for (const [wire, pts] of polys) {
    if (wire === self || doc.items[wire]?.hidden) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      if (projectOnSegment(pt, pts[i], pts[i + 1]).d < 0.5) return { kind: 'wire', wire, seg: i };
    }
  }
  return null;
}
