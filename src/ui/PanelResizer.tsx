import { useRef, useSyncExternalStore } from 'react';
import { S, set, setPrefs, useStore } from '../store/store';

/** Width limits of the side panels (px); the canvas always keeps at least STAGE_MIN. */
export const PANEL_BOUNDS = {
  left: { min: 240, max: 560, def: 280 },
  right: { min: 250, max: 600, def: 290 },
} as const;
const STAGE_MIN = 360;

type Side = keyof typeof PANEL_BOUNDS;
const key = (side: Side) => (side === 'left' ? 'leftWidth' : 'rightWidth');

/** Width the window leaves for a side panel next to the other one (can fall below the panel minimum). */
function panelRoom(side: Side): number {
  const s = S();
  const other = side === 'left' ? (s.rightPanel ? s.prefs.rightWidth : 0) : s.leftPanel ? s.prefs.leftWidth : 0;
  return window.innerWidth - other - STAGE_MIN;
}

/** Clamps a panel width to its bounds and to what the window leaves next to the other panel. */
export function clampPanelWidth(side: Side, w: number): number {
  const b = PANEL_BOUNDS[side];
  return Math.round(Math.max(b.min, Math.min(b.max, panelRoom(side), w)));
}

const onWindowResize = (cb: () => void) => {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
};

/** Panel width as laid out: the stored width, clamped to the current window (and the other panel). */
export function usePanelWidth(side: Side, stored: number): number {
  useSyncExternalStore(onWindowResize, () => window.innerWidth);
  // the other panel opening, closing or resizing changes the room left
  useStore((s) => (side === 'left' ? (s.rightPanel ? s.prefs.rightWidth : 0) : s.leftPanel ? s.prefs.leftWidth : 0));
  return clampPanelWidth(side, stored || PANEL_BOUNDS[side].def);
}

/**
 * Drag handle on a side panel's inner edge. Dragging resizes the panel live;
 * the width is saved on release. Double-click restores the default width.
 */
export function PanelResizer({ side }: { side: Side }) {
  // from: width when the drag started; w: width currently laid out by the drag
  const drag = useRef<{ x: number; from: number; w: number } | null>(null);
  const k = key(side);
  return (
    <div
      className={`panel-resizer ${side}`}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const w = clampPanelWidth(side, S().prefs[k]);
        drag.current = { x: e.clientX, from: w, w };
        document.body.classList.add('is-resizing-panel');
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = (e.clientX - d.x) * (side === 'left' ? 1 : -1);
        const w = clampPanelWidth(side, d.from + dx);
        // live, without writing storage on every frame; nothing to resize when the window leaves no room
        if (w !== d.w && panelRoom(side) >= PANEL_BOUNDS[side].min) {
          d.w = w;
          set((s) => ({ prefs: { ...s.prefs, [k]: w } }));
        }
      }}
      onPointerUp={() => {
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        document.body.classList.remove('is-resizing-panel');
        // only save a width the user actually dragged to, never the clamped one a small window forces
        if (d.w !== d.from) setPrefs({ [k]: d.w });
      }}
      onPointerCancel={() => {
        drag.current = null;
        document.body.classList.remove('is-resizing-panel');
      }}
      onDoubleClick={() => setPrefs({ [k]: PANEL_BOUNDS[side].def })}
    />
  );
}
