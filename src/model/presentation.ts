import { calloutAnchor } from './callout';
import { docBounds, itemBounds } from './doc';
import { unionRects } from './geometry';
import { computeNets } from './netlist';
import { resolveNet } from './trace';
import type { CircuitDoc, Item, Rect, ShapeItem } from './types';

/*
 * A presentation is a timeline of steps: frames (a drawn rectangle that is
 * exactly what the camera shows) and numbered callouts (framing the part or
 * net they point at). Each step glides in over `transition` seconds and then
 * stays put for `hold` seconds. The camera starts on the whole circuit.
 */

export const DEFAULT_HOLD = 4;
export const DEFAULT_TRANSITION = 1.2;

export const isFrame = (i: Item): i is ShapeItem => i.type === 'shape' && i.kind === 'frame';

/** The document minus its presentation frames (for exports, which never show them). */
export function withoutFrames(doc: CircuitDoc): CircuitDoc {
  if (!Object.values(doc.items).some(isFrame)) return doc;
  return { ...doc, items: Object.fromEntries(Object.entries(doc.items).filter(([, i]) => !isFrame(i))) };
}

export const isStep = (i: Item): i is ShapeItem => i.type === 'shape' && (i.kind === 'frame' || i.kind === 'callout') && !i.hidden;

/** Frames and callouts in walkthrough order. */
export function presentationSteps(doc: CircuitDoc): ShapeItem[] {
  return Object.values(doc.items)
    .filter(isStep)
    .sort((a, b) => (a.step ?? 0) - (b.step ?? 0) || a.z - b.z);
}

export { nextStep as nextPresentationStep } from './callout';

export const holdOf = (s: Pick<ShapeItem, 'hold'>) => Math.max(0, s.hold ?? DEFAULT_HOLD);
export const transitionOf = (s: Pick<ShapeItem, 'transition'>) => Math.max(0, s.transition ?? DEFAULT_TRANSITION);

export const normRect = (r: Rect): Rect => ({ x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) });

/** What a step puts on screen: the world area, the screen padding around it and how far it may zoom in. */
export interface Shot {
  rect: Rect;
  pad: number;
  maxZoom: number;
}

/** Wires lit up for a callout pointing at a wire (its whole net). */
export function stepNetWires(doc: CircuitDoc, s: ShapeItem): string[] {
  const target = s.kind === 'callout' && s.anchor?.id ? doc.items[s.anchor.id] : undefined;
  if (target?.type !== 'wire') return [];
  return resolveNet(computeNets(doc), { wire: target.id })?.wires ?? [target.id];
}

export function stepShot(doc: CircuitDoc, s: ShapeItem): Shot {
  if (s.kind === 'frame') return { rect: normRect(s), pad: 0, maxZoom: 12 };
  const target = s.anchor?.id ? doc.items[s.anchor.id] : undefined;
  const framed = [s.id, ...(target?.type === 'wire' ? stepNetWires(doc, s) : target ? [target.id] : [])];
  const rects = framed.map((id) => (doc.items[id] ? itemBounds(doc, doc.items[id]) : null)).filter((r): r is Rect => !!r);
  const anchor = calloutAnchor(doc, s);
  if (anchor) rects.push({ x: anchor.x - 50, y: anchor.y - 50, w: 100, h: 100 });
  return { rect: unionRects(rects) ?? { x: s.x, y: s.y, w: 100, h: 100 }, pad: 70, maxZoom: 2.4 };
}

/** Everything except the frames themselves (they are never drawn when presenting). */
export function overviewShot(doc: CircuitDoc): Shot {
  const ids = Object.values(doc.items)
    .filter((i) => !isFrame(i))
    .map((i) => i.id);
  return { rect: docBounds(doc, ids) ?? { x: 0, y: 0, w: 400, h: 300 }, pad: 70, maxZoom: 1.6 };
}

/** Camera: world point at the centre of the viewing area, and zoom. */
export interface Camera {
  cx: number;
  cy: number;
  zoom: number;
}

export function fitShot(shot: Shot, w: number, h: number): Camera {
  const r = shot.rect;
  const pad = Math.min(shot.pad, w / 6, h / 6);
  const zoom = Math.max(0.05, Math.min(shot.maxZoom, (w - 2 * pad) / Math.max(r.w, 1), (h - 2 * pad) / Math.max(r.h, 1)));
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, zoom };
}

export const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

/** Glide between cameras: the centre moves in a straight line, zoom evenly in log space. */
export function lerpCamera(a: Camera, b: Camera, e: number): Camera {
  return { cx: a.cx + (b.cx - a.cx) * e, cy: a.cy + (b.cy - a.cy) * e, zoom: Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * e) };
}

export interface TimelineEntry {
  id: string;
  /** When its transition begins. */
  start: number;
  transition: number;
  hold: number;
  /** start + transition + hold */
  end: number;
}

export function timeline(doc: CircuitDoc, steps = presentationSteps(doc)): { entries: TimelineEntry[]; total: number } {
  let t = 0;
  const entries = steps.map((s) => {
    const e = { id: s.id, start: t, transition: transitionOf(s), hold: holdOf(s), end: 0 };
    t += e.transition + e.hold;
    e.end = t;
    return e;
  });
  return { entries, total: t };
}

/** Step on screen (or on its way) at time t, and how far its transition has got (0–1). */
export function entryAt(entries: TimelineEntry[], t: number): { index: number; k: number } {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (t < e.end || i === entries.length - 1) {
      const k = e.transition > 0 ? Math.min(1, Math.max(0, (t - e.start) / e.transition)) : 1;
      return { index: i, k };
    }
  }
  return { index: -1, k: 1 };
}

/**
 * Camera at time t for a w × h viewing area. `shots` holds each step's shot
 * (same order as the entries) so callers can compute them once.
 */
export function cameraAt(entries: TimelineEntry[], shots: Shot[], overview: Shot, t: number, w: number, h: number): Camera {
  if (!entries.length) return fitShot(overview, w, h);
  const { index, k } = entryAt(entries, t);
  const i = Math.max(0, index);
  const to = fitShot(shots[i], w, h);
  if (k >= 1) return to;
  const from = fitShot(i > 0 ? shots[i - 1] : overview, w, h);
  return lerpCamera(from, to, easeInOut(k));
}

/** World rectangle seen by a camera on a w × h area. */
export function cameraRect(c: Camera, w: number, h: number): Rect {
  return { x: c.cx - w / 2 / c.zoom, y: c.cy - h / 2 / c.zoom, w: w / c.zoom, h: h / c.zoom };
}

/** New step numbers 1, 2, 3… for the steps in the given order. */
export function renumberSteps(doc: CircuitDoc, order: string[]) {
  order.forEach((id, i) => {
    const s = doc.items[id];
    if (s?.type === 'shape') s.step = i + 1;
  });
}

/** Caption of a step as plain text (frames: their title; callouts: their note). */
export const stepCaption = (s: ShapeItem) => (s.text ?? '').trim();
