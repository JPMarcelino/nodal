import { describe, expect, it } from 'vitest';
import { toWorld } from '../model/geometry';
import { instanceSymbol } from '../model/registry';
import { BUILTIN_SYMBOLS } from '../model/symbols';
import { compileSource } from '../model/symbols/dsl';
import { gridAlignSymbol } from '../model/symbols/scale';
import type { SymbolDef } from '../model/types';

const onGrid = (v: number) => Math.abs(Math.round(v / 10) * 10 - v) < 0.01;

function pinsOnGrid(def: SymbolDef) {
  for (const rot of [0, 90, 180, 270] as const)
    for (const flipX of [false, true])
      for (const p of def.ports) {
        const w = toWorld({ x: 120, y: 340, rot, flipX }, def, p.x, p.y);
        expect(onGrid(w.x) && onGrid(w.y), `${def.id}@${def.w} pin ${p.id} at ${w.x},${w.y} (rot ${rot})`).toBe(true);
      }
}

describe('pins of placed parts stay on the grid', () => {
  it('leaves symbols already on the grid untouched', () => {
    for (const s of BUILTIN_SYMBOLS) pinsOnGrid(instanceSymbol({ symbols: {} }, { symbol: s.id }));
    const res = BUILTIN_SYMBOLS.find((s) => s.id === 'resistor')!;
    expect(gridAlignSymbol(res)).toBe(res);
  });

  it('at any size', () => {
    for (const scale of [0.25, 0.5, 0.75, 1.25, 1.5, 1.75, 2, 2.5, 3, 0.33, 1.1, 1.37])
      for (const s of BUILTIN_SYMBOLS) {
        const def = instanceSymbol({ symbols: {} }, { symbol: s.id, scale });
        pinsOnGrid(def);
        // no two pins collapse onto one point unless they already did
        const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
        expect(new Set(def.ports.map(key)).size).toBe(new Set(s.ports.map(key)).size);
      }
  });

  it('for user symbols with an odd-grid outline', () => {
    const def = compileSource({
      id: 'odd', name: 'Odd', category: 'Mine', w: 30, h: 50,
      draw: 'L 0 20 10 20\nR 10 10 10 30', ports: 'a:0,20 b:30,20 c:10,50',
      prefix: 'U', value: '', fields: '', keywords: '',
    });
    const placed = instanceSymbol({ symbols: { odd: def } }, { symbol: 'odd' });
    pinsOnGrid(placed);
    // the drawing keeps its shape: the anchor moved, nothing was stretched
    expect(placed.prims).toHaveLength(def.prims.length);
  });

  it('stretches a lead to meet a snapped pin', () => {
    const def = gridAlignSymbol({
      id: 'x', name: 'x', category: 'x', prefix: 'U', w: 40, h: 20,
      prims: [{ t: 'line', pts: [0, 10, 13, 10] }, { t: 'line', pts: [27, 10, 40, 10] }, { t: 'line', pts: [20, 0, 20, 3] }],
      ports: [{ id: 'a', name: 'a', x: 0, y: 10, side: 'left' }, { id: 'b', name: 'b', x: 40, y: 10, side: 'right' }, { id: 'c', name: 'c', x: 23, y: 3, side: 'top' }],
    } as SymbolDef);
    pinsOnGrid(def);
    const c = def.ports.find((p) => p.id === 'c')!;
    expect(def.prims.some((p) => p.t === 'line' && p.pts.includes(c.x) && p.pts.includes(c.y))).toBe(true);
  });
});

describe('tiny parts', () => {
  it('keep their pins inside the outline', () => {
    for (const s of BUILTIN_SYMBOLS) {
      const def = instanceSymbol({ symbols: {} }, { symbol: s.id, scale: 0.1 });
      pinsOnGrid(def);
      for (const p of def.ports) expect(p.x >= -0.01 && p.x <= def.w + 0.01 && p.y >= -0.01 && p.y <= def.h + 0.01, `${s.id} ${p.id}`).toBe(true);
    }
  });
});
