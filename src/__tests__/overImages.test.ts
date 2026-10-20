import { describe, expect, it } from 'vitest';
import { findGlue } from '../model/connectors';
import { createDoc, drawOrder, makeShape } from '../model/doc';
import type { CircuitDoc, ShapeKind } from '../model/types';

const add = (doc: CircuitDoc, kind: ShapeKind, x = 0, y = 0, w = 200, h = 100) => {
  const s = makeShape(doc, kind, x, y, w, h);
  doc.items[s.id] = s;
  return s;
};

describe('drawing over pictures', () => {
  it('areas drawn after a picture land in front of it', () => {
    const doc = createDoc();
    const pic = add(doc, 'image');
    const kinds: ShapeKind[] = ['rect', 'zone', 'ellipse', 'polygon'];
    const order = () => drawOrder(doc);
    for (const k of kinds) {
      const s = add(doc, k, 20, 20, 50, 30);
      expect(order().get(s.id)!).toBeGreaterThan(order().get(pic.id)!);
    }
  });

  it('a new picture still goes behind everything', () => {
    const doc = createDoc();
    const rect = add(doc, 'rect');
    const pic = add(doc, 'image');
    expect(drawOrder(doc).get(pic.id)!).toBeLessThan(drawOrder(doc).get(rect.id)!);
  });

  it('an area drawn over a picture stays behind areas above the picture', () => {
    const doc = createDoc();
    const pic = add(doc, 'image');
    const first = add(doc, 'rect');
    const second = add(doc, 'rect');
    const o = drawOrder(doc);
    expect(o.get(pic.id)!).toBeLessThan(o.get(second.id)!);
    expect(o.get(second.id)!).toBeLessThan(o.get(first.id)!);
  });

  it("a connector end inside a picture stays where it is drawn, not glued to the picture's edge", () => {
    const doc = createDoc();
    add(doc, 'image', 0, 0, 200, 100);
    expect(findGlue(doc, { x: 100, y: 50 }, 8)).toBeNull();
  });
});
