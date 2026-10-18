import { itemBounds } from './doc';
import { pointInRect, rectContains, rectsIntersect, segmentIntersectsRect } from './geometry';
import { pointInPolygon } from './polygon';
import { rotatedCorners, shapeBox, shapeRot } from './rotation';
import type { CircuitDoc, Item, Point, Rect } from './types';

/** Whether any segment of a polyline passes through a rectangle. */
const crossesRect = (pts: Point[], r: Rect) => pts.length === 1 ? pointInRect(pts[0], r) : pts.some((p, i) => i > 0 && segmentIntersectsRect(pts[i - 1], p, r));

/**
 * Items picked by a selection rectangle. A window selection (dragged left to
 * right) takes what lies wholly inside; a crossing selection (right to left)
 * also takes what the rectangle touches — for wires and lines, only where they
 * are actually drawn, not anywhere in their bounding box.
 */
export function marqueeHits(doc: CircuitDoc, polys: Map<string, Point[]>, r: Rect, crossing: boolean): string[] {
  const hit = (it: Item): boolean => {
    const b = itemBounds(doc, it);
    if (!b) return false;
    if (it.type === 'wire') {
      const pts = polys.get(it.id) ?? [];
      return crossing ? crossesRect(pts, r) : pts.length > 0 && pts.every((p) => pointInRect(p, r));
    }
    if (crossing && it.type === 'shape' && (it.kind === 'line' || it.kind === 'arrow')) {
      return segmentIntersectsRect({ x: it.x, y: it.y }, { x: it.x + it.w, y: it.y + it.h }, r);
    }
    if (crossing && it.type === 'shape' && shapeRot(it)) {
      // a turned box is touched where its outline runs, or when it holds the rectangle
      const pts = rotatedCorners(shapeBox(it), shapeRot(it));
      return crossesRect([...pts, pts[0]], r) || pointInPolygon({ x: r.x, y: r.y }, pts);
    }
    return crossing ? rectsIntersect(b, r) : rectContains(r, b);
  };
  return Object.values(doc.items)
    .filter((it) => !it.hidden && !it.locked && hit(it))
    .map((it) => it.id);
}
