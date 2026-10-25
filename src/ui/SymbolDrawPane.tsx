import { ArrowDownToLine, ArrowUpToLine, Circle, Copy, Magnet, Maximize2, Minus, MousePointer2, Pin, Plus, Redo2, Slash, Spline, Square, Trash2, Type, Undo2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { PrimEl } from '../canvas/SymbolGraphic';
import { inferSide, type SymbolSource } from '../model/symbols/dsl';
import { movePrim, primBounds, scalePrim } from '../model/symbols/primGeometry';
import { resizeInFrame, type BoxHandle } from '../model/rotation';
import { S } from '../store/store';
import type { Fill, PortDef, Prim, PrimStyle } from '../model/types';
import { eventToCombo } from '../store/commands';
import { ColorInput, NumberInput, Segmented, TextInput } from './controls';

export interface Snap {
  src: SymbolSource;
  prims: Prim[];
  ports: PortDef[];
}

export type Tool = 'select' | 'line' | 'poly' | 'rect' | 'circle' | 'ellipse' | 'text' | 'pin';
type P = { x: number; y: number };

const TOOL_KEYS: Record<Tool, string> = { select: 'V', line: 'L', poly: 'P', rect: 'R', circle: 'C', ellipse: 'E', text: 'T', pin: 'N' };
/** Pins and the outline sit on the schematic's grid so wires meet them; the drawing can use a finer one. */
const PIN_GRID = 10;
const GRIDS = [10, 5, 2, 1];
/** Largest outline the editor allows (the old 400 cap cut real ICs short). */
const MAX_SIZE = 2000;
const r10 = (v: number) => Math.min(MAX_SIZE, Math.max(PIN_GRID, Math.round(v / PIN_GRID) * PIN_GRID));
const s10 = (v: number) => Math.round(v / PIN_GRID) * PIN_GRID;
const r2 = (v: number) => +v.toFixed(2);
/** Drawing grid; kept between editor sessions like the new-shape style. */
let lastGrid = 5;
/** Screen pixels a press must travel before it counts as a drag (as on the schematic). */
const DRAG_SLOP = 3;

const mapRect = (r: { x: number; y: number; w: number; h: number }) => ({ x: r2(r.x), y: r2(r.y), w: r2(r.w), h: r2(r.h) });

/** Box around several primitives. */
function unionBounds(list: Prim[]) {
  const bs = list.map(primBounds);
  const x = Math.min(...bs.map((b) => b.x));
  const y = Math.min(...bs.map((b) => b.y));
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
}

const BOX_KEYS: BoxHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const boxHandles = (b: { x: number; y: number; w: number; h: number }) =>
  BOX_KEYS.map((key) => ({
    key,
    x: b.x + (key.includes('w') ? 0 : key.includes('e') ? b.w : b.w / 2),
    y: b.y + (key.includes('n') ? 0 : key.includes('s') ? b.h : b.h / 2),
  }));
const HANDLE_CURSOR: Record<BoxHandle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

/**
 * The outline resized to w × h with its top-left corner moved by (ox, oy):
 * the drawing shifts so it stays put, pins on a dragged edge follow it, the rest stay inside.
 */
function resizeOutline(s: Snap, base: { w: number; h: number; prims: Prim[]; ports: PortDef[] }, ox: number, oy: number, w: number, h: number) {
  s.src.w = w;
  s.src.h = h;
  s.prims = ox || oy ? base.prims.map((p) => movePrim(p, -ox, -oy)) : base.prims;
  s.ports = base.ports.map((q) => {
    const x = q.x === 0 ? 0 : q.x === base.w ? w : Math.min(w, Math.max(0, q.x - ox));
    const y = q.y === 0 ? 0 : q.y === base.h ? h : Math.min(h, Math.max(0, q.y - oy));
    return { ...q, x, y };
  });
}

/** The primitive a drag from a to b draws with the given tool, or null for click-only tools. */
/** Style for new shapes; kept between editor sessions. */
type NewStyle = PrimStyle & { w: number };
let lastStyle: NewStyle = { w: 2 };

/** Gives a new primitive the chosen colours, dash and width. */
function withStyle(p: Prim, st: NewStyle): Prim {
  const out = { ...p } as Prim;
  if (st.color) out.color = st.color;
  if (st.fc && 'fill' in out) out.fc = st.fc;
  if (st.dash && out.t !== 'text') out.dash = true;
  if (st.w !== 2) {
    if (out.t === 'rect') out.sw = st.w;
    else if (out.t !== 'text') out.w = st.w;
  }
  return out;
}

const widthOf = (p: Prim) => (p.t === 'rect' ? (p.sw ?? 2) : 'w' in p ? (p.w ?? 2) : 2);

function dragShape(tool: Tool, a: P, b: P, fill: Fill): Prim | null {
  if (tool === 'line') return { t: 'line', pts: [a.x, a.y, b.x, b.y] };
  if (tool === 'rect') return { t: 'rect', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), fill };
  if (tool === 'circle') return { t: 'circle', cx: a.x, cy: a.y, r: Math.round(Math.hypot(b.x - a.x, b.y - a.y)), fill };
  if (tool === 'ellipse') return { t: 'ellipse', cx: a.x, cy: a.y, rx: Math.abs(b.x - a.x), ry: Math.abs(b.y - a.y), fill };
  return null;
}

