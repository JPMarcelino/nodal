import { describe, expect, it } from 'vitest';
import { BUILTIN_SYMBOLS } from '../model/symbols';

describe('built-in symbol library', () => {
  it('has unique ids', () => {
    const ids = BUILTIN_SYMBOLS.map((s) => s.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  for (const s of BUILTIN_SYMBOLS) {
    it(`${s.id} fits the grid`, () => {
      const problems: string[] = [];
      if (s.w % 20 || s.h % 20) problems.push(`size ${s.w}x${s.h} not a multiple of 20`);
      const ids = new Set<string>();
      for (const p of s.ports) {
        if (ids.has(p.id)) problems.push(`duplicate port ${p.id}`);
        ids.add(p.id);
        if (p.x % 10 || p.y % 10) problems.push(`port ${p.id} (${p.x},${p.y}) off grid`);
        const onEdge = p.x === 0 || p.y === 0 || p.x === s.w || p.y === s.h;
        if (!onEdge) problems.push(`port ${p.id} (${p.x},${p.y}) not on edge`);
      }
      expect(problems).toEqual([]);
    });
  }
});
