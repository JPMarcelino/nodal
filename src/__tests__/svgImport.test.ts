import { describe, expect, it } from 'vitest';
import { arcToCubics, parsePathData } from '../io/svgImport';
import { parseDraw, primsToDsl } from '../model/symbols/dsl';

describe('parsePathData', () => {
  it('normalises relative, H/V and implicit commands to absolute segments', () => {
    const segs = parsePathData('m10 10 20 0 v20 H10 z M5,5l1-1');
    expect(segs.map((s) => s.c).join('')).toBe('MLLLZML');
    expect(segs[1].p).toEqual([30, 10]);
    expect(segs[2].p).toEqual([30, 30]);
    expect(segs[3].p).toEqual([10, 30]);
    expect(segs[6].p).toEqual([6, 4]);
  });

  it('reflects control points for S and T', () => {
    const [, c, s] = parsePathData('M0 0 C0 10 10 10 10 0 S20 -10 20 0');
    expect(c.c).toBe('C');
    expect(s.p.slice(0, 2)).toEqual([10, -10]);
    const [, , t] = parsePathData('M0 0 Q5 10 10 0 T20 0');
    expect(t.p).toEqual([15, -10, 20, 0]);
  });

  it('reads compact arc flags and turns arcs into curves ending on the target', () => {
    const segs = parsePathData('M0 0a10 10 0 0110 10');
    expect(segs[1].c).toBe('C');
    expect(segs[segs.length - 1].p.slice(-2)).toEqual([10, 10]);
  });

  it('rejects junk instead of looping', () => {
    expect(() => parsePathData('M0 0 Z 5 5')).toThrow();
  });
});

describe('arcToCubics', () => {
  it('draws a half circle through the expected midpoint', () => {
    const curves = arcToCubics(-10, 0, 10, 10, 0, false, true, 10, 0)!;
    expect(curves).toHaveLength(2);
    // end of the first quarter is the top of the circle (y down: sweep=1 goes through y = -10)
    expect(curves[0][4]).toBeCloseTo(0, 6);
    expect(Math.abs(curves[0][5])).toBeCloseTo(10, 6);
  });
  it('treats a zero radius as a straight line', () => {
    expect(arcToCubics(0, 0, 0, 5, 0, false, true, 10, 0)).toBeNull();
  });
});

describe('imported drawings survive the symbol DSL', () => {
  it('keeps zero-width (fill only) shapes and paths', () => {
    const src = primsToDsl([
      { t: 'poly', pts: [0, 0, 10, 0, 10, 10], fill: 'solid', w: 0 },
      { t: 'path', d: 'M0 0 C1 2 3 4 5 6 Z', fill: 'none', w: 0.5 },
      { t: 'line', pts: [0, 0, 10, 10], w: 1.25 },
    ]);
    const back = parseDraw(src);
    expect(back.map((p) => p.t)).toEqual(['poly', 'path', 'line']);
    expect(back.map((p) => ('w' in p ? p.w : undefined))).toEqual([0, 0.5, 1.25]);
  });
});
