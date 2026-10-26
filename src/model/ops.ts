import { current, isDraft } from 'immer';
import { withContents } from './containers';
import { connectorsOf, detachConnector, fromLocal, isConnector, isFixed, resolveConnector, targetFrame, toLocal } from './connectors';
import { attachedWires, docBounds, drawOrder, groupChain, itemBounds, migrateShapeLayers, nextRef, refersTo, uid } from './doc';
import { componentBounds, eq, pointInRect, projectOnSegment, rectsIntersect, rotate, segmentIntersectsRect, simplify, snap, unionRects } from './geometry';
import { routeLeg, routeObstacles } from './route';
import { inkPoints, packInk } from './ink';
import { mapNodes, pathNodes, setPathNodes } from './path';
import { mapShapeFrame, normDeg, rectCentre, ROT_KINDS, rotateDeg, shapeBox, shapeRot } from './rotation';
import { touchingPins } from './netlist';
import { docPages, itemPage } from './pages';
import { instanceSymbol } from './registry';
import type { CircuitDoc, ComponentItem, Endpoint, Group, Item, LabelSide, LabelSpotName, Point, Rect, ShapeItem, WireItem } from './types';
// label placement is shared with the renderer, so a turned part's labels land where they are drawn
import { labelBox, labelLayout, labelLook } from '../canvas/Scene';
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

/** A wire piece split off another one: the name stays on the original piece only, so it isn't drawn twice. */
function withoutLabel(w: WireItem): WireItem {
  for (const k of ['label', 'labelAt', 'labelSide', 'labelHidden', 'labelStyle'] as const) delete w[k];
  return w;
}

