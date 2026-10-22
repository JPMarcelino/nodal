import { componentBounds, pointInRect, rectsIntersect, segmentIntersectsRect, sideVector, toWorld } from './geometry';
import { instanceSymbol } from './registry';
import type { CircuitDoc, ComponentItem, Point, Rect } from './types';
import { portPosition, wirePolyline } from './wires';

export type QuickDir = 'left' | 'right' | 'up' | 'down';

export const QUICK_DIRS: Record<QuickDir, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};

/** Where a chained copy of a part goes, and how it is wired back to it. */
export interface QuickAddPlan {
  rot: ComponentItem['rot'];
  x: number;
  y: number;
  /** Pin of the source part the wire starts on, and its position / outward direction. */
  from: { port: string; pt: Point; dir: Point };
  /** Pin of the new part facing back toward the source. */
  to: { port: string; pt: Point; dir: Point };
  /** The straight run between the pins crosses another part: route the wire around it. */
  route: boolean;
}

/** Wire length between the two pins, in grid steps; each blocked try steps this much further out. */
const GAP_STEPS = 2;
const MAX_TRIES = 12;

const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const sameDir = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const inset = (r: Rect, by: number): Rect => ({ x: r.x + by, y: r.y + by, w: Math.max(0, r.w - 2 * by), h: Math.max(0, r.h - 2 * by) });

/**
 * Plans "quick add": a copy of `src` one short wire away in direction `d`.
 * The source pin is the one facing furthest that way (never one facing back);
 * the copy keeps the rotation when one of its pins faces back toward the
 * source, else it is turned until one does, and sits so that pin is on the
 * source pin's grid line. A spot overlapping another part, wire or junction
 * is skipped by stepping further out. Returns a short reason when it can't.
 */
export function planQuickAdd(doc: CircuitDoc, src: ComponentItem, d: Point, grid: number): QuickAddPlan | string {
  const def = instanceSymbol(doc, src);
  const wired = new Set<string>();
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire') continue;
    for (const ep of [it.a, it.b]) if (ep.kind === 'port' && ep.comp === src.id) wired.add(ep.port);
  }
  // pick the pin facing that way (a free one first), else one beside it; then the one furthest out
  let from: QuickAddPlan['from'] | null = null;
  let best = -Infinity;
  for (const p of def.ports) {
    const at = portPosition(doc, src, p.id);
    if (!at) continue;
    const facing = dot(at.dir, d);
    if (facing < 0) continue;
    const score = facing * 1e6 + (wired.has(p.id) ? 0 : 1e5) + dot({ x: at.pt.x - src.x, y: at.pt.y - src.y }, d) * 100 + (at.pt.x + at.pt.y) * 1e-3;
    if (score > best) {
      best = score;
      from = { port: p.id, pt: at.pt, dir: at.dir };
    }
  }
  if (!from) return 'No pin faces that way';

  // keep the rotation if a pin faces back, else turn (a quarter first, then half way round)
  const back = { x: -d.x, y: -d.y };
  let rot: ComponentItem['rot'] | null = null;
  type BackPin = { port: string; off: Point; dir: Point };
  let to: BackPin | null = null;
  for (const turn of [0, 90, 270, 180]) {
    const r = ((src.rot + turn) % 360) as ComponentItem['rot'];
    const pose = { x: 0, y: 0, rot: r, flipX: src.flipX };
    let pick: BackPin | null = null;
    for (const p of def.ports) {
      const dir = sideVector(pose, p.side);
      if (!sameDir(dir, back)) continue;
      const off = toWorld(pose, def, p.x, p.y);
      // the pin furthest back (nearest the source), first in pin order on a tie
      if (!pick || dot(off, d) < dot(pick.off, d)) pick = { port: p.id, off, dir };
    }
    if (pick) {
      rot = r;
      to = pick;
      break;
    }
  }
  if (rot === null || !to) return 'The part has no pin that could face back';

  // obstacles on the page: other parts' bodies, wires and junctions
  const bodies: { id: string; r: Rect }[] = [];
  const wires: Point[][] = [];
  const dots: Point[] = [];
  for (const it of Object.values(doc.items)) {
    if (it.hidden) continue;
    if (it.type === 'component') bodies.push({ id: it.id, r: componentBounds(it, instanceSymbol(doc, it)) });
    else if (it.type === 'wire') wires.push(wirePolyline(doc, it));
    else if (it.type === 'junction') dots.push({ x: it.x, y: it.y });
  }
  const free = (r: Rect) =>
    !bodies.some((b) => rectsIntersect(b.r, r)) && !dots.some((p) => pointInRect(p, r)) && !wires.some((pts) => pts.some((q, i) => i > 0 && segmentIntersectsRect(pts[i - 1], q, r)));

  for (let k = 1; k <= MAX_TRIES; k++) {
    const len = GAP_STEPS * grid * k;
    const q = { x: from.pt.x + d.x * len, y: from.pt.y + d.y * len };
    const x = q.x - to.off.x;
    const y = q.y - to.off.y;
    const body = componentBounds({ ...src, x, y, rot }, def);
    if (!free(body)) continue;
    // a straight run through another part is routed round it instead
    const start = from.pt;
    const route = bodies.some((b) => b.id !== src.id && segmentIntersectsRect(start, q, inset(b.r, 0.5)));
    return { rot, x, y, from, to: { port: to.port, pt: q, dir: to.dir }, route };
  }
  return 'No free spot that way';
}

/** Look and user-set details a chained copy carries over (as duplicating would). */
const CARRIED = ['value', 'showRef', 'showValue', 'closed', 'scale', 'color', 'fill', 'fillOpacity', 'lineWidth', 'dash', 'labelColor', 'refStyle', 'valueStyle'] as const;
/** Label placement: only meaningful while the copy keeps the source's rotation. */
const CARRIED_LABELS = ['labelSpot', 'labelDx', 'labelDy', 'valueDx', 'valueDy'] as const;

/**
 * Fields of `src` a quick-add copy takes on: its value, fields (footprint,
 * part number…), look and label styling. Never its identity: the id,
 * reference designator, group, lock, page or "do not populate" flag.
 */
export function quickAddFields(src: ComponentItem, rot: ComponentItem['rot']): Partial<ComponentItem> {
  const out: Record<string, unknown> = {};
  const keys: readonly (keyof ComponentItem)[] = rot === src.rot ? [...CARRIED, ...CARRIED_LABELS] : CARRIED;
  for (const k of keys) if (src[k] !== undefined) out[k] = structuredClone(src[k]);
  const props = { ...src.props };
  delete props.dnp;
  out.props = props;
  return out as Partial<ComponentItem>;
}
