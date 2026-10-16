import { uid } from './doc';
import { eq, simplify } from './geometry';
import { cleanup, splitWire } from './ops';
import type { CircuitDoc, Endpoint, Point, WireAngle, WireItem, WireStyle } from './types';
import { routeLeg, routeObstacles } from './route';
import { adjustWireForMove, endpointInfo, hitWire, wirePolyline } from './wires';

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
 * Last leg of an angled wire from `from` to `to`. At 45° it is one straight
 * (horizontal / vertical) run and one diagonal; `straightFirst` picks which
 * leaves `from` first. With both ends on the grid the bend lands on it too.
 */
export function angledLeg(from: Point, to: Point, angle: Exclude<WireAngle, 'ortho'>, straightFirst: boolean): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.min(Math.abs(dx), Math.abs(dy));
  if (angle === 'any' || d < ORTHO_EPS || Math.abs(Math.abs(dx) - Math.abs(dy)) < ORTHO_EPS) return [to];
  const diag = { x: Math.sign(dx) * d, y: Math.sign(dy) * d };
  const bend = straightFirst ? { x: to.x - diag.x, y: to.y - diag.y } : { x: from.x + diag.x, y: from.y + diag.y };
  return [bend, to];
}

/** Preview polyline of an angled (45° / any angle) wire gesture: start, clicked vertices, then the live leg. */
export function buildAngledPreview(start: Point, via: Point[], end: Point, angle: Exclude<WireAngle, 'ortho'>, straightFirst: boolean): Point[] {
  const last = via.length ? via[via.length - 1] : start;
  return simplify([start, ...via, ...angledLeg(last, end, angle, straightFirst)]);
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
      let w = doc.items[t.wire] as WireItem | undefined;
      let end = t.end;
      const endAt = (x: WireItem, e: 'a' | 'b') => {
        const info = endpointInfo(doc, x[e]);
        return !!info && eq(info.pt, t.pt);
      };
      if (!w || !endAt(w, end)) {
        // resolving the start may have split this wire, handing the end to the other piece
        const moved = Object.values(doc.items).find((i): i is WireItem => i.type === 'wire' && i.id !== self && ((i.a.kind === 'free' && eq(i.a, t.pt)) || (i.b.kind === 'free' && eq(i.b, t.pt))));
        if (moved) {
          w = moved;
          end = moved.a.kind === 'free' && eq(moved.a, t.pt) ? 'a' : 'b';
        } else if (!w) return { kind: 'free', ...t.pt };
      }
      // already connected earlier in this same commit (a loop closing where it started)
      if (w[end].kind !== 'free') return w[end];
      const jid = uid('j');
      doc.items[jid] = { id: jid, type: 'junction', x: t.pt.x, y: t.pt.y, group: w.group };
      w.pts = wirePolyline(doc, w).slice(1, -1);
      w[end] = { kind: 'junction', id: jid };
      return { kind: 'junction', id: jid };
    }
    case 'wire': {
      // re-locate the wire under the point (ids may have changed after a previous split)
      const polys = new Map<string, Point[]>();
      for (const it of Object.values(doc.items)) if (it.type === 'wire' && it.id !== self && !it.hidden && !it.locked) polys.set(it.id, wirePolyline(doc, it));
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
  /** Angle of the last leg (default orthogonal); `hFirst` then means "straight run first". */
  angle?: WireAngle;
  /** Keep diagonal segments (clicked vertices may already have some): the wire is saved straight-routed. */
  straight?: boolean;
}

/**
 * Commits a wire gesture between two targets. Returns the new wire id, or
 * null when the gesture is degenerate (zero-length, or same port/junction at
 * both ends without a loop). Mirrors the Canvas commitWire behaviour.
 */
