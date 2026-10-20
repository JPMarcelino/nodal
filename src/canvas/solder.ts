import type { HotSpot } from '../model/hotspots';
import { attachedWires } from '../model/doc';
import { cleanup, solderPinToWire, solderTouch, solderWires, unsolderJunction, unsolderPort } from '../model/ops';
import type { CircuitDoc } from '../model/types';
import { crossingStack } from '../model/wires';
import type { SceneData } from './Scene';

export type SolderAction = 'solder' | 'unsolder';

/** What clicking a hot spot with the solder tool does (null: nothing to solder there). */
export function solderActionFor(spot: HotSpot): SolderAction | null {
  switch (spot.kind) {
    case 'crossing':
    case 'touch':
    case 'pinTouch':
      return 'solder';
    case 'junction':
    case 'pin':
      return 'unsolder';
    case 'end':
      return null;
  }
}

/** Solders or unsolders at a hot spot (call inside mutate). Returns an error message, or null on success. */
export function applySolder(d: CircuitDoc, spot: HotSpot, data: SceneData): string | null {
  let ok = false;
  switch (spot.kind) {
    case 'crossing': {
      const wires = crossingStack(data.crossings, spot.pt, 1, data.layers).map((s) => s.wire);
      if (wires.some((id) => d.items[id]?.locked)) return 'Locked wires cannot be soldered';
      ok = !!solderWires(d, wires, spot.pt);
      break;
    }
    case 'touch': {
      if (d.items[spot.wire]?.locked) return 'Locked wires cannot be soldered';
      const t = spot.target;
      if ((t.kind === 'wire' || t.kind === 'end') && d.items[t.wire]?.locked) return 'Locked wires cannot be soldered';
      if (t.kind === 'junction' && d.items[t.id]?.locked) return 'Locked wires cannot be soldered';
      ok = solderTouch(d, spot.wire, spot.end, spot.target);
      break;
    }
    case 'pinTouch':
      if (d.items[spot.wire]?.locked) return 'Locked wires cannot be soldered';
      ok = solderPinToWire(d, spot.comp, spot.port, spot.wire);
      break;
    case 'junction': {
      if (d.items[spot.id]?.locked) return 'Locked wires cannot be unsoldered';
      if (attachedWires(d, spot.id).some((id) => d.items[id]?.locked)) return 'Locked wires cannot be unsoldered';
      ok = !!unsolderJunction(d, spot.id);
      break;
    }
    case 'pin': {
      const locked = Object.values(d.items).some(
        (it) => it.type === 'wire' && it.locked && [it.a, it.b].some((ep) => ep.kind === 'port' && ep.comp === spot.comp && ep.port === spot.port),
      );
      if (locked) return 'Locked wires cannot be unsoldered';
      ok = !!unsolderPort(d, spot.comp, spot.port);
      break;
    }
    case 'end':
      return 'Nothing to solder at a loose end';
  }
  if (!ok) return solderActionFor(spot) === 'unsolder' ? 'Could not unsolder here' : 'Could not solder here';
  cleanup(d);
  return null;
}
