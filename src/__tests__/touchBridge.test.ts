import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent } from '../model/doc';
import { computeNets } from '../model/netlist';
import { translateItems } from '../model/ops';
import type { CircuitDoc, WireItem } from '../model/types';

/** Two resistors butted end to end: R1's right pin sits on R2's left pin. */
function butted() {
  const d = createDoc();
  const r1 = makeComponent(d, 'resistor', 0, 0);
  d.items[r1.id] = r1;
  const r2 = makeComponent(d, 'resistor', 80, 0);
  d.items[r2.id] = r2;
  return { d, r1: r1.id, r2: r2.id };
}
const wires = (d: CircuitDoc) => Object.values(d.items).filter((i): i is WireItem => i.type === 'wire');
const joined = (d: CircuitDoc) => computeNets(d).filter((n) => n.pins.length > 1).length;

describe('touching pins pulled apart', () => {
  it('adds a wire so the parts stay connected', () => {
    const { d, r1, r2 } = butted();
    expect(joined(d)).toBe(1);
    const moved = produce(d, (x) => translateItems(d, x as CircuitDoc, new Set([r2]), 20, 60));
    const ws = wires(moved);
    expect(ws).toHaveLength(1);
    expect(ws[0].a).toEqual({ kind: 'port', comp: r1, port: '2' });
    expect(ws[0].b).toEqual({ kind: 'port', comp: r2, port: '1' });
    expect(joined(moved)).toBe(1);
  });

  it('rebuilds the same wire on every drag step and adds none when both parts move', () => {
    const { d, r1, r2 } = butted();
    const step1 = produce(d, (x) => translateItems(d, x as CircuitDoc, new Set([r2]), 0, 40));
    const step2 = produce(d, (x) => translateItems(d, x as CircuitDoc, new Set([r2]), 0, 80));
    expect(wires(step1).map((w) => w.id)).toEqual(wires(step2).map((w) => w.id));
    const both = produce(d, (x) => translateItems(d, x as CircuitDoc, new Set([r1, r2]), 0, 80));
    expect(wires(both)).toHaveLength(0);
  });
});
