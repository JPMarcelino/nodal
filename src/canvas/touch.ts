import { useEffect, type RefObject } from 'react';
import type { Point } from '../model/types';
import * as A from '../store/actions';
import { S, inGesture, redo, set, toast, undo, type AppState } from '../store/store';

/*
 * Touch screens and tablets (iPad + Apple Pencil). Runs before the canvas and
 * explain handlers (capture phase on the canvas wrapper) and takes over the
 * touches that navigate:
 *   - two fingers pinch-zoom and pan; one finger pans too once a stylus has
 *     been used (the pen draws, fingers move the paper) or when set to;
 *   - a two-finger tap undoes (or cancels the wire being drawn), a three-finger tap redoes;
 *   - a long press opens the context menu.
 * A touch that turns into a pinch takes back whatever its first finger started.
 */

/** A tool's in-progress gesture, so a touch that becomes a pinch can put it back. */
export interface GestureSlot {
  get(): unknown;
  restore(g: unknown): void;
}
export const gestureSlots: { canvas: GestureSlot | null; explain: GestureSlot | null } = { canvas: null, explain: null };

let lastPointer = 'mouse';
let penSeen = false;

/** Hit tolerance multiplier: a fingertip is far less precise than a mouse. */
export const hitSlop = () => (lastPointer === 'touch' ? 1.8 : 1);

const fingerPans = () => {
  const p = S().prefs.touch;
  return p === 'pan' || (p === 'auto' && penSeen);
};

const LONG_PRESS = 550;
const TAP_TIME = 350;
const TAP_TRAVEL = 14;
/** Elements on the canvas that keep their own touch handling. */
const OWN_INPUT = 'input, textarea, button, select, [contenteditable="true"], .minimap, .cross-pop, .text-editor';

interface Before {
  doc: AppState['doc'];
  selection: string[];
  wirePart: AppState['wirePart'];
  placing: AppState['placing'];
  canvas: unknown;
  explain: unknown;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function useTouchInput(wrapRef: RefObject<HTMLDivElement>) {
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const fingers = new Map<number, Point>();
    /** Touches handled here; the tools never see them. */
    const taken = new Set<number>();
    /** `spread`: how far the fingers moved apart or together in all, so a quick small pinch isn't taken for a tap. */
    let nav: { t0: number; most: number; travel: number; spread: number; last: { c: Point; d: number } | null } | null = null;
    let before: Before | null = null;
    let press: { id: number; at: Point; timer: number } | null = null;
    /** Recent positions of the touch centre, to carry a flick on after the fingers lift. */
    let trail: { t: number; c: Point }[] = [];
    /** The trail as it stood when a finger lifted while others stayed: fingers of a flick lift a few ms apart. */
    let liftTrail: { t: number; trail: { t: number; c: Point }[] } | null = null;
    let coast = 0;
    const stopCoast = () => {
      if (coast) cancelAnimationFrame(coast);
      coast = 0;
    };

    /** Lets the paper glide on after a flick and slow to a stop, as touch screens do. */
    const fling = () => {
      let now = performance.now();
      let recent = trail.filter((s) => now - s.t < 100);
      if (recent.length < 2 && liftTrail && now - liftTrail.t < 80) {
        // measure up to when the first finger lifted
        now = liftTrail.t;
        recent = liftTrail.trail.filter((s) => now - s.t < 100);
      }
      trail = [];
      liftTrail = null;
      // a finger that came to rest before lifting means "stop here"
      if (recent.length < 2 || now - recent[recent.length - 1].t > 50) return;
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      const a = recent[0];
      const b = recent[recent.length - 1];
      const dt = Math.max(1, b.t - a.t);
      let vx = (b.c.x - a.c.x) / dt;
      let vy = (b.c.y - a.c.y) / dt;
      if (Math.hypot(vx, vy) < 0.25) return; // px per ms: slower is a placed pan, not a flick
      let last = performance.now();
      let mine = S().view;
      const step = (t: number) => {
        // the user (or a camera move) took over
        if (S().view !== mine) return void (coast = 0);
        const ms = Math.min(48, t - last);
        last = t;
        const k = Math.exp(-ms / 320);
        vx *= k;
        vy *= k;
        if (Math.hypot(vx, vy) < 0.02) return void (coast = 0);
        mine = { ...mine, x: mine.x + vx * ms, y: mine.y + vy * ms };
        set({ view: mine });
        coast = requestAnimationFrame(step);
      };
      coast = requestAnimationFrame(step);
    };

    const snapshot = (): Before => {
      const s = S();
      return { doc: s.doc, selection: s.selection, wirePart: s.wirePart, placing: s.placing, canvas: gestureSlots.canvas?.get(), explain: gestureSlots.explain?.get() };
    };

    /** Undoes what the first finger of a touch did before it became navigation. */
    const takeBack = () => {
      const b = before;
      before = null;
      if (!b) return;
      gestureSlots.explain?.restore(b.explain);
      gestureSlots.canvas?.restore(b.canvas);
      const s = S();
      if (s.doc !== b.doc && s.past[s.past.length - 1] === b.doc) set({ doc: b.doc, past: s.past.slice(0, -1) });
      set({ selection: b.selection, wirePart: b.wirePart, placing: b.placing, contextMenu: null });
    };

    const cancelPress = () => {
      if (press) window.clearTimeout(press.timer);
      press = null;
    };

    const centre = () => {
      const pts = [...fingers.values()].slice(0, 2);
      const c = pts.length === 2 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0];
      return { c, d: pts.length === 2 ? dist(pts[0], pts[1]) : 0 };
    };

