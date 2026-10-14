import { describe, expect, it } from 'vitest';
import { nextStep } from '../model/callout';
import { createDoc, makeComponent, makeShape } from '../model/doc';
import {
  DEFAULT_HOLD,
  DEFAULT_TRANSITION,
  cameraAt,
  cameraRect,
  entryAt,
  fitShot,
  overviewShot,
  presentationSteps,
  renumberSteps,
  stepShot,
  timeline,
  withoutFrames,
} from '../model/presentation';
import { exportSvg } from '../io/export';
import type { CircuitDoc } from '../model/types';

function frame(doc: CircuitDoc, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) {
  const s = { ...makeShape(doc, 'frame', x, y, w, h), step: nextStep(doc), ...extra };
  doc.items[s.id] = s;
  return s;
}

describe('presentation timeline', () => {
  it('orders frames and callouts as one sequence of steps', () => {
    const doc = createDoc();
    const a = frame(doc, 0, 0, 160, 90);
    const c = { ...makeShape(doc, 'callout', 10, 10, 24, 24), step: nextStep(doc) };
    doc.items[c.id] = c;
    const b = frame(doc, 200, 0, 160, 90);
    expect([a.step, c.step, b.step]).toEqual([1, 2, 3]);
    expect(presentationSteps(doc).map((s) => s.id)).toEqual([a.id, c.id, b.id]);
    renumberSteps(doc, [b.id, a.id, c.id]);
    expect(presentationSteps(doc).map((s) => s.id)).toEqual([b.id, a.id, c.id]);
  });

  it('lays steps end to end: glide in, then stay', () => {
    const doc = createDoc();
    frame(doc, 0, 0, 100, 100, { transition: 1, hold: 2 });
    frame(doc, 500, 0, 100, 100);
    const { entries, total } = timeline(doc);
    expect(entries.map((e) => [e.start, e.end])).toEqual([
      [0, 3],
      [3, 3 + DEFAULT_TRANSITION + DEFAULT_HOLD],
    ]);
    expect(total).toBeCloseTo(3 + DEFAULT_TRANSITION + DEFAULT_HOLD);
    expect(entryAt(entries, 0.5)).toEqual({ index: 0, k: 0.5 });
    expect(entryAt(entries, 2)).toEqual({ index: 0, k: 1 });
    expect(entryAt(entries, 3.1).index).toBe(1);
  });

  it('flies from the overview into each frame and holds there', () => {
    const doc = createDoc();
    doc.items.r = { ...makeComponent(doc, 'resistor', 0, 0), id: 'r' };
    const f1 = frame(doc, 0, 0, 160, 90, { transition: 1, hold: 1 });
    const f2 = frame(doc, 1000, 500, 320, 180, { transition: 2, hold: 1 });
    const steps = presentationSteps(doc);
    const { entries } = timeline(doc, steps);
    const shots = steps.map((s) => stepShot(doc, s));
    const ov = overviewShot(doc);
    const W = 1600;
    const H = 900;
    // at rest on a frame the camera shows exactly that frame (same aspect ratio)
    const r1 = cameraRect(cameraAt(entries, shots, ov, 1.5, W, H), W, H);
    expect(r1.x).toBeCloseTo(f1.x);
    expect(r1.w).toBeCloseTo(f1.w);
    const r2 = cameraRect(cameraAt(entries, shots, ov, 10, W, H), W, H);
    expect(r2.x).toBeCloseTo(f2.x);
    expect(r2.h).toBeCloseTo(f2.h);
    // t = 0 is the overview; mid-glide sits strictly between the two frames
    expect(cameraAt(entries, shots, ov, 0, W, H)).toEqual(fitShot(ov, W, H));
    const mid = cameraAt(entries, shots, ov, 3, W, H);
    const c1 = fitShot(shots[0], W, H);
    const c2 = fitShot(shots[1], W, H);
    expect(mid.cx).toBeGreaterThan(c1.cx);
    expect(mid.cx).toBeLessThan(c2.cx);
    expect(mid.zoom).toBeLessThan(Math.max(c1.zoom, c2.zoom));
  });

  it('never shows frames in exports', () => {
    const doc = createDoc();
    doc.items.r = { ...makeComponent(doc, 'resistor', 0, 0), id: 'r' };
    const f = frame(doc, -2000, -2000, 100, 100, { text: 'Intro' });
    expect(withoutFrames(doc).items[f.id]).toBeUndefined();
    expect(withoutFrames(doc).items.r).toBeDefined();
    const { svg, bounds } = exportSvg(doc, { theme: 'light', background: false, padding: 0 });
    expect(svg).not.toContain('Intro');
    expect(bounds.x).toBeGreaterThan(-1000);
    // the overview ignores frames too
    expect(overviewShot(doc).rect.x).toBeGreaterThan(-1000);
  });
});