export function commitWire(doc: CircuitDoc, start: WireTarget, end: WireTarget, opts: CommitWireOptions = {}): string | null {
  const angle = opts.angle ?? 'ortho';
  const route = opts.routeGrid && angle === 'ortho' ? wireRouter(doc, start, end, opts.routeGrid) : undefined;
  const pts =
    angle === 'ortho'
      ? buildWirePreview(start.pt, opts.via ?? [], opts.hFirst ?? true, end.pt, route)
      : buildAngledPreview(start.pt, opts.via ?? [], end.pt, angle, opts.hFirst ?? true);
  if (pts.length < 2 || (pts.length === 2 && eq(pts[0], pts[1]))) return null;
  // same start and end is only fine when the wire goes somewhere and comes back (a loop)
  if (sameWireTarget(start, end) && pts.length < 4) return null;
  const a = resolveWireEndpoint(doc, start);
  const b = resolveWireEndpoint(doc, end);
  const w: WireItem = { id: uid('w'), type: 'wire', a, b, pts: pts.slice(1, -1), group: opts.group };
  if (angle !== 'ortho' || opts.straight) w.routing = 'straight';
  if (opts.style) w.style = { ...opts.style };
  doc.items[w.id] = w;
  cleanup(doc);
  return doc.items[w.id] ? w.id : null;
}

/**
 * Drags one segment of a wire's base polyline by (dx, dy). Free ends travel
 * with the segment; so does a junction at the end of the dragged segment (with
 * `baseDoc`, the document the drag started from): the solder dot comes along
 * and the other wires meeting there bend to stay connected. Ends attached to
 * pins stay put (a stub keeps the connection, inserted as an endpoint copy).
 * Mutates the document in place; the caller runs cleanup(). Returns false when
 * the wire or segment is missing.
 */
export function moveWireSegment(doc: CircuitDoc, wireId: string, base: Point[], seg: number, dx: number, dy: number, baseDoc?: CircuitDoc): boolean {
  const wire = doc.items[wireId] as WireItem | undefined;
  if (!wire || wire.type !== 'wire') return false;
  if (seg < 0 || seg >= base.length - 1) return false;
  const pts = base.map((p) => ({ ...p }));
  const jA = !!baseDoc && wire.a.kind === 'junction' && seg === 0 ? wire.a.id : null;
  const jB = !!baseDoc && wire.b.kind === 'junction' && seg === base.length - 2 ? wire.b.id : null;
  const freeA = wire.a.kind === 'free' || !!jA;
  const freeB = wire.b.kind === 'free' || !!jB;
  let s = seg;
  if (s === 0 && !freeA) {
    pts.splice(1, 0, { ...pts[0] });
    s = 1;
  }
  if (s === pts.length - 2 && !freeB) pts.splice(pts.length - 1, 0, { ...pts[pts.length - 1] });
  pts[s] = { x: pts[s].x + dx, y: pts[s].y + dy };
  pts[s + 1] = { x: pts[s + 1].x + dx, y: pts[s + 1].y + dy };
  const full = simplify(pts);
  if (wire.a.kind === 'free') wire.a = { kind: 'free', ...full[0] };
  if (wire.b.kind === 'free') wire.b = { kind: 'free', ...full[full.length - 1] };
  wire.pts = full.slice(1, -1);
  for (const j of new Set([jA, jB])) if (j) moveJunction(doc, baseDoc!, j, dx, dy, wireId);
  return true;
}

/** Moves a junction by (dx, dy) from where it was in `baseDoc`; the other wires meeting there bend to follow. */
function moveJunction(doc: CircuitDoc, baseDoc: CircuitDoc, id: string, dx: number, dy: number, except: string) {
  const bj = baseDoc.items[id];
  const j = doc.items[id];
  if (bj?.type !== 'junction' || j?.type !== 'junction') return;
  j.x = bj.x + dx;
  j.y = bj.y + dy;
  const d = { x: dx, y: dy };
  for (const bw of Object.values(baseDoc.items)) {
    if (bw.type !== 'wire' || bw.id === except) continue;
    const atA = bw.a.kind === 'junction' && bw.a.id === id;
    const atB = bw.b.kind === 'junction' && bw.b.id === id;
    if (!atA && !atB) continue;
    const w = doc.items[bw.id] as WireItem | undefined;
    if (!w) continue;
    const adj = adjustWireForMove(wirePolyline(baseDoc, bw), atA ? d : null, atB ? d : null, bw.routing !== 'straight');
    w.pts = simplify(adj).slice(1, -1);
  }
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
