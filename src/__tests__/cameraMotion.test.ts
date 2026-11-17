import { beforeAll, describe, expect, it } from 'vitest';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

// a hand-cranked frame clock, so the easing can be stepped through
let now = 0;
let queue: FrameRequestCallback[] = [];
const frame = (ms = 16) => {
  now += ms;
  const q = queue;
  queue = [];
  q.forEach((f) => f(now));
};
const settle = () => {
  for (let i = 0; i < 200 && queue.length; i++) frame();
};

beforeAll(() => {
  g.requestAnimationFrame = (f: FrameRequestCallback) => (queue.push(f), queue.length);
  g.cancelAnimationFrame = () => {};
  g.document ??= { hidden: false };
  (g.window as Record<string, unknown>).matchMedia = () => ({ matches: false });
  (g.performance as { now: () => number }).now = () => now;
});

describe('mouse-wheel zoom', () => {
  it('eases in over several frames instead of jumping a whole step', async () => {
    const { S, set } = await import('../store/store');
    const A = await import('../store/actions');
    set({ view: { x: 0, y: 0, zoom: 1 }, canvasSize: { w: 800, h: 600 } });
    A.zoomSmooth(2, 400, 300);
    expect(S().view.zoom).toBe(1); // nothing jumps on the notch itself
    frame();
    const first = S().view.zoom;
    expect(first).toBeGreaterThan(1);
    expect(first).toBeLessThan(2);
    settle();
    expect(S().view.zoom).toBeCloseTo(2, 6);
  });

  it('keeps the point under the cursor still while it zooms', async () => {
    const { S, set } = await import('../store/store');
    const A = await import('../store/actions');
    set({ view: { x: 30, y: -20, zoom: 1.3 }, canvasSize: { w: 800, h: 600 } });
    const world = (v: { x: number; y: number; zoom: number }) => ({ x: (250 - v.x) / v.zoom, y: (120 - v.y) / v.zoom });
    const w0 = world(S().view);
    A.zoomSmooth(0.7, 250, 120);
    for (let i = 0; i < 5; i++) {
      frame();
      expect(world(S().view).x).toBeCloseTo(w0.x, 6);
      expect(world(S().view).y).toBeCloseTo(w0.y, 6);
    }
    settle();
  });

  it('adds quick notches up into one zoom', async () => {
    const { S, set } = await import('../store/store');
    const A = await import('../store/actions');
    set({ view: { x: 0, y: 0, zoom: 1 }, canvasSize: { w: 800, h: 600 } });
    A.zoomSmooth(1.5, 400, 300);
    frame();
    A.zoomSmooth(1.5, 400, 300);
    frame();
    A.zoomSmooth(1.5, 400, 300);
    settle();
    expect(S().view.zoom).toBeCloseTo(3.375, 6);
  });

  it('stops when something else moves the view', async () => {
    const { S, set } = await import('../store/store');
    const A = await import('../store/actions');
    set({ view: { x: 0, y: 0, zoom: 1 }, canvasSize: { w: 800, h: 600 } });
    A.zoomSmooth(4, 400, 300);
    frame();
    const panned = { ...S().view, x: S().view.x + 50 };
    set({ view: panned });
    settle();
    expect(S().view).toBe(panned);
  });

  it('a camera glide takes over from a wheel zoom on its way', async () => {
    const { S, set } = await import('../store/store');
    const A = await import('../store/actions');
    set({ view: { x: 0, y: 0, zoom: 1 }, canvasSize: { w: 800, h: 600 } });
    A.zoomSmooth(4, 400, 300);
    frame();
    A.glideView({ x: 10, y: 20, zoom: 0.5 });
    settle();
    expect(S().view).toEqual({ x: 10, y: 20, zoom: 0.5 });
  });
});
