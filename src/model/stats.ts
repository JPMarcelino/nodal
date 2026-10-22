import { docBounds } from './doc';
import { computeNets } from './netlist';
import { docPages, viewDoc } from './pages';
import { getSymbol } from './registry';
import { ROT_KINDS, shapeRot } from './rotation';
import type { CircuitDoc, ComponentItem, Point, Rect } from './types';
import { wirePolyline } from './wires';

/*
 * Numbers for the stats panel. Pure, so they can be tested and cached: the
 * panel feeds them settled documents only, never one per pointer move.
 */

/** What a set of items holds. Lengths and sizes are in px, like the inspector. */
export interface Counts {
  /** Real parts: components whose symbol's reference prefix doesn't start with '#'. */
  parts: number;
  /** Power symbols, net labels, ports, flags (reference prefix '#…', as in KiCad). */
  markers: number;
  wires: number;
  /** Total drawn length of the wires, px. */
  wireLength: number;
  /** Shapes, text, ink and pictures. */
  shapes: number;
}

export interface DocStats {
  /** The page in view. */
  page: Counts;
  /** The whole circuit, every page. */
  all: Counts & { nets: number; pages: number };
}

export interface SelectionStats {
  count: number;
  /** Bounding box of the visible selected items (px), or null when none has a size. */
  bounds: Rect | null;
  /** One part or turnable shape selected: its rotation in degrees (clockwise). */
  rotation?: number;
  /** One part selected and mirrored. */
  flipped?: boolean;
}

/** Whether a component is a marker (power, label, port, flag) rather than a part. */
export function isMarker(doc: Pick<CircuitDoc, 'symbols'>, c: ComponentItem): boolean {
  return getSymbol(doc, c.symbol).prefix.startsWith('#');
}

export function polylineLength(pts: Point[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return n;
}

/** Counts the items of `doc` (a page view or the whole circuit). */
export function countItems(doc: CircuitDoc): Counts {
  const c: Counts = { parts: 0, markers: 0, wires: 0, wireLength: 0, shapes: 0 };
  for (const it of Object.values(doc.items)) {
    if (it.type === 'component') {
      if (isMarker(doc, it)) c.markers++;
      else c.parts++;
    } else if (it.type === 'wire') {
      c.wires++;
      c.wireLength += polylineLength(wirePolyline(doc, it));
    } else if (it.type === 'shape') c.shapes++;
  }
  c.wireLength = Math.round(c.wireLength);
  return c;
}

/** Nets that join something: at least one wire, or two pins touching. */
export function countNets(doc: CircuitDoc): number {
  return computeNets(doc).filter((n) => n.wires.length > 0 || n.pins.length > 1).length;
}

const cache = new WeakMap<CircuitDoc, Map<string, DocStats>>();

/** Stats of the page in view and of the whole circuit; cached per document and page. */
export function docStats(doc: CircuitDoc, page?: string | null): DocStats {
  const key = page ?? '';
  let byPage = cache.get(doc);
  const hit = byPage?.get(key);
  if (hit) return hit;
  const all = countItems(doc);
  const out: DocStats = {
    page: docPages(doc).length > 1 ? countItems(viewDoc(doc, page)) : all,
    all: { ...all, nets: countNets(doc), pages: docPages(doc).length },
  };
  if (!byPage) cache.set(doc, (byPage = new Map()));
  byPage.set(key, out);
  return out;
}

/** Stats of the selected items of `view` (the page's document). */
export function selectionStats(view: CircuitDoc, ids: readonly string[]): SelectionStats {
  const present = ids.filter((id) => view.items[id]);
  const out: SelectionStats = { count: present.length, bounds: present.length ? docBounds(view, present) : null };
  if (present.length === 1) {
    const it = view.items[present[0]];
    if (it.type === 'component') {
      out.rotation = it.rot;
      if (it.flipX) out.flipped = true;
    } else if (it.type === 'shape') {
      if (ROT_KINDS.has(it.kind)) out.rotation = shapeRot(it);
    }
  }
  return out;
}
