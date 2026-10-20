import { describe, expect, it } from 'vitest';
import type { CircuitDoc } from '../model/types';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

describe('selectAll inside a group', () => {
  it('selects only the scoped subtree, skipping other groups and root items', async () => {
    const { S, set } = await import('../store/store');
    const { createDoc, makeComponent } = await import('../model/doc');
    const { selectAll } = await import('../store/actions');

    const doc = createDoc();
    doc.groups['A'] = { id: 'A', name: 'A', group: undefined };
    doc.groups['B'] = { id: 'B', name: 'B', group: undefined };
    doc.groups['A1'] = { id: 'A1', name: 'A1', group: 'A' };
    const put = (x: number, group?: string) => {
      const c = makeComponent(doc as CircuitDoc, 'resistor', x, 0);
      if (group) c.group = group;
      doc.items[c.id] = c;
      return c.id;
    };
    const a1 = put(0, 'A');
    const a2 = put(100, 'A');
    const n1 = put(200, 'A1');
    const b1 = put(300, 'B');
    const b2 = put(400, 'B');
    const u1 = put(500);
    const h1 = put(600, 'A');
    doc.items[h1].hidden = true;
    const l1 = put(700, 'B');
    doc.items[l1].locked = true;

    // inside group A: its direct members plus the nested subgroup, nothing else
    set({ doc, page: undefined, scope: 'A', selection: [] });
    selectAll();
    expect(new Set(S().selection)).toEqual(new Set([a1, a2, n1]));

    // without a scope everything visible still matches (other groups and root items included)
    set({ scope: undefined, selection: [] });
    selectAll();
    expect(S().selection).toEqual(expect.arrayContaining([a1, a2, n1, b1, b2, u1]));
  });
});
