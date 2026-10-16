import { describe, expect, it } from 'vitest';
import { toWorld } from '../model/geometry';
import { instanceSymbol } from '../model/registry';
import { BUILTIN, BUILTIN_SYMBOLS } from '../model/symbols';
import { compileSource } from '../model/symbols/dsl';
import { gridScale, scaleStep, scaleSymbol, shiftPath } from '../model/symbols/scale';
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

  it('for path-prim symbols with arcs, relative commands and fractional pins', () => {
    const def = compileSource({
      id: 'pathodd', name: 'Path odd', category: 'Mine', w: 31, h: 51,
      draw: 'P m 1.5 21.5 H 21.5 V 41.5 A 8.5 8.5 0 0 1 1.5 21.5 Z M 3.5 5.5 h 5.5 v 5.5 m 2 1 l 1e1 3 a 8.5 8.5 0 0 1 5 5 Z',
      ports: 'a:1.5,21.5 b:31.5,21.5',
      prefix: 'U', value: '', fields: '', keywords: '',
    });
    const doc = { symbols: { pathodd: def } };
    const placed = instanceSymbol(doc, { symbol: 'pathodd' });
    pinsOnGrid(placed);
    // the odd outline shifts the drawing as a whole: absolute coords move,
    // relative commands and arc flags stay untouched
    const path = placed.prims[0];
    if (path.t !== 'path') throw new Error('expected a path prim');
    expect(path.d).toBe(
      'm 9.5 29.5 H 29.5 V 49.5 A 8.5 8.5 0 0 1 9.5 29.5 Z M 11.5 13.5 h 5.5 v 5.5 m 2 1 l 10 3 a 8.5 8.5 0 0 1 5 5 Z');
    // resizing keeps pins on the grid with the drawing moved as a whole
    for (const scale of [0.5, 1.5, 2, 2.5]) {
      const at = instanceSymbol(doc, { symbol: 'pathodd', scale });
      pinsOnGrid(at);
      const plain = scaleSymbol(def, gridScale(def, scale));
      const dx = at.ports[0].x - plain.ports[0].x;
      const dy = at.ports[0].y - plain.ports[0].y;
      at.ports.forEach((p, i) => {
        expect(p.x - plain.ports[i].x).toBeCloseTo(dx, 2);
        expect(p.y - plain.ports[i].y).toBeCloseTo(dy, 2);
      });
      const plainPath = plain.prims[0];
      const atPath = at.prims[0];
      if (plainPath.t !== 'path' || atPath.t !== 'path') throw new Error('expected path prims');
      // alignment is a pure translation: every absolute coordinate moves by the pin offset
      expect(atPath.d).toBe(shiftPath(plainPath.d, dx, dy));
    }
  });

  it('shifts only absolute path coordinates', () => {
    expect(shiftPath('m 1 2 H 3 V 4 A 5 5 0 0 1 6 7 Z M 8 9 h 1 v 1 m 2 2 l 1e1 3 a 5 5 0 0 1 1 1 Z', 10, 20)).toBe(
      'm 11 22 H 13 V 24 A 5 5 0 0 1 16 27 Z M 18 29 h 1 v 1 m 2 2 l 10 3 a 5 5 0 0 1 1 1 Z');
  });
});
