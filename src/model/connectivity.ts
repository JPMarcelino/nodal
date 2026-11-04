import { eq, projectOnSegment, toWorld } from './geometry';
import { Grid } from './hotspots';
import { itemPage, multiPage } from './pages';
import { instanceSymbol } from './registry';
import type { CircuitDoc, Point } from './types';
import { wirePolyline } from './wires';

/**
 * What touches what, read from the drawing itself.
 *
 * Nodal follows one rule, as Cadence and KiCad do: if it touches, it is
 * connected, unless it hops. A wire end, a pin or a junction dot connects to
 * anything it lands on: another end, a pin, a dot, a bend or the middle of a
 * wire. Two wire runs crossing each other are the only things that touch
 * without connecting, and they are drawn with a hop. Wires stay separate
 * items either way; touching only puts them on the same net.
 *
 * There are no exceptions: a wire laid across a part's pins shorts it, as it
 * would on paper, and the ERC shows it.
 *
 * Explicit links (wire ends attached to a pin or a junction) are not repeated
 * here; computeNets adds them. Hidden items do not touch anything, and things
 * only touch on their own page.
 */

/** A connection point: a wire end, a pin or a junction dot. Keys match computeNets: `w:`, `p:comp:port`, `j:`. */
interface Spot {
  key: string;
  pt: Point;
  page: string;
  /** The wire this is an end of (it never touches its own run here). */
  wire?: string;
}

interface Run {
  wire: string;
  page: string;
  a: Point;
  b: Point;
}

/** Pairs of conductors that touch (see above). */
export function contactLinks(doc: CircuitDoc, polys?: Map<string, Point[]>): Array<[string, string]> {
  const multi = multiPage(doc);
  const pageOf = (it: { page?: string }) => (multi ? itemPage(doc, it) : '');
  const spots: Spot[] = [];
  const runs = new Grid<Run>(64);
  for (const it of Object.values(doc.items)) {
    if (it.hidden) continue;
    if (it.type === 'junction') spots.push({ key: `j:${it.id}`, pt: { x: it.x, y: it.y }, page: pageOf(it) });
    else if (it.type === 'component') {
      const def = instanceSymbol(doc, it);
      for (const p of def.ports) spots.push({ key: `p:${it.id}:${p.id}`, pt: toWorld(it, def, p.x, p.y), page: pageOf(it) });
    } else if (it.type === 'wire') {
      const pts = polys?.get(it.id) ?? wirePolyline(doc, it);
      if (pts.length < 2) continue;
      const page = pageOf(it);
      const key = `w:${it.id}`;
      spots.push({ key, pt: pts[0], page, wire: it.id }, { key, pt: pts[pts.length - 1], page, wire: it.id });
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        runs.add(Math.min(a.x, b.x) - 1, Math.min(a.y, b.y) - 1, Math.max(a.x, b.x) + 1, Math.max(a.y, b.y) + 1, { wire: it.id, page, a, b });
      }
    }
  }

  const links: Array<[string, string]> = [];
  // spots on one spot: grouped by a fine cell, then compared exactly
  const cells = new Map<string, Spot[]>();
  for (const s of spots) {
    const k = `${s.page}|${Math.round(s.pt.x)},${Math.round(s.pt.y)}`;
    const list = cells.get(k);
    if (list) list.push(s);
    else cells.set(k, [s]);
  }
  for (const list of cells.values()) {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].key !== list[j].key && eq(list[i].pt, list[j].pt)) links.push([list[i].key, list[j].key]);
      }
  }
  // spots on a wire's run (its bends and middle included)
  for (const s of spots) {
    for (const r of runs.near(s.pt)) {
      if (r.page !== s.page || r.wire === s.wire) continue;
      if (projectOnSegment(s.pt, r.a, r.b).d < 0.5) links.push([s.key, `w:${r.wire}`]);
    }
  }
  return links;
}
