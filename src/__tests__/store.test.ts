import { describe, expect, it } from 'vitest';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

describe('store mutations', () => {
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
