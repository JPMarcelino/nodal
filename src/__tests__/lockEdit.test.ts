import { describe, expect, it } from 'vitest';
import type { ComponentItem, WireItem } from '../model/types';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

async function setup() {
  const store = await import('../store/store');
  const A = await import('../store/actions');
  const { createDoc } = await import('../model/doc');
  store.set({ doc: createDoc(), page: undefined, scope: undefined, selection: [], past: [], future: [], viewOnly: false, placing: null, wirePart: null });
  return { ...store, A };
}

describe('lock-aware edits', () => {
  it('updateItems leaves locked items alone', async () => {
    const { S, A, mutate } = await setup();
    const locked = A.placeComponent('resistor', 0, 0);
    const unlocked = A.placeComponent('resistor', 100, 0);
    mutate((d) => void ((d.items[locked] as ComponentItem).locked = true));
    const before = (S().doc.items[locked] as ComponentItem).ref;

    A.updateItems([locked, unlocked], (it) => {
      if (it.type === 'component') it.ref = 'R99';
    });

    expect((S().doc.items[locked] as ComponentItem).ref).toBe(before);
    expect((S().doc.items[unlocked] as ComponentItem).ref).toBe('R99');
  });

  it('rerouteWires does not clear the bends of locked wires', async () => {
    const { S, A, mutate, set } = await setup();
    const wire = (id: string, x: number, y: number, locked?: boolean): WireItem => ({
      id,
      type: 'wire',
      a: { kind: 'free', x, y },
      b: { kind: 'free', x: x + 100, y },
      pts: [{ x: x + 50, y: y + 20 }],
      ...(locked ? { locked } : {}),
    });
    mutate((d) => {
      d.items.wLocked = wire('wLocked', 0, 200, true);
      d.items.wFree = wire('wFree', 0, 300);
    });
    set({ selection: ['wLocked', 'wFree'] });

    A.rerouteWires();

    expect((S().doc.items.wLocked as WireItem).pts).toHaveLength(1);
    expect((S().doc.items.wFree as WireItem).pts).toHaveLength(0);
  });

  it('reorder leaves locked items where they are', async () => {
    const { S, A, mutate, set } = await setup();
    const locked = A.placeComponent('resistor', 0, 0);
    const moved = A.placeComponent('resistor', 100, 0);
    const top = A.placeComponent('resistor', 200, 0);
    mutate((d) => {
      d.items[locked].z = 0;
      d.items[moved].z = 1;
      d.items[top].z = 2;
      d.items[locked].locked = true;
    });
    set({ selection: [locked, moved] });

    A.reorder('front');

    expect(S().doc.items[locked].z).toBe(0);
    expect(S().doc.items[moved].z).toBe(2);
    expect(S().doc.items[top].z).toBe(1);
  });

  it('toggleHidden skips locked items', async () => {
    const { S, A, mutate } = await setup();
    const locked = A.placeComponent('resistor', 0, 0);
    const free = A.placeComponent('resistor', 100, 0);
    mutate((d) => void (d.items[locked].locked = true));

    A.toggleHidden([locked, free]);

    expect(S().doc.items[locked].hidden).toBeFalsy();
    expect(S().doc.items[free].hidden).toBe(true);
  });
});