/** Splits a wire at a point on segment `seg` at a junction (a new one unless `jid` is given). Returns the junction id. */
export function splitWire(doc: CircuitDoc, wireId: string, seg: number, pt: Point, jid = uid('j')): string {
  const w = doc.items[wireId] as WireItem;
  const full = wirePolyline(doc, w);
  if (!doc.items[jid]) doc.items[jid] = { id: jid, type: 'junction', x: pt.x, y: pt.y, group: w.group };
  const first = full.slice(0, seg + 1);
  const second = full.slice(seg + 1);
  const w2: WireItem = {
    ...withoutLabel(clone(w)),
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
      if (it.type !== 'wire' || !doc.items[it.id]) continue;
      const a = endpointInfo(doc, it.a);
      const b = endpointInfo(doc, it.b);
      if (!a || !b) {
        // an end whose pin or junction is gone lets go where the wire last ran, keeping the rest of it
        const keep = a ?? b;
        const end = a ? 'b' : 'a';
        const at = it.pts.length ? (end === 'a' ? it.pts[0] : it.pts[it.pts.length - 1]) : null;
        if (keep && at) {
          it[end] = { kind: 'free', x: at.x, y: at.y };
          it.pts = end === 'a' ? it.pts.slice(1) : it.pts.slice(0, -1);
        } else delete doc.items[it.id];
        changed = true;
        continue;
      }
      if (eq(a.pt, b.pt) && wirePolyline(doc, it).length < 2 && collapseWire(doc, it)) changed = true;
    }
    for (const it of Object.values(doc.items)) {
      if (it.type !== 'junction' || !doc.items[it.id]) continue;
      // a locked junction is an anchor: nothing here may fold it away or drop it
      if (it.locked) continue;
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

/**
 * Removes a zero-length wire. When it joins a junction to a pin or another
 * junction (a pin set down on a junction, two junctions dragged together)
 * the junction is folded into the other end, so whatever met there stays
 * connected instead of losing the link with the wire. Returns false when the
 * wire has to stay (it holds a pin to a locked junction).
 */
function collapseWire(doc: CircuitDoc, w: WireItem): boolean {
  const same = endpointOwner(w.a) === endpointOwner(w.b) && (w.a.kind !== 'port' || (w.b.kind === 'port' && w.a.port === w.b.port));
  const loose = (ep: Endpoint) => ep.kind === 'junction' && !doc.items[ep.id]?.locked;
  // a locked junction is an anchor: fold the other end into it, never it away
  const [from, to] = loose(w.b) ? [w.b, w.a] : loose(w.a) ? [w.a, w.b] : [null, null];
  const linked = w.a.kind !== 'free' && w.b.kind !== 'free' && !same;
  // two pins on one spot touch (connected without the wire); a locked junction on a pin keeps its short wire
  if (linked && (!from || to!.kind === 'free') && !(w.a.kind === 'port' && w.b.kind === 'port')) return false;
  delete doc.items[w.id];
  if (!linked || !from || !to || from.kind !== 'junction') return true;
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire') continue;
    for (const end of ['a', 'b'] as const) if (refersTo(it[end], from.id)) it[end] = { ...to };
  }
  delete doc.items[from.id];
  return true;
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
  // the joined wire keeps a name either half had
  if (!w1.label && w2.label) for (const k of ['label', 'labelAt', 'labelSide', 'labelHidden', 'labelStyle'] as const) (w1 as unknown as Record<string, unknown>)[k] = w2[k];
  setFullPolyline(w1, [...p1, ...p2.slice(1)]);
  // the polylines are already as drawn: joining a 45° / free wire must not square off its diagonals
  if (w1.routing === 'straight' || w2.routing === 'straight') w1.routing = 'straight';
  delete doc.items[w2id];
  delete doc.items[jid];
}

/** Deletes items; wires attached to deleted components keep their shape and become free. */
export function deleteItems(doc: CircuitDoc, ids: Iterable<string>) {
  const del = new Set(ids);
  // connectors glued to what goes let go of it, staying where they are
  for (const s of connectorsOf(doc, del)) {
    if (!del.has(s.id)) detachConnector(doc, s, { from: !!s.from && del.has(s.from.id), to: !!s.to && del.has(s.to.id) });
  }
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
      ...withoutLabel(clone(w)),
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
  if (rotateBy || flip) {
    turnWireLabels(base, doc, ids, rotateBy, flip);
    turnGlue(base, doc, ids, map);
  }
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
      if (rotateBy || flip) turnLabels(base, b, it, map, rotateBy, flip);
    } else if (b.type === 'junction' && it.type === 'junction') {
      const p = map(b);
      it.x = p.x;
      it.y = p.y;
    } else if (b.type === 'shape' && it.type === 'shape') {
      const p1 = map({ x: b.x, y: b.y });
      const p2 = map({ x: b.x + b.w, y: b.y + b.h });
      if (ROT_KINDS.has(b.kind)) {
        // boxy shapes keep their own frame: a turn adds to `rot` instead of reshaping the box
        const f = mapShapeFrame(b, map, rotateBy);
        it.x = f.x;
        it.y = f.y;
        // free text is sized by its content (scaleItems sets its font size)
        if (b.kind !== 'text') {
          it.w = f.w;
          it.h = f.h;
        }
        // a mirror turns a picture inside out too (text can't, so it takes the turn that reads right)
        const mirror = flip && b.kind === 'image';
        const rot = mirror ? normDeg(f.rot - rotateBy) : f.rot;
        if (rot) it.rot = rot;
        else delete it.rot;
        if (mirror) {
          if (b.flipX) delete it.flipX;
          else it.flipX = true;
        }
      } else if (b.kind === 'line' || b.kind === 'arrow') {
        // free ends and bends go with the map; glued ends stay on their targets (resolved on use)
        it.x = p1.x;
        it.y = p1.y;
        it.w = p2.x - p1.x;
        it.h = p2.y - p1.y;
        if (b.pts) it.pts = b.pts.map(map);
      } else if (b.kind === 'callout') {
        // the note's box keeps its size and upright text: its centre goes with the map
        const c = map({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
        it.x = c.x - b.w / 2;
        it.y = c.y - b.h / 2;
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
        // nodes and handles both: an affine map keeps every curve exact
        setPathNodes(it, mapNodes(pathNodes(b), map), b.open);
      } else {
        it.x = Math.min(p1.x, p2.x);
        it.y = Math.min(p1.y, p2.y);
        it.w = Math.abs(p2.x - p1.x);
        it.h = Math.abs(p2.y - p1.y);
      }
    }
  }
}

const MIRROR_X: Partial<Record<LabelSpotName, LabelSpotName>> = { left: 'right', right: 'left', topLeft: 'topRight', topRight: 'topLeft', bottomLeft: 'bottomRight', bottomRight: 'bottomLeft' };
const MIRROR_Y: Partial<Record<LabelSpotName, LabelSpotName>> = { above: 'below', below: 'above', topLeft: 'bottomLeft', bottomLeft: 'topLeft', topRight: 'bottomRight', bottomRight: 'topRight' };

/**
 * A part's labels turn and mirror with it: a chosen spot swaps sides on a
 * flip, and labels dragged off their spot are carried by the same transform
 * (the text itself stays upright), so they stay next to the same end.
 */
function turnLabels(base: CircuitDoc, b: ComponentItem, it: ComponentItem, map: (p: Point) => Point, rotateBy: number, flip: boolean) {
  if (flip && b.labelSpot) {
    // a vertical flip is a mirror plus a half turn: top and bottom swap, left and right stay
    const swap = rotateBy ? MIRROR_Y : MIRROR_X;
    it.labelSpot = swap[b.labelSpot] ?? b.labelSpot;
  }
  if (b.labelDx == null && b.labelDy == null && b.valueDx == null && b.valueDy == null) return;
  const def = instanceSymbol(base, b);
  const was = labelLayout(b, def);
  // the offsets are measured from the fixed spot (what the layout gives with zero offsets)
  const spot = labelLayout({ ...it, labelDx: 0, labelDy: 0, valueDx: 0, valueDy: 0 } as ComponentItem, instanceSymbol(base, it));
  // the middle of the text goes with the map (text reads left to right, so a mirrored label must not run back over the part)
  const off = (which: 'ref' | 'value') => {
    const p = was[which];
    const q = spot[which];
    if (!p || !q) return null;
    const look = labelLook(b, which, def);
    const box = labelBox(p, look);
    const m = map({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
    const anchor = look.st.align ?? q.anchor;
    const x = anchor === 'start' ? m.x - box.w / 2 : anchor === 'end' ? m.x + box.w / 2 : m.x;
    const y = m.y - box.h / 2 + look.size;
    return { x: Math.round((x - q.x) * 100) / 100, y: Math.round((y - q.y) * 100) / 100 };
  };
  const ref = off('ref');
  const value = off('value');
  if (ref) Object.assign(it, { labelDx: ref.x, labelDy: ref.y });
  if (value) Object.assign(it, { valueDx: value.x, valueDy: value.y });
}

/**
 * Connector ends glued to a spot of a turned or mirrored target stay on that
 * same spot of the drawing: a shape's frame doesn't mirror (and a polygon's
 * is rebuilt from its turned points), so the spot is mapped and measured again.
 */
function turnGlue(base: CircuitDoc, doc: CircuitDoc, ids: Set<string>, map: (p: Point) => Point) {
  for (const b of Object.values(base.items)) {
    if (!isConnector(b) || b.locked) continue;
    const s = doc.items[b.id] as ShapeItem | undefined;
    if (!s) continue;
    for (const end of ['from', 'to'] as const) {
      const a = b[end];
      if (!a || !isFixed(a) || !ids.has(a.id) || base.items[a.id]?.locked) continue;
      const was = targetFrame(base, base.items[a.id]);
      const now = targetFrame(doc, doc.items[a.id]);
      if (!was || !now) continue;
      const l = toLocal(now, map(fromLocal(was, 2 * a.fx! - 1, 2 * a.fy! - 1)));
      const r = (v: number) => Math.round(Math.min(1, Math.max(0, (v + 1) / 2)) * 1e4) / 1e4;
      const fx = r(l.x);
      const fy = r(l.y);
      if (Math.abs(fx - a.fx!) > 1e-3 || Math.abs(fy - a.fy!) > 1e-3) s[end] = { ...a, fx, fy };
    }
  }
}

const TURN_SIDE: Record<LabelSide, LabelSide> = { above: 'right', right: 'below', below: 'left', left: 'above' };

/** A turned or mirrored wire keeps its name on the same side of the run (above a run that is now vertical would sit on it). */
function turnWireLabels(base: CircuitDoc, doc: CircuitDoc, ids: Set<string>, rotateBy: number, flip: boolean) {
  for (const id of ids) {
    const b = base.items[id];
    const w = doc.items[id];
    if (b?.type !== 'wire' || w?.type !== 'wire' || b.locked || !b.labelSide) continue;
    let side = b.labelSide;
    if (flip) side = side === 'left' ? 'right' : side === 'right' ? 'left' : side;
    for (let k = ((rotateBy % 360) + 360) % 360; k > 0; k -= 90) side = TURN_SIDE[side];
    w.labelSide = side;
  }
}

/** Wires follow whatever they are attached to (rubber-banding the free side). */
function transformWires(base: CircuitDoc, doc: CircuitDoc, ids: Set<string>, map: (p: Point) => Point, rigid = true) {
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
    // a locked part or junction stays put even when it is selected, and so do the wire ends on it
    const ownA = endpointOwner(b.a);
    const ownB = endpointOwner(b.b);
    const stays = (o: string) => !!base.items[o]?.locked;
    const selfSel = ids.has(b.id);
    const movesA = (ownA && ids.has(ownA) && !stays(ownA)) || (!ownA && (selfSel || onMovingPin(b.a)));
    const movesB = (ownB && ids.has(ownB) && !stays(ownB)) || (!ownB && (selfSel || onMovingPin(b.b)));
    if (!movesA && !movesB) continue;
    const full = wirePolyline(base, b);
    if (full.length < 2) continue;
    if (rigid && movesA && movesB && (selfSel || (ownA && ownB))) {
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
    // bends next to a moved end slide along its straight runs (drawn diagonals stay as they are)
    const adj = adjustWireForMove(full, dA, dB, true);
    if (b.a.kind === 'free' && movesA) w.a = { kind: 'free', ...adj[0] };
    if (b.b.kind === 'free' && movesB) w.b = { kind: 'free', ...adj[adj.length - 1] };
    w.pts = simplify(adj).slice(1, -1);
  }
}

/**
 * Brings wires up to date after parts were edited directly (position, turn,
 * flip, size or symbol typed into the Inspector, or a part's resize handle):
 * the ends on their pins follow, the bends next to them slide along, and a
 * wire left running through a turned part is routed around it.
 */
export function followParts(base: CircuitDoc, doc: CircuitDoc, ids: Set<string>, reroute = true) {
  const changed = new Set(
    [...ids].filter((id) => {
      const b = base.items[id];
      const it = doc.items[id];
      return b?.type === 'component' && it?.type === 'component' && (b.x !== it.x || b.y !== it.y || b.rot !== it.rot || !!b.flipX !== !!it.flipX || (b.scale ?? 1) !== (it.scale ?? 1) || b.symbol !== it.symbol);
    }),
  );
  if (!changed.size) return;
  transformWires(base, doc, changed, (p) => p, false);
  if (reroute) rerouteTurnedWires(base, doc, changed);
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
  // connectors are cut loose the same way: glued to something that moves while they stay, or the other way round
  for (const b of Object.values(base.items)) {
    if (!isConnector(b) || b.locked || (!b.from && !b.to)) continue;
    const s = doc.items[b.id] as ShapeItem | undefined;
    if (!s) continue;
    const moves = ids.has(b.id);
    const cut = (a: typeof b.from) => !!a && ids.has(a.id) !== moves;
    const from = cut(b.from);
    const to = cut(b.to);
    if (!from && !to) continue;
    // where the ends are at the start of the move, carried along when the connector moves
    const p = resolveConnector(base, b);
    const at = (q: Point) => (moves ? map(q) : q);
    if (from) {
      const a = at(p.start);
      const e = { x: s.x + s.w, y: s.y + s.h };
      Object.assign(s, { x: a.x, y: a.y, w: e.x - a.x, h: e.y - a.y });
      delete s.from;
    }
    if (to) {
      const e = at(p.end);
      s.w = e.x - s.x;
      s.h = e.y - s.y;
      delete s.to;
    }
  }
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

/**
 * Resizes a selection as one: positions, wire bends and shapes spread out
 * from `pivot` by `factor`, and every part and text grows by the same factor
 * (relative to the size it had in `base`), so the layout stays as it was.
 * Returns the factor used, kept so no part goes outside 10%…1000%.
 */
export function scaleItems(base: CircuitDoc, doc: CircuitDoc, ids: Set<string>, factor: number, pivot: Point): number {
  let r = factor;
  for (const id of ids) {
    const c = base.items[id];
    if (c?.type !== 'component' || c.locked) continue;
    const k = c.scale ?? 1;
    r = Math.min(Math.max(r, 0.1 / k), 10 / k);
  }
  const map = (p: Point) => ({ x: pivot.x + (p.x - pivot.x) * r, y: pivot.y + (p.y - pivot.y) * r });
  transformItems(base, doc, ids, map);
  for (const id of ids) {
    const b = base.items[id];
    const it = doc.items[id];
    if (!b || !it || b.locked) continue;
    if (b.type === 'component' && it.type === 'component') {
      const k = Math.round((b.scale ?? 1) * r * 1e4) / 1e4;
      if (Math.abs(k - 1) < 1e-4) delete it.scale;
      else it.scale = k;
    } else if (b.type === 'shape' && it.type === 'shape' && b.kind === 'text') {
      it.fontSize = Math.round((b.fontSize ?? 16) * r * 100) / 100;
      it.w = b.w * r;
      it.h = b.h * r;
      if (b.wrapW) it.wrapW = b.wrapW * r;
    }
  }
  // parts only take sizes that keep their pins on the grid, so a pin can sit a little off where
  // a scaled wire ends: those ends go onto the pins, the bends next to them sliding along
  const moves = (o: string | null) => !!o && ids.has(o) && !base.items[o]?.locked;
  for (const b of Object.values(base.items)) {
    if (b.type !== 'wire' || b.locked) continue;
    const w = doc.items[b.id] as WireItem | undefined;
    if (!w || (b.a.kind !== 'port' && b.b.kind !== 'port')) continue;
    const ownA = endpointOwner(b.a);
    const ownB = endpointOwner(b.b);
    const sel = ids.has(b.id);
    const rigid = (ownA ? moves(ownA) : sel) && (ownB ? moves(ownB) : sel) && (sel || (!!ownA && !!ownB));
    if (!rigid) continue;
    const full = wirePolyline(base, b).map(map);
    if (full.length < 2) continue;
    const last = full[full.length - 1];
    const nowA = endpointNow(doc, w.a, full[0]);
    const nowB = endpointNow(doc, w.b, last);
    const dA = eq(nowA, full[0]) ? null : { x: nowA.x - full[0].x, y: nowA.y - full[0].y };
    const dB = eq(nowB, last) ? null : { x: nowB.x - last.x, y: nowB.y - last.y };
    if (!dA && !dB) continue;
    w.pts = simplify(adjustWireForMove(full, dA, dB, true)).slice(1, -1);
  }
  return r;
}

/**
 * Pivot of a turn or flip: a lone part turns about its origin and a lone shape
 * about its own centre; a selection about the middle of its bounds, rounded so
 * grid points land on grid points again (both coordinates on the grid or both
 * half way between), and so the same turn or flip repeated comes back to the start.
 */
export function turnPivot(doc: CircuitDoc, ids: Set<string>): Point {
  const single = [...ids].filter((id) => doc.items[id] && doc.items[id].type !== 'wire');
  const lone = single.length === 1 ? doc.items[single[0]] : null;
  if (lone?.type === 'component') return { x: lone.x, y: lone.y };
  if (lone?.type === 'shape') return rectCentre(shapeBox(lone));
  const rects: Rect[] = [];
  for (const id of ids) {
    const it = doc.items[id];
    const r = it && itemBounds(doc, it);
    if (r) rects.push(r);
  }
  const b = unionRects(rects);
  if (!b) return { x: 0, y: 0 };
  const h = doc.settings.grid / 2;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const x = Math.round(cx / h);
  let y = Math.round(cy / h);
  // a quarter turn about (x, y) maps the grid onto itself only when x and y are both whole or both half steps
  if ((((x + y) % 2) + 2) % 2) y += cy / h > y ? 1 : -1;
  return { x: x * h, y: y * h };
}

export function rotateItems(doc: CircuitDoc, ids: Set<string>, deg: 90 | -90, pivot?: Point) {
  const base = clone(doc);
  const piv = pivot ?? turnPivot(doc, ids);
  transformItems(base, doc, ids, (p) => rotate({ x: p.x - piv.x, y: p.y - piv.y }, deg === 90 ? 90 : 270, piv), deg);
  rerouteTurnedWires(base, doc, ids);
}

/**
 * Turns one shape by any angle about `pivot` (the rotation handle). Boxy kinds
 * add to their `rot`; point-based kinds have their points turned. `base` is the
 * gesture-start document, so a drag never accumulates error.
 */
export function rotateShapeBy(base: CircuitDoc, doc: CircuitDoc, id: string, deg: number, pivot: Point) {
  if (base.items[id]?.type !== 'shape') return;
  const map = (p: Point) => rotateDeg(p, deg, pivot);
  transformItems(base, doc, new Set([id]), map);
  // a turned polygon or drawing gets a new box from its turned points: glued ends keep their spot
  turnGlue(base, doc, new Set([id]), map);
}

export type SizeMode = 'width' | 'height' | 'both';

/** Shape kinds "make same size" resizes (text and callouts are sized by their content). */
const sizable = (it: Item | undefined): it is ShapeItem => it?.type === 'shape' && it.kind !== 'text' && it.kind !== 'callout' && !it.locked;

/**
 * Make same width / height / size: every selected shape takes the size of the
 * first selected one (`ids[0]` when it is a shape, else the first shape). Sizes
 * are each shape's own (unrotated) box; turned shapes keep their centre, the
 * rest their top-left corner. Lines and arrows keep their direction. Parts only
 * scale uniformly, so they are left alone. Returns how many shapes changed.
 */
export function matchSizes(doc: CircuitDoc, ids: string[], mode: SizeMode): number {
  const ref = ids.map((id) => doc.items[id]).find((it): it is ShapeItem => it?.type === 'shape' && it.kind !== 'text' && it.kind !== 'callout');
  if (!ref) return 0;
  const W = Math.abs(ref.w);
  const H = Math.abs(ref.h);
  let n = 0;
  for (const id of ids) {
    const s = doc.items[id];
    if (s === ref || !sizable(s)) continue;
    const c = rectCentre(shapeBox(s));
    const turned = !!shapeRot(s);
    if (mode !== 'height') s.w = s.w < 0 ? -W : W;
    if (mode !== 'width') s.h = s.h < 0 ? -H : H;
    if (turned) {
      s.x = c.x - s.w / 2;
      s.y = c.y - s.h / 2;
    }
    n++;
  }
  return n;
}

export function flipItems(doc: CircuitDoc, ids: Set<string>, axis: 'x' | 'y', pivot?: Point) {
  const base = clone(doc);
  const piv = pivot ?? turnPivot(doc, ids);
  if (axis === 'x') {
    transformItems(base, doc, ids, (p) => ({ x: 2 * piv.x - p.x, y: p.y }), 0, true);
  } else {
    // vertical flip = horizontal flip + 180° rotation
    transformItems(base, doc, ids, (p) => ({ x: p.x, y: 2 * piv.y - p.y }), 180, true);
  }
  rerouteTurnedWires(base, doc, ids);
}

/**
 * After a turn or flip, a wire from a turned part to something that stayed
 * can end up running back through the part's body or over its other pins
 * (a lone diode flipped: each lead now crosses the diode to reach its old
 * net). Such wires are routed afresh around the parts, so the drawing shows
 * the connections the netlist has.
 */
function rerouteTurnedWires(base: CircuitDoc, doc: CircuitDoc, ids: Set<string>) {
  const parts = [...ids].map((id) => doc.items[id]).filter((it): it is ComponentItem => it?.type === 'component' && !base.items[it.id]?.locked);
  if (!parts.length) return;
  const bodies = parts.map((c) => {
    const r = componentBounds(c, instanceSymbol(doc, c));
    return { id: c.id, r: { x: r.x + 0.5, y: r.y + 0.5, w: r.w - 1, h: r.h - 1 } };
  });
  const pins = parts.flatMap((c) => instanceSymbol(doc, c).ports.map((p) => endpointInfo(doc, { kind: 'port', comp: c.id, port: p.id })!.pt));
  const moving = (ep: Endpoint) => {
    const o = endpointOwner(ep);
    return !!o && ids.has(o) && !base.items[o]?.locked;
  };
  const bad: { w: WireItem; end: 'a' | 'b' }[] = [];
  for (const w of Object.values(doc.items)) {
    if (w.type !== 'wire' || w.locked || ids.has(w.id)) continue;
    const ma = moving(w.a) && w.a.kind === 'port';
    const mb = moving(w.b) && w.b.kind === 'port';
    if (ma === mb || moving(ma ? w.b : w.a)) continue;
    const full = wirePolyline(doc, w);
    if (full.length < 2) continue;
    const ends = [full[0], full[full.length - 1]];
    // a pin drawn inside its own outline necessarily starts there
    const own = (w[ma ? 'a' : 'b'] as Extract<Endpoint, { kind: 'port' }>).comp;
    const pinAt = ma ? full[0] : full[full.length - 1];
    const crosses = full.some((q, i) => i > 0 && bodies.some((b) => !(b.id === own && pointInRect(pinAt, b.r)) && segmentIntersectsRect(full[i - 1], q, b.r)));
    const overPin = pins.some((p) => !ends.some((e) => eq(e, p)) && full.some((q, i) => i > 0 && projectOnSegment(p, full[i - 1], q).d < 0.01));
    if (crosses || overPin) bad.push({ w, end: ma ? 'a' : 'b' });
  }
  const pending = new Set(bad.map((b) => b.w.id));
  for (const { w, end } of bad) {
    routeWireAround(doc, w, pending, end);
    pending.delete(w.id);
  }
}

/**
 * Routes a wire afresh between its ends, square and around parts and other
 * wires (`skip`: wires not to avoid, such as others still to be routed).
 * Starts from end `from` (its pin direction leads). Returns false when no
 * clean route was found and the wire was left as it was.
 */
export function routeWireAround(doc: CircuitDoc, w: WireItem, skip: Set<string> = new Set(), from: 'a' | 'b' = 'a'): boolean {
  const s = endpointInfo(doc, w[from]);
  const t = endpointInfo(doc, w[from === 'a' ? 'b' : 'a']);
  if (!s || !t) return false;
  const dir = (d: Point) => (d.x || d.y ? d : undefined);
  const route = routeLeg(routeObstacles(doc, new Set([...skip, w.id])), s.pt, t.pt, {
    grid: doc.settings.grid,
    hFirst: s.dir.x !== 0 || (!s.dir.y && Math.abs(t.pt.x - s.pt.x) >= Math.abs(t.pt.y - s.pt.y)),
    startDir: dir(s.dir),
    endDir: dir(t.dir),
  });
  if (!route || route.length < 2) return false;
  const inner = route.slice(1, -1);
  w.pts = from === 'a' ? inner : inner.reverse();
  delete w.routing;
  return true;
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
  // a junction two or more selected parts meet at comes along, so they stay connected through it
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'junction' || all.has(it.id)) continue;
    const into = attachedWires(doc, it.id).filter((wid) => {
      const w = doc.items[wid] as WireItem;
      const other = endpointOwner(refersTo(w.a, it.id) ? w.b : w.a);
      return !!other && ids.has(other);
    });
    if (into.length >= 2) all.add(it.id);
  }
  // include wires whose both ends are within the selection
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire') continue;
    const oa = endpointOwner(it.a);
    const ob = endpointOwner(it.b);
    if ((!oa || all.has(oa)) && (!ob || all.has(ob)) && (oa || ob) && (all.has(oa ?? '') || all.has(ob ?? ''))) all.add(it.id);
  }
  for (const id of all) {
    const it = doc.items[id];
    if (!it) continue;
    const c = clone(it);
    // pages belong to the document the items come from: copies, templates and
    // imported circuits land on the page they are inserted into
    delete c.page;
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
    } else if (isConnector(c)) {
      // a connector keeps its ends glued only to things copied with it
      detachConnector(doc, c, { from: !!c.from && !all.has(c.from.id), to: !!c.to && !all.has(c.to.id) });
    }
    items.push(c);
  }
  const groupIds = new Set<string>();
  for (const it of items) for (const g of groupChain(doc, it.group)) groupIds.add(g);
  const symbols: CircuitDoc['symbols'] = {};
  for (const it of items) {
    if (it.type !== 'component') continue;
    const def = doc.symbols[it.symbol];
    if (!def) continue;
    symbols[it.symbol] = def;
    // a user-defined "type" brings its base along, so its type picker works where the fragment lands
    if (def.variantOf && doc.symbols[def.variantOf]) symbols[def.variantOf] = doc.symbols[def.variantOf];
  }
  return { format: 'nodal-fragment', items, groups: [...groupIds].map((g) => clone(doc.groups[g])), symbols };
}

