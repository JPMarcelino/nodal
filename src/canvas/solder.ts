import type { HotSpot } from '../model/hotspots';
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
    case 'crossing':
      ok = !!solderWires(d, crossingStack(data.crossings, spot.pt, 1, data.layers).map((s) => s.wire), spot.pt);
      break;
    case 'touch':
      ok = solderTouch(d, spot.wire, spot.end, spot.target);
      break;
    case 'pinTouch':
      ok = solderPinToWire(d, spot.comp, spot.port, spot.wire);
      break;
    case 'junction':
      ok = !!unsolderJunction(d, spot.id);
      break;
    case 'pin':
      ok = !!unsolderPort(d, spot.comp, spot.port);
      break;
    case 'end':
      return 'Nothing to solder at a loose end';
  }
  if (!ok) return solderActionFor(spot) === 'unsolder' ? 'Could not unsolder here' : 'Could not solder here';
  cleanup(d);
  return null;
}
