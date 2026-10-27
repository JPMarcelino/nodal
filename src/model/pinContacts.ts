import { produce } from 'immer';
import { eq, projectOnSegment } from './geometry';
import { foldJunctionsAtPins, splitWire } from './ops';
import { instanceSymbol } from './registry';
import type { CircuitDoc, ComponentItem, Endpoint, Point, WireItem } from './types';
import { portPosition, wirePolyline } from './wires';

/** Parts that are new in `next`, or were moved, turned, flipped, resized or swapped since `prev`. */
function landedParts(prev: CircuitDoc, next: CircuitDoc): ComponentItem[] {
  const out: ComponentItem[] = [];
  for (const it of Object.values(next.items)) {
    if (it.type !== 'component' || it.hidden) continue;
    const p = prev.items[it.id];
    if (p === it) continue;
    if (!p || p.type !== 'component' || p.x !== it.x || p.y !== it.y || p.rot !== it.rot || !!p.flipX !== !!it.flipX || (p.scale ?? 1) !== (it.scale ?? 1) || p.symbol !== it.symbol) out.push(it);
  }
  return out;
}

const onPort = (ep: Endpoint, comp: string, port: string) => ep.kind === 'port' && ep.comp === comp && ep.port === port;
const onPart = (ep: Endpoint, comp: string) => ep.kind === 'port' && ep.comp === comp;

/**
 * Connects the pins of parts that were just placed or moved to wires they now
 * sit on: a pin exactly on a loose wire end takes that end, and a pin on the
 * middle of a wire splits it there so both halves end on the pin. A wire piece
 * left running between two pins of the same part (a part dropped onto a wire)
 * is removed, so the part sits in series instead of being shorted.
 *
 * Wires that are dragged over pins are left alone: only the part that moves
 * connects. Returns `next` unchanged when nothing connects.
 */
export function attachLandedPins(prev: CircuitDoc, next: CircuitDoc): CircuitDoc {
  const parts = landedParts(prev, next);
  if (!parts.length || !Object.values(next.items).some((i) => i.type === 'wire')) return next;
  // quick reject: does any pin of a landed part touch any wire at all?
  const pins: { comp: string; port: string; pt: Point }[] = [];
  for (const c of parts) {
    for (const p of instanceSymbol(next, c).ports) {
      const at = portPosition(next, c, p.id);
      if (at) pins.push({ comp: c.id, port: p.id, pt: at.pt });
    }
  }
  const touches = (doc: CircuitDoc, w: WireItem, pt: Point) => wirePolyline(doc, w).some((q, i, all) => i > 0 && projectOnSegment(pt, all[i - 1], q).d < 0.01);
  const wires = Object.values(next.items).filter((i): i is WireItem => i.type === 'wire' && !i.hidden);
  if (!pins.some((pin) => wires.some((w) => touches(next, w, pin.pt)))) return next;

  // wires already on a landed part before this settle (not the pieces split off here)
  const leads = new Set(wires.filter((w) => parts.some((c) => onPart(w.a, c.id) || onPart(w.b, c.id))).map((w) => w.id));
  const ownLead = (w: WireItem, comp: string) => leads.has(w.id) && (onPart(w.a, comp) || onPart(w.b, comp));
  return produce(next, (d) => {
    const doc = d as CircuitDoc;
    /** Wire pieces created here, to drop the ones that end up shorting a part. */
    const made = new Set<string>();
    for (const pin of pins) {
      const port: Endpoint = { kind: 'port', comp: pin.comp, port: pin.port };
      for (const w of Object.values(doc.items)) {
        if (w.type !== 'wire' || w.hidden || w.locked) continue;
        // the part's own wires: a turn or flip can lay a lead across another of its pins, which must not swap its nets
        if (onPort(w.a, pin.comp, pin.port) || onPort(w.b, pin.comp, pin.port) || ownLead(w, pin.comp)) continue;
        const full = wirePolyline(doc, w);
        if (full.length < 2) continue;
        for (const end of ['a', 'b'] as const) {
          if (w[end].kind !== 'free' || !eq(end === 'a' ? full[0] : full[full.length - 1], pin.pt)) continue;
          // keep the drawn route: only the end's connection changes
          w.pts = full.slice(1, -1);
          w[end] = port;
        }
        if (onPort(w.a, pin.comp, pin.port) || onPort(w.b, pin.comp, pin.port)) continue;
        if (eq(full[0], pin.pt) || eq(full[full.length - 1], pin.pt)) continue; // an end attached elsewhere
        const seg = full.findIndex((q, i) => i < full.length - 1 && projectOnSegment(pin.pt, q, full[i + 1]).d < 0.01);
        if (seg < 0) continue;
        // split at the pin: both halves end on it
        const jid = splitWire(doc, w.id, seg, pin.pt);
        delete doc.items[jid];
        for (const x of Object.values(doc.items)) {
          if (x.type !== 'wire') continue;
          if (x.a.kind === 'junction' && x.a.id === jid) (x.a = port), made.add(x.id);
          if (x.b.kind === 'junction' && x.b.id === jid) (x.b = port), made.add(x.id);
        }
      }
    }
    // a pin that landed exactly on a solder dot is that dot's connection: fold
    // the dot into the pin first, so a piece left between two pins is seen
    // (including the one running through the part from the dot to its other pin)
    foldJunctionsAtPins(doc, made, new Set(pins.map((p) => `${p.comp}:${p.port}`)));
    // a part dropped across a wire: the piece between its own pins would short it
    for (const id of made) {
      const w = doc.items[id];
      if (w?.type === 'wire' && w.a.kind === 'port' && w.b.kind === 'port' && w.a.comp === w.b.comp && w.a.port !== w.b.port) delete doc.items[id];
    }
  });
}
