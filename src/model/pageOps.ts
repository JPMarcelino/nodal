import { connectorsOf, detachConnector, isConnector } from './connectors';
import { groupChain } from './doc';
import { deleteItems, extractFragment, insertFragment, pruneGroups } from './ops';
import { addPage, docPages, itemPage, pageItemIds, resolvePage } from './pages';
import type { CircuitDoc, Endpoint, Item } from './types';
import { endpointInfo } from './wires';

/* Page edits that need the item operations (kept apart from model/pages so ops can use that one). */

const owner = (ep: Endpoint) => (ep.kind === 'port' ? ep.comp : ep.kind === 'junction' ? ep.id : null);

/** Deletes a page and everything on it; the last page can't go. Returns false when nothing was deleted. */
export function deletePage(d: CircuitDoc, id: string): boolean {
  const pages = docPages(d);
  if (pages.length < 2 || !pages.some((p) => p.id === id)) return false;
  deleteItems(d, pageItemIds(d, id));
  d.pages = d.pages!.filter((p) => p.id !== id);
  return true;
}

/**
 * Copies a page, and everything on it, to a new page right after it. The
 * copies get fresh ids (wires, glued connectors and groups follow them) and
 * parts take free references, so the netlist stays valid. Returns the new page id.
 */
export function duplicatePage(d: CircuitDoc, id: string, name?: string): string {
  const src = resolvePage(d, id);
  const label = name ?? `${docPages(d).find((p) => p.id === src)!.name} copy`;
  const page = addPage(d, label, src);
  const ids = pageItemIds(d, src);
  const frag = extractFragment(d, new Set(ids));
  // the new page starts empty, so the copies keep their references
  const added = insertFragment(d, frag, 0, 0, undefined, []);
  added.forEach((nid, i) => {
    const it = d.items[nid];
    it.page = page;
    // the copy keeps the original's locks
    if (frag.items[i].locked) it.locked = true;
  });
  return page;
}

/**
 * Moves items to another page. Wires and junctions that only join moved
 * items go along; a wire still joining something left behind stays where it
 * is and lets go of the moved part (its end is left loose on the spot), so
 * nothing is deleted. Connectors let go the same way, and groups split
 * between pages are left behind by what moved. Locked items never move (nor
 * are they auto-added); a locked wire or connector staying behind still lets
 * go of moved ends, so nothing stays attached across pages. Returns the ids moved.
 */
export function moveItemsToPage(d: CircuitDoc, ids: Iterable<string>, page: string): string[] {
  const target = resolvePage(d, page);
  const move = new Set([...ids].filter((id) => d.items[id] && !d.items[id].locked && itemPage(d, d.items[id]) !== target));
  if (!move.size) return [];
  const from = new Set([...move].map((id) => itemPage(d, d.items[id])));
  const onFrom = (it: Item) => from.has(itemPage(d, it));
  // wires between moved items (or loose ones touching them) go too
  for (const it of Object.values(d.items)) {
    if (it.type !== 'wire' || it.locked || move.has(it.id) || !onFrom(it)) continue;
    const oa = owner(it.a);
    const ob = owner(it.b);
    if ((oa || ob) && (!oa || move.has(oa)) && (!ob || move.has(ob))) move.add(it.id);
  }
  // junctions all of whose wires go
  for (const it of Object.values(d.items)) {
    if (it.type !== 'junction' || it.locked || move.has(it.id) || !onFrom(it)) continue;
    const wires = Object.values(d.items).filter((w) => w.type === 'wire' && (owner(w.a) === it.id || owner(w.b) === it.id));
    if (wires.length && wires.every((w) => move.has(w.id))) move.add(it.id);
  }
  // wires crossing the cut let go of whatever is on the other side (locked
  // wires stay too, but their moved ends still go loose, so no connection
  // spans pages and every view keeps resolving)
  for (const it of Object.values(d.items)) {
    if (it.type !== 'wire' || !onFrom(it)) continue;
    for (const end of ['a', 'b'] as const) {
      const o = owner(it[end]);
      if (!o || move.has(o) === move.has(it.id)) continue;
      const info = endpointInfo(d, it[end]);
      if (info) it[end] = { kind: 'free', x: info.pt.x, y: info.pt.y };
    }
  }
  for (const s of connectorsOf(d, move)) {
    if (!move.has(s.id)) detachConnector(d, s, { from: !!s.from && move.has(s.from.id), to: !!s.to && move.has(s.to.id) });
  }
  for (const id of move) {
    const s = d.items[id];
    if (isConnector(s)) detachConnector(d, s, { from: !!s.from && !move.has(s.from.id), to: !!s.to && !move.has(s.to.id) });
  }
  // groups: a group that also holds items staying behind is left behind by the moved ones
  const whole = (g: string) => Object.values(d.items).every((it) => !groupChain(d, it.group).includes(g) || move.has(it.id));
  for (const id of move) {
    const it = d.items[id];
    const chain = groupChain(d, it.group);
    const keep = chain.findIndex((g) => !whole(g));
    if (keep === 0) delete it.group;
    else if (keep > 0) delete d.groups[chain[keep - 1]].group;
  }
  const first = docPages(d)[0].id === target;
  for (const id of move) {
    if (first) delete d.items[id].page;
    else d.items[id].page = target;
  }
  pruneGroups(d);
  return [...move];
}