/** Edit handles of a single selected primitive. */
function primHandles(p: Prim): { key: string; x: number; y: number }[] {
  switch (p.t) {
    case 'line':
    case 'poly': {
      const out: { key: string; x: number; y: number }[] = [];
      for (let i = 0; i < p.pts.length; i += 2) out.push({ key: `v${i / 2}`, x: p.pts[i], y: p.pts[i + 1] });
      return out;
    }
    case 'rect': {
      const { x, y, w, h } = p;
      return [
        { key: 'nw', x, y },
        { key: 'n', x: x + w / 2, y },
        { key: 'ne', x: x + w, y },
        { key: 'e', x: x + w, y: y + h / 2 },
        { key: 'se', x: x + w, y: y + h },
        { key: 's', x: x + w / 2, y: y + h },
        { key: 'sw', x, y: y + h },
        { key: 'w', x, y: y + h / 2 },
      ];
    }
    case 'circle':
      return [
        { key: 'n', x: p.cx, y: p.cy - p.r },
        { key: 'e', x: p.cx + p.r, y: p.cy },
        { key: 's', x: p.cx, y: p.cy + p.r },
        { key: 'w', x: p.cx - p.r, y: p.cy },
      ];
    case 'ellipse':
      return [
        { key: 'n', x: p.cx, y: p.cy - p.ry },
        { key: 'e', x: p.cx + p.rx, y: p.cy },
        { key: 's', x: p.cx, y: p.cy + p.ry },
        { key: 'w', x: p.cx - p.rx, y: p.cy },
      ];
    default:
      return [];
  }
}

