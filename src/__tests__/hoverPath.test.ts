import { describe, expect, it } from 'vitest';
import { onWayToPopup } from '../canvas/hoverPath';

describe('the way to a hover popup', () => {
  // the pointer left the object at (100, 200); the popup sits up and to the right
  const from = { x: 100, y: 200 };
  const box = { left: 200, top: 40, right: 360, bottom: 80 };

  it('covers the straight line and the popup itself', () => {
    for (let t = 0; t <= 1; t += 0.1) expect(onWayToPopup({ x: 100 + t * 180, y: 200 - t * 140 }, from, box)).toBe(true);
    expect(onWayToPopup({ x: 340, y: 50 }, from, box)).toBe(true);
  });

  it('widens towards the popup, so an aim at either end of it counts', () => {
    expect(onWayToPopup({ x: 150, y: 140 }, from, box)).toBe(true);
    expect(onWayToPopup({ x: 250, y: 120 }, from, box)).toBe(true);
  });

  it('leaves out heading away from the popup', () => {
    expect(onWayToPopup({ x: 60, y: 260 }, from, box)).toBe(false);
    expect(onWayToPopup({ x: 400, y: 260 }, from, box)).toBe(false);
    expect(onWayToPopup({ x: 30, y: 60 }, from, box)).toBe(false);
  });
});
