import { uid } from './doc';
import { eq, simplify } from './geometry';
import { cleanup, splitWire } from './ops';
import type { CircuitDoc, Endpoint, Point, WireItem, WireStyle } from './types';
import { routeLeg, routeObstacles } from './route';
import { hitWire, wirePolyline } from './wires';

/* ------------------------------------------------------------------ */
/* Wire gesture targets (UI-agnostic copy of the Canvas Target type)   */
/* ------------------------------------------------------------------ */

export type WireTarget =
  | { kind: 'port'; comp: string; port: string; pt: Point; dir: Point }
  | { kind: 'junction'; id: string; pt: Point }
  | { kind: 'wireEnd'; wire: string; end: 'a' | 'b'; pt: Point }
  | { kind: 'wire'; wire: string; seg: number; pt: Point }
  | { kind: 'grid'; pt: Point };

const ORTHO_EPS = 0.01;

/** Port/junction targets that refer to the same connection point. */
export function sameWireTarget(a: WireTarget, b: WireTarget): boolean {
  return (
    (a.kind === 'port' && b.kind === 'port' && a.comp === b.comp && a.port === b.port) ||
    (a.kind === 'junction' && b.kind === 'junction' && a.id === b.id)
  );
}

/** Port/junction target matching an existing endpoint (for same-target checks). */
export function wireTargetForEndpoint(ep: Endpoint): WireTarget {
  return ep.kind === 'port'
    ? { kind: 'port', comp: ep.comp, port: ep.port, pt: { x: 0, y: 0 }, dir: { x: 0, y: 0 } }
    : ep.kind === 'junction'
      ? { kind: 'junction', id: ep.id, pt: { x: 0, y: 0 } }
      : { kind: 'grid', pt: { x: ep.x, y: ep.y } };
}

/**
 * Routes the live leg of a wire gesture (from the last clicked point to the
 * cursor); `first` is true while no vertex has been clicked yet. Returns null
 * to fall back to a plain L-shape.
 */
export type LegRouter = (from: Point, to: Point, hFirst: boolean, prevDir: Point | undefined, first: boolean) => Point[] | null;

/**
 * Orthogonal preview polyline for a wire gesture: the start point, any
 * clicked vertices, then the live leg to the cursor — routed around
 * instances by `route` when given, else one elbow keeping it square.
 */
export function buildWirePreview(start: Point, via: Point[], hFirst: boolean, end: Point, route?: LegRouter): Point[] {
  const last = via.length ? via[via.length - 1] : start;
  const out = [start, ...via];
  const prev = out.length >= 2 ? out[out.length - 2] : null;
  const prevDir = prev ? { x: Math.sign(last.x - prev.x), y: Math.sign(last.y - prev.y) } : undefined;
  const routed = route && !eq(last, end) ? route(last, end, hFirst, prevDir, !via.length) : null;
  if (routed && routed.length >= 2) return simplify([...out, ...routed.slice(1)]);
  if (Math.abs(last.x - end.x) > ORTHO_EPS && Math.abs(last.y - end.y) > ORTHO_EPS) {
    let elbow = hFirst ? { x: end.x, y: last.y } : { x: last.x, y: end.y };
    // never run back over the leg just drawn: take the other elbow instead
    if (prev && (elbow.x - last.x) * (last.x - prev.x) + (elbow.y - last.y) * (last.y - prev.y) < 0) {
      elbow = hFirst ? { x: last.x, y: end.y } : { x: end.x, y: last.y };
    }
    out.push(elbow);
  }
  out.push(end);
  return simplify(out);
}

/**
 * Leg router for a wire gesture between two targets: avoids instance bodies,
 * unrelated terminals and existing wires, leaving / entering pins along
 * their lead. Build it from the document as it was when the gesture started.
 */
export function wireRouter(doc: CircuitDoc, start: WireTarget, end: WireTarget, grid: number, obs = routeObstacles(doc)): LegRouter {
  const startDir = start.kind === 'port' ? start.dir : undefined;
  const endDir = end.kind === 'port' ? end.dir : undefined;
  return (from, to, hFirst, prevDir, first) => routeLeg(obs, from, to, { grid, hFirst, prevDir, startDir: first ? startDir : undefined, endDir });
}

/**
 * Turns a gesture target into a wire endpoint; `self` is a wire being
 * reconnected, which must never be split onto itself. Mutates the doc
 * (may create a junction and split a wire) like the Canvas gesture does.
 */
