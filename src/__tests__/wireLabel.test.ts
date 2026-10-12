import { describe, expect, it } from 'vitest';
import { pointAlong, projectAlong, wireLabelSpot } from '../model/wires';

const L = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
];

describe('wire net labels', () => {
  it('finds points along a bent wire', () => {
    expect(pointAlong(L, 0.25)).toEqual({ pt: { x: 50, y: 0 }, horiz: true });
    expect(pointAlong(L, 0.75)).toEqual({ pt: { x: 100, y: 50 }, horiz: false });
    expect(pointAlong(L, 2)!.pt).toEqual({ x: 100, y: 100 });
  });

  it('projects the pointer onto the wire', () => {
    const p = projectAlong(L, { x: 120, y: 50 })!;
    expect(p.t).toBeCloseTo(0.75);
    expect(p.d).toBeCloseTo(20);
    expect(p.horiz).toBe(false);
  });

  it('places the label on the chosen side', () => {
    expect(wireLabelSpot({}, L, 2)).toMatchObject({ side: 'above', anchor: 'middle' });
    expect(wireLabelSpot({ labelAt: 0.75 }, L, 2)).toMatchObject({ side: 'right', anchor: 'start', x: 106 });
    expect(wireLabelSpot({ labelAt: 0.75, labelSide: 'left' }, L, 2)).toMatchObject({ anchor: 'end', x: 94 });
    expect(wireLabelSpot({ labelAt: 0.25, labelSide: 'below' }, L, 2)!.y).toBeGreaterThan(0);
  });
});
