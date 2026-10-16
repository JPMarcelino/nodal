import { current, isDraft } from 'immer';
import { attachedWires, docBounds, drawOrder, groupChain, itemBounds, nextRef, refersTo, uid } from './doc';
import { eq, projectOnSegment, rotate, simplify, snap, unionRects } from './geometry';
import { inkPoints, packInk } from './ink';
import { packPoly, polyPoints } from './polygon';
import { touchingPins } from './netlist';
import { instanceSymbol } from './registry';
import type { CircuitDoc, ComponentItem, Endpoint, Group, Item, Point, Rect, WireItem } from './types';
import { adjustWireForMove, endpointInfo, wirePolyline } from './wires';
import type { TouchTarget } from './hotspots';

/** Deep copy that also works on immer drafts. */
export const clone = <T,>(x: T): T => (isDraft(x) ? current(x) : structuredClone(x));

/* ------------------------------------------------------------------ */
/* Wires & junctions                                                   */
/* ------------------------------------------------------------------ */

function setFullPolyline(w: WireItem, full: Point[]) {
  w.pts = simplify(full).slice(1, -1);
}

/** Splits a wire at a point on segment `seg` at a junction (a new one unless `jid` is given). Returns the junction id. */
export function splitWire(doc: CircuitDoc, wireId: string, seg: number, pt: Point, jid = uid('j')): string {
  const w = doc.items[wireId] as WireItem;
  const full = wirePolyline(doc, w);
  if (!doc.items[jid]) doc.items[jid] = { id: jid, type: 'junction', x: pt.x, y: pt.y, group: w.group };
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

/**
 * Solders wires together where they cross: each wire is split at `pt` and
 * all pieces meet at one shared junction. Returns the junction id, or null
 * when fewer than two of the wires actually pass through the point.
 */
export function solderWires(doc: CircuitDoc, wireIds: string[], pt: Point): string | null {
  const hits: { id: string; seg: number }[] = [];
  for (const id of wireIds) {
    const w = doc.items[id];
    if (!w || w.type !== 'wire') continue;
    const full = wirePolyline(doc, w);
    for (let i = 0; i < full.length - 1; i++) {
      if (projectOnSegment(pt, full[i], full[i + 1]).d < 0.5) {
        hits.push({ id, seg: i });
        break;
      }
    }
  }
  if (hits.length < 2) return null;
  const jid = uid('j');
  for (const h of hits) splitWire(doc, h.id, h.seg, pt, jid);
  return jid;
}

/** Connects a loose wire end to whatever it is touching (see TouchTarget). Returns false if nothing changed. */
export function solderTouch(doc: CircuitDoc, wireId: string, end: 'a' | 'b', target: TouchTarget): boolean {
  const w = doc.items[wireId];
  if (!w || w.type !== 'wire') return false;
  const ep = w[end];
  if (ep.kind !== 'free') return false;
  const pt = { x: ep.x, y: ep.y };
  // keep the drawn route; only the end's connection changes
  w.pts = wirePolyline(doc, w).slice(1, -1);
  switch (target.kind) {
    case 'port':
      w[end] = { kind: 'port', comp: target.comp, port: target.port };
      return true;
    case 'junction':
      if (!doc.items[target.id]) return false;
      w[end] = { kind: 'junction', id: target.id };
      return true;
    case 'end': {
      const o = doc.items[target.wire];
      if (!o || o.type !== 'wire') return false;
      const jid = uid('j');
      doc.items[jid] = { id: jid, type: 'junction', x: pt.x, y: pt.y, group: w.group };
      o.pts = wirePolyline(doc, o).slice(1, -1);
      o[target.end] = { kind: 'junction', id: jid };
      w[end] = { kind: 'junction', id: jid };
      return true;
    }
    case 'wire': {
      const o = doc.items[target.wire];
      if (!o || o.type !== 'wire') return false;
      // re-find the segment: the stored index may be stale
      const full = wirePolyline(doc, o);
      const seg = full.findIndex((q, i) => i < full.length - 1 && projectOnSegment(pt, q, full[i + 1]).d < 0.5);
      if (seg < 0) return false;
      w[end] = { kind: 'junction', id: splitWire(doc, o.id, seg, pt) };
      return true;
    }
  }
}

/**
 * Undoes a solder junction: wires that run straight through it become one
 * wire again (crossing, so they hop), any other branch is detached and left
 * as a loose end touching the point.
 */
export function unsolderJunction(doc: CircuitDoc, jid: string): { through: number; detached: number } | null {
  const j = doc.items[jid];
  if (!j || j.type !== 'junction') return null;
  const r = detachEnds(doc, (ep) => refersTo(ep, jid), { x: j.x, y: j.y }, j.group);
  delete doc.items[jid];
  cleanup(doc);
  return r;
}

/** Same as unsolderJunction, for a component pin: everything on the pin is disconnected. */
export function unsolderPort(doc: CircuitDoc, comp: string, port: string): { through: number; detached: number } | null {
  const c = doc.items[comp];
  if (!c || c.type !== 'component') return null;
  const at = endpointInfo(doc, { kind: 'port', comp, port });
  if (!at) return null;
  const r = detachEnds(doc, (ep) => ep.kind === 'port' && ep.comp === comp && ep.port === port, at.pt, c.group);
  cleanup(doc);
  return r;
}

/**
 * Detaches every wire end matching `isHere` (all at point `pt`). Ends leaving
 * in opposite directions are paired and rejoined into one straight-through
 * wire; the rest become free ends at `pt`.
 */
function detachEnds(doc: CircuitDoc, isHere: (ep: Endpoint) => boolean, pt: Point, group?: string): { through: number; detached: number } {
  const ends: { w: WireItem; end: 'a' | 'b'; dir: Point }[] = [];
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire') continue;
    const full = wirePolyline(doc, it);
    if (full.length < 2) continue;
    for (const end of ['a', 'b'] as const) {
      if (!isHere(it[end])) continue;
      const [p, q] = end === 'a' ? [full[0], full[1]] : [full[full.length - 1], full[full.length - 2]];
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      ends.push({ w: it, end, dir: { x: (q.x - p.x) / len, y: (q.y - p.y) / len } });
    }
  }
  // keep every route exactly as drawn while the ends change
  for (const e of ends) e.w.pts = wirePolyline(doc, e.w).slice(1, -1);
  const used = new Set<number>();
  let through = 0;
  for (let i = 0; i < ends.length; i++) {
    if (used.has(i)) continue;
    const k = ends.findIndex((e, n) => n > i && !used.has(n) && e.w !== ends[i].w && e.dir.x * ends[i].dir.x + e.dir.y * ends[i].dir.y < -0.99);
    if (k < 0) continue;
    used.add(i).add(k);
    // a private two-way junction, merged into one wire by cleanup()
    const nj = uid('j');
    doc.items[nj] = { id: nj, type: 'junction', x: pt.x, y: pt.y, group };
    ends[i].w[ends[i].end] = { kind: 'junction', id: nj };
    ends[k].w[ends[k].end] = { kind: 'junction', id: nj };
    through++;
  }
  let detached = 0;
  ends.forEach((e, i) => {
    if (used.has(i)) return;
    e.w[e.end] = { kind: 'free', x: pt.x, y: pt.y };
    detached++;
  });
  return { through, detached };
}