/**
 * Inserts a fragment with fresh ids, offset by (dx, dy). Returns the new item
 * ids, one for each fragment item and in the same order (so callers can pair a
 * copy with its original). Parts keep their references unless one is already
 * in `taken` (by default the references in `doc`, which during a page edit is
 * just that page).
 */
export function insertFragment(doc: CircuitDoc, frag: Fragment, dx: number, dy: number, scope?: string, taken?: Iterable<string>): string[] {
  const idMap = new Map<string, string>();
  const orderOf = new Map<string, number>();
  frag.items.forEach((it, i) => orderOf.set(it.id, i));
  for (const it of frag.items) idMap.set(it.id, uid(it.id[0] ?? 'i'));
  const gMap = new Map<string, string>();
  // the group being edited (and the ones around it) is where the copies land, not a group to copy again
  const around = new Set(groupChain(doc, scope));
  for (const g of frag.groups) if (!around.has(g.id)) gMap.set(g.id, uid('g'));
  for (const g of frag.groups) {
    if (around.has(g.id)) continue;
    const parent = g.group && gMap.get(g.group);
    doc.groups[gMap.get(g.id)!] = { id: gMap.get(g.id)!, name: g.name, group: parent || scope };
  }
  // a symbol this circuit already defines keeps its own (possibly edited) definition
  for (const [k, v] of Object.entries(frag.symbols ?? {})) if (!doc.symbols[k]) doc.symbols[k] = v;
  const refs = new Set(taken ?? Object.values(doc.items).flatMap((i) => (i.type === 'component' ? [i.ref] : [])));
  const out: string[] = new Array(frag.items.length).fill('');
  const remapEp = (ep: Endpoint): Endpoint => {
    if (ep.kind === 'port') return idMap.has(ep.comp) ? { ...ep, comp: idMap.get(ep.comp)! } : { kind: 'free', x: 0, y: 0 };
    if (ep.kind === 'junction') return idMap.has(ep.id) ? { kind: 'junction', id: idMap.get(ep.id)! } : { kind: 'free', x: 0, y: 0 };
    return { kind: 'free', x: ep.x + dx, y: ep.y + dy };
  };
  // copies go in front of everything, in the order the originals were drawn
  const rank = drawOrder({ items: Object.fromEntries(frag.items.map((i) => [i.id, i])) } as CircuitDoc);
  const order = [...frag.items].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  for (const src of order) {
    const it = clone(src) as Item;
    it.id = idMap.get(src.id)!;
    it.group = (src.group && gMap.get(src.group)) || scope;
    it.locked = false;
    delete it.z;
    // a fragment carries no page: its items land on the page they are inserted into
    delete it.page;
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
      if (it.type === 'shape' && it.pts) it.pts = it.pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      if (it.type === 'shape') {
        // glued ends follow the copies of their targets; a target left behind lets go
        for (const end of ['from', 'to'] as const) {
          const a = it[end];
          if (!a) continue;
          if (idMap.has(a.id)) it[end] = { ...a, id: idMap.get(a.id)! };
          else delete it[end];
        }
      }
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
    out[orderOf.get(src.id)!] = it.id;
  }
  // fragments copied / saved by older versions still carry shape layers
  migrateShapeLayers(doc.items);
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

/**
 * What each aligned / distributed item takes along: a container carries what lies inside it,
 * and anything selected that lies inside a selected container rides with it rather than
 * being placed on its own. Worked out up front, before any item has moved.
 */
function carriedBy(doc: CircuitDoc, ids: string[]): { movable: string[]; carry: Map<string, Set<string>> } {
  const carry = new Map<string, Set<string>>();
  const riding = new Set<string>();
  for (const id of ids) {
    const set = withContents(doc, [id]);
    carry.set(id, set);
    for (const o of set) if (o !== id) riding.add(o);
  }
  return { movable: ids.filter((id) => !riding.has(id)), carry };
}

export function alignItems(doc: CircuitDoc, ids: string[], mode: AlignMode) {
  const picked = ids.filter((id) => doc.items[id] && doc.items[id].type !== 'wire');
  const { movable, carry } = carriedBy(doc, picked);
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
    translateItems(base, doc, carry.get(id)!, snap(dx, g), snap(dy, g));
    Object.assign(base.items, clone(doc.items));
  }
}

