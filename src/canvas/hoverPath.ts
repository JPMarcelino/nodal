/**
 * The way from a hovered thing to the popup it opened: the convex hull of a
 * small square around where the pointer left the thing and the popup's box
 * (both padded). While the pointer is inside it, the pointer is on its way to
 * the popup, so the popup stays open and nothing else under that path lights up.
 */

type Pt = { x: number; y: number };
export type Box = { left: number; top: number; right: number; bottom: number };

/** Corners of the convex hull of `pts` (Andrew's monotone chain), counter-clockwise. */
function hull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

const corners = (b: Box, pad: number): Pt[] => [
  { x: b.left - pad, y: b.top - pad },
  { x: b.right + pad, y: b.top - pad },
  { x: b.right + pad, y: b.bottom + pad },
  { x: b.left - pad, y: b.bottom + pad },
];

/** Whether `p` lies on the way from `from` (where the pointer left the hovered thing) to the popup `box`. */
export function onWayToPopup(p: Pt, from: Pt, box: Box, reach = 10, pad = 10): boolean {
  const h = hull([...corners({ left: from.x, top: from.y, right: from.x, bottom: from.y }, reach), ...corners(box, pad)]);
  // inside a counter-clockwise convex polygon: left of (or on) every edge
  for (let i = 0; i < h.length; i++) {
    const a = h[i];
    const b = h[(i + 1) % h.length];
    if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < 0) return false;
  }
  return h.length >= 3;
}

/** A popup's box in the coordinates of `wrap` (the canvas), or null when it isn't on screen. */
export function popupBox(wrap: HTMLElement | null, selector: string): Box | null {
  const el = wrap?.querySelector<HTMLElement>(selector);
  if (!wrap || !el) return null;
  const w = wrap.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { left: r.left - w.left, top: r.top - w.top, right: r.right - w.left, bottom: r.bottom - w.top };
}
