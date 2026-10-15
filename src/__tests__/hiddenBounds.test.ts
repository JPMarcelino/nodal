import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent } from '../model/doc';
import { alignItems, flipItems, rotateItems, selectionPivot } from '../model/ops';
import type { CircuitDoc, ComponentItem } from '../model/types';

function twoParts() {
  const doc = createDoc();
  const a = makeComponent(doc, 'resistor', 100, 100);
  doc.items[a.id] = a;
  const b = makeComponent(doc, 'resistor', 300, 100);
  doc.items[b.id] = b;
  return { doc, a, b };
}

const comp = (doc: CircuitDoc, id: string) => doc.items[id] as ComponentItem;

describe('hidden selected items share the same bounds as the transform', () => {
  it('aligns to the union including hidden items', () => {
    const { doc, a, b } = twoParts();
    comp(doc, a.id).hidden = true;
    alignItems(doc, [a.id, b.id], 'left');
    expect(comp(doc, a.id).x).toBe(100);
    expect(comp(doc, b.id).x).toBe(100);
  });

  it('computes the selection pivot including hidden items', () => {
    const { doc, a, b } = twoParts();
    comp(doc, a.id).hidden = true;
    expect(selectionPivot(doc, [a.id, b.id])).toEqual({ x: 200, y: 100 });
  });

  it('flips around the pivot including hidden items', () => {
    const { doc, a, b } = twoParts();
    comp(doc, a.id).hidden = true;
    flipItems(doc, new Set([a.id, b.id]), 'x');
    expect(comp(doc, a.id).x).toBe(300);
    expect(comp(doc, b.id).x).toBe(100);
  });

  it('rotates around the pivot including hidden items', () => {
    const { doc, a, b } = twoParts();
    comp(doc, a.id).hidden = true;
    rotateItems(doc, new Set([a.id, b.id]), 90);
    expect({ x: comp(doc, a.id).x, y: comp(doc, a.id).y }).toEqual({ x: 200, y: 0 });
    expect({ x: comp(doc, b.id).x, y: comp(doc, b.id).y }).toEqual({ x: 200, y: 200 });
  });
});