export function distributeItems(doc: CircuitDoc, ids: string[], axis: 'x' | 'y') {
  const picked = ids.filter((id) => doc.items[id] && doc.items[id].type !== 'wire');
  const { movable, carry } = carriedBy(doc, picked);
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
    translateItems(base, doc, carry.get(id)!, axis === 'x' ? delta : 0, axis === 'y' ? delta : 0);
  });
}

/* ------------------------------------------------------------------ */
/* Annotation                                                          */
/* ------------------------------------------------------------------ */

/** Renumbers reference designators left-to-right, top-to-bottom. */
export function annotate(doc: CircuitDoc) {
  const comps = Object.values(doc.items).filter((i): i is ComponentItem => i.type === 'component');
  // page by page, then top to bottom, left to right
  const sheet = new Map(docPages(doc).map((p, i) => [p.id, i]));
  const at = (c: ComponentItem) => sheet.get(itemPage(doc, c)) ?? 0;
  // rows: parts within 40px of a row's first (top-most) part share it; a stable,
  // transitive order (a pairwise "close enough in y" comparison is not)
  comps.sort((a, b) => at(a) - at(b) || a.y - b.y || a.x - b.x);
  const row = new Map<ComponentItem, number>();
  let top = -Infinity;
  let page = -1;
  let r = 0;
  for (const c of comps) {
    if (at(c) !== page || c.y - top > 40) [page, top, r] = [at(c), c.y, r + 1];
    row.set(c, r);
  }
  comps.sort((a, b) => row.get(a)! - row.get(b)! || a.x - b.x);
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
  if (!it || !target || id === targetId || it.locked || it.group !== target.group) return false;
  const rank = drawOrder(doc);
  const siblings = Object.values(doc.items)
    .filter((i) => i.type !== 'junction' && i.group === it.group)
    .sort((a, b) => rank.get(b.id)! - rank.get(a.id)!);
  const slots = siblings.map((s) => rank.get(s.id)!);
  const moved = siblings.filter((s) => s.id !== id);
  const at = moved.findIndex((i) => i.id === targetId) + (place === 'after' ? 1 : 0);
  moved.splice(at, 0, it);
  // A locked item keeps its place: refuse any move that would shift one.
  if (siblings.some((s, i) => s.id !== moved[i].id && s.locked)) return false;
  moved.forEach((s, i) => rank.set(s.id, slots[i]));
  for (const [iid, r] of rank) if (doc.items[iid].z !== r) doc.items[iid].z = r;
  return true;
}

