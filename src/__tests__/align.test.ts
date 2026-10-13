import { describe, expect, it } from 'vitest';
import { alignAnchors, alignMove } from '../model/align';
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