/** A primitive with one of its handles dragged to `pt` (always computed from the gesture's start state). */
function applyHandle(base: Prim, key: string, pt: P): Prim {
  switch (base.t) {
    case 'line':
    case 'poly': {
      const i = Number(key.slice(1)) * 2;
      const pts = [...base.pts];
      pts[i] = pt.x;
      pts[i + 1] = pt.y;
      return { ...base, pts };
    }
    case 'rect': {
      let x1 = base.x;
      let y1 = base.y;
      let x2 = base.x + base.w;
      let y2 = base.y + base.h;
      if (key.includes('w')) x1 = pt.x;
      if (key.includes('e')) x2 = pt.x;
      if (key.includes('n')) y1 = pt.y;
      if (key.includes('s')) y2 = pt.y;
      return { ...base, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    }
    case 'circle':
      return { ...base, r: Math.max(1, Math.round(key === 'e' || key === 'w' ? Math.abs(pt.x - base.cx) : Math.abs(pt.y - base.cy))) };
    case 'ellipse':
      return key === 'e' || key === 'w' ? { ...base, rx: Math.max(1, Math.abs(pt.x - base.cx)) } : { ...base, ry: Math.max(1, Math.abs(pt.y - base.cy)) };
    default:
      return base;
  }
}

const distToSeg = (p: P, a: P, b: P) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/** Whether a point (symbol units) is on / in a primitive, with tolerance `tol`. */
function primHit(p: Prim, q: P, tol: number): boolean {
  if (p.t === 'line' || p.t === 'poly') {
    for (let i = 0; i + 3 < p.pts.length; i += 2) if (distToSeg(q, { x: p.pts[i], y: p.pts[i + 1] }, { x: p.pts[i + 2], y: p.pts[i + 3] }) <= tol) return true;
    if (p.t === 'line') return false;
  }
  const b = primBounds(p);
  return q.x >= b.x - tol && q.x <= b.x + b.w + tol && q.y >= b.y - tol && q.y <= b.y + b.h + tol;
}

/* ------------------------------------------------------------------ */
/* Draw pane                                                           */
/* ------------------------------------------------------------------ */

type Gesture =
  | { kind: 'draw'; start: P; cur: P }
  | { kind: 'move'; start: P; client: P; base: Prim[]; ids: number[]; moved: boolean }
  | { kind: 'handle'; idx: number; key: string; base: Prim; client: P; moved: boolean }
  | { kind: 'scale'; key: BoxHandle; box: { x: number; y: number; w: number; h: number }; base: Prim[]; ids: number[]; client: P; moved: boolean }
  | { kind: 'marquee'; start: P; cur: P; add: boolean }
  | { kind: 'pan'; client: P; view: View }
  | { kind: 'pin'; idx: number; moved: boolean }
  | { kind: 'size'; key: BoxHandle; base: { w: number; h: number; prims: Prim[]; ports: PortDef[] }; view: View; client: P; moved: boolean };

interface View {
  x: number;
  y: number;
  zoom: number;
}

let clipboard: Prim[] = [];

export function SymbolDrawPane({
  src,
  apply,
  prims,
  ports,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  escRef,
}: {
  src: SymbolSource;
  apply: (mut: (s: Snap) => void, history?: boolean | string) => void;
  prims: Prim[];
  ports: PortDef[];
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Set to a handler the modal calls on Esc; returns true when the pane used the key. */
  escRef: MutableRefObject<(() => boolean) | null>;
}) {
  const [tool, setTool] = useState<Tool>('select');
  const [sel, setSel] = useState<number[]>([]);
  const [g, setG] = useState<Gesture | null>(null);
  const [poly, setPoly] = useState<number[] | null>(null);
  const [fill, setFill] = useState<Fill>('none');
  const [style, setStyleState] = useState<NewStyle>(lastStyle);
  const setStyle = (patch: Partial<NewStyle>) => setStyleState((st) => (lastStyle = { ...st, ...patch }));
  const [snapOn, setSnapOn] = useState(true);
  const [grid, setGridState] = useState(lastGrid);
  const setGrid = (v: number) => setGridState((lastGrid = v));
  const [cursor, setCursor] = useState<P>({ x: 0, y: 0 });
  /** Unsnapped pointer, for hover hit tests. */
  const [hover, setHover] = useState<P>({ x: -1e9, y: -1e9 });
  const [view, setView] = useState<View>({ x: 40, y: 40, zoom: 4 });
  const [space, setSpace] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 640, h: 440 });

  const valid = sel.filter((i) => i < prims.length);
  const single = valid.length === 1 ? prims[valid[0]] : null;

  /* ---------------------------- view ---------------------------- */

  const fit = (w = size.w, h = size.h) => {
    const pad = 40;
    const zoom = Math.max(0.5, Math.min(40, Math.min((w - pad * 2) / src.w, (h - pad * 2) / src.h)));
    setView({ zoom, x: (w - src.w * zoom) / 2, y: (h - src.h * zoom) / 2 });
  };
  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setSize({ w: r.width, h: r.height });
    fit(r.width, r.height);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zoomAt = (factor: number, sx = size.w / 2, sy = size.h / 2) =>
    setView((v) => {
      const zoom = Math.max(0.5, Math.min(40, v.zoom * factor));
      const k = zoom / v.zoom;
      return { zoom, x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k };
    });

  // wheel zooms at the cursor (non-passive so the dialog doesn't scroll)
  useEffect(() => {
    const el = wrapRef.current!;
    // the same rules as the schematic: the wheel preference, Ctrl / pinch zooms, Shift scrolls sideways
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? r.height : 1;
      const deltaX = e.deltaX * unit;
      const deltaY = e.deltaY * unit;
      if ((e.ctrlKey || e.metaKey || S().prefs.wheel === 'zoom') && !e.shiftKey) {
        zoomAt(Math.exp(-deltaY * (e.ctrlKey && Math.abs(deltaY) < 50 ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
        return;
      }
      const dx = e.shiftKey && !deltaX ? deltaY : deltaX;
      const dy = e.shiftKey && !deltaX ? 0 : deltaY;
      setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const toWorld = (e: { clientX: number; clientY: number }): P => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.zoom, y: (e.clientY - r.top - view.y) / view.zoom };
  };
  const snap = (p: P, free = false): P => {
    const step = free || !snapOn ? 1 : grid;
    return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
  };
  /** Grid step for a gesture: 1 with snapping off or Alt held. */
  const stepFor = (alt: boolean) => (alt || !snapOn ? 1 : grid);

  /* -------------------------- editing --------------------------- */

  /** `closed`: ended on the first point, so it is a closed outline even without a fill. */
  const finishPoly = (closed = false) => {
    if (poly && poly.length >= 4) {
      const pts = poly;
      apply((s) => void s.prims.push(withStyle(fill === 'none' && !closed ? { t: 'line', pts } : { t: 'poly', pts, fill }, style)));
      setSel([prims.length]);
    }
    setPoly(null);
  };

  const dupSel = () => {
    if (!valid.length) return;
    const copies = valid.map((i) => movePrim(structuredClone(prims[i]), 5, 5));
    apply((s) => void s.prims.push(...copies));
    setSel(copies.map((_, k) => prims.length + k));
  };
  const delSel = () => {
    if (!valid.length) return;
    const del = new Set(valid);
    apply((s) => void (s.prims = s.prims.filter((_, i) => !del.has(i))));
    setSel([]);
  };
  const paste = () => {
    if (!clipboard.length) return;
    const copies = clipboard.map((p) => movePrim(structuredClone(p), 10, 10));
    clipboard = copies;
    apply((s) => void s.prims.push(...copies));
    setSel(copies.map((_, k) => prims.length + k));
  };
  /** Moves the selection to the front (end of the list) or back. */
  const restack = (front: boolean) => {
    if (!valid.length) return;
    const pick = new Set(valid);
    const chosen = prims.filter((_, i) => pick.has(i));
    const rest = prims.filter((_, i) => !pick.has(i));
    apply((s) => void (s.prims = front ? [...rest, ...chosen] : [...chosen, ...rest]));
    setSel(chosen.map((_, k) => (front ? rest.length + k : k)));
  };
  const updSel = (fn: (p: Prim) => Prim, key?: string) => {
    if (!valid.length) return;
    apply((s) => {
      for (const i of valid) s.prims[i] = fn(s.prims[i]);
    }, key ?? true);
  };
  const setSelFill = (f: Fill) => {
    setFill(f);
    updSel((p) => ('fill' in p ? ({ ...p, fill: f } as Prim) : p.t === 'line' && f !== 'none' ? ({ ...p, t: 'poly', fill: f } as Prim) : p));
  };
  const setSelWidth = (w: number) => {
    setStyle({ w });
    updSel((p) => (p.t === 'rect' ? { ...p, sw: w } : p.t === 'text' ? p : ({ ...p, w } as Prim)), 'width');
  };
  const setSelColor = (v: string) => {
    const color = v || undefined;
    setStyle({ color });
    updSel((p) => ({ ...p, color }) as Prim, 'color');
  };
  const setSelFillColor = (v: string) => {
    const fc = v || undefined;
    setStyle({ fc });
    updSel((p) => ('fill' in p ? ({ ...p, fc } as Prim) : p), 'fill-colour');
  };
  const setSelDash = (dash: boolean) => {
    setStyle({ dash: dash || undefined });
    updSel((p) => (p.t === 'text' ? p : ({ ...p, dash: dash || undefined } as Prim)));
  };
  /** What the style controls show: the selected shape's style, or the style for new shapes. */
  const shown = single ? { color: single.color, fc: single.fc, dash: !!single.dash, w: widthOf(single), fill: 'fill' in single ? single.fill : fill } : { ...style, dash: !!style.dash, fill };

  const selectTool = (t: Tool) => {
    finishPoly();
    setTool(t);
  };

  /** Esc: cancel the current action → back to the select tool → clear the selection → (modal closes). */
  escRef.current = () => {
    if (poly) {
      setPoly(null);
      return true;
    }
    if (g) {
      setG(null);
      return true;
    }
    if (tool !== 'select') {
      setTool('select');
      return true;
    }
    if (valid.length) {
      setSel([]);
      return true;
    }
    return false;
  };

  /* -------------------------- keyboard -------------------------- */

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      const combo = eventToCombo(e);
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.code === 'Space' && !e.ctrlKey && !e.metaKey) {
        take();
        setSpace(true);
        return;
      }
      if (combo === 'Mod+Z') return take(), onUndo();
      if (combo === 'Mod+Shift+Z' || combo === 'Mod+Y') return take(), onRedo();
      if (combo === 'Mod+A') return take(), setSel(prims.map((_, i) => i));
      if (combo === 'Mod+C') return take(), void (clipboard = valid.map((i) => structuredClone(prims[i])));
      if (combo === 'Mod+X') {
        take();
        clipboard = valid.map((i) => structuredClone(prims[i]));
        return delSel();
      }
      if (combo === 'Mod+V') return take(), paste();
      if (combo === 'Mod+D') return take(), dupSel();
      if (combo === 'Mod+]') return take(), restack(true);
      if (combo === 'Mod+[') return take(), restack(false);
      if (combo === '=' || combo === '+' || combo === 'Shift+=') return take(), zoomAt(1.25);
      if (combo === '-') return take(), zoomAt(0.8);
      if (combo === '0' || combo === 'F' || combo === 'Shift+1') return take(), fit();
      if (combo === 'Enter' && poly) return take(), finishPoly();
      if (poly && (combo === 'Delete' || combo === 'Backspace')) {
        take();
        if (poly.length >= 4) setPoly(poly.slice(0, -2));
        else setPoly(null);
        return;
      }
      if (combo === 'Delete' || combo === 'Backspace') return take(), delSel();
      const hot = (Object.keys(TOOL_KEYS) as Tool[]).find((k) => TOOL_KEYS[k] === combo);
      if (hot) return take(), selectTool(hot);
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const base = combo.replace(/^(Mod\+)?(Shift\+)?/, '');
      if (arrows[base]) {
        take();
        // as on the schematic: one grid step, Shift five, Ctrl one unit
        const one = snapOn ? grid : 1;
        const step = combo.startsWith('Mod+') ? 1 : combo.includes('Shift+') ? one * 5 : one;
        const [dx, dy] = [arrows[base][0] * step, arrows[base][1] * step];
        if (poly) return setPoly([...poly.slice(0, -2), poly[poly.length - 2] + dx, poly[poly.length - 1] + dy]);
        updSel((p) => movePrim(p, dx, dy), `nudge-${valid.join(',')}`);
      }
    };
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpace(false);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  });

  /* --------------------------- pointer --------------------------- */

  const tol = 5 / view.zoom;
  const hitPrim = (q: P) => {
    for (let i = prims.length - 1; i >= 0; i--) if (primHit(prims[i], q, tol)) return i;
    return null;
  };
  const hitHandle = (q: P) => (single ? primHandles(single).find((h) => Math.hypot(h.x - q.x, h.y - q.y) <= 6 / view.zoom) : undefined);
  const hitPin = (q: P) => ports.findIndex((p) => Math.hypot(p.x - q.x, p.y - q.y) <= 6 / view.zoom);
  const sizeHandles = boxHandles({ x: 0, y: 0, w: src.w, h: src.h });
  const hitSize = (q: P) => sizeHandles.find((h) => Math.hypot(h.x - q.x, h.y - q.y) <= 7 / view.zoom);
  /** Several shapes, or one without handles of its own (text, arc, path), scale by a box around them. */
  const selBox = tool === 'select' && valid.length && (valid.length > 1 || !primHandles(prims[valid[0]]).length) ? unionBounds(valid.map((i) => prims[i])) : null;
  const scaleHandles = selBox ? boxHandles({ x: selBox.x - 2, y: selBox.y - 2, w: selBox.w + 4, h: selBox.h + 4 }) : [];
  const hitScale = (q: P) => scaleHandles.find((h) => Math.hypot(h.x - q.x, h.y - q.y) <= 6 / view.zoom);
  const client = (e: { clientX: number; clientY: number }): P => ({ x: e.clientX, y: e.clientY });

  const onDown = (e: React.PointerEvent) => {
    wrapRef.current!.setPointerCapture(e.pointerId);
    const raw = toWorld(e);
    if (e.button === 1 || space) {
      setG({ kind: 'pan', client: { x: e.clientX, y: e.clientY }, view });
      return;
    }
    if (e.button !== 0) return;
    const p = snap(raw, e.altKey);
    if (tool === 'select') {
      const h = hitHandle(raw);
      if (h && valid.length === 1) return setG({ kind: 'handle', idx: valid[0], key: h.key, base: prims[valid[0]], client: client(e), moved: false });
      const sc = hitScale(raw);
      if (sc && selBox) return setG({ kind: 'scale', key: sc.key, box: selBox, base: prims, ids: valid, client: client(e), moved: false });
      const pin = hitPin(raw);
      if (pin >= 0) return setG({ kind: 'pin', idx: pin, moved: false });
      const sh = hitSize(raw);
      if (sh) return setG({ kind: 'size', key: sh.key, base: { w: src.w, h: src.h, prims, ports: ports.map((q) => ({ ...q })) }, view, client: client(e), moved: false });
      const i = hitPrim(raw);
      if (i === null) {
        if (!e.shiftKey) setSel([]);
        return setG({ kind: 'marquee', start: raw, cur: raw, add: e.shiftKey });
      }
      if (e.shiftKey) return setSel(valid.includes(i) ? valid.filter((k) => k !== i) : [...valid, i]);
      const ids = valid.includes(i) ? valid : [i];
      setSel(ids);
      return setG({ kind: 'move', start: raw, client: client(e), base: prims.map((q) => q), ids, moved: false });
    }
    if (tool === 'pin') {
      const x = Math.min(src.w, Math.max(0, s10(raw.x)));
      const y = Math.min(src.h, Math.max(0, s10(raw.y)));
      const side = inferSide(x, y, src.w, src.h);
      const pos = side === 'left' ? { x: 0, y } : side === 'right' ? { x: src.w, y } : side === 'top' ? { x, y: 0 } : { x, y: src.h };
      const existing = ports.findIndex((q) => q.x === pos.x && q.y === pos.y);
      if (existing >= 0) return apply((s) => void s.ports.splice(existing, 1));
      let n = ports.length + 1;
      while (ports.some((q) => q.id === String(n))) n++;
      apply((s) => void s.ports.push({ id: String(n), name: String(n), ...pos, side }));
      return;
    }
    if (tool === 'text') {
      // drop a text and select it; its content is edited in the properties bar
      apply((s) => void s.prims.push(withStyle({ t: 'text', x: p.x, y: p.y, size: 10, anchor: 'middle', text: 'Text' }, style)));
      setSel([prims.length]);
      setTimeout(() => document.querySelector<HTMLInputElement>('[data-se-text]')?.select(), 30);
      return;
    }
    if (tool === 'poly') {
      if (poly && e.detail >= 2) return finishPoly();
      // clicking the first point again closes the polygon (too few points: ignored)
      if (poly && Math.hypot(p.x - poly[0], p.y - poly[1]) <= 6 / view.zoom) {
        if (poly.length >= 6) finishPoly(true);
        return;
      }
      setPoly([...(poly ?? []), p.x, p.y]);
      return;
    }
    setG({ kind: 'draw', start: p, cur: p });
  };

  const onMove = (e: React.PointerEvent) => {
    const raw = toWorld(e);
    const p = snap(raw, e.altKey);
    setCursor(p);
    setHover(raw);
    if (!g) return;
    switch (g.kind) {
      case 'pan':
        setView({ ...g.view, x: g.view.x + e.clientX - g.client.x, y: g.view.y + e.clientY - g.client.y });
        return;
      case 'draw':
        setG({ ...g, cur: p });
        return;
      case 'marquee':
        setG({ ...g, cur: raw });
        return;
      case 'move': {
        // as on the schematic: a small slop before it counts, the distance (not the cursor) snaps, Shift keeps to one axis
        if (!g.moved && Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < DRAG_SLOP) return;
        const step = stepFor(e.altKey);
        let dx = Math.round((raw.x - g.start.x) / step) * step;
        let dy = Math.round((raw.y - g.start.y) / step) * step;
        if (e.shiftKey) {
          if (Math.abs(raw.x - g.start.x) > Math.abs(raw.y - g.start.y)) dy = 0;
          else dx = 0;
        }
        if (!g.moved && !dx && !dy) return;
        const ids = new Set(g.ids);
        // the first real movement records the undo step; the rest of the drag updates in place
        apply((s) => void (s.prims = g.base.map((q, i) => (ids.has(i) ? movePrim(q, dx, dy) : q))), !g.moved);
        if (!g.moved) setG({ ...g, moved: true });
        return;
      }
      case 'handle': {
        if (!g.moved && Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < DRAG_SLOP) return;
        const b = g.base;
        // a rectangle resizes like a schematic shape: Shift keeps its proportions, Ctrl grows it about its centre
        const next =
          b.t === 'rect'
            ? { ...b, ...mapRect(resizeInFrame(b, 0, g.key as BoxHandle, raw, 1, stepFor(e.altKey), { aspect: e.shiftKey, centre: e.ctrlKey || e.metaKey })) }
            : applyHandle(b, g.key, p);
        apply((s) => void (s.prims[g.idx] = next), !g.moved);
        if (!g.moved) setG({ ...g, moved: true });
        return;
      }
      case 'scale': {
        if (!g.moved && Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < DRAG_SLOP) return;
        const b0 = g.box;
        const nb = resizeInFrame(b0, 0, g.key, raw, 1, stepFor(e.altKey), { aspect: e.shiftKey, centre: e.ctrlKey || e.metaKey });
        const kx = b0.w ? nb.w / b0.w : 1;
        const ky = b0.h ? nb.h / b0.h : 1;
        const ids = new Set(g.ids);
        apply((s) => {
          s.prims = g.base.map((q, i) => (ids.has(i) ? movePrim(scalePrim(q, b0.x, b0.y, kx, ky), r2(nb.x - b0.x), r2(nb.y - b0.y)) : q));
        }, !g.moved);
        if (!g.moved) setG({ ...g, moved: true });
        return;
      }
      case 'pin': {
        // pins slide along the outline on the 10px schematic grid
        const x = Math.min(src.w, Math.max(0, s10(raw.x)));
        const y = Math.min(src.h, Math.max(0, s10(raw.y)));
        const side = inferSide(x, y, src.w, src.h);
        const pos = side === 'left' ? { x: 0, y } : side === 'right' ? { x: src.w, y } : side === 'top' ? { x, y: 0 } : { x, y: src.h };
        const cur = ports[g.idx];
        if (!cur || (cur.x === pos.x && cur.y === pos.y)) return;
        if (ports.some((q, i) => i !== g.idx && q.x === pos.x && q.y === pos.y)) return;
        apply((s) => void (s.ports[g.idx] = { ...s.ports[g.idx], ...pos, side }), !g.moved);
        if (!g.moved) setG({ ...g, moved: true });
        return;
      }
      case 'size': {
        // any edge or corner; the outline stays on the pin grid so wires still meet the pins
        if (!g.moved && Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < DRAG_SLOP) return;
        const k = g.key;
        const { w: bw, h: bh } = g.base;
        // the top-left of the outline is the symbol's origin, so dragging it moves the origin
        const ox = k.includes('w') ? Math.min(bw - PIN_GRID, s10(raw.x)) : 0;
        const oy = k.includes('n') ? Math.min(bh - PIN_GRID, s10(raw.y)) : 0;
        const w = k.includes('w') ? Math.min(MAX_SIZE, bw - ox) : k.includes('e') ? r10(raw.x) : bw;
        const h = k.includes('n') ? Math.min(MAX_SIZE, bh - oy) : k.includes('s') ? r10(raw.y) : bh;
        const fx = k.includes('w') ? bw - w : 0;
        const fy = k.includes('n') ? bh - h : 0;
        apply((s) => resizeOutline(s, g.base, fx, fy, w, h), !g.moved);
        // ...and the view shifts with it, so nothing jumps on screen
        setView({ ...g.view, x: g.view.x + fx * g.view.zoom, y: g.view.y + fy * g.view.zoom });
        if (!g.moved) setG({ ...g, moved: true });
        return;
      }
    }
  };

  const onUp = () => {
    if (!g) return;
    if (g.kind === 'draw') {
      const { start: a, cur: b } = g;
      if (a.x !== b.x || a.y !== b.y) {
        const prim = dragShape(tool, a, b, fill);
        if (prim) {
          apply((s) => void s.prims.push(withStyle(prim, style)));
          setSel([prims.length]);
        }
      }
    }
    if (g.kind === 'marquee') {
      const x0 = Math.min(g.start.x, g.cur.x);
      const y0 = Math.min(g.start.y, g.cur.y);
      const x1 = Math.max(g.start.x, g.cur.x);
      const y1 = Math.max(g.start.y, g.cur.y);
      if (x1 - x0 > 1 || y1 - y0 > 1) {
        const hits = prims
          .map((q, i) => ({ b: primBounds(q), i }))
          .filter(({ b }) => b.x <= x1 && b.x + b.w >= x0 && b.y <= y1 && b.y + b.h >= y0)
          .map(({ i }) => i);
        setSel(g.add ? [...new Set([...valid, ...hits])] : hits);
      }
    }
    setG(null);
  };

  /* --------------------------- render --------------------------- */

  const z = view.zoom;
  // hovering the first point of a polygon: the preview closes onto it
  const polyClose = poly && poly.length >= 6 && Math.hypot(cursor.x - poly[0], cursor.y - poly[1]) <= 6 / z ? { x: poly[0], y: poly[1] } : null;
  const draftEnd = polyClose ?? cursor;
  const rawDraft: Prim | null = poly ? { t: 'line', pts: [...poly, draftEnd.x, draftEnd.y] } : g?.kind === 'draw' ? dragShape(tool, g.start, g.cur, fill) : null;
  const draft = rawDraft && withStyle(rawDraft, style);
  const activeKey = g?.kind === 'scale' || g?.kind === 'size' ? g.key : g?.kind === 'handle' ? g.key : undefined;
  const hoverKey = tool === 'select' && !g ? (hitHandle(hover) ?? hitScale(hover) ?? hitSize(hover))?.key : activeKey;
  const handleCursor = hoverKey && hoverKey in HANDLE_CURSOR ? HANDLE_CURSOR[hoverKey as BoxHandle] : hoverKey ? 'crosshair' : undefined;
  const cursorStyle =
    g?.kind === 'pan' ? 'grabbing' : space ? 'grab' : g?.kind === 'move' ? 'move' : handleCursor ? handleCursor : tool === 'select' ? (hitPrim(hover) !== null || hitPin(hover) >= 0 ? 'move' : 'default') : 'crosshair';

  const tools: [Tool, JSX.Element, string][] = [
    ['select', <MousePointer2 size={15} />, 'Select & move · drag handles to resize · drag pins along the outline'],
    ['line', <Slash size={15} />, 'Line (drag)'],
    ['poly', <Spline size={15} />, 'Polyline / polygon (click points, Enter or double-click to finish)'],
    ['rect', <Square size={15} />, 'Rectangle (drag)'],
    ['circle', <Circle size={15} />, 'Circle (drag from centre)'],
    ['ellipse', <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><ellipse cx="12" cy="12" rx="10" ry="6" /></svg>, 'Ellipse (drag from centre)'],
    ['text', <Type size={15} />, 'Text (click to place)'],
    ['pin', <Pin size={15} />, 'Pin (click on the outline, click a pin to remove it)'],
  ];

  const toolNote =
    tool === 'pin'
      ? 'Click on the dashed outline to add a pin; click an existing pin to remove it.'
      : tool === 'poly'
        ? 'Click to add points · click the first point to close · Enter or double-click to finish · Backspace removes the last point · Esc cancels.'
        : tool === 'select'
          ? 'Click / Shift+click / drag a box to select · drag to move (Shift: one axis) · handles resize (Shift: keep proportions, Ctrl: from the centre) · drag any edge or corner of the dashed outline to resize the symbol.'
          : tool === 'text'
            ? 'Click to place text, then type it in the bar above.'
            : 'Drag to draw · hold Alt to draw off-grid.';

  return (
    <div className="se-draw">
      <div className="se-toolbar">
        {tools.map(([t, icon, title]) => (
          <button key={t} className={tool === t ? 'tool-btn active' : 'tool-btn'} title={`${title} — ${TOOL_KEYS[t]}`} onClick={() => selectTool(t)}>
            {icon}
            <span className="tool-key">{TOOL_KEYS[t]}</span>
          </button>
        ))}
        <span className="rail-sep v" />
        <button className="tool-btn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}>
          <Undo2 size={15} />
        </button>
        <button className="tool-btn" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo}>
          <Redo2 size={15} />
        </button>
        <span className="rail-sep v" />
        <button className={snapOn ? 'tool-btn active-soft' : 'tool-btn'} title={`Snap to the ${grid}px grid: ${snapOn ? 'on' : 'off'} (hold Alt to ignore)`} onClick={() => setSnapOn(!snapOn)}>
          <Magnet size={15} />
        </button>
        <select className="input se-grid" value={grid} title="Drawing grid (pins and the outline always use the 10px schematic grid)" onChange={(e) => setGrid(Number(e.target.value))}>
          {GRIDS.map((v) => (
            <option key={v} value={v}>
              {v}px grid
            </option>
          ))}
        </select>
        <span className="grow" />
        <span className="se-zoom">
          <button className="tool-btn" title="Zoom out (−)" onClick={() => zoomAt(0.8)}>
            <Minus size={14} />
          </button>
          <button className="se-zoom-val" title="Fit to view (0)" onClick={() => fit()}>
            {Math.round(z * 25)}%
          </button>
          <button className="tool-btn" title="Zoom in (+)" onClick={() => zoomAt(1.25)}>
            <Plus size={14} />
          </button>
          <button className="tool-btn" title="Fit (0)" onClick={() => fit()}>
            <Maximize2 size={14} />
          </button>
        </span>
        <span className="se-size">
          <NumberInput value={src.w} min={PIN_GRID} max={MAX_SIZE} step={PIN_GRID} suffix="w" onChange={(v) => apply((s) => resizeOutline(s, { w: src.w, h: src.h, prims, ports }, 0, 0, r10(v), src.h))} />
          <NumberInput value={src.h} min={PIN_GRID} max={MAX_SIZE} step={PIN_GRID} suffix="h" onChange={(v) => apply((s) => resizeOutline(s, { w: src.w, h: src.h, prims, ports }, 0, 0, src.w, r10(v)))} />
        </span>
      </div>

      <div className="se-props">
        <span className="se-props-label">{valid.length ? `${valid.length} selected` : 'New shapes'}</span>
        <Segmented
          value={shown.fill}
          options={[
            { value: 'none', label: 'Outline' },
            { value: 'solid', label: 'Filled' },
            { value: 'bg', label: 'Opaque' },
          ]}
          onChange={setSelFill}
        />
        <span className="se-style" title="Line colour (empty: follows the theme)">
          <span className="se-props-label">Line colour</span>
          <ColorInput value={shown.color ?? ''} onChange={setSelColor} allowNone />
        </span>
        {shown.fill === 'solid' && (
          <span className="se-style" title="Fill colour (empty: same as the line)">
            <span className="se-props-label">Fill colour</span>
            <ColorInput value={shown.fc ?? ''} onChange={setSelFillColor} allowNone />
          </span>
        )}
        <span className="se-style" title="Line width">
          <span className="se-props-label">Line width</span>
          <span className="se-num">
            <NumberInput value={shown.w} min={0.5} max={10} step={0.5} suffix="px" onChange={setSelWidth} />
          </span>
        </span>
        <span className="se-style" title="Line style">
          <Segmented
            value={shown.dash ? 'dash' : 'solid'}
            options={[
              { value: 'solid', label: 'Solid', title: 'Solid lines' },
              { value: 'dash', label: 'Dashed', title: 'Dashed lines' },
            ]}
            onChange={(v) => setSelDash(v === 'dash')}
          />
        </span>
        {valid.length > 0 && (
          <>
            {single?.t === 'text' && (
              <>
                <span className="se-text-input">
                  <TextInput value={single.text} onChange={(text) => updSel((p) => (p.t === 'text' ? { ...p, text } : p), `text-${valid[0]}`)} placeholder="Text" />
                </span>
                <span className="se-num">
                  <NumberInput value={single.size} min={4} max={60} suffix="pt" onChange={(size) => updSel((p) => (p.t === 'text' ? { ...p, size } : p), `tsize-${valid[0]}`)} />
                </span>
                <Segmented
                  value={single.anchor}
                  options={[
                    { value: 'start', label: 'Left' },
                    { value: 'middle', label: 'Centre' },
                    { value: 'end', label: 'Right' },
                  ]}
                  onChange={(anchor) => updSel((p) => (p.t === 'text' ? { ...p, anchor } : p))}
                />
              </>
            )}
            {single?.t === 'rect' && (
              <span className="se-num" title="Corner radius">
                <NumberInput value={single.rx ?? 0} min={0} max={50} suffix="r" onChange={(rx) => updSel((p) => (p.t === 'rect' ? { ...p, rx } : p), `rx-${valid[0]}`)} />
              </span>
            )}
            <span className="grow" />
            <button className="tool-btn" title="Bring to front (Ctrl+])" onClick={() => restack(true)}>
              <ArrowUpToLine size={15} />
            </button>
            <button className="tool-btn" title="Send to back (Ctrl+[)" onClick={() => restack(false)}>
              <ArrowDownToLine size={15} />
            </button>
            <button className="tool-btn" title="Duplicate (Ctrl+D)" onClick={dupSel}>
              <Copy size={15} />
            </button>
            <button className="tool-btn" title="Delete (Del)" onClick={delSel}>
              <Trash2 size={15} />
            </button>
          </>
        )}
      </div>

      <div ref={wrapRef} className="se-canvas" style={{ cursor: cursorStyle }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setG(null)} onDoubleClick={() => poly && finishPoly()}>
        <svg width="100%" height="100%">
          <defs>
            <pattern id="se-grid" width={grid * z} height={grid * z} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
              <circle cx={0.6} cy={0.6} r={0.6} className="grid-dot" />
            </pattern>
            <pattern id="se-grid10" width={PIN_GRID * z} height={PIN_GRID * z} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
              <circle cx={1} cy={1} r={1.2} className="grid-dot-major" />
            </pattern>
          </defs>
          {grid < PIN_GRID && grid * z >= 7 && <rect width="100%" height="100%" fill="url(#se-grid)" />}
          <rect width="100%" height="100%" fill="url(#se-grid10)" />
          <g transform={`translate(${view.x} ${view.y}) scale(${z})`}>
            <rect x={0} y={0} width={src.w} height={src.h} className="se-bounds" strokeWidth={1 / z} strokeDasharray={`${3 / z} ${3 / z}`} />
            <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" className="se-prims">
              {prims.map((p, i) =>
                p.t === 'text' ? (
                  <text key={i} x={p.x} y={p.y} fontSize={p.size} textAnchor={p.anchor} fill={p.color ?? 'currentColor'} stroke="none">
                    {p.text}
                  </text>
                ) : (
                  <PrimEl key={i} p={p} sw={2} />
                ),
              )}
              {draft && (
                <g opacity={0.6}>
                  <PrimEl p={draft} sw={2} />
                </g>
              )}
            </g>
            {valid.map((i) => {
              const b = primBounds(prims[i]);
              return <rect key={i} x={b.x - 2} y={b.y - 2} width={b.w + 4} height={b.h + 4} className="se-sel" strokeWidth={1 / z} />;
            })}
            {single &&
              tool === 'select' &&
              primHandles(single).map((h) => (
                <rect key={h.key} x={h.x - 3.5 / z} y={h.y - 3.5 / z} width={7 / z} height={7 / z} rx={1.5 / z} className="se-handle" strokeWidth={1.4 / z} />
              ))}
            {scaleHandles.map((h) => (
              <rect key={`scale-${h.key}`} x={h.x - 3.5 / z} y={h.y - 3.5 / z} width={7 / z} height={7 / z} rx={1.5 / z} className="se-handle" strokeWidth={1.4 / z} />
            ))}
            {tool === 'select' &&
              sizeHandles.map((h) => (
                <rect key={h.key} x={h.x - 4 / z} y={h.y - 4 / z} width={8 / z} height={8 / z} rx={2 / z} className="se-size-handle" strokeWidth={1.4 / z}>
                  <title>Drag to resize the symbol</title>
                </rect>
              ))}
            {ports.map((p) => (
              <g key={`${p.id}-${p.x},${p.y}`}>
                <circle cx={p.x} cy={p.y} r={3} className="se-pin" />
                <text x={p.x + (p.side === 'left' ? -5 : p.side === 'right' ? 5 : 0)} y={p.y + (p.side === 'top' ? -6 : p.side === 'bottom' ? 11 : 3)} textAnchor={p.side === 'left' ? 'end' : p.side === 'right' ? 'start' : 'middle'} className="se-pin-label">
                  {p.id}
                </text>
              </g>
            ))}
            {g?.kind === 'marquee' && (
              <rect x={Math.min(g.start.x, g.cur.x)} y={Math.min(g.start.y, g.cur.y)} width={Math.abs(g.cur.x - g.start.x)} height={Math.abs(g.cur.y - g.start.y)} className="marquee" strokeWidth={1 / z} />
            )}
            {tool !== 'select' && <circle cx={cursor.x} cy={cursor.y} r={2 / z + 0.8} className="se-cursor" />}
            {poly && poly.length >= 2 && <circle cx={poly[poly.length - 2]} cy={poly[poly.length - 1]} r={3 / z + 1} className="se-cursor" />}
            {polyClose && <circle cx={polyClose.x} cy={polyClose.y} r={4 / z} strokeWidth={1.4 / z} className="se-handle" />}
          </g>
        </svg>
        <div className="se-coords">
          {cursor.x}, {cursor.y}
        </div>
      </div>
      <div className="se-help muted small">
        <div className="se-tool-note">{toolNote}</div>
        Wheel and Space / middle-drag work as on the schematic · <kbd>F</kbd> fit · <kbd>Esc</kbd> cancels, then deselects · <kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>V</kbd>/<kbd>D</kbd> copy/paste/duplicate · arrows nudge (Shift: ×5, Ctrl: 1px) · <kbd>Alt</kbd> ignores the grid. Pins and the outline stay on the 10px schematic grid.
      </div>
    </div>
  );
}