    const navigate = () => {
      if (!nav || !fingers.size) return;
      const now = centre();
      const last = nav.last;
      nav.last = now;
      // the centre jumps when a finger joins or leaves: only a steady finger set measures speed
      if (!last) trail = [];
      trail.push({ t: performance.now(), c: now.c });
      if (trail.length > 8) trail.shift();
      if (!last) return;
      const r = el.getBoundingClientRect();
      if (now.d && last.d) A.zoomBy(now.d / last.d, now.c.x - r.left, now.c.y - r.top);
      const v = S().view;
      set({ view: { ...v, x: v.x + now.c.x - last.c.x, y: v.y + now.c.y - last.c.y } });
      nav.travel += dist(now.c, last.c) + Math.abs(now.d - last.d);
      if (now.d && last.d) nav.spread += Math.abs(now.d - last.d);
    };

    const startNav = () => {
      nav = nav ?? { t0: performance.now(), most: 0, travel: 0, spread: 0, last: null };
      nav.most = Math.max(nav.most, fingers.size);
      nav.last = null; // the finger set changed: measure from here
      navigate();
      for (const id of fingers.keys()) taken.add(id);
    };

    const longPress = (id: number, at: Point) => {
      press = null;
      takeBack();
      taken.add(id);
      navigator.vibrate?.(8);
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2 }));
    };

    const down = (e: PointerEvent) => {
      lastPointer = e.pointerType;
      if (e.pointerType === 'pen') penSeen = true;
      // any new press catches the gliding paper
      stopCoast();
      if (e.pointerType !== 'touch') return;
      if ((e.target as Element).closest?.(OWN_INPUT)) return;
      const p = { x: e.clientX, y: e.clientY };
      fingers.set(e.pointerId, p);
      if (nav || fingers.size > 1 || fingerPans()) {
        e.stopPropagation();
        e.preventDefault();
        if (fingers.size > 1) {
          cancelPress();
          takeBack();
        }
        startNav();
        return;
      }
      // a single finger uses the tools: remember the state in case it becomes a pinch
      before = snapshot();
      const s = S();
      if (s.tool === 'select' && !s.placing) {
        const id = e.pointerId;
        press = { id, at: p, timer: window.setTimeout(() => longPress(id, p), LONG_PRESS) };
      }
    };

    const move = (e: PointerEvent) => {
      if (!fingers.has(e.pointerId)) return;
      const p = { x: e.clientX, y: e.clientY };
      fingers.set(e.pointerId, p);
      if (press?.id === e.pointerId && dist(press.at, p) > 10) cancelPress();
      if (!taken.has(e.pointerId)) return;
      e.stopPropagation();
      navigate();
    };

    const up = (e: PointerEvent) => {
      if (!fingers.has(e.pointerId)) return;
      fingers.delete(e.pointerId);
      if (press?.id === e.pointerId) cancelPress();
      if (!taken.delete(e.pointerId)) {
        if (!fingers.size) before = null;
        return;
      }
      e.stopPropagation();
      if (fingers.size) {
        liftTrail = { t: performance.now(), trail };
        if (nav) nav.last = null;
        navigate();
        return;
      }
      const n = nav;
      nav = null;
      before = null;
      if (!n || e.type === 'pointercancel' || inGesture()) {
        trail = [];
        return;
      }
      if (n.travel >= TAP_TRAVEL) fling();
      else trail = [];
      // a pinch, however small and quick, zoomed: it mustn't also undo
      if (performance.now() - n.t0 < TAP_TIME && n.travel < TAP_TRAVEL && n.spread < 4) {
        if (n.most === 2 && gestureSlots.canvas?.get()) {
          // no Escape key on a tablet: a two-finger tap ends the wire being drawn first
          gestureSlots.canvas.restore(null);
        } else if (n.most === 2 && S().past.length) {
          undo();
          toast('Undo', 'info');
        } else if (n.most === 3 && S().future.length) {
          redo();
          toast('Redo', 'info');
        }
      }
    };

    /** Android opens a menu on long press by itself; keep only ours. */
    const contextMenu = (e: MouseEvent) => {
      if (!e.isTrusted || !fingers.size) return;
      e.preventDefault();
      e.stopPropagation();
      if (press) longPress(press.id, press.at);
    };

    // Safari's own page pinch-zoom would fight the canvas zoom
    const noPageZoom = (e: Event) => e.preventDefault();

    const opts = { capture: true, passive: false } as const;
    el.addEventListener('pointerdown', down, opts);
    el.addEventListener('pointermove', move, opts);
    el.addEventListener('pointerup', up, opts);
    el.addEventListener('pointercancel', up, opts);
    el.addEventListener('contextmenu', contextMenu, opts);
    el.addEventListener('gesturestart', noPageZoom, opts);
    el.addEventListener('gesturechange', noPageZoom, opts);
    return () => {
      cancelPress();
      stopCoast();
      el.removeEventListener('pointerdown', down, opts);
      el.removeEventListener('pointermove', move, opts);
      el.removeEventListener('pointerup', up, opts);
      el.removeEventListener('pointercancel', up, opts);
      el.removeEventListener('contextmenu', contextMenu, opts);
      el.removeEventListener('gesturestart', noPageZoom, opts);
      el.removeEventListener('gesturechange', noPageZoom, opts);
    };
  }, [wrapRef]);
}
