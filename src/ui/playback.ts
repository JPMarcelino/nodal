import { calloutAnchor } from '../model/callout';
import {
  cameraAt,
  easeInOut,
  entryAt,
  fitShot,
  lerpCamera,
  overviewShot,
  presentationSteps,
  stepNetWires,
  stepShot,
  timeline,
  type Camera,
  type Shot,
  type TimelineEntry,
} from '../model/presentation';
import type { CircuitDoc, ShapeItem } from '../model/types';
import { TRACE_COLORS, X, setX, type Trace } from '../store/explain';
import { S, set, type View } from '../store/store';

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

/** Height kept free for the caption card while presenting. */
const CAPTION_H = 170;

/** Part of the canvas the camera frames: below the top edge, above the caption when presenting. */
function stageArea(): { w: number; h: number; top: number } {
  const { w, h } = S().canvasSize;
  if (X().presenting === null) return { w, h, top: 0 };
  return { w, h: Math.max(120, h - CAPTION_H), top: 10 };
}

function viewOf(c: Camera, a = stageArea()): View {
  return { x: a.w / 2 - c.cx * c.zoom, y: a.top + a.h / 2 - c.cy * c.zoom, zoom: c.zoom };
}

function cameraOf(v: View, a = stageArea()): Camera {
  return { cx: (a.w / 2 - v.x) / v.zoom, cy: (a.top + a.h / 2 - v.y) / v.zoom, zoom: v.zoom };
}

let flight = 0;
/** Glides the view to `to` (ease in-out). */
export function flyTo(to: View, ms = 650) {
  const id = ++flight;
  if (ms <= 0) {
    set({ view: to });
    return;
  }
  const a = stageArea();
  const from = cameraOf(S().view, a);
  const target = cameraOf(to, a);
  const t0 = performance.now();
  const step = () => {
    if (id !== flight) return;
    const k = Math.min(1, (performance.now() - t0) / ms);
    set({ view: viewOf(lerpCamera(from, target, easeInOut(k)), a) });
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Glides to a shot over `ms`. */
export function flyToShot(shot: Shot, ms = 650) {
  const a = stageArea();
  flyTo(viewOf(fitShot(shot, a.w, a.h), a), ms);
}

/* ------------------------------------------------------------------ */
/* Steps                                                               */
/* ------------------------------------------------------------------ */

/** A callout on a wire lights up its whole net. */
export function stepTraces(doc: CircuitDoc, s: ShapeItem | undefined): Trace[] {
  if (!s || !stepNetWires(doc, s).length) return [];
  const anchor = calloutAnchor(doc, s);
  return [{ id: `p${s.id}`, seed: { wire: s.anchor!.id! }, color: s.stroke === '#000000' ? TRACE_COLORS[0] : s.stroke, origin: anchor ?? { x: 0, y: 0 } }];
}

/** Everything needed to play the timeline, recomputed only when the document changes. */
interface Plan {
  doc: CircuitDoc;
  steps: ShapeItem[];
  entries: TimelineEntry[];
  total: number;
  shots: Shot[];
  overview: Shot;
}
let plan: Plan | null = null;
export function playPlan(doc = S().doc): Plan {
  if (plan?.doc === doc) return plan;
  const steps = presentationSteps(doc);
  const { entries, total } = timeline(doc, steps);
  plan = { doc, steps, entries, total, shots: steps.map((s) => stepShot(doc, s)), overview: overviewShot(doc) };
  return plan;
}

/** Start of a step's hold (where it is fully on screen). */
export function stepTime(i: number): number {
  const e = playPlan().entries[i];
  return e ? e.start + e.transition : 0;
}

/* ------------------------------------------------------------------ */
/* Playback                                                            */
/* ------------------------------------------------------------------ */

let raf = 0;
let lastFrame = 0;

/** Puts the camera (and, when presenting, the current step) where the timeline is at time t. */
export function showTime(t: number) {
  const p = playPlan();
  const a = stageArea();
  flight++; // cancel any glide in progress
  set({ view: viewOf(cameraAt(p.entries, p.shots, p.overview, t, a.w, a.h), a) });
  const patch: Partial<ReturnType<typeof X>> = { playT: t };
  if (X().presenting !== null && p.entries.length) {
    const { index } = entryAt(p.entries, t);
    if (index !== X().presenting) {
      patch.presenting = index;
      patch.traces = stepTraces(p.doc, p.steps[index]);
    }
  }
  setX(patch);
}

function tick(now: number) {
  if (!X().playing) return;
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const total = playPlan().total;
  const t = Math.min(total, X().playT + dt);
  showTime(t);
  if (t >= total) return pause();
  raf = requestAnimationFrame(tick);
}

export function play() {
  const total = playPlan().total;
  if (!total) return;
  // from the top again once it has run to the end
  if (X().playT >= total - 0.01) setX({ playT: 0 });
  setX({ playing: true });
  cancelAnimationFrame(raf);
  lastFrame = performance.now();
  raf = requestAnimationFrame(tick);
}

export function pause() {
  cancelAnimationFrame(raf);
  if (X().playing) setX({ playing: false });
}

export const togglePlay = () => (X().playing ? pause() : play());

/** Moves the playhead (keeps playing if it was). */
export function seek(t: number) {
  showTime(Math.max(0, Math.min(playPlan().total, t)));
  lastFrame = performance.now();
}
