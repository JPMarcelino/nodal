import { describe, expect, it } from 'vitest';
import type { CircuitDoc } from '../model/types';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

describe('store mutations', () => {
  it('keeps the base symbol copy while only its types are placed', async () => {
    const { S, set, removeSymbolFromLibrary } = await import('../store/store');
    const { createDoc, makeComponent } = await import('../model/doc');
    const { compileSource } = await import('../model/symbols/dsl');
    const { librarySymbols } = await import('../model/registry');
    const { produce } = await import('immer');

    const base = compileSource({ id: 'user-thing', name: 'Thing', category: 'My symbols', w: 40, h: 20, draw: 'L 0 10 40 10', ports: '1:0,10', prefix: 'U', value: '', fields: '', keywords: '' });
    const typeB = compileSource({ id: 'user-type-b', name: 'Thing', category: 'My symbols', w: 40, h: 20, draw: 'L 0 10 40 10', ports: '1:0,10', prefix: 'U', value: '', fields: '', keywords: '', variantOf: 'user-thing', variantName: 'Type B' });
    // placing Type B copies both defs into the document; no part uses the base directly
    const doc = produce(createDoc(), (d) => {
      d.symbols[base.id] = base;
      d.symbols[typeB.id] = typeB;
      for (const x of [0, 80]) {
        const c = makeComponent(d as CircuitDoc, typeB.id, x, 0);
        d.items[c.id] = c;
      }
    });
    set({ doc, userLibrary: { [base.id]: base, [typeB.id]: typeB } });

    const { inUse } = removeSymbolFromLibrary(base.id);
    // two parts use the family, each counted once
    expect(inUse).toBe(2);
    // the document copies stay, so the variant's base link doesn't dangle
    expect(S().doc.symbols[base.id]).toBeTruthy();
    expect(S().doc.symbols[typeB.id]).toBeTruthy();
    // ... and the family is still listed in the library
    expect(librarySymbols(S().doc).some((d) => d.id === base.id)).toBe(true);
    // but the "My symbols" entries are gone
    expect(S().userLibrary[base.id]).toBeUndefined();
    expect(S().userLibrary[typeB.id]).toBeUndefined();
  });
  it('ignores a recipe return value, so re-picking the current option cannot replace the document', async () => {
    const { S, mutate } = await import('../store/store');
    const before = S().doc;
    const hops = before.settings.hops;
    // `(d) => (d.settings.hops = hops)` returns the value and changes nothing
    mutate((d) => (d.settings.hops = hops) as unknown as void);
    expect(S().doc).toBe(before);
    mutate((d) => (d.settings.hops = hops === 'arc' ? 'gap' : 'arc') as unknown as void);
    expect(typeof S().doc).toBe('object');
    expect(S().doc.items).toBeTruthy();
    expect(S().doc.settings.hops).not.toBe(hops);
  });
});