export type StackMove = 'forward' | 'backward' | 'front' | 'back';

/**
 * Moves items within the one stacking order shared by shapes, wires and
 * parts. Front / back move the whole selection to an end (keeping its
 * internal order); forward / backward step each selected item past the next
 * unselected item it overlaps (or simply the next one when nothing overlaps).
 * Locked items are fixed anchors: a move that would cross one is refused and
 * their z is left untouched. Otherwise every item's z is rewritten to its
 * rank. Returns false when nothing moved.
 */
export function restackItems(doc: CircuitDoc, ids: Iterable<string>, dir: StackMove): boolean {
  const sel = new Set(
    [...ids].filter((id) => doc.items[id] && doc.items[id].type !== 'junction' && !doc.items[id].locked),
  );
  if (!sel.size) return false;
  const rank = drawOrder(doc);
  let order = Object.values(doc.items)
    .filter((i) => i.type !== 'junction')
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
    .map((i) => i.id);
  const before = order.join();
  const initial = [...order];
  const lockedAt = new Map<string, number>();
  order.forEach((id, i) => doc.items[id].locked && lockedAt.set(id, i));
  if (dir === 'front') order = [...order.filter((id) => !sel.has(id)), ...order.filter((id) => sel.has(id))];
  else if (dir === 'back') order = [...order.filter((id) => sel.has(id)), ...order.filter((id) => !sel.has(id))];
  else {
    // work on the list front-to-back for 'backward' so both directions are "step towards the end"
    if (dir === 'backward') order.reverse();
    const box = new Map<string, Rect | null>();
    const bounds = (id: string) => (box.has(id) ? box.get(id)! : (box.set(id, itemBounds(doc, doc.items[id])), box.get(id)!));
    for (let i = order.length - 2; i >= 0; i--) {
      const id = order[i];
      if (!sel.has(id)) continue;
      const b = bounds(id);
      let next = -1;
      let target = -1;
      for (let j = i + 1; j < order.length; j++) {
        if (sel.has(order[j])) continue;
        // A locked item is a fixed anchor: never step across it.
        if (doc.items[order[j]].locked) break;
        if (next < 0) next = j;
        const o = bounds(order[j]);
        if (b && o && rectsIntersect(b, o)) {
          target = j;
          break;
        }
      }
      if (target < 0) target = next;
      if (target < 0) continue;
      order.splice(i, 1);
      order.splice(target, 0, id);
    }
    if (dir === 'backward') order.reverse();
  }
  // A locked item keeps its place: refuse any move that would shift one.
  for (const [id, i] of lockedAt) if (order[i] !== id) return false;
  if (order.join() === before) return false;
  if (!lockedAt.size) {
    order.forEach((id, i) => {
      if (doc.items[id].z !== i) doc.items[id].z = i;
    });
  } else {
    // Keep locked items' z untouched: permute the z slots of each unlocked
    // run (locked items split the order, and no move crosses one).
    const all = Object.values(doc.items);
    const top = Math.max(0, ...all.map((it) => it.z ?? 0)) + 1;
    const key = new Map(all.map((it, i) => [it.id, it.z ?? top + i]));
    for (let start = 0; start < order.length; ) {
      if (doc.items[order[start]].locked) {
        start++;
        continue;
      }
      let end = start;
      while (end < order.length && !doc.items[order[end]].locked) end++;
      const slots = initial.slice(start, end).map((id) => key.get(id)!);
      for (let i = start; i < end; i++) {
        const z = slots[i - start];
        if (doc.items[order[i]].z !== z) doc.items[order[i]].z = z;
      }
      start = end;
    }
  }
  return true;
}
