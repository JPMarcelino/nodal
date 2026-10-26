import { componentBounds, segmentIntersectsRect, sideVector, toWorld } from './geometry';
import { measureRich, upperText } from './richText';
import type { ComponentItem, LabelSpotName, LabelStyle, Rect, SymbolDef } from './types';

/* ------------------------------------------------------------------ */
/* Part labels (ref / value)                                           */
/* ------------------------------------------------------------------ */

const LABEL_SYMBOLS = /^$/;

/** Offset of each label: the reference uses labelDx/Dy, the value its own offset or else the reference's. */
export const labelOffsets = (c: ComponentItem) => ({
  ref: { x: c.labelDx ?? 0, y: c.labelDy ?? 0 },
  value: { x: c.valueDx ?? c.labelDx ?? 0, y: c.valueDy ?? c.labelDy ?? 0 },
});

export function labelLayout(c: ComponentItem, def: SymbolDef) {
  const L = baseLabelLayout(c, def);
  const o = labelOffsets(c);
  const shift = <T extends { x: number; y: number } | null>(p: T, d: { x: number; y: number }): T => (p ? { ...p, x: p.x + d.x, y: p.y + d.y } : p);
  return { ...L, ref: shift(L.ref, o.ref), value: shift(L.value, o.value) };
}

/** Default label spots, before any dragging. */
function baseLabelLayout(c: ComponentItem, def: SymbolDef) {
  const b = componentBounds(c, def);
  const dx = 0;
  const dy = 0;
  if (def.valueIsLabel) {
    if (LABEL_SYMBOLS.test(def.id)) {
      // text sits inside the flag body, away from the connection point
      return { value: { x: b.x + b.w / 2 + dx, y: b.y + b.h / 2 + 4 + dy, anchor: 'middle' as const }, ref: null, inside: true };
    }
    const port = def.ports[0];
    const pd = port ? sideVector(c, port.side) : null;
    const dir = pd ? { x: -pd.x, y: -pd.y } : { x: 0, y: -1 };
    if (dir.y < 0) return { value: { x: c.x + dx, y: b.y - 4 + dy, anchor: 'middle' as const }, ref: null };
    if (dir.y > 0) return { value: { x: c.x + dx, y: b.y + b.h + 13 + dy, anchor: 'middle' as const }, ref: null };
    if (dir.x > 0) return { value: { x: b.x + b.w + 4 + dx, y: c.y + 4 + dy, anchor: 'start' as const }, ref: null };
    return { value: { x: b.x - 4 + dx, y: c.y + 4 + dy, anchor: 'end' as const }, ref: null };
  }
  const spots = labelCandidates(b, c);
  if (c.labelSpot && spots[c.labelSpot]) return spots[c.labelSpot];
  // dragged labels are offsets from this fixed spot (see frozenLabelOffsets)
  if (hasLabelOffsets(c)) return b.w >= b.h ? spots.split : spots.right;
  // otherwise use the first spot that keeps both labels off the wires leaving the pins
  const leads = def.ports.map((p) => {
    const at = toWorld(c, def, p.x, p.y);
    const v = sideVector(c, p.side);
    return [at, { x: at.x + v.x * LEAD_CLEARANCE, y: at.y + v.y * LEAD_CLEARANCE }] as const;
  });
  const hits = (spot: LabelSpot) =>
    labelRects(spot, c).reduce((n, r) => n + leads.filter(([a, z]) => segmentIntersectsRect(a, z, r)).length, 0);
  const sides = new Set(leads.map(([a, z]) => `${Math.sign(z.x - a.x)},${Math.sign(z.y - a.y)}`));
  const order: (keyof typeof spots)[] =
    sides.size === 4
      ? // chips with pins all round: keep the labels off the body, at a corner
        ['topRight', 'topLeft', 'bottomRight', 'split', 'right', 'left', 'above', 'below']
      : b.w >= b.h
      ? ['split', 'right', 'topRight', 'above', 'below', 'left', 'bottomRight', 'topLeft']
      : ['right', 'left', 'split', 'topRight', 'bottomRight', 'above', 'below', 'topLeft'];
  let best = spots[order[0]];
  let bestHits = Infinity;
  for (const k of order) {
    const n = hits(spots[k]);
    if (n < bestHits) [best, bestHits] = [spots[k], n];
    if (!n) break;
  }
  return best;
}

const hasLabelOffsets = (c: ComponentItem) => c.labelDx != null || c.labelDy != null || c.valueDx != null || c.valueDy != null;

