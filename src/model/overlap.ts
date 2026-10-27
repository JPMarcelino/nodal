import { produce } from 'immer';
import { uid } from './doc';
import { eq, simplify } from './geometry';
import { cleanup, splitWire } from './ops';
import type { CircuitDoc, Endpoint, Point, WireItem } from './types';
import { wirePolyline } from './wires';

/*
 * Two wires never run on top of each other: where an edit leaves part of a
 * wire lying along another one, that stretch is taken out of the wire that
 * changed and what is left of it joins the other wire with junctions. What
 * looks connected is connected, and nothing is drawn twice.
 */

const EPS = 0.01;
const sub = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;

interface Overlap {
  /** Wire to cut, and which of its segments overlaps. */
  wire: string;
  seg: number;
  /** Ends of the shared stretch, in the cut wire's direction. */
  p: Point;
  q: Point;
  /** The wire it lies on. */
  other: string;
}

/** Shared stretch of two segments, if they lie on one line and overlap by more than a point. */
function segOverlap(a1: Point, a2: Point, b1: Point, b2: Point): [Point, Point] | null {
  const d = sub(a2, a1);
  const len2 = dot(d, d);
  if (len2 < EPS) return null;
  const len = Math.sqrt(len2);
  if (Math.abs(cross(d, sub(b1, a1))) / len > EPS || Math.abs(cross(d, sub(b2, a1))) / len > EPS) return null;
  const t = (p: Point) => dot(sub(p, a1), d) / len2;
  const lo = Math.max(0, Math.min(t(b1), t(b2)));
  const hi = Math.min(1, Math.max(t(b1), t(b2)));
  if ((hi - lo) * len <= EPS) return null;
  const at = (k: number) => ({ x: Math.round((a1.x + d.x * k) * 1000) / 1000, y: Math.round((a1.y + d.y * k) * 1000) / 1000 });
  return [at(lo), at(hi)];
}

/**
 * Two wires on different pins of the same part: when a move or turn lays one
 * lead along the other, joining them would short the part, so they are left
 * as they are (they only look connected until rerouted).
 */
function leadsOfOnePart(w: WireItem, o: WireItem): boolean {
  for (const p of [w.a, w.b]) {
    if (p.kind !== 'port') continue;
    for (const q of [o.a, o.b]) if (q.kind === 'port' && q.comp === p.comp && q.port !== p.port) return true;
  }
  return false;
}

function findOverlap(doc: CircuitDoc, changed: Set<string>): Overlap | null {
  const wires = Object.values(doc.items).filter((i): i is WireItem => i.type === 'wire' && !i.hidden);
  const polys = new Map(wires.map((w) => [w.id, wirePolyline(doc, w)]));
  for (const w of wires) {
    if (!changed.has(w.id)) continue;
    const pw = polys.get(w.id)!;
    for (const o of wires) {
      if (o.id === w.id || leadsOfOnePart(w, o)) continue;
      // a locked wire is an anchor: never cut it, and never let it be the run
      // another wire is folded onto (that would edit it just the same)
      if (w.locked || o.locked) continue;
      const po = polys.get(o.id)!;
      for (let i = 0; i < pw.length - 1; i++) {
        for (let j = 0; j < po.length - 1; j++) {
          const hit = segOverlap(pw[i], pw[i + 1], po[j], po[j + 1]);
          // when both changed, the later one gives way
          if (hit) return changed.has(o.id) && o.id > w.id ? { wire: o.id, seg: j, ...orient(po[j], po[j + 1], hit), other: w.id } : { wire: w.id, seg: i, p: hit[0], q: hit[1], other: o.id };
        }
      }
    }
  }
  return null;
}

/** The overlap's ends ordered along segment a1 → a2. */
function orient(a1: Point, a2: Point, [p, q]: [Point, Point]) {
  const d = sub(a2, a1);
  return dot(sub(p, a1), d) <= dot(sub(q, a1), d) ? { p, q } : { p: q, q: p };
}

/**
 * Makes `pt` (on wire `onto`, or on what it has been split into) a connection
 * point and returns the endpoint other wires should use there. `prefer` is the
 * cut wire's own endpoint at that spot, kept when it is a pin or junction.
 */
