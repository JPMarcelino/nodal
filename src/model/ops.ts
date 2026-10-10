import { current, isDraft } from 'immer';
import { attachedWires, docBounds, groupChain, itemBounds, nextRef, refersTo, uid } from './doc';
import { eq, rotate, simplify, snap } from './geometry';
import { getSymbol } from './registry';
import type { CircuitDoc, ComponentItem, Endpoint, Group, Item, Point, Rect, WireItem } from './types';
import { adjustWireForMove, endpointInfo, wirePolyline } from './wires';

/** Deep copy that also works on immer drafts. */
export const clone = <T,>(x: T): T => (isDraft(x) ? current(x) : structuredClone(x));

/* ------------------------------------------------------------------ */
/* Wires & junctions                                                   */
/* ------------------------------------------------------------------ */

function setFullPolyline(w: WireItem, full: Point[]) {
  w.pts = simplify(full).slice(1, -1);
}

/** Splits a wire at a point on segment `seg`, inserting a junction. Returns the junction id. */
export function splitWire(doc: CircuitDoc, wireId: string, seg: number, pt: Point): string {
  const w = doc.items[wireId] as WireItem;
  const full = wirePolyline(doc, w);
  const jid = uid('j');
  doc.items[jid] = { id: jid, type: 'junction', x: pt.x, y: pt.y, group: w.group };
  const first = full.slice(0, seg + 1);
  const second = full.slice(seg + 1);
  const w2: WireItem = {
    ...clone(w),
    id: uid('w'),
    a: { kind: 'junction', id: jid },
    pts: simplify([pt, ...second]).slice(1, -1),
  };
  w.b = { kind: 'junction', id: jid };
  w.pts = simplify([...first, pt]).slice(1, -1);
  doc.items[w2.id] = w2;
  return jid;
}

export function wireDegree(doc: CircuitDoc, id: string) {
  return attachedWires(doc, id).length;
}

/** Removes orphan junctions and merges junctions that only join two wires. */
export function cleanup(doc: CircuitDoc) {
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    // degenerate wires
    for (const it of Object.values(doc.items)) {
      if (it.type !== 'wire') continue;
      const a = endpointInfo(doc, it.a);
      const b = endpointInfo(doc, it.b);
      if (!a || !b) {
        delete doc.items[it.id];
        changed = true;
        continue;
      }
      if (eq(a.pt, b.pt) && it.pts.length === 0) {
        delete doc.items[it.id];
        changed = true;
      }
    }
    for (const it of Object.values(doc.items)) {
      if (it.type !== 'junction') continue;
      const ws = attachedWires(doc, it.id);
      if (ws.length === 0) {
        delete doc.items[it.id];
        changed = true;
      } else if (ws.length === 2 && ws[0] !== ws[1]) {
        mergeAtJunction(doc, it.id, ws[0], ws[1]);
        changed = true;
      } else if (ws.length === 1) {
        // a dangling junction becomes a free wire end
        const w = doc.items[ws[0]] as WireItem;
        const free: Endpoint = { kind: 'free', x: it.x, y: it.y };
        if (refersTo(w.a, it.id)) w.a = free;
        if (refersTo(w.b, it.id)) w.b = free;
        delete doc.items[it.id];
        changed = true;
      }
    }
    if (!changed) break;
  }
}

function mergeAtJunction(doc: CircuitDoc, jid: string, w1id: string, w2id: string) {
  const w1 = doc.items[w1id] as WireItem;
  const w2 = doc.items[w2id] as WireItem;
  let p1 = wirePolyline(doc, w1);
  let p2 = wirePolyline(doc, w2);
  let a1 = w1.a;
  let b2 = w2.b;
  // orient so that w1 ends at the junction and w2 starts there
  if (refersTo(w1.a, jid)) {
    p1 = p1.reverse();
    a1 = w1.b;
  }
  if (refersTo(w2.b, jid)) {
    p2 = p2.reverse();
    b2 = w2.a;
  }
  w1.a = a1;
  w1.b = b2;
  setFullPolyline(w1, [...p1, ...p2.slice(1)]);
  delete doc.items[w2id];
  delete doc.items[jid];
}

