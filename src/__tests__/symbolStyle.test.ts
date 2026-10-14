import { describe, expect, it } from 'vitest';
import { parseDraw, primsToDsl } from '../model/symbols/dsl';
import type { Prim } from '../model/types';

describe('symbol drawing colours and dashes', () => {
  it('survive a round trip through the symbol text format', () => {
    const prims: Prim[] = [
      { t: 'rect', x: 0, y: 0, w: 40, h: 20, fill: 'solid', color: '#ff0000', fc: '#00ff00', dash: true },
      { t: 'line', pts: [0, 0, 10, 10], w: 3 },
      { t: 'line', pts: [0, 10, 10, 0], dash: true, color: '#0000ff' },
      { t: 'circle', cx: 5, cy: 5, r: 4, fill: 'none', dash: true },
      { t: 'line', pts: [1, 1, 2, 2], dash: true },
      { t: 'text', x: 0, y: 0, size: 10, anchor: 'middle', text: 'Hi', color: 'red' },
      { t: 'poly', pts: [0, 0, 10, 0, 5, 5], fill: 'solid' },
    ];
    const back = parseDraw(primsToDsl(prims));
    expect(back).toEqual(prims.map((p) => expect.objectContaining(p)));
    expect(back[1].color).toBeUndefined();
    expect(back[1].dash).toBeUndefined();
    expect(back[6].color).toBeUndefined();
    expect(back[6].fc).toBeUndefined();
  });

  it('leaves plain drawings unchanged', () => {
    const dsl = 'W 2\nR 0 0 40 20\nL 0 10 -10 10';
    expect(primsToDsl(parseDraw(dsl))).toBe(dsl);
  });

  it('rejects colours that are not colours', () => {
    expect(() => parseDraw('SC url(#x)')).toThrow(/colour/);
  });
});
