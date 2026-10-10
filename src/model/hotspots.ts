import { eq, projectOnSegment, toWorld } from './geometry';
import { getSymbol } from './registry';
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
  | { kind: 'end'; pt: Point; wire: string; end: 'a' | 'b' };

export const hotSpotKey = (h: HotSpot) => `${h.kind}:${h.pt.x},${h.pt.y}`;

/**
 * Every hover-menu spot: wire crossings, solder junctions, loose wire ends
 * and loose ends that touch something (a wire, end, junction or pin) without
 * being connected to it.
 */
export function computeHotSpots(doc: CircuitDoc, polys: Map<string, Point[]>, crossings: Crossing[]): HotSpot[] {
  const out: HotSpot[] = crossings.map((c) => ({ kind: 'crossing', pt: c.pt }));
  const items = Object.values(doc.items).filter((it) => !it.hidden);
  for (const it of items) if (it.type === 'junction') out.push({ kind: 'junction', pt: { x: it.x, y: it.y }, id: it.id });

  const ports: { comp: string; port: string; pt: Point }[] = [];
  for (const it of items) {
    if (it.type !== 'component') continue;
    const def = getSymbol(doc, it.symbol);
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
  return out;
}

function touchTarget(doc: CircuitDoc, polys: Map<string, Point[]>, ports: { comp: string; port: string; pt: Point }[], self: string, pt: Point): TouchTarget | null {
  for (const p of ports) if (eq(p.pt, pt)) return { kind: 'port', comp: p.comp, port: p.port };
  for (const it of Object.values(doc.items)) if (it.type === 'junction' && eq(it, pt)) return { kind: 'junction', id: it.id };
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
