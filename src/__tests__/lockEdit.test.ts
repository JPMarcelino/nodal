import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent } from '../model/doc';
import { reorderItem, restackItems } from '../model/ops';
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

  it('restackItems treats locked items as fixed anchors', () => {
    const doc = createDoc();
    const parts = [0, 1, 2, 3].map((z, i) => {
      const c = makeComponent(doc, 'resistor', i * 200, 0);
      c.z = z;
      doc.items[c.id] = c;
      return c;
    });
    const [a, b, locked, c] = parts;
    locked.locked = true;

    // it may still move within the segment below the lock
    expect(restackItems(doc, [a.id], 'forward')).toBe(true);
    expect([a.z, b.z, locked.z, c.z]).toEqual([1, 0, 2, 3]);
    // but not across it
    expect(restackItems(doc, [a.id], 'forward')).toBe(false);
    expect([a.z, b.z, locked.z, c.z]).toEqual([1, 0, 2, 3]);
    // front / back must not shift the locked item either
    expect(restackItems(doc, [a.id], 'front')).toBe(false);
    expect(restackItems(doc, [c.id], 'back')).toBe(false);
    expect([a.z, b.z, locked.z, c.z]).toEqual([1, 0, 2, 3]);
    // a locked id in the selection is ignored
    expect(restackItems(doc, [locked.id], 'front')).toBe(false);
  });

  it('restackItems leaves a locked item’s z untouched', () => {
    const doc = createDoc();
    const add = (z: number, i: number) => {
      const c = makeComponent(doc, 'resistor', i * 200, 0);
      c.z = z;
      doc.items[c.id] = c;
      return c;
    };
    const a = add(0, 0);
    const b = add(1, 1);
    const locked = add(10, 2);
    const c = add(11, 3);
    const d = add(12, 4);
    locked.locked = true;

    // moving within the unlocked run below the lock leaves its z alone
    expect(restackItems(doc, [a.id], 'forward')).toBe(true);
    expect([a.z, b.z, locked.z, c.z, d.z]).toEqual([1, 0, 10, 11, 12]);
    // and so does moving within the run above it
    expect(restackItems(doc, [d.id], 'backward')).toBe(true);
    expect([a.z, b.z, locked.z, c.z, d.z]).toEqual([1, 0, 10, 12, 11]);
  });

  it('reorderItem treats a locked item as a fixed anchor', () => {
    const doc = createDoc();
    const parts = [0, 100, 200, 300].map((x, i) => {
      const c = makeComponent(doc, 'resistor', x, 0);
      c.z = i;
      doc.items[c.id] = c;
      return c;
    });
    const [a, locked, c, d] = parts;
    locked.locked = true;

    // moving the locked row itself is refused
    expect(reorderItem(doc, locked.id, d.id, 'before')).toBe(false);
    // moving another row across it is refused
    expect(reorderItem(doc, a.id, d.id, 'before')).toBe(false);
    // and moving onto it would shift it, so that is refused too
    expect(reorderItem(doc, c.id, locked.id, 'after')).toBe(false);
    expect(doc.items[locked.id].z).toBe(1);

    // unlocked rows may still be reordered within their segment
    expect(reorderItem(doc, c.id, d.id, 'before')).toBe(true);
    expect(doc.items[locked.id].z).toBe(1);
  });
});
