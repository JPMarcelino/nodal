import { itemBounds } from './doc';
import { normDeg, rectCentre, rotateDeg, shapeBox, shapeRot } from './rotation';
import type { CircuitDoc, Item, Point, Rect, ShapeItem } from './types';

/**
 * Containers: a rectangle or zone with `container` set carries what lies fully
 * inside it when it moves (parts, shapes, wire ends and bends), draw.io style.
 */
export const isContainer = (it: Item | undefined): it is ShapeItem => it?.type === 'shape' && !!it.container && (it.kind === 'rect' || it.kind === 'zone');

/** Corners of an item's bounds, as a rectangle outline. */
const corners = (r: Rect): Point[] => [
  { x: r.x, y: r.y },
  { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h },
  { x: r.x, y: r.y + r.h },
];

/** Whether everything in `r` lies inside the (possibly turned) container box. */
function insideContainer(c: ShapeItem, r: Rect): boolean {
  const box = shapeBox(c);
  const rot = normDeg(shapeRot(c));
  const o = rectCentre(box);
  const eps = 0.01;
  return corners(r).every((p) => {
    const q = rot ? rotateDeg(p, -rot, o) : p;
    return q.x >= box.x - eps && q.x <= box.x + box.w + eps && q.y >= box.y - eps && q.y <= box.y + box.h + eps;
  });
}

/**
 * `ids` plus everything inside the containers among them, nested containers
 * included. Hidden and locked items stay put; locked containers carry nothing.
 * A Set, so something selected as well as contained still moves once.
 */
export function withContents(doc: CircuitDoc, ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  const items = Object.values(doc.items).filter((i) => !i.hidden && !i.locked);
  const bounds = new Map<string, Rect>();
  for (const i of items) {
    const r = itemBounds(doc, i);
    if (r) bounds.set(i.id, r);
  }
  const done = new Set<string>();
  const queue = [...out];
  while (queue.length) {
    const id = queue.pop()!;
    if (done.has(id)) continue;
    done.add(id);
    const c = doc.items[id];
    if (!isContainer(c) || c.locked || c.hidden) continue;
    for (const it of items) {
      if (it.id === id || out.has(it.id)) continue;
      const r = bounds.get(it.id);
      if (!r || !insideContainer(c, r)) continue;
      out.add(it.id);
      queue.push(it.id);
    }
  }
  return out;
}
