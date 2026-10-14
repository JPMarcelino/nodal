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
    let nav: { t0: number; most: number; travel: number; last: { c: Point; d: number } | null } | null = null;
    let before: Before | null = null;
    let press: { id: number; at: Point; timer: number } | null = null;

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
      if (!last) return;
      const r = el.getBoundingClientRect();
      if (now.d && last.d) A.zoomBy(now.d / last.d, now.c.x - r.left, now.c.y - r.top);
      const v = S().view;
      set({ view: { ...v, x: v.x + now.c.x - last.c.x, y: v.y + now.c.y - last.c.y } });
      nav.travel += dist(now.c, last.c) + Math.abs(now.d - last.d);
    };

    const startNav = () => {
      nav = nav ?? { t0: performance.now(), most: 0, travel: 0, last: null };
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
        if (nav) nav.last = null;
        navigate();
        return;
      }
      const n = nav;
      nav = null;
      before = null;
      if (!n || e.type === 'pointercancel' || inGesture()) return;
      if (performance.now() - n.t0 < TAP_TIME && n.travel < TAP_TRAVEL) {
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