/** Connects a pin that lies on a wire: the wire is split there and both halves attach to the pin. */
export function solderPinToWire(doc: CircuitDoc, comp: string, port: string, wireId: string): boolean {
  const at = endpointInfo(doc, { kind: 'port', comp, port });
  const w = doc.items[wireId];
  if (!at || !w || w.type !== 'wire') return false;
  const full = wirePolyline(doc, w);
  const seg = full.findIndex((q, i) => i < full.length - 1 && projectOnSegment(at.pt, q, full[i + 1]).d < 0.5);
  if (seg < 0) return false;
  const jid = splitWire(doc, wireId, seg, at.pt);
  // the split junction is replaced by the pin itself
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire') continue;
    for (const end of ['a', 'b'] as const) {
      if (refersTo(it[end], jid)) {
        it.pts = wirePolyline(doc, it).slice(1, -1);
        it[end] = { kind: 'port', comp, port };
      }
    }
  }
  delete doc.items[jid];
  return true;
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
      if (it.type !== 'junction' || !doc.items[it.id]) continue;
      // count wire *ends*: a loop with both ends here counts twice
      const ws = attachedWires(doc, it.id);
      const ends = ws.reduce((n, id) => {
        const w = doc.items[id] as WireItem;
        return n + (refersTo(w.a, it.id) ? 1 : 0) + (refersTo(w.b, it.id) ? 1 : 0);
      }, 0);
      if (ends === 0) {
        delete doc.items[it.id];
        changed = true;
      } else if (ends === 2 && ws.length === 2) {
        // two wires simply continuing through: join them into one
        mergeAtJunction(doc, it.id, ws[0], ws[1]);
        changed = true;
      } else if (ends <= 2) {
        // a dangling junction, or a single loop closing on itself, becomes free wire ends
        const w = doc.items[ws[0]] as WireItem;
        const free: Endpoint = { kind: 'free', x: it.x, y: it.y };
        if (refersTo(w.a, it.id)) w.a = free;
        if (refersTo(w.b, it.id)) w.b = { ...free };
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

/**
 * Deletes one vertex ("node") or one segment of a wire.
 *
 * - a segment: the wire is shortened (end segment) or split in two (middle one),
 *   leaving a gap exactly the size of the removed segment;
 * - a node: an end node removes its end segment; an interior bend is removed and
 *   the route is re-joined, staying orthogonal unless the wire is straight-routed.
 */
export function deleteWirePart(doc: CircuitDoc, part: { wire: string; kind: 'node' | 'segment'; index: number }): void {
  const w = doc.items[part.wire] as WireItem | undefined;
  if (!w || w.type !== 'wire') return;
  const full = wirePolyline(doc, w);
  const n = full.length - 1; // segment count
  if (n < 1) return;

  let seg: number;
  if (part.kind === 'node') {
    const k = Math.max(0, Math.min(full.length - 1, part.index));
    if (k > 0 && k < n) {
      removeVertex(w, full, k);
      cleanup(doc);
      return;
    }
    seg = k <= 0 ? 0 : n - 1;
  } else {
    seg = Math.max(0, Math.min(n - 1, part.index));
  }

  if (n === 1) {
    delete doc.items[w.id];
    cleanup(doc);
    return;
  }
  if (seg === 0) {
    const rest = full.slice(1);
    w.a = { kind: 'free', x: rest[0].x, y: rest[0].y };
    setFullPolyline(w, rest);
  } else if (seg === n - 1) {
    const rest = full.slice(0, n);
    w.b = { kind: 'free', x: rest[rest.length - 1].x, y: rest[rest.length - 1].y };
    setFullPolyline(w, rest);
  } else {
    const first = full.slice(0, seg + 1);
    const second = full.slice(seg + 1);
    const w2: WireItem = {
      ...clone(w),
      id: uid('w'),
      a: { kind: 'free', x: second[0].x, y: second[0].y },
      pts: simplify(second).slice(1, -1),
    };
    w.b = { kind: 'free', x: first[first.length - 1].x, y: first[first.length - 1].y };
    setFullPolyline(w, first);
    doc.items[w2.id] = w2;
  }
  cleanup(doc);
}

/** Removes interior vertex `k`; for orthogonal wires an elbow keeps the route right-angled. */
function removeVertex(w: WireItem, full: Point[], k: number) {
  const P = full.map((p) => ({ ...p }));
  const prev = P[k - 1];
  const next = P[k + 1];
  if (w.routing === 'straight' || Math.abs(prev.x - next.x) < 0.01 || Math.abs(prev.y - next.y) < 0.01) {
    P.splice(k, 1);
  } else {
    // choose the elbow that continues the run entering (or leaving) the vertex
    const before = P[k - 2];
    const after = P[k + 2];
    let elbow: Point;
    if (before && Math.abs(before.y - prev.y) < 0.01) elbow = { x: next.x, y: prev.y };
    else if (before && Math.abs(before.x - prev.x) < 0.01) elbow = { x: prev.x, y: next.y };
    else if (after && Math.abs(after.y - next.y) < 0.01) elbow = { x: prev.x, y: next.y };
    else if (after && Math.abs(after.x - next.x) < 0.01) elbow = { x: next.x, y: prev.y };
    else elbow = { x: next.x, y: prev.y };
    P.splice(k, 1, elbow);
  }
  setFullPolyline(w, P);
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
  transformNonWires(base, doc, ids, map, rotateBy, flip);
  transformWires(base, doc, ids, map);
  bridgeTouchingPins(base, doc, ids);
}

/**
 * Pins butted together are connected without a wire; when a move pulls them
 * apart, a wire between them keeps the connection. Ids derive from the pins,
 * so repeated calls during a drag rebuild the same wire.
 */
function bridgeTouchingPins(base: CircuitDoc, doc: CircuitDoc, ids: Set<string>) {
  const moves = (comp: string) => ids.has(comp) && !base.items[comp]?.locked;
  for (const group of touchingPins(base)) {
    const pins = group.map((k) => {
      const [comp, port] = k.split(':');
      return { comp, port };
    });
    const still = pins.find((p) => !moves(p.comp));
    if (!still) continue;
    const stillAt = endpointInfo(doc, { kind: 'port', ...still })?.pt;
    for (const p of pins) {
      if (!moves(p.comp)) continue;
      const at = endpointInfo(doc, { kind: 'port', ...p })?.pt;
      if (!at || !stillAt || eq(at, stillAt)) continue;
      let id = `w-${p.comp}-${p.port}-${still.comp}-${still.port}`;
      while (base.items[id]) id += '_';
      doc.items[id] = { id, type: 'wire', a: { kind: 'port', ...still }, b: { kind: 'port', ...p }, pts: [], group: base.items[still.comp]?.group };
    }
  }
}

/** Components, junctions and shapes of a transform (wires are handled separately). */
function transformNonWires(base: CircuitDoc, doc: CircuitDoc, ids: Set<string>, map: (p: Point) => Point, rotateBy = 0, flip = false) {
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
      } else if (b.kind === 'callout') {
        it.x = p1.x;
        it.y = p1.y;
        // a loose leader end travels with the note; one pinned to a part stays on the part
        if (b.anchor && it.anchor && !(b.anchor.id && base.items[b.anchor.id])) {
          const a = map({ x: b.anchor.x, y: b.anchor.y });
          it.anchor.x = a.x;
          it.anchor.y = a.y;
        }
      } else if (b.kind === 'ink') {
        // map every point, so rotating or flipping a drawing turns the drawing, not just its box
        Object.assign(it, packInk(inkPoints(b).map((q) => ({ ...map(q), p: q.p }))));
      } else if (b.kind === 'polygon') {
        Object.assign(it, packPoly(polyPoints(b).map(map)));
      } else {
        it.x = Math.min(p1.x, p2.x);
        it.y = Math.min(p1.y, p2.y);
        it.w = Math.abs(p2.x - p1.x);
        it.h = Math.abs(p2.y - p1.y);
      }
    }
  }
}

