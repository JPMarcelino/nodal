import { describe, expect, it } from 'vitest';
import { toWorld } from '../model/geometry';
import { instanceSymbol } from '../model/registry';
import { BUILTIN, BUILTIN_SYMBOLS } from '../model/symbols';
import { compileSource } from '../model/symbols/dsl';
import { gridScale, scaleStep, scaleSymbol } from '../model/symbols/scale';
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
    expect(instanceSymbol({ symbols: {} }, { symbol: 'resistor' })).toBe(BUILTIN.resistor);
  });

  it('at any size, with the drawing scaled exactly and never reshaped', () => {
    for (const scale of [0.1, 0.25, 0.5, 0.75, 1.25, 1.5, 1.75, 2, 2.5, 3, 0.33, 1.1, 1.37])
      for (const s of BUILTIN_SYMBOLS) {
        const def = instanceSymbol({ symbols: {} }, { symbol: s.id, scale });
        pinsOnGrid(def);
        // same drawing as a plain scale by the snapped size, moved as a whole
        const plain = scaleSymbol(s, gridScale(s, scale));
        expect(def.prims).toHaveLength(plain.prims.length);
        if (!def.ports.length) continue;
        const dx = def.ports[0].x - plain.ports[0].x;
        const dy = def.ports[0].y - plain.ports[0].y;
        def.ports.forEach((p, i) => {
          expect(p.x - plain.ports[i].x).toBeCloseTo(dx, 2);
          expect(p.y - plain.ports[i].y).toBeCloseTo(dy, 2);
        });
      }
  });

  it('snaps sizes to steps that keep the pin spacing on the grid', () => {
    const step = scaleStep(BUILTIN.resistor);
    expect(step).toBeGreaterThan(0);
    expect(gridScale(BUILTIN.resistor, 1)).toBe(1);
    for (const k of [0.3, 1.4, 2.2]) expect(gridScale(BUILTIN.resistor, k) / step).toBeCloseTo(Math.round(gridScale(BUILTIN.resistor, k) / step), 6);
  });

  it('for user symbols with an odd-grid outline', () => {
    const def = compileSource({
      id: 'odd', name: 'Odd', category: 'Mine', w: 30, h: 50,
      draw: 'L 0 20 10 20\nR 10 10 10 30', ports: 'a:0,20 b:30,20 c:10,50',
      prefix: 'U', value: '', fields: '', keywords: '',
    });
    const placed = instanceSymbol({ symbols: { odd: def } }, { symbol: 'odd' });
    pinsOnGrid(placed);
    expect(placed.prims).toHaveLength(def.prims.length);
  });
});