export function resolveWireEndpoint(doc: CircuitDoc, t: WireTarget, self?: string): Endpoint {
  switch (t.kind) {
    case 'port':
      return { kind: 'port', comp: t.comp, port: t.port };
    case 'junction':
      return { kind: 'junction', id: t.id };
    case 'wireEnd': {
      const w = doc.items[t.wire] as WireItem | undefined;
      if (!w) return { kind: 'free', ...t.pt };
      // already connected earlier in this same commit (a loop closing where it started)
      if (w[t.end].kind !== 'free') return w[t.end];
      const jid = uid('j');
      doc.items[jid] = { id: jid, type: 'junction', x: t.pt.x, y: t.pt.y, group: w.group };
      w.pts = wirePolyline(doc, w).slice(1, -1);
      w[t.end] = { kind: 'junction', id: jid };
      return { kind: 'junction', id: jid };
    }
    case 'wire': {
      // re-locate the wire under the point (ids may have changed after a previous split)
      const polys = new Map<string, Point[]>();
      for (const it of Object.values(doc.items)) if (it.type === 'wire' && it.id !== self) polys.set(it.id, wirePolyline(doc, it));
      const hit = hitWire(polys, t.pt, 0.5);
      if (!hit) return { kind: 'free', ...t.pt };
      const pts = polys.get(hit.wire)!;
      if (eq(pts[0], t.pt) || eq(pts[pts.length - 1], t.pt)) {
        const w = doc.items[hit.wire] as WireItem;
        const end = eq(pts[0], t.pt) ? 'a' : 'b';
        if (w[end].kind !== 'free') return w[end];
        return resolveWireEndpoint(doc, { kind: 'wireEnd', wire: w.id, end, pt: t.pt });
      }
      return { kind: 'junction', id: splitWire(doc, hit.wire, hit.seg, t.pt) };
    }
    case 'grid':
      return { kind: 'free', ...t.pt };
  }
}

export interface CommitWireOptions {
  /** Clicked intermediate vertices (elbows of the preview). */
  via?: Point[];
  hFirst?: boolean;
  group?: string;
  style?: Partial<WireStyle>;
  /** Route the last leg around instances (pass the grid to route on). */
  routeGrid?: number;
}

/**
 * Commits a wire gesture between two targets. Returns the new wire id, or
 * null when the gesture is degenerate (zero-length, or same port/junction at
 * both ends without a loop). Mirrors the Canvas commitWire behaviour.
 */
export function commitWire(doc: CircuitDoc, start: WireTarget, end: WireTarget, opts: CommitWireOptions = {}): string | null {
  const route = opts.routeGrid ? wireRouter(doc, start, end, opts.routeGrid) : undefined;
  const pts = buildWirePreview(start.pt, opts.via ?? [], opts.hFirst ?? true, end.pt, route);
  if (pts.length < 2 || (pts.length === 2 && eq(pts[0], pts[1]))) return null;
  // same start and end is only fine when the wire goes somewhere and comes back (a loop)
  if (sameWireTarget(start, end) && pts.length < 4) return null;
  const a = resolveWireEndpoint(doc, start);
  const b = resolveWireEndpoint(doc, end);
  const w: WireItem = { id: uid('w'), type: 'wire', a, b, pts: pts.slice(1, -1), group: opts.group };
  if (opts.style) w.style = { ...opts.style };
  doc.items[w.id] = w;
  cleanup(doc);
  return doc.items[w.id] ? w.id : null;
}

/**
 * Drags one segment of a wire's base polyline by (dx, dy). Attached ends stay
 * put (a stub keeps the connection, inserted as an endpoint copy); free ends
 * travel with the segment. Mutates the wire in place; the caller runs
 * cleanup(). Returns false when the wire or segment is missing.
 */
export function moveWireSegment(doc: CircuitDoc, wireId: string, base: Point[], seg: number, dx: number, dy: number): boolean {
  const wire = doc.items[wireId] as WireItem | undefined;
  if (!wire || wire.type !== 'wire') return false;
  if (seg < 0 || seg >= base.length - 1) return false;
  const pts = base.map((p) => ({ ...p }));
  // attached ends stay put (a stub keeps the connection); free ends travel with the segment
  const freeA = wire.a.kind === 'free';
  const freeB = wire.b.kind === 'free';
  let s = seg;
  if (s === 0 && !freeA) {
    pts.splice(1, 0, { ...pts[0] });
    s = 1;
  }
  if (s === pts.length - 2 && !freeB) pts.splice(pts.length - 1, 0, { ...pts[pts.length - 1] });
  pts[s] = { x: pts[s].x + dx, y: pts[s].y + dy };
  pts[s + 1] = { x: pts[s + 1].x + dx, y: pts[s + 1].y + dy };
  const full = simplify(pts);
  if (freeA) wire.a = { kind: 'free', ...full[0] };
  if (freeB) wire.b = { kind: 'free', ...full[full.length - 1] };
  wire.pts = full.slice(1, -1);
  return true;
}

/**
 * Reconnects one end of a wire to a new target (endpoint drag release).
 * Bakes the exact route shown while dragging so the wire doesn't jump, then
 * resolves the target and cleans up. Returns false when nothing changed
 * (missing wire, or dropping onto the wire's own other end).
 */
export function reconnectWireEnd(doc: CircuitDoc, wireId: string, end: 'a' | 'b', target: WireTarget): boolean {
  const wire = doc.items[wireId] as WireItem | undefined;
  if (!wire || wire.type !== 'wire') return false;
  const other = end === 'a' ? wire.b : wire.a;
  // dropping onto the wire's own other end would make a zero-length loop
  if (sameWireTarget(target, wireTargetForEndpoint(other))) return false;
  // bake the exact route shown while dragging, so the wire doesn't jump on release
  const shown = wirePolyline(doc, { ...wire, [end]: { kind: 'free', ...target.pt } });
  wire[end] = resolveWireEndpoint(doc, target, wireId);
  wire.pts = shown.slice(1, -1);
  cleanup(doc);
  return true;
}
