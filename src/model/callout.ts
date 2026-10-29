import { drawOrderCached, itemBounds } from './doc';
import { measureRich, wrapRich } from './richText';
import type { CircuitDoc, Item, Point, Rect, ShapeItem } from './types';

/** Badge radius of a numbered callout. */
export const CALLOUT_R = 12;
const GAP = 6;

export interface CalloutLayout {
  badge: { cx: number; cy: number; r: number };
  /** The note card next to the badge (absent while the note is empty), with its text as laid out (wrapped). */
  card: { x: number; y: number; w: number; h: number; tx: number; ty: number; text: string } | null;
  box: Rect;
}

/** Narrowest a callout's note can be wrapped to. */
export const CALLOUT_MIN_WRAP = 60;
/** Where a note wraps when it has no width of its own. */
export const CALLOUT_AUTO_WRAP = 280;

/** Measured notes, by text, size and width: laying a note out is text measuring, and it runs on every hit test. */
const sizes = new Map<string, { text: string; w: number; h: number }>();

/** A note's wrapped text and card size (independent of where it sits). */
function noteSize(raw: string, fs: number, set: number): { text: string; w: number; h: number } {
  const key = `${fs}|${set}|${raw}`;
  const hit = sizes.get(key);
  if (hit) return hit;
  // without a width of its own a note still wraps before it gets too wide, and hugs shorter text
  const text = wrapRich(raw, fs, 500, set || CALLOUT_AUTO_WRAP);
  const m = measureRich(text, fs, 500);
  const out = { text, w: (set || m.w) + 22, h: Math.max(2 * CALLOUT_R, m.h + 12) };
  if (sizes.size > 500) sizes.clear();
  sizes.set(key, out);
  return out;
}

/**
 * Badge and note card of a callout. The card sits beside the badge on the
 * side away from what the leader points at (so the leader never crosses
 * it); `wrapW` makes long notes wrap at that width.
 */
export function calloutLayout(s: Pick<ShapeItem, 'x' | 'y' | 'text' | 'fontSize' | 'wrapW'>, anchor?: Point | null): CalloutLayout {
  const r = CALLOUT_R;
  const badge = { cx: s.x + r, cy: s.y + r, r };
  const raw = (s.text ?? '').trim();
  if (!raw) return { badge, card: null, box: { x: s.x, y: s.y, w: 2 * r, h: 2 * r } };
  const fs = s.fontSize ?? 14;
  const set = s.wrapW && s.wrapW > 0 ? Math.max(CALLOUT_MIN_WRAP, s.wrapW) : 0;
  const { text, w, h } = noteSize(raw, fs, set);
  // the leader leaves the badge towards the anchor: put the note on the other side
  const left = !!anchor && anchor.x > badge.cx + r;
  const cx = left ? s.x - GAP - w : s.x + 2 * r + GAP;
  const card = { x: cx, y: s.y, w, h, tx: cx + 11, ty: s.y + 6 + fs * 0.92, text };
  const bx = Math.min(s.x, cx);
  return { badge, card, box: { x: bx, y: s.y, w: 2 * r + GAP + w, h: Math.max(2 * r, h) } };
}

/** Where a callout's leader line ends: on its target item (following it when it moves), else a fixed point. */
export function calloutAnchor(doc: CircuitDoc, s: ShapeItem): Point | null {
  const a = s.anchor;
  if (!a) return null;
  const t = a.id ? doc.items[a.id] : undefined;
  if (t && !t.hidden && t.type !== 'shape') {
    const b = itemBounds(doc, t);
    if (b) return { x: b.x + a.dx, y: b.y + a.dy };
  }
  return { x: a.x, y: a.y };
}

/** Anchor record for a point on (or near) an item. */
export function makeAnchor(doc: CircuitDoc, target: Item | null, p: Point): NonNullable<ShapeItem['anchor']> {
  const b = target ? itemBounds(doc, target) : null;
  if (!target || !b) return { dx: 0, dy: 0, x: p.x, y: p.y };
  return { id: target.id, dx: p.x - b.x, dy: p.y - b.y, x: p.x, y: p.y };
}

export function callouts(doc: CircuitDoc): ShapeItem[] {
  const rank = drawOrderCached(doc);
  return Object.values(doc.items)
    .filter((i): i is ShapeItem => i.type === 'shape' && i.kind === 'callout' && !i.hidden)
    .sort((a, b) => (a.step ?? 0) - (b.step ?? 0) || rank.get(a.id)! - rank.get(b.id)!);
}

/** Next free step number; callouts and presentation frames share one sequence. */
export function nextStep(doc: CircuitDoc): number {
  const steps = Object.values(doc.items).filter((i): i is ShapeItem => i.type === 'shape' && (i.kind === 'callout' || i.kind === 'frame') && !i.hidden);
  return Math.max(0, ...steps.map((c) => c.step ?? 0)) + 1;
}

/** Leader curve from the badge edge to the anchor, slightly bowed. */
export function leaderPath(from: Point, r: number, to: Point): string | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const l = Math.hypot(dx, dy);
  if (l < r + 4) return null;
  const sx = from.x + (dx / l) * (r + 2);
  const sy = from.y + (dy / l) * (r + 2);
  const bow = Math.min(28, l * 0.18);
  const cx = (sx + to.x) / 2 - (dy / l) * bow;
  const cy = (sy + to.y) / 2 + (dx / l) * bow;
  return `M${sx},${sy}Q${cx},${cy} ${to.x},${to.y}`;
}
