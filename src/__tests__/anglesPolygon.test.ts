import { describe, expect, it } from 'vitest';
import { createDoc, itemBounds, makeShape } from '../model/doc';
import { constrain45, packPoly, pointInPolygon, polyHit, polyPoints } from '../model/polygon';
import type { ShapeItem, WireItem } from '../model/types';
import { angledLeg, buildAngledPreview, commitWire } from '../model/wireCommit';
import { wirePolyline } from '../model/wires';
import { translateItems } from '../model/ops';

describe('angled wires', () => {
  it('45°: one straight run and one diagonal, bend on the grid', () => {
    expect(angledLeg({ x: 0, y: 0 }, { x: 100, y: 40 }, '45', true)).toEqual([{ x: 60, y: 0 }, { x: 100, y: 40 }]);
    expect(angledLeg({ x: 0, y: 0 }, { x: 100, y: 40 }, '45', false)).toEqual([{ x: 40, y: 40 }, { x: 100, y: 40 }]);
    expect(angledLeg({ x: 0, y: 0 }, { x: -30, y: 90 }, '45', true)).toEqual([{ x: 0, y: 60 }, { x: -30, y: 90 }]);
  });

  it('45°: pure axis or pure diagonal moves need no bend', () => {
    expect(angledLeg({ x: 0, y: 0 }, { x: 50, y: 50 }, '45', true)).toEqual([{ x: 50, y: 50 }]);
    expect(angledLeg({ x: 0, y: 0 }, { x: 0, y: 70 }, '45', false)).toEqual([{ x: 0, y: 70 }]);
  });

  it('any angle goes straight to the point', () => {
    expect(buildAngledPreview({ x: 0, y: 0 }, [{ x: 20, y: 0 }], { x: 50, y: 30 }, 'any', true)).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 50, y: 30 },
    ]);
  });

  it('commits a straight-routed wire that keeps its diagonals', () => {
    const doc = createDoc();
    const id = commitWire(doc, { kind: 'grid', pt: { x: 0, y: 0 } }, { kind: 'grid', pt: { x: 100, y: 40 } }, { angle: '45', hFirst: false })!;
    const w = doc.items[id] as WireItem;
    expect(w.routing).toBe('straight');
    expect(wirePolyline(doc, w)).toEqual([{ x: 0, y: 0 }, { x: 40, y: 40 }, { x: 100, y: 40 }]);
  });

  it('orthogonal commits stay orthogonal unless vertices already have diagonals', () => {
    const doc = createDoc();
    const a = commitWire(doc, { kind: 'grid', pt: { x: 0, y: 200 } }, { kind: 'grid', pt: { x: 100, y: 240 } })!;
    expect((doc.items[a] as WireItem).routing).toBeUndefined();
    const b = commitWire(doc, { kind: 'grid', pt: { x: 0, y: 400 } }, { kind: 'grid', pt: { x: 100, y: 400 } }, { via: [{ x: 40, y: 440 }], straight: true })!;
    expect((doc.items[b] as WireItem).routing).toBe('straight');
  });
});

describe('polygon shapes', () => {
  const tri = [
    { x: 10, y: 10 },
    { x: 110, y: 10 },
    { x: 60, y: 90 },
  ];

  it('round-trips corners through the box', () => {
    const s = { ...makeShape(createDoc(), 'polygon', 0, 0, 1, 1), ...packPoly(tri) } as ShapeItem;
    expect(polyPoints(s)).toEqual(tri);
    expect(itemBounds(createDoc(), s)).toEqual({ x: 10, y: 10, w: 100, h: 80 });
  });

  it('scales with its box', () => {
    const s = { ...makeShape(createDoc(), 'polygon', 0, 0, 1, 1), ...packPoly(tri) } as ShapeItem;
    s.w = 200;
    expect(polyPoints(s)[1]).toEqual({ x: 210, y: 10 });
  });

  it('moves with the selection', () => {
    const doc = createDoc();
    const s = { ...makeShape(doc, 'polygon', 0, 0, 1, 1), ...packPoly(tri) } as ShapeItem;
    doc.items[s.id] = s;
    const next = structuredClone(doc);
    translateItems(doc, next, new Set([s.id]), 20, 30);
    expect(polyPoints(next.items[s.id] as ShapeItem)[2]).toEqual({ x: 80, y: 120 });
  });

  it('hits its outline, and its inside only when filled', () => {
    const s = { ...makeShape(createDoc(), 'polygon', 0, 0, 1, 1), ...packPoly(tri) } as ShapeItem;
    expect(polyHit(s, { x: 60, y: 11 }, 3)).toBe(true);
    expect(polyHit(s, { x: 60, y: 40 }, 3)).toBe(false);
    s.fillOpacity = 0.3;
    expect(polyHit(s, { x: 60, y: 40 }, 3)).toBe(true);
    expect(pointInPolygon({ x: 200, y: 40 }, tri)).toBe(false);
  });

  it('Shift constrains to 45° keeping diagonals on the grid', () => {
    expect(constrain45({ x: 0, y: 0 }, { x: 100, y: 10 })).toEqual({ x: 100, y: 0 });
    expect(constrain45({ x: 0, y: 0 }, { x: 60, y: 40 })).toEqual({ x: 50, y: 50 });
  });
});
