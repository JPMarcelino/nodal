import { itemBounds } from './doc';
import { measureRich } from './richText';
import type { CircuitDoc, Item, Point, Rect, ShapeItem } from './types';

/** Badge radius of a numbered callout. */
export const CALLOUT_R = 12;
const GAP = 6;

export interface CalloutLayout {
  badge: { cx: number; cy: number; r: number };
  /** The note card next to the badge (absent while the note is empty). */
  card: { x: number; y: number; w: number; h: number; tx: number; ty: number } | null;
  box: Rect;
}

export function calloutLayout(s: Pick<ShapeItem, 'x' | 'y' | 'text' | 'fontSize'>): CalloutLayout {
  const r = CALLOUT_R;
  const badge = { cx: s.x + r, cy: s.y + r, r };
  const text = (s.text ?? '').trim();
  if (!text) return { badge, card: null, box: { x: s.x, y: s.y, w: 2 * r, h: 2 * r } };
  const fs = s.fontSize ?? 14;
  const m = measureRich(text, fs, 500);
  const w = m.w + 22;
  const h = Math.max(2 * r, m.h + 12);
  const card = { x: s.x + 2 * r + GAP, y: s.y, w, h, tx: s.x + 2 * r + GAP + 11, ty: s.y + 6 + fs * 0.92 };
  return { badge, card, box: { x: s.x, y: s.y, w: 2 * r + GAP + w, h: Math.max(2 * r, h) } };
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
  return Object.values(doc.items)
    .filter((i): i is ShapeItem => i.type === 'shape' && i.kind === 'callout' && !i.hidden)
    .sort((a, b) => (a.step ?? 0) - (b.step ?? 0) || a.z - b.z);
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