/** Wires follow whatever they are attached to (rubber-banding the free side). */
function transformWires(base: CircuitDoc, doc: CircuitDoc, ids: Set<string>, map: (p: Point) => Point) {
  // loose wire ends resting exactly on a moving pin come along too, like real connections
  const movingPins = new Set<string>();
  for (const id of ids) {
    const c = base.items[id];
    if (c?.type !== 'component' || c.locked) continue;
    for (const p of instanceSymbol(base, c).ports) {
      const at = endpointInfo(base, { kind: 'port', comp: c.id, port: p.id });
      if (at) movingPins.add(`${at.pt.x},${at.pt.y}`);
    }
  }
  const onMovingPin = (ep: Endpoint) => ep.kind === 'free' && movingPins.has(`${ep.x},${ep.y}`);
  for (const b of Object.values(base.items)) {
    if (b.type !== 'wire') continue;
    const w = doc.items[b.id] as WireItem | undefined;
    if (!w || b.locked) continue;
    const ownA = endpointOwner(b.a);
    const ownB = endpointOwner(b.b);
    const selfSel = ids.has(b.id);
    const movesA = (ownA && ids.has(ownA)) || (!ownA && (selfSel || onMovingPin(b.a)));
    const movesB = (ownB && ids.has(ownB)) || (!ownB && (selfSel || onMovingPin(b.b)));
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

/**
 * Alt move: only the selection moves. Wires connecting the selection to
 * anything else are cut there — unselected wires keep their shape with a
 * loose end left behind, selected wires take their loose ends with them.
 */
export function translateDetached(base: CircuitDoc, doc: CircuitDoc, ids: Set<string>, dx: number, dy: number) {
  const map = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
  transformNonWires(base, doc, ids, map);
  for (const b of Object.values(base.items)) {
    if (b.type !== 'wire' || b.locked) continue;
    const w = doc.items[b.id] as WireItem | undefined;
    if (!w) continue;
    const full = wirePolyline(base, b);
    if (full.length < 2) continue;
    const last = full.length - 1;
    const ownA = endpointOwner(b.a);
    const ownB = endpointOwner(b.b);
    if (ids.has(b.id)) {
      const mapped = full.map(map);
      w.pts = mapped.slice(1, -1);
      // ends stay connected only to things that move along with the wire
      w.a = ownA && ids.has(ownA) ? b.a : { kind: 'free', ...mapped[0] };
      w.b = ownB && ids.has(ownB) ? b.b : { kind: 'free', ...mapped[last] };
      continue;
    }
    const cutA = !!ownA && ids.has(ownA);
    const cutB = !!ownB && ids.has(ownB);
    if (!cutA && !cutB) continue;
    w.pts = full.slice(1, -1);
    if (cutA) w.a = { kind: 'free', ...full[0] };
    if (cutB) w.b = { kind: 'free', ...full[last] };
  }
}

/** Rotation pivot: centre of the selection snapped to the grid. */
export function selectionPivot(doc: CircuitDoc, ids: Iterable<string>): Point {
  const rects: Rect[] = [];
  for (const id of ids) {
    const it = doc.items[id];
    if (!it) continue;
    const r = itemBounds(doc, it);
    if (r) rects.push(r);
  }
  const b = unionRects(rects);
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
        const prefix = instanceSymbol(doc, it).prefix;
        it.ref = nextRef(doc, prefix, refs);
      }
      refs.add(it.ref);
    } else if (it.type === 'junction' || it.type === 'shape') {
      it.x += dx;
      it.y += dy;
      if (it.type === 'shape' && it.anchor) {
        if (it.anchor.id && idMap.has(it.anchor.id)) it.anchor.id = idMap.get(it.anchor.id)!;
        it.anchor.x += dx;
        it.anchor.y += dy;
      }
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
  const tops = new Set<string>();
  const direct: Item[] = [];
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
    if (top && top !== gid) tops.add(top);
    else direct.push(it);
  }
  for (const top of tops) doc.groups[top].group = gid;
  for (const it of direct) it.group = gid;
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
  const all = unionRects(boxes.map((b) => b.r).filter((r): r is Rect => !!r));
  if (!all) return;
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
    const prefix = instanceSymbol(doc, c).prefix;
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    c.ref = prefix.startsWith('#') ? `${prefix}${String(n).padStart(2, '0')}` : `${prefix}${n}`;
  }
}