/** Deletes items; wires attached to deleted components keep their shape and become free. */
export function deleteItems(doc: CircuitDoc, ids: Iterable<string>) {
  const del = new Set(ids);
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire' || del.has(it.id)) continue;
    const touches = [it.a, it.b].some((ep) => del.has(endpointOwner(ep) ?? ''));
    if (touches) it.pts = wirePolyline(doc, it).slice(1, -1);
    for (const end of ['a', 'b'] as const) {
      const ep = it[end];
      const target = ep.kind === 'port' ? ep.comp : ep.kind === 'junction' ? ep.id : null;
      if (target && del.has(target)) {
        const info = endpointInfo(doc, ep);
        if (info) it[end] = { kind: 'free', x: info.pt.x, y: info.pt.y };
      }
    }
  }
  for (const id of del) delete doc.items[id];
  cleanup(doc);
  pruneGroups(doc);
}

export function pruneGroups(doc: CircuitDoc) {
  const used = new Map<string, number>();
  for (const it of Object.values(doc.items)) if (it.group) used.set(it.group, (used.get(it.group) ?? 0) + 1);
  for (const g of Object.values(doc.groups)) if (g.group) used.set(g.group, (used.get(g.group) ?? 0) + 1);
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const g of Object.values(doc.groups)) {
      const n = used.get(g.id) ?? 0;
      if (n === 0) {
        delete doc.groups[g.id];
        if (g.group) used.set(g.group, (used.get(g.group) ?? 1) - 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
}

/* ------------------------------------------------------------------ */
/* Moving & transforming                                               */
/* ------------------------------------------------------------------ */

function endpointOwner(ep: Endpoint): string | null {
  return ep.kind === 'port' ? ep.comp : ep.kind === 'junction' ? ep.id : null;
}

/**
 * Applies a point transform to a set of items. `base` is the untouched document
 * (gesture start) and `doc` the one being written, so repeated calls during a
 * drag never accumulate error.
 */
export function transformItems(
  base: CircuitDoc,
  doc: CircuitDoc,
  ids: Set<string>,
  map: (p: Point) => Point,
  rotateBy = 0,
  flip = false,
) {
  for (const id of ids) {
    const b = base.items[id];
    const it = doc.items[id];
    if (!b || !it || b.locked) continue;
    if (b.type === 'component' && it.type === 'component') {
      const p = map(b);
      it.x = p.x;
      it.y = p.y;
      if (flip) {
        it.flipX = !b.flipX;
        if (b.rot === 90 || b.rot === 270) it.rot = ((b.rot + 180) % 360) as ComponentItem['rot'];
      }
      if (rotateBy) it.rot = ((((it.rot + rotateBy) % 360) + 360) % 360) as ComponentItem['rot'];
    } else if (b.type === 'junction' && it.type === 'junction') {
      const p = map(b);
      it.x = p.x;
      it.y = p.y;
    } else if (b.type === 'shape' && it.type === 'shape') {
      const p1 = map({ x: b.x, y: b.y });
      const p2 = map({ x: b.x + b.w, y: b.y + b.h });
      if (b.kind === 'line' || b.kind === 'arrow') {
        it.x = p1.x;
        it.y = p1.y;
        it.w = p2.x - p1.x;
        it.h = p2.y - p1.y;
      } else if (b.kind === 'text') {
        it.x = p1.x;
        it.y = p1.y;
      } else {
        it.x = Math.min(p1.x, p2.x);
        it.y = Math.min(p1.y, p2.y);
        it.w = Math.abs(p2.x - p1.x);
        it.h = Math.abs(p2.y - p1.y);
      }
    }
  }
  // wires
  for (const b of Object.values(base.items)) {
    if (b.type !== 'wire') continue;
    const w = doc.items[b.id] as WireItem | undefined;
    if (!w || b.locked) continue;
    const ownA = endpointOwner(b.a);
    const ownB = endpointOwner(b.b);
    const selfSel = ids.has(b.id);
    const movesA = (ownA && ids.has(ownA)) || (!ownA && selfSel);
    const movesB = (ownB && ids.has(ownB)) || (!ownB && selfSel);
    if (!movesA && !movesB) continue;
    const full = wirePolyline(base, b);
    if (full.length < 2) continue;
    if (movesA && movesB && (selfSel || (ownA && ownB))) {
      const mapped = full.map(map);
      w.pts = mapped.slice(1, -1);
      if (b.a.kind === 'free') w.a = { kind: 'free', ...mapped[0] };
      if (b.b.kind === 'free') w.b = { kind: 'free', ...mapped[mapped.length - 1] };
      continue;
    }
    const newA = movesA ? endpointNow(doc, w.a, map(full[0])) : full[0];
    const newB = movesB ? endpointNow(doc, w.b, map(full[full.length - 1])) : full[full.length - 1];
    const dA = movesA ? { x: newA.x - full[0].x, y: newA.y - full[0].y } : null;
    const last = full[full.length - 1];
    const dB = movesB ? { x: newB.x - last.x, y: newB.y - last.y } : null;
    const adj = adjustWireForMove(full, dA, dB, w.routing !== 'straight');
    if (b.a.kind === 'free' && movesA) w.a = { kind: 'free', ...adj[0] };
    if (b.b.kind === 'free' && movesB) w.b = { kind: 'free', ...adj[adj.length - 1] };
    w.pts = simplify(adj).slice(1, -1);
  }
}

function endpointNow(doc: CircuitDoc, ep: Endpoint, fallback: Point): Point {
  if (ep.kind === 'free') return fallback;
  return endpointInfo(doc, ep)?.pt ?? fallback;
}

export function translateItems(base: CircuitDoc, doc: CircuitDoc, ids: Set<string>, dx: number, dy: number) {
  transformItems(base, doc, ids, (p) => ({ x: p.x + dx, y: p.y + dy }));
}

/** Rotation pivot: centre of the selection snapped to the grid. */
export function selectionPivot(doc: CircuitDoc, ids: Iterable<string>): Point {
  const b = docBounds(doc, ids);
  if (!b) return { x: 0, y: 0 };
  const g = doc.settings.grid;
  return { x: snap(b.x + b.w / 2, g), y: snap(b.y + b.h / 2, g) };
}

export function rotateItems(doc: CircuitDoc, ids: Set<string>, deg: 90 | -90) {
  const base = clone(doc);
  const single = [...ids].filter((id) => doc.items[id]?.type !== 'wire');
  const piv =
    single.length === 1 && doc.items[single[0]].type === 'component'
      ? { x: (doc.items[single[0]] as ComponentItem).x, y: (doc.items[single[0]] as ComponentItem).y }
      : selectionPivot(doc, ids);
  transformItems(base, doc, ids, (p) => rotate({ x: p.x - piv.x, y: p.y - piv.y }, deg === 90 ? 90 : 270, piv), deg);
}

export function flipItems(doc: CircuitDoc, ids: Set<string>, axis: 'x' | 'y') {
  const base = clone(doc);
  const piv = selectionPivot(doc, ids);
  if (axis === 'x') {
    transformItems(base, doc, ids, (p) => ({ x: 2 * piv.x - p.x, y: p.y }), 0, true);
  } else {
    // vertical flip = horizontal flip + 180° rotation
    transformItems(base, doc, ids, (p) => ({ x: p.x, y: 2 * piv.y - p.y }), 180, true);
  }
}

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/* ------------------------------------------------------------------ */

export interface Fragment {
  format: 'nodal-fragment';
  items: Item[];
  groups: Group[];
  symbols: CircuitDoc['symbols'];
}

export function extractFragment(doc: CircuitDoc, ids: Set<string>): Fragment {
  const items: Item[] = [];
  const all = new Set(ids);
  // include wires whose both ends are within the selection
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire') continue;
    const oa = endpointOwner(it.a);
    const ob = endpointOwner(it.b);
    if ((!oa || all.has(oa)) && (!ob || all.has(ob)) && (oa || ob) && (ids.has(oa ?? '') || ids.has(ob ?? ''))) all.add(it.id);
  }
  for (const id of all) {
    const it = doc.items[id];
    if (!it) continue;
    const c = clone(it);
    if (c.type === 'wire') {
      for (const end of ['a', 'b'] as const) {
        const o = endpointOwner(c[end]);
        if (o && !all.has(o)) {
          const info = endpointInfo(doc, c[end]);
          if (info) c[end] = { kind: 'free', ...info.pt };
        }
      }
      // freeze routing so the copy looks identical
      c.pts = wirePolyline(doc, it as WireItem).slice(1, -1);
    }
    items.push(c);
  }
  const groupIds = new Set<string>();
  for (const it of items) for (const g of groupChain(doc, it.group)) groupIds.add(g);
  const symbols: CircuitDoc['symbols'] = {};
  for (const it of items) if (it.type === 'component' && doc.symbols[it.symbol]) symbols[it.symbol] = doc.symbols[it.symbol];
  return { format: 'nodal-fragment', items, groups: [...groupIds].map((g) => clone(doc.groups[g])), symbols };
}

/** Inserts a fragment with fresh ids, offset by (dx, dy). Returns the new item ids. */
export function insertFragment(doc: CircuitDoc, frag: Fragment, dx: number, dy: number, scope?: string): string[] {
  const idMap = new Map<string, string>();
  for (const it of frag.items) idMap.set(it.id, uid(it.id[0] ?? 'i'));
  const gMap = new Map<string, string>();
  for (const g of frag.groups) gMap.set(g.id, uid('g'));
  for (const g of frag.groups) {
    const parent = g.group && gMap.get(g.group);
    doc.groups[gMap.get(g.id)!] = { id: gMap.get(g.id)!, name: g.name, group: parent || scope };
  }
  Object.assign(doc.symbols, frag.symbols);
  const refs = new Set(Object.values(doc.items).flatMap((i) => (i.type === 'component' ? [i.ref] : [])));
  const out: string[] = [];
  const remapEp = (ep: Endpoint): Endpoint => {
    if (ep.kind === 'port') return idMap.has(ep.comp) ? { ...ep, comp: idMap.get(ep.comp)! } : { kind: 'free', x: 0, y: 0 };
    if (ep.kind === 'junction') return idMap.has(ep.id) ? { kind: 'junction', id: idMap.get(ep.id)! } : { kind: 'free', x: 0, y: 0 };
    return { kind: 'free', x: ep.x + dx, y: ep.y + dy };
  };
  for (const src of frag.items) {
    const it = clone(src) as Item;
    it.id = idMap.get(src.id)!;
    it.group = src.group ? gMap.get(src.group) : scope;
    it.locked = false;
    if (it.type === 'component') {
      it.x += dx;
      it.y += dy;
      if (refs.has(it.ref)) {
        const prefix = getSymbol(doc, it.symbol).prefix;
        it.ref = nextRef(doc, prefix, refs);
      }
      refs.add(it.ref);
    } else if (it.type === 'junction' || it.type === 'shape') {
      it.x += dx;
      it.y += dy;
    } else if (it.type === 'wire') {
      it.a = remapEp(it.a);
      it.b = remapEp(it.b);
      it.pts = it.pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
    doc.items[it.id] = it;
    out.push(it.id);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Groups                                                              */
/* ------------------------------------------------------------------ */

export function groupItems(doc: CircuitDoc, ids: string[], scope?: string, name?: string): string | null {
  if (ids.length < 2) return null;
  const gid = uid('g');
  const count = Object.keys(doc.groups).length + 1;
  doc.groups[gid] = { id: gid, name: name ?? `Group ${count}`, group: scope };
  for (const id of ids) {
    const it = doc.items[id];
    if (!it) continue;
    const chain = groupChain(doc, it.group);
    // find the ancestor directly inside the scope
    let top: string | undefined;
    if (!scope) top = chain[chain.length - 1];
    else {
      const idx = chain.indexOf(scope);
      top = idx > 0 ? chain[idx - 1] : undefined;
    }
    if (top && top !== gid) doc.groups[top].group = gid;
    else it.group = gid;
  }
  return gid;
}

/** Dissolves the outermost groups (relative to scope) of the given items. */
export function ungroupItems(doc: CircuitDoc, ids: string[], scope?: string): number {
  const tops = new Set<string>();
  for (const id of ids) {
    const it = doc.items[id];
    if (!it) continue;
    const chain = groupChain(doc, it.group);
    if (!scope) {
      if (chain.length) tops.add(chain[chain.length - 1]);
    } else {
      const idx = chain.indexOf(scope);
      if (idx > 0) tops.add(chain[idx - 1]);
    }
  }
  for (const g of tops) {
    const parent = doc.groups[g]?.group;
    for (const it of Object.values(doc.items)) if (it.group === g) it.group = parent;
    for (const sg of Object.values(doc.groups)) if (sg.group === g) sg.group = parent;
    delete doc.groups[g];
  }
  return tops.size;
}

/* ------------------------------------------------------------------ */
/* Align & distribute                                                  */
/* ------------------------------------------------------------------ */

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

export function alignItems(doc: CircuitDoc, ids: string[], mode: AlignMode) {
  const movable = ids.filter((id) => doc.items[id] && doc.items[id].type !== 'wire');
  if (movable.length < 2) return;
  const boxes = movable.map((id) => ({ id, r: itemBounds(doc, doc.items[id])! }));
  const all = docBounds(doc, movable)!;
  const base = clone(doc);
  for (const { id, r } of boxes) {
    let dx = 0,
      dy = 0;
    if (mode === 'left') dx = all.x - r.x;
    if (mode === 'right') dx = all.x + all.w - (r.x + r.w);
    if (mode === 'hcenter') dx = all.x + all.w / 2 - (r.x + r.w / 2);
    if (mode === 'top') dy = all.y - r.y;
    if (mode === 'bottom') dy = all.y + all.h - (r.y + r.h);
    if (mode === 'vcenter') dy = all.y + all.h / 2 - (r.y + r.h / 2);
    const g = doc.settings.snap ? doc.settings.grid : 1;
    translateItems(base, doc, new Set([id]), snap(dx, g), snap(dy, g));
    Object.assign(base.items, clone(doc.items));
  }
}

export function distributeItems(doc: CircuitDoc, ids: string[], axis: 'x' | 'y') {
  const movable = ids.filter((id) => doc.items[id] && doc.items[id].type !== 'wire');
  if (movable.length < 3) return;
  const boxes = movable.map((id) => ({ id, r: itemBounds(doc, doc.items[id])! }));
  const key = axis === 'x' ? 'x' : 'y';
  const size = axis === 'x' ? 'w' : 'h';
  boxes.sort((a, b) => a.r[key] + a.r[size] / 2 - (b.r[key] + b.r[size] / 2));
  const first = boxes[0].r[key] + boxes[0].r[size] / 2;
  const lastB = boxes[boxes.length - 1];
  const last = lastB.r[key] + lastB.r[size] / 2;
  const step = (last - first) / (boxes.length - 1);
  const g = doc.settings.snap ? doc.settings.grid : 1;
  boxes.forEach(({ id, r }, i) => {
    const target = first + step * i;
    const delta = snap(target - (r[key] + r[size] / 2), g);
    const base = clone(doc);
    translateItems(base, doc, new Set([id]), axis === 'x' ? delta : 0, axis === 'y' ? delta : 0);
  });
}

/* ------------------------------------------------------------------ */
/* Annotation                                                          */
/* ------------------------------------------------------------------ */

/** Renumbers reference designators left-to-right, top-to-bottom. */
export function annotate(doc: CircuitDoc) {
  const comps = Object.values(doc.items).filter((i): i is ComponentItem => i.type === 'component');
  comps.sort((a, b) => (Math.abs(a.y - b.y) > 40 ? a.y - b.y : a.x - b.x));
  const counters = new Map<string, number>();
  for (const c of comps) {
    const prefix = getSymbol(doc, c.symbol).prefix;
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    c.ref = prefix.startsWith('#') ? `${prefix}${String(n).padStart(2, '0')}` : `${prefix}${n}`;
  }
}

export function boundsOfIds(doc: CircuitDoc, ids: Iterable<string>): Rect | null {
  return docBounds(doc, ids);
}
