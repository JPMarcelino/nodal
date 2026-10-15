import { describe, expect, it } from 'vitest';
import { instanceSymbol } from '../model/registry';
import { BUILTIN, BUILTIN_SYMBOLS } from '../model/symbols';

describe('built-in symbol library', () => {
  it('has unique ids', () => {
    const ids = BUILTIN_SYMBOLS.map((s) => s.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('wires up symbol types both ways', () => {
    for (const s of BUILTIN_SYMBOLS) {
      if (s.variantOf) {
        expect(BUILTIN[s.variantOf], `${s.id} references missing base ${s.variantOf}`).toBeTruthy();
      }
      for (const ref of s.variants ?? []) {
        const v = BUILTIN[ref.id];
        expect(v, `${s.id} lists missing type ${ref.id}`).toBeTruthy();
        expect(v.variantOf, `${ref.id} is not marked as a type of ${s.id}`).toBe(s.id);
      }
    }
  });

  it('offers at least three MOSFET drawing types', () => {
    for (const id of ['nmos', 'pmos']) {
      const base = BUILTIN[id];
      expect(base.variants?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
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

describe('switch open/closed state', () => {
  const doc = { symbols: {} };

  it('draws a closed switch with its closed drawing', () => {
    const def = BUILTIN['switch-spst'];
    expect(def.closedPrims).toBeTruthy();
    expect(instanceSymbol(doc, { symbol: 'switch-spst' }).prims).toBe(def.prims);
    const closed = instanceSymbol(doc, { symbol: 'switch-spst', closed: true });
    expect(closed.prims).toBe(def.closedPrims);
    expect(closed.ports).toBe(def.ports);
    expect(instanceSymbol(doc, { symbol: 'switch-spst', closed: true })).toBe(closed);
  });

  it('scales the closed drawing', () => {
    const closed = instanceSymbol(doc, { symbol: 'switch-spst', closed: true, scale: 2 });
    expect(closed.w).toBe(160);
    expect(closed.prims).toHaveLength(BUILTIN['switch-spst'].closedPrims!.length);
  });

  it('ignores the state on parts without a closed drawing', () => {
    expect(instanceSymbol(doc, { symbol: 'relay-coil', closed: true })).toBe(BUILTIN['relay-coil']);
  });
});
