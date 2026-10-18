import { settleConnectors } from './connectors';
import { resolveWireOverlaps } from './overlap';
import { attachLandedPins } from './pinContacts';
import type { CircuitDoc } from './types';

/**
 * Tidies the connections an edit made, once it is committed (never mid-drag):
 * parts placed or moved onto wires connect to them, and wires left lying on
 * top of each other are merged into one run with junctions. Connectors glued
 * to what moved get their stored ends brought up to date.
 */
export function settleEdit(prev: CircuitDoc, next: CircuitDoc): CircuitDoc {
  if (prev === next) return next;
  return settleConnectors(resolveWireOverlaps(prev, attachLandedPins(prev, next)));
}