/** Offsets that keep both labels exactly where they are drawn now; written when a label is first dragged. */
export function frozenLabelOffsets(c: ComponentItem, def: SymbolDef) {
  const o = labelOffsets(c);
  if (hasLabelOffsets(c) || def.valueIsLabel || c.labelSpot) return { labelDx: o.ref.x, labelDy: o.ref.y, valueDx: o.value.x, valueDy: o.value.y };
  const auto = baseLabelLayout(c, def);
  const b = componentBounds(c, def);
  const spots = labelCandidates(b, c);
  const fixed = b.w >= b.h ? spots.split : spots.right;
  const d = (p: { x: number; y: number } | null, q: LabelPos) => (p ? { x: p.x - q.x, y: p.y - q.y } : { x: 0, y: 0 });
  const r = d(auto.ref, fixed.ref);
  const v = d(auto.value, fixed.value);
  return { labelDx: r.x, labelDy: r.y, valueDx: v.x, valueDy: v.y };
}

/** How far out from a pin its wire is kept clear of labels. */
const LEAD_CLEARANCE = 30;

export interface LabelPos {
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
}
interface LabelSpot {
  ref: LabelPos;
  value: LabelPos;
}

/** Spots the reference and value can take around a part's bounds. */
function labelCandidates(b: Rect, c: ComponentItem): Record<LabelSpotName, LabelSpot> {
  const r = b.x + b.w + 6;
  const l = b.x - 6;
  const both = (x: number, y1: number, y2: number, anchor: LabelPos['anchor']): LabelSpot => ({ ref: { x, y: y1, anchor }, value: { x, y: y2, anchor } });
  return {
    split: { ref: { x: c.x, y: b.y - 5, anchor: 'middle' }, value: { x: c.x, y: b.y + b.h + 14, anchor: 'middle' } },
    right: both(r, c.y - 2, c.y + 12, 'start'),
    left: both(l, c.y - 2, c.y + 12, 'end'),
    above: both(c.x, b.y - 18, b.y - 5, 'middle'),
    below: both(c.x, b.y + b.h + 14, b.y + b.h + 27, 'middle'),
    topRight: both(b.x + b.w + 2, b.y - 18, b.y - 5, 'start'),
    bottomRight: both(b.x + b.w + 2, b.y + b.h + 14, b.y + b.h + 27, 'start'),
    topLeft: both(b.x - 2, b.y - 18, b.y - 5, 'end'),
    bottomLeft: both(b.x - 2, b.y + b.h + 14, b.y + b.h + 27, 'end'),
  };
}

/** Approximate boxes of the visible labels at a spot. */
function labelRects(spot: LabelSpot, c: ComponentItem): Rect[] {
  const out: Rect[] = [];
  for (const which of ['ref', 'value'] as const) {
    if (!(which === 'ref' ? c.showRef && c.ref : c.showValue && c.value)) continue;
    const look = labelLook(c, which);
    out.push(labelBox(spot[which], look));
  }
  return out;
}

/** Text, size, weight and style a part label is drawn with. */
export function labelLook(c: ComponentItem, which: 'ref' | 'value', def?: Pick<SymbolDef, 'valueIsLabel'>) {
  const st: LabelStyle = (which === 'ref' ? c.refStyle : c.valueStyle) ?? {};
  const raw = which === 'ref' ? c.ref : c.value;
  let text = raw ? `${st.prefix ?? ''}${raw}${st.suffix ?? ''}` : raw;
  if (st.allCaps) text = upperText(text);
  const netName = which === 'value' && !!def?.valueIsLabel;
  const size = st.size ?? (which === 'ref' || netName ? 11 : 10.5);
  const normal = which === 'ref' ? 650 : netName ? 700 : 400;
  const weight = st.bold === undefined ? normal : st.bold ? 700 : 400;
  return { st, text, size, weight };
}
export type LabelLook = ReturnType<typeof labelLook>;

/** Approximate unrotated box of a label's text at its anchor. */
export function labelBox(at: LabelPos, look: LabelLook): Rect {
  const m = measureRich(look.text, look.size, look.weight);
  const anchor = look.st.align ?? at.anchor;
  const x = anchor === 'start' ? at.x : anchor === 'middle' ? at.x - m.w / 2 : at.x - m.w;
  return { x, y: at.y - look.size, w: m.w, h: Math.max(look.size * 1.3, m.h) };
}
