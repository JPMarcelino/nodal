import { describe, expect, it } from 'vitest';
import { nearEllipse, pointInEllipse } from '../model/geometry';

describe('hitting an oval where it is drawn', () => {
  const r = { x: 0, y: 0, w: 100, h: 60 };

  it('hits the outline, and not the empty corners of its box', () => {
    expect(nearEllipse({ x: 100, y: 30 }, r, 2)).toBe(true);
    expect(nearEllipse({ x: 50, y: 0 }, r, 2)).toBe(true);
    expect(nearEllipse({ x: 0, y: 0 }, r, 2)).toBe(false);
    expect(nearEllipse({ x: 50, y: 30 }, r, 2)).toBe(false);
  });

  it('tells the inside from the outside', () => {
    expect(pointInEllipse({ x: 50, y: 30 }, r)).toBe(true);
    expect(pointInEllipse({ x: 50, y: 0 }, r)).toBe(true);
    expect(pointInEllipse({ x: 0, y: 0 }, r)).toBe(false);
    expect(pointInEllipse({ x: 5, y: 5 }, r)).toBe(false);
  });

  it('reads a turned or stretched oval through its own box', () => {
    const flat = { x: 0, y: 0, w: 200, h: 20 };
    expect(nearEllipse({ x: 200, y: 10 }, flat, 2)).toBe(true);
    expect(nearEllipse({ x: 100, y: 0 }, flat, 2)).toBe(true);
    expect(nearEllipse({ x: 100, y: 10 }, flat, 2)).toBe(false);
  });
});
