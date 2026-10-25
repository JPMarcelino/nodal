import { describe, expect, it } from 'vitest';
import { movePrim, pathBounds, primBounds, scalePrim, transformPath } from '../model/symbols/primGeometry';

describe('symbol editor path geometry', () => {
  it('moves absolute commands and leaves relative ones alone', () => {
    expect(transformPath('M0 0 L10 0 l5 5 Z', 1, 1, 3, 4)).toBe('M3 4 L13 4 l5 5 Z');
  });

  it('scales curves, H/V and arcs', () => {
    expect(transformPath('M0 0 C10 0 10 10 20 10 H30 V20', 2, 1, 0, 0)).toBe('M0 0 C20 0 20 10 40 10 H60 V20');
    expect(transformPath('M0 0 A5 5 0 0 1 10 0', -2, 1, 0, 0)).toBe('M0 0 A10 5 0 0 0 -20 0');
  });

  it('measures a path, control points included', () => {
    expect(pathBounds('M10 10 C10 0 30 0 30 10 Z')).toEqual({ x: 10, y: 0, w: 20, h: 10 });
    expect(pathBounds('m5 5 l10 0 v10')).toEqual({ x: 5, y: 5, w: 10, h: 10 });
  });

  it('lets imported paths be moved and selected', () => {
    const p = { t: 'path' as const, d: 'M0 0 L10 10', fill: 'none' as const };
    expect(primBounds(movePrim(p, 5, 5))).toEqual({ x: 5, y: 5, w: 10, h: 10 });
  });

  it('scales shapes about a point; a stretched circle becomes an ellipse', () => {
    expect(scalePrim({ t: 'rect', x: 10, y: 10, w: 10, h: 10, fill: 'none' }, 10, 10, 2, 3)).toEqual({ t: 'rect', x: 10, y: 10, w: 20, h: 30, fill: 'none' });
    expect(scalePrim({ t: 'circle', cx: 10, cy: 10, r: 5, fill: 'none', color: '#f00' }, 0, 0, 2, 1)).toEqual({ t: 'ellipse', cx: 20, cy: 10, rx: 10, ry: 5, fill: 'none', color: '#f00' });
    expect(scalePrim({ t: 'line', pts: [0, 0, 10, 10] }, 0, 0, 0.5, 0.5)).toEqual({ t: 'line', pts: [0, 0, 5, 5] });
  });
});