function connectionAt(doc: CircuitDoc, pt: Point, onto: string[], prefer: Endpoint | null): Endpoint {
  for (const id of onto) {
    const w = doc.items[id];
    if (w?.type !== 'wire') continue;
    const full = wirePolyline(doc, w);
    for (const end of ['a', 'b'] as const) {
      if (!eq(end === 'a' ? full[0] : full[full.length - 1], pt)) continue;
      const ep = w[end];
      if (ep.kind !== 'free') return ep;
      if (prefer && prefer.kind !== 'free') return (w[end] = prefer);
      const jid = uid('j');
      doc.items[jid] = { id: jid, type: 'junction', x: pt.x, y: pt.y, group: w.group };
      return (w[end] = { kind: 'junction', id: jid });
    }
    for (let i = 0; i < full.length - 1; i++) {
      if (!onSegment(pt, full[i], full[i + 1])) continue;
      const jid = prefer?.kind === 'junction' ? prefer.id : uid('j');
      splitWire(doc, id, i, pt, jid);
      if (prefer?.kind === 'port') {
        // the pin itself joins the two halves
        delete doc.items[jid];
        for (const x of Object.values(doc.items)) {
          if (x.type !== 'wire') continue;
          if (x.a.kind === 'junction' && x.a.id === jid) x.a = prefer;
          if (x.b.kind === 'junction' && x.b.id === jid) x.b = prefer;
        }
        return prefer;
      }
      return { kind: 'junction', id: jid };
    }
  }
  return prefer ?? { kind: 'free', ...pt };
}

function onSegment(p: Point, a: Point, b: Point) {
  const d = sub(b, a);
  const len2 = dot(d, d);
  if (len2 < EPS) return eq(p, a);
  const t = dot(sub(p, a), d) / len2;
  return t > -EPS && t < 1 + EPS && Math.abs(cross(d, sub(p, a))) / Math.sqrt(len2) <= EPS;
}

/** Ids of the wire pieces `id` may have been split into (same net run, created during this pass). */
const piecesOf = (doc: CircuitDoc, id: string, before: Set<string>) => [id, ...Object.keys(doc.items).filter((k) => !before.has(k) && doc.items[k].type === 'wire')];

/** Takes the shared stretch out of the cut wire and joins what is left to the other wire. */
function resolve(doc: CircuitDoc, o: Overlap, changed: Set<string>) {
  const w = doc.items[o.wire] as WireItem;
  const full = wirePolyline(doc, w);
  const startsAtP = eq(full[0], o.p) && o.seg === 0;
  const endsAtQ = eq(full[full.length - 1], o.q) && o.seg === full.length - 2;
  const before = startsAtP ? null : [...full.slice(0, o.seg + 1), o.p];
  const after = endsAtQ ? null : [o.q, ...full.slice(o.seg + 1)];
  const known = new Set(Object.keys(doc.items));
  const epP = connectionAt(doc, o.p, piecesOf(doc, o.other, known), startsAtP ? w.a : null);
  const epQ = connectionAt(doc, o.q, piecesOf(doc, o.other, known), endsAtQ ? w.b : null);
  const origB = w.b;
  if (before && simplify(before).length >= 2) {
    w.b = epP;
    w.pts = simplify(before).slice(1, -1);
    if (after && simplify(after).length >= 2) {
      const w2: WireItem = { ...(JSON.parse(JSON.stringify(w)) as WireItem), id: uid('w'), a: epQ, b: origB, pts: simplify(after).slice(1, -1) };
      delete w2.label;
      doc.items[w2.id] = w2;
      changed.add(w2.id);
    }
  } else if (after && simplify(after).length >= 2) {
    w.a = epQ;
    w.pts = simplify(after).slice(1, -1);
  } else {
    delete doc.items[w.id];
  }
}

/** Wires that are new in `next` or changed since `prev`. */
function changedWires(prev: CircuitDoc, next: CircuitDoc): Set<string> {
  const out = new Set<string>();
  for (const it of Object.values(next.items)) if (it.type === 'wire' && prev.items[it.id] !== it) out.add(it.id);
  // wires whose shape follows a moved part or junction change without being edited themselves
  for (const it of Object.values(next.items)) {
    if (it.type !== 'wire' || out.has(it.id)) continue;
    for (const ep of [it.a, it.b]) {
      const owner = ep.kind === 'port' ? ep.comp : ep.kind === 'junction' ? ep.id : null;
      if (owner && prev.items[owner] !== next.items[owner]) out.add(it.id);
    }
  }
  return out;
}

/** Removes overlaps an edit created between wires. Returns `next` unchanged when there are none. */
export function resolveWireOverlaps(prev: CircuitDoc, next: CircuitDoc): CircuitDoc {
  const changed = changedWires(prev, next);
  if (!changed.size || !findOverlap(next, changed)) return next;
  return produce(next, (d) => {
    const doc = d as CircuitDoc;
    for (let guard = 0; guard < 50; guard++) {
      const o = findOverlap(doc, changed);
      if (!o) break;
      resolve(doc, o, changed);
    }
    cleanup(doc);
  });
}
