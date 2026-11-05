import { produce } from 'immer';
import { findTouches, type Touch } from './hotspots';
import { multiPage } from './pages';
import { cleanup, solderDotToWire, solderPinToWire, solderTouch } from './ops';
import type { CircuitDoc, Point } from './types';
import { wirePolyline } from './wires';

function polysOf(doc: CircuitDoc): Map<string, Point[]> {
  const polys = new Map<string, Point[]>();
  for (const it of Object.values(doc.items)) if (it.type === 'wire' && !it.hidden) polys.set(it.id, wirePolyline(doc, it));
  return polys;
}

const locked = (doc: CircuitDoc, id: string) => !!doc.items[id]?.locked;

/** Whether the items sit on more than one page: a page view keeps the whole page list but only one page's items. */
function spansPages(doc: CircuitDoc): boolean {
  if (!multiPage(doc)) return false;
  const pages = new Set<string>();
  for (const it of Object.values(doc.items)) if (it.page) pages.add(it.page);
  return pages.size > 1;
}

/** Records one touch as a connection; false when a locked wire is in the way or the touch is gone (looked for again next round). */
function join(doc: CircuitDoc, t: Touch): boolean {
  switch (t.kind) {
    case 'end': {
      if (locked(doc, t.wire)) return false;
      const g = t.target;
      if ((g.kind === 'wire' || g.kind === 'end') && locked(doc, g.wire)) return false;
      return solderTouch(doc, t.wire, t.end, g);
    }
    case 'dot':
      return !locked(doc, t.wire) && solderDotToWire(doc, t.id, t.wire);
    case 'pin':
      return !locked(doc, t.wire) && solderPinToWire(doc, t.comp, t.port, t.wire);
  }
}

/**
 * Makes the document say what the drawing shows. Whatever touches is already
 * connected (see connectivity.ts); this records those touches as real
 * connections, so junction dots are drawn and the wires follow when a part or
 * junction is dragged: a loose end resting on something attaches to it, and a
 * dot or pin lying on a wire's run splits the wire there. Locked wires are
 * left as they are (they stay connected all the same). Works on one page (a
 * page view, as settling and exporting use); returns `doc` unchanged when
 * there is nothing to record, or when its items span several pages.
 */
export function joinTouches(doc: CircuitDoc): CircuitDoc {
  if (spansPages(doc) || !findTouches(doc, polysOf(doc)).length) return doc;
  return produce(doc, (d) => {
    const draft = d as CircuitDoc;
    let any = false;
    // each join can split a wire the next touch was found on, so look again until nothing more joins
    for (let round = 0; round < 20; round++) {
      let joined = false;
      for (const t of findTouches(draft, polysOf(draft))) if (join(draft, t)) joined = true;
      if (!joined) break;
      any = true;
    }
    if (any) cleanup(draft);
  });
}
