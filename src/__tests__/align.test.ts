import { describe, expect, it } from 'vitest';
import { alignAnchors, alignMove, spaceMove } from '../model/align';
import { createDoc, makeComponent } from '../model/doc';

function twoParts() {
  const doc = createDoc();
  const a = makeComponent(doc, 'resistor', 100, 100);
  doc.items[a.id] = a;
  const b = makeComponent(doc, 'resistor', 300, 205);
  doc.items[b.id] = b;
  return { doc, a, b };
}

describe('alignMove', () => {
  it('shows a guide when a moving part lines up with a static one', () => {
    const { doc, b } = twoParts();
    const { moving, index } = alignAnchors(doc, new Set([b.id]));
    const r = alignMove(moving, index, 0, -105, 6, false);
    expect(r.dy).toBe(-105);
    expect(r.guides.some((g) => g.axis === 'y' && g.v === 100)).toBe(true);
  });

  it('pulls a nearby offset onto the alignment when magnetic', () => {
    const { doc, b } = twoParts();
    const { moving, index } = alignAnchors(doc, new Set([b.id]));
    const r = alignMove(moving, index, 0, -102, 6, true);
    expect(r.dy).toBe(-105);
    expect(alignMove(moving, index, 0, -102, 6, false).guides.some((g) => g.axis === 'y' && g.v === 100)).toBe(false);
  });

  it('ignores the moving items themselves', () => {
    const { doc, a, b } = twoParts();
    const { index } = alignAnchors(doc, new Set([a.id, b.id]));
    expect(index.xs.length).toBe(0);
  });
});

describe('spaceMove', () => {
  const box = (x: number, y = 0, w = 20, h = 20) => ({ x, y, w, h });

  it('centres a box between its two neighbours', () => {
    // neighbours end at 20 and start at 100: a 20-wide box fits evenly at x = 50
    const r = spaceMove(box(47), [box(0), box(100)], 0, 0, 6, true);
    expect(r.dx).toBe(3);
    const g = r.guides.find((gd) => gd.axis === 'x')!;
    expect(g.gaps.map((gp) => gp.to - gp.from)).toEqual([30, 30]);
  });

  it('repeats the gap of the pair beside it', () => {
    // 0–20 and 50–70 are 30 apart: the next step is x = 100
    const r = spaceMove(box(98), [box(0), box(50)], 0, 0, 6, true);
    expect(r.dx).toBe(2);
    expect(r.guides[0].gaps.every((gp) => gp.to - gp.from === 30)).toBe(true);
  });

  it('works vertically too', () => {
    const r = spaceMove(box(0, 101), [box(0, 0), box(0, 50)], 0, 0, 6, true);
    expect(r.dy).toBe(-1);
    expect(r.guides[0].axis).toBe('y');
  });

  it('only shows exact matches without the magnet, and leaves held axes alone', () => {
    expect(spaceMove(box(98), [box(0), box(50)], 0, 0, 6, false).guides).toEqual([]);
    expect(spaceMove(box(100), [box(0), box(50)], 0, 0, 6, false).guides.length).toBe(1);
    expect(spaceMove(box(98), [box(0), box(50)], 0, 0, 6, true, { x: true }).dx).toBe(0);
  });

  it('ignores items outside the row', () => {
    expect(spaceMove(box(98), [box(0, 200), box(50, 200)], 0, 0, 6, true).guides).toEqual([]);
  });
});

describe('label anchors', () => {
  it('lines a moving part up by the boxes travelling with it', () => {
    const { doc, a, b } = twoParts();
    const extra = (it: { id: string }) => (it.id === b.id ? [{ x: 500, y: 500, w: 10, h: 10 }] : it.id === a.id ? [{ x: 600, y: 0, w: 10, h: 10 }] : []);
    const { moving, index } = alignAnchors(doc, new Set([b.id]), extra);
    expect(moving.some((p) => p.x === 505 && p.y === 505)).toBe(true);
    expect(index.xs).toContain(605);
  });
});