export function boundsOfIds(doc: CircuitDoc, ids: Iterable<string>): Rect | null {
  return docBounds(doc, ids);
}

/**
 * Moves an item in the layer list (front first) to just before / after
 * another item of the same group. The group's items are reshuffled within
 * the stacking slots they already hold, then every item's z is rewritten to
 * its rank so the whole document shares one consistent order.
 */
export function reorderItem(doc: CircuitDoc, id: string, targetId: string, place: 'before' | 'after'): boolean {
  const it = doc.items[id];
  const target = doc.items[targetId];
  if (!it || !target || id === targetId || it.group !== target.group) return false;
  const rank = drawOrder(doc);
  const siblings = Object.values(doc.items)
    .filter((i) => i.type !== 'junction' && i.group === it.group)
    .sort((a, b) => rank.get(b.id)! - rank.get(a.id)!);
  const slots = siblings.map((s) => rank.get(s.id)!);
  const moved = siblings.filter((s) => s.id !== id);
  const at = moved.findIndex((i) => i.id === targetId) + (place === 'after' ? 1 : 0);
  moved.splice(at, 0, it);
  moved.forEach((s, i) => rank.set(s.id, slots[i]));
  for (const [iid, r] of rank) if (doc.items[iid].z !== r) doc.items[iid].z = r;
  return true;
}
