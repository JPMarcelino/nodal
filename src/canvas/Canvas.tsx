import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { measureRich } from '../model/richText';
import { drawOrderCached, itemBounds, labelsShown, makeShape } from '../model/doc';
import { componentBounds, dist, eq, pointInRect, projectOnSegment, rectFromPoints, snap, toWorld } from '../model/geometry';
import { cleanup, deleteWirePart, translateDetached, translateItems } from '../model/ops';
import { getSymbol, instanceSymbol } from '../model/registry';
import { gridScale, scaleStep } from '../model/symbols/scale';
import type { CircuitDoc, ComponentItem, Endpoint, LabelSide, Point, Rect, ShapeItem, ShapeKind, Tool, WireItem } from '../model/types';
import { buildWirePath, endpointInfo, hitWire, moveWireNode, projectAlong, snapOnSegment, wireLabelSpot, wireStyle } from '../model/wires';
import { wireStyleFor } from '../model/bus';
import { computeNets, netOfWire } from '../model/netlist';
import { buildAngledPreview, buildWirePreview, commitWire as commitWireDoc, moveWireSegment, reconnectWireEnd, wireRouter } from '../model/wireCommit';
import { routeObstacles } from '../model/route';
import { runAreaExport } from '../io/fileActions';
import { importDroppedFiles } from '../io/importFiles';
import * as A from '../store/actions';
import { S, beginGesture, endGesture, gestureBaseDoc, gestureUpdate, inGesture, mutate, rebaseGesture, select, set, toast, useStore } from '../store/store';
import { alignAnchors, alignMove, type AlignIndex, type Guide } from '../model/align';
import { canvasActions } from '../store/canvasActions';
import { ArrowHeadEl, ComponentView, EDITOR_PALETTE, Scene, clampTitleOffset, dashArray, hasMovableTitle, frameTag, frozenLabelOffsets, inkColor, labelBox, labelLayout, labelLook, shapeTitle, useSceneData } from './Scene';
import { Minimap } from './Minimap';
import { ExplainLayer } from './ExplainLayer';
import { inkHit } from '../model/ink';
import { constrain45, deletePolyCorner, dragPolyPart, packPoly, polyHit, polyPoints, setPolyPoints } from '../model/polygon';
import { X, setX, useExplain } from '../store/explain';
import { FollowFrame, RemotePresence } from './RemotePresence';
import { useErcIssues } from '../ui/CheckPanel';
import { HotSpotMenu } from './HotSpotMenu';
import { marqueeHits } from '../model/marquee';
import { gestureSlots, hitSlop, useTouchInput } from './touch';
import { applySolder, solderActionFor } from './solder';
import { computeHotSpots, hotSpotKey, type HotSpot } from '../model/hotspots';

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */

type Target =
  | { kind: 'port'; comp: string; port: string; pt: Point; dir: Point }
  | { kind: 'junction'; id: string; pt: Point }
  | { kind: 'wireEnd'; wire: string; end: 'a' | 'b'; pt: Point }
  | { kind: 'wire'; wire: string; seg: number; pt: Point }
  | { kind: 'grid'; pt: Point };

interface PortInfo {
  comp: string;
  port: string;
  pt: Point;
  dir: Point;
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'p1' | 'p2';

type Gesture =
  | { kind: 'pan'; client: Point; view: { x: number; y: number } }
  | { kind: 'marquee'; start: Point; cur: Point; additive: boolean }
  /**
   * `pick`: selected by a click without a drag: the item pressed when it was already
   * part of a larger selection, or the next item down when items overlap. `floating`: a keyboard
   * move (Cadence m / c) that follows the pointer until the next click.
   */
  /** `rejoin`: a wires-only move; ends dropped exactly on a pin, junction or wire end connect there. */
  | { kind: 'move'; start: Point; ids: Set<string>; moved: boolean; client: Point; detach: boolean; dx: number; dy: number; pick?: string; floating?: boolean; rejoin?: boolean }
  /** `postureSet`: the bend direction was flipped by hand, so the pointer no longer picks it. */
  /** `angled`: a clicked vertex already has a diagonal, so the wire keeps them (straight-routed) whatever the angle mode. */
  | { kind: 'wire'; start: Target; pts: Point[]; hFirst: boolean; fromDrag: boolean; downClient: Point; cur: Target; dragging: boolean; postureSet?: boolean; angled?: boolean }
  /** `pick`: a click without a drag selects this item instead (the next one down under the pointer). */
  | { kind: 'segment'; wire: string; seg: number; base: Point[]; start: Point; moved: boolean; pick?: string }
  | { kind: 'endpoint'; wire: string; end: 'a' | 'b'; cur: Target; moved: boolean }
  | { kind: 'node'; wire: string; idx: number; base: Point[]; cur: Point; free: boolean; moved: boolean }
  | { kind: 'shape'; shape: ShapeKind; start: Point; cur: Point }
  /** Edit points on a polygon: dragging corner `idx`, or with `edge` the edge from corner `idx` to the next one. */
  | { kind: 'polyPart'; id: string; base: Point[]; idx: number; edge: boolean; start: Point; moved: boolean }
  /** Polygon being clicked out corner by corner; it closes when a click lands back on the first corner. */
  | { kind: 'polygon'; pts: Point[]; cur: Point }
  | { kind: 'exportArea'; start: Point; cur: Point }
  | { kind: 'resize'; id: string; handle: Handle; base: ShapeItem; start: Point }
  /** Resizing a part from a corner handle: its size follows the distance from its centre. */
  | { kind: 'scale'; id: string; base: number; d0: number }
  | { kind: 'label'; id: string; which: 'ref' | 'value'; start: Point; base: { dx: number; dy: number }; frozen: ReturnType<typeof frozenLabelOffsets> }
  /** Sliding a wire's net label along its net, to either side of the wire. */
  | { kind: 'wireLabel'; id: string; net: string[] }
  | { kind: 'shapeTitle'; id: string; start: Point; base: { dx: number; dy: number } }
  /** Cadence m / c pressed: waiting for the click on the reference point (or on what to move) before anything follows the pointer. */
  | { kind: 'arm'; detach: boolean; copy: boolean };

const ORTHO_EPS = 0.01;

const isDiagonal = (a: Point, b: Point) => Math.abs(a.x - b.x) > ORTHO_EPS && Math.abs(a.y - b.y) > ORTHO_EPS;

const NO_HOTSPOTS: HotSpot[] = [];

/** Live hooks for the global keyboard handler. */
export const canvasKeys: { handle: ((combo: string) => boolean) | null } = { handle: null };

/* ------------------------------------------------------------------ */
/* Tool indicator cursors                                              */
/* ------------------------------------------------------------------ */

const PLUS_GLYPH = '<path d="M6.5 3.5v6M3.5 6.5h6" stroke="#1f2433" stroke-width="1.4" stroke-linecap="round"/>';
const AREA_GLYPH = '<path d="M3.5 5.5v-2h2M8.5 3.5h2v2M10.5 8.5v2h-2M5.5 10.5h-2v-2" stroke="#1f2433" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
const BADGE_GLYPHS: Partial<Record<Tool, string>> = {
  wire: '<polyline points="3,5 5.5,5 6.5,9.5 10,4" fill="none" stroke="#1f2433" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  rect: '<rect x="3" y="3.5" width="7" height="6" rx="1" fill="none" stroke="#1f2433" stroke-width="1.4"/>',
  zone: '<rect x="3" y="3.5" width="7" height="6" rx="1" fill="#1f2433" fill-opacity="0.35" stroke="#1f2433" stroke-width="1.4"/>',
  ellipse: '<circle cx="6.5" cy="6.5" r="3.4" fill="none" stroke="#1f2433" stroke-width="1.4"/>',
  polygon: '<path d="M6.5 2.8l3.7 2.7-1.4 4.4H4.2L2.8 5.5z" fill="none" stroke="#1f2433" stroke-width="1.3" stroke-linejoin="round"/>',
  line: '<path d="M3 9.5L9.5 3.5" stroke="#1f2433" stroke-width="1.4" stroke-linecap="round"/>',
  arrow: '<path d="M3 9.5L9 3.5M6.4 3.5H9v2.6" fill="none" stroke="#1f2433" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  solder: '<circle cx="6.5" cy="6.5" r="4.3" fill="none" stroke="#1f2433" stroke-width="1.1"/><circle cx="6.5" cy="6.5" r="2.3" fill="#1f2433"/>',
  text: '<text x="6.5" y="9.8" font-family="sans-serif" font-size="9" fill="#1f2433" text-anchor="middle" stroke="none">T</text>',
  frame: '<rect x="3" y="4" width="7" height="5" fill="none" stroke="#a855f7" stroke-width="1.3" stroke-dasharray="1.8 1.2"/>',
};

const CURSOR_THEMES = {
  light: { ink: '#1d1a14', halo: '#fffdf8', badge: '#fffdf8', border: '#d6ccb8' },
  dark: { ink: '#e6dfcf', halo: '#0f0e0c', badge: '#1a1915', border: '#3a362e' },
};

const cursorCache = new Map<string, string | null>();

/**
 * Crosshair cursor with a small themed tool badge tucked away at the
 * bottom-right, clear of the hotspot so it never hides what is being clicked.
 */
export function badgeCursor(t: Tool | 'plus' | 'area', theme: 'light' | 'dark'): string | null {
  const key = `${theme}:${t}`;
  if (cursorCache.has(key)) return cursorCache.get(key)!;
  const glyph = t === 'plus' ? PLUS_GLYPH : t === 'area' ? AREA_GLYPH : BADGE_GLYPHS[t];
  if (!glyph) {
    cursorCache.set(key, null);
    return null;
  }
  const c = CURSOR_THEMES[theme];
  const arms = '<path d="M10 1v6M10 13v6M1 10h6M13 10h6" stroke-linecap="round"/>';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">`
    + `<g stroke="${c.halo}" stroke-width="3" opacity="0.8">${arms}</g>`
    + `<g stroke="${c.ink}" stroke-width="1.3">${arms}</g>`
    + `<g transform="translate(18 18)">`
    + `<rect x="0.5" y="0.5" width="13" height="13" rx="3.5" fill="${c.badge}" stroke="${c.border}"/>`
    + glyph.replaceAll('#1f2433', c.ink)
    + `</g></svg>`;
  const css = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 10 10, crosshair`;
  cursorCache.set(key, css);
  return css;
}

export function Canvas() {
  const doc = useStore((s) => s.doc);
  const view = useStore((s) => s.view);
  const selection = useStore((s) => s.selection);
  const wirePart = useStore((s) => s.wirePart);
  const tool = useStore((s) => s.tool);
  const placing = useStore((s) => s.placing);
  const highlight = useStore((s) => s.highlight);
  const presenting = useExplain((s) => s.presenting !== null);
  const prefs = useStore((s) => s.prefs);
  const scope = useStore((s) => s.scope);
  const exportAreaJob = useStore((s) => s.exportArea);
  const altMove = useStore((s) => s.altMove);
  const layerHover = useStore((s) => s.layerHover);
  const data = useSceneData(doc);
  const wireAvoid = useStore((s) => s.prefs.wireAvoid);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gRef = useRef<Gesture | null>(null);
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  const [hover, setHover] = useState<{ item: string | null; port: PortInfo | null }>({ item: null, port: null });
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 });
  const [guides, setGuides] = useState<Guide[]>([]);
  /** Alignment anchors of the running move, keyed by its id set. */
  const alignRef = useRef<{ ids: Set<string>; moving: Point[]; index: AlignIndex } | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [fileDrag, setFileDrag] = useState(false);
  const [editingText, setEditingText] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState<{ id: string; which: 'ref' | 'value' } | null>(null);
  const lastClick = useRef<{ t: number; p: Point }>({ t: 0, p: { x: 0, y: 0 } });
  // hover menus: open after the pointer rests on a hot spot, close shortly after leaving it
  const [hotMenu, setHotMenu] = useState<HotSpot | null>(null);
  const [hotPending, setHotPending] = useState<string | null>(null);
  const hotTimers = useRef<{ open?: number; close?: number }>({});
  /** Set while the menu is busy (dragging a row): pointer movement must not close it. */
  const hotHold = useRef(false);

  const setGesture = useCallback((g: Gesture | null) => {
    gRef.current = g;
    setGestureState(g);
  }, []);
  const gestureKind = gesture?.kind ?? null;
  const routeObs = useMemo(() => (wireAvoid && gestureKind === 'wire' ? routeObstacles(doc) : null), [doc, wireAvoid, gestureKind]);

  useTouchInput(wrapRef);
  useEffect(() => {
    gestureSlots.canvas = {
      get: () => gRef.current,
      restore: (g) => {
        const before = g as Gesture | null;
        if (gRef.current === before) return;
        if (inGesture()) endGesture(false);
        // only a wire or polygon being clicked out survives between touches; anything else is dropped
        setGesture(before?.kind === 'wire' || before?.kind === 'polygon' ? before : null);
      },
    };
    return () => {
      gestureSlots.canvas = null;
    };
  }, [setGesture]);

  const HOT_DWELL = 550;
  const clearHotTimer = (k: 'open' | 'close') => {
    window.clearTimeout(hotTimers.current[k]);
    hotTimers.current[k] = undefined;
  };
  const closeHotMenu = () => {
    hotHold.current = false;
    clearHotTimer('open');
    clearHotTimer('close');
    setHotPending(null);
    setHotMenu(null);
  };
  const scheduleHotClose = () => {
    if (hotHold.current) return;
    if (hotTimers.current.close === undefined) hotTimers.current.close = window.setTimeout(closeHotMenu, 300);
  };
  useEffect(() => () => closeHotMenu(), []);

  const hotSpots = useMemo(() => (gestureKind ? NO_HOTSPOTS : computeHotSpots(doc, data.polys, data.crossings)), [doc, data, gestureKind]);

  /** Nearest hot spot under the pointer (crossings get a little extra reach for their hop arcs). */
  const hotSpotAt = (w: Point): HotSpot | null => {
    const z = S().view.zoom;
    let best: HotSpot | null = null;
    let bd = Infinity;
    for (const h of hotSpots) {
      const tol = h.kind === 'crossing' ? Math.max(8 / z, doc.settings.hopSize + 2) : 7 / z;
      const d = dist(h.pt, w);
      if (d < tol && d < bd) {
        best = h;
        bd = d;
      }
    }
    return best;
  };

  /** Tracks the pointer resting on a hot spot (only while idle in the select / edit points tools). */
  const trackHotSpot = (w: Point) => {
    const h = tool === 'select' || tool === 'node' ? hotSpotAt(w) : null;
    if (!h) {
      clearHotTimer('open');
      setHotPending(null);
      if (hotMenu) scheduleHotClose();
      return;
    }
    clearHotTimer('close');
    const key = hotSpotKey(h);
    if ((hotMenu && hotSpotKey(hotMenu) === key) || hotPending === key) return;
    clearHotTimer('open');
    setHotPending(key);
    hotTimers.current.open = window.setTimeout(() => {
      setHotPending(null);
      setHotMenu(h);
    }, HOT_DWELL);
  };

  /** "Continue wire" from a loose end: click-to-click wiring starting at that end. */
  const continueWire = (wire: string, end: 'a' | 'b') => {
    const w = S().doc.items[wire];
    if (!w || w.type !== 'wire' || w[end].kind !== 'free') return;
    const ep = w[end] as Extract<Endpoint, { kind: 'free' }>;
    const pts = data.polys.get(wire) ?? [];
    const nb = end === 'a' ? pts[1] : pts[pts.length - 2];
    const horizLeg = !!nb && Math.abs(nb.y - ep.y) < ORTHO_EPS;
    const start: Target = { kind: 'wireEnd', wire, end, pt: { x: ep.x, y: ep.y } };
    // keep going in the same direction first
    setGesture({ kind: 'wire', start, pts: [], hFirst: horizLeg, fromDrag: false, downClient: { x: 0, y: 0 }, cur: start, dragging: false });
  };

  const grid = doc.settings.grid;
  const snapOn = doc.settings.snap;
  const sp = (p: Point) => (snapOn ? { x: snap(p.x, grid), y: snap(p.y, grid) } : { x: Math.round(p.x), y: Math.round(p.y) });

  /* ---------------------------- derived -------------------------- */

  const ports = useMemo(() => {
    const out: PortInfo[] = [];
    for (const it of Object.values(doc.items)) {
      if (it.type !== 'component' || it.hidden) continue;
      const def = instanceSymbol(doc, it);
      for (const p of def.ports) {
        const pt = toWorld(it, def, p.x, p.y);
        out.push({ comp: it.id, port: p.id, pt, dir: { x: 0, y: 0 } });
      }
    }
    return out;
  }, [doc]);

  const selSet = useMemo(() => new Set(selection), [selection]);

  /* ------------------------- coordinates ------------------------- */

  const toWorldPt = useCallback((clientX: number, clientY: number): Point => {
    const r = wrapRef.current!.getBoundingClientRect();
    const v = S().view;
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
  }, []);

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      set({ canvasSize: { w: r.width, h: r.height } });
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    set({ canvasSize: { w: r.width, h: r.height } });
    // first layout: fit the document
    requestAnimationFrame(() => A.fitView());
    return () => ro.disconnect();
  }, []);

  /* --------------------------- hit tests -------------------------- */


  const findPort = useCallback(
    (p: Point, exclude?: string): PortInfo | null => {
      let best: PortInfo | null = null;
      let bd = Math.max(8, 10 / S().view.zoom) * hitSlop();
      for (const pi of ports) {
        if (exclude && pi.comp === exclude) continue;
        const d = dist(pi.pt, p);
        if (d < bd) {
          bd = d;
          best = pi;
        }
      }
      return best;
    },
    [ports],
  );

  const portDir = (pi: PortInfo): Point => {
    const c = S().doc.items[pi.comp] as ComponentItem;
    const info = endpointInfo(S().doc, { kind: 'port', comp: c.id, port: pi.port });
    return info?.dir ?? { x: 0, y: 0 };
  };

  const findTarget = useCallback(
    (raw: Point, excludeWire?: string): Target => {
      const d = S().doc;
      const z = S().view.zoom;
      const pi = findPort(raw);
      if (pi) return { kind: 'port', comp: pi.comp, port: pi.port, pt: pi.pt, dir: portDir(pi) };
      const t = Math.max(6, 9 / z) * hitSlop();
      for (const it of Object.values(d.items)) {
        if (it.hidden || it.locked) continue;
        if (it.type === 'junction' && dist(it, raw) < t) return { kind: 'junction', id: it.id, pt: { x: it.x, y: it.y } };
      }
      for (const it of Object.values(d.items)) {
        if (it.type !== 'wire' || it.id === excludeWire || it.hidden || it.locked) continue;
        for (const end of ['a', 'b'] as const) {
          const ep = it[end];
          if (ep.kind === 'free' && dist(ep, raw) < t) return { kind: 'wireEnd', wire: it.id, end, pt: { x: ep.x, y: ep.y } };
        }
      }
      const polys = new Map(data.polys);
      if (excludeWire) polys.delete(excludeWire);
      for (const [id] of polys) {
        const it = d.items[id];
        if (it?.hidden || it?.locked) polys.delete(id);
      }
      const hit = hitWire(polys, raw, Math.max(4, 6 / z));
      if (hit) {
        const pts = polys.get(hit.wire)!;
        const pt = snapOn ? snapOnSegment(hit.pt, pts[hit.seg], pts[hit.seg + 1], grid) : hit.pt;
        return { kind: 'wire', wire: hit.wire, seg: hit.seg, pt };
      }
      return { kind: 'grid', pt: sp(raw) };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [findPort, data, snapOn, grid],
  );

  /** Every item under the pointer, topmost first. */
  const hitItems = useCallback(
    (p: Point): string[] => {
      const d = S().doc;
      const z = S().view.zoom;
      const t = (6 / z) * hitSlop();
      const items = Object.values(d.items).filter((i) => !i.hidden && !i.locked);
      // frames are not drawn (so not clickable) while presenting
      const shapes = items.filter((i): i is ShapeItem => i.type === 'shape' && (X().presenting === null || i.kind !== 'frame')).sort((a, b) => b.z - a.z);
      const shapeHit = (s: ShapeItem) => {
        const r = itemBounds(d, s)!;
        if (hasMovableTitle(s) && pointInRect(p, shapeTitle(s).box, 3)) return true;
        if (s.kind === 'frame' && pointInRect(p, frameTag(s), 2)) return true;
        if (s.kind === 'line' || s.kind === 'arrow') return projectOnSegment(p, { x: s.x, y: s.y }, { x: s.x + s.w, y: s.y + s.h }).d < t + s.strokeWidth;
        if (s.kind === 'text' || s.kind === 'image' || s.kind === 'callout') return pointInRect(p, r, 4);
        if (s.kind === 'ink') return inkHit(s, p, t);
        if (s.kind === 'polygon') return polyHit(s, p, t);
        const inside = pointInRect(p, r, t);
        if (!inside) return false;
        if (s.fillOpacity > 0) return true;
        return !pointInRect(p, { x: r.x + t, y: r.y + t, w: r.w - 2 * t, h: r.h - 2 * t });
      };
      const out: string[] = [];
      for (const s of shapes) if (s.layer === 'above' && shapeHit(s)) out.push(s.id);
      for (const it of items) if (it.type === 'junction' && dist(it, p) < t + 2) out.push(it.id);
      // parts and wires in their shared stacking order, front first (as drawn)
      const rank = drawOrderCached(d);
      const circuit: string[] = [];
      for (const c of items) if (c.type === 'component' && pointInRect(p, itemBounds(d, c)!, 1)) circuit.push(c.id);
      for (const [id, pts] of data.polys) {
        if (!d.items[id] || d.items[id].locked || d.items[id].hidden) continue;
        let best = Infinity;
        for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, projectOnSegment(p, pts[i], pts[i + 1]).d);
        if (best <= Math.max(4, t)) circuit.push(id);
      }
      out.push(...circuit.sort((a, b) => rank.get(b)! - rank.get(a)!));
      for (const s of shapes) if (s.layer === 'below' && shapeHit(s)) out.push(s.id);
      return out;
    },
    [data],
  );
  const hitItem = useCallback((p: Point): string | null => hitItems(p)[0] ?? null, [hitItems]);

  /** Selected component label (reference or value *text*) under the pointer; dragging it moves just that label. `any` looks at every part. */
  const hitLabel = useCallback((p: Point, any = false): { id: string; which: 'ref' | 'value' } | null => {
    const d = S().doc;
    const ids = any ? Object.keys(d.items).reverse() : S().selection;
    for (const id of ids) {
      const c = d.items[id];
      if (c?.type !== 'component') continue;
      const def = instanceSymbol(d, c);
      const L = labelLayout(c, def);
      const shown = labelsShown(d.settings, c, def);
      for (const which of ['ref', 'value'] as const) {
        const at = L[which];
        if (!at || !shown[which] || !(which === 'ref' || c.value)) continue;
        const look = labelLook(c, which, def);
        // test in the label's own (unrotated) frame
        const r = ((look.st.rotate ?? 0) * Math.PI) / 180;
        const q = r ? { x: at.x + (p.x - at.x) * Math.cos(r) + (p.y - at.y) * Math.sin(r), y: at.y - (p.x - at.x) * Math.sin(r) + (p.y - at.y) * Math.cos(r) } : p;
        if (pointInRect(q, labelBox(at, look), 2)) return { id: c.id, which };
      }
    }
    return null;
  }, []);

  /** Wire whose (visible) net label text is under the pointer. */
  const hitWireLabel = useCallback(
    (p: Point): string | null => {
      const d = S().doc;
      for (const it of Object.values(d.items)) {
        if (it.type !== 'wire' || !it.label || it.labelHidden || it.hidden || it.locked || d.settings.hideWireLabels) continue;
        const spot = wireLabelSpot(it, data.polys.get(it.id) ?? [], wireStyle(d, it).width);
        if (!spot) continue;
        const m = measureRich(it.label, 10, 600);
        const x = spot.anchor === 'start' ? spot.x : spot.anchor === 'middle' ? spot.x - m.w / 2 : spot.x - m.w;
        if (pointInRect(p, { x, y: spot.y - 10, w: m.w, h: 13 }, 2)) return it.id;
      }
      return null;
    },
    [data],
  );

  /* ------------------------ selection handles ------------------------ */

  const singleShape = selection.length === 1 && doc.items[selection[0]]?.type === 'shape' ? (doc.items[selection[0]] as ShapeItem) : null;
  const singleWire = selection.length === 1 && doc.items[selection[0]]?.type === 'wire' ? (doc.items[selection[0]] as WireItem) : null;
  const singleComp = selection.length === 1 && doc.items[selection[0]]?.type === 'component' ? (doc.items[selection[0]] as ComponentItem) : null;
  /** Corner handles of a selected part, just outside its body so they stay clear of its pins. */
  const compHandles = (c: ComponentItem): Point[] => {
    const b = componentBounds(c, instanceSymbol(doc, c));
    const o = 6 / view.zoom;
    return [
      { x: b.x - o, y: b.y - o },
      { x: b.x + b.w + o, y: b.y - o },
      { x: b.x + b.w + o, y: b.y + b.h + o },
      { x: b.x - o, y: b.y + b.h + o },
    ];
  };

  const shapeHandles = (s: ShapeItem): { h: Handle; p: Point }[] => {
    if (s.kind === 'line' || s.kind === 'arrow')
      return [
        { h: 'p1', p: { x: s.x, y: s.y } },
        { h: 'p2', p: { x: s.x + s.w, y: s.y + s.h } },
      ];
    if (s.kind === 'text' || s.kind === 'callout') return [];
    const { x, y, w, h } = s;
    return [
      { h: 'nw', p: { x, y } },
      { h: 'n', p: { x: x + w / 2, y } },
      { h: 'ne', p: { x: x + w, y } },
      { h: 'e', p: { x: x + w, y: y + h / 2 } },
      { h: 'se', p: { x: x + w, y: y + h } },
      { h: 's', p: { x: x + w / 2, y: y + h } },
      { h: 'sw', p: { x, y: y + h } },
      { h: 'w', p: { x, y: y + h / 2 } },
    ];
  };

  /* -------------------------- edit points -------------------------- */

  /** Wire vertex (end or bend) under the pointer; selected wires win over the rest. */
  const nodeAt = (p: Point): { wire: string; idx: number; pts: Point[] } | null => {
    const d = S().doc;
    const tol = (7 / S().view.zoom) * hitSlop();
    const sel = new Set(S().selection);
    let best: { wire: string; idx: number; pts: Point[] } | null = null;
    let bestScore = Infinity;
    for (const [wire, pts] of data.polys) {
      const it = d.items[wire];
      if (!it || it.hidden || it.locked) continue;
      for (let idx = 0; idx < pts.length; idx++) {
        const dd = dist(pts[idx], p);
        const score = dd - (sel.has(wire) ? tol : 0);
        if (dd < tol && score < bestScore) {
          best = { wire, idx, pts };
          bestScore = score;
        }
      }
    }
    return best;
  };

  /**
   * Polygon part under the pointer in the edit points tool: a corner, an edge's
   * midpoint knob (dragging it adds a corner) or anywhere along an edge.
   * Selected polygons win over the rest.
   */
  const polyPartAt = (p: Point): { id: string; idx: number; part: 'corner' | 'mid' | 'edge'; pts: Point[] } | null => {
    const d = S().doc;
    const tol = (7 / S().view.zoom) * hitSlop();
    const sel = new Set(S().selection);
    const polys = Object.values(d.items).filter((i): i is ShapeItem => i.type === 'shape' && i.kind === 'polygon' && !i.hidden && !i.locked);
    polys.sort((a, b) => Number(sel.has(b.id)) - Number(sel.has(a.id)));
    for (const part of ['corner', 'mid', 'edge'] as const) {
      for (const s of polys) {
        const pts = polyPoints(s);
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const hit = part === 'corner' ? dist(a, p) < tol : part === 'mid' ? dist(mid, p) < tol * 0.8 : projectOnSegment(p, a, b).d < tol * 0.7 + s.strokeWidth / 2;
          if (hit) return { id: s.id, idx: i, part, pts };
        }
      }
    }
    return null;
  };

  const onNodeDown = (w: Point, e: React.PointerEvent, isDouble: boolean) => {
    const v = S().view;
    const pp = polyPartAt(w);
    if (pp) {
      if (!selSet.has(pp.id)) select([pp.id]);
      if (pp.part === 'corner') {
        set({ wirePart: { wire: pp.id, kind: 'node', index: pp.idx } });
        if (isDouble) {
          // double-click a corner removes it (a polygon keeps three)
          mutate((d) => void deletePolyCorner(d.items[pp.id] as ShapeItem, pp.idx));
          set({ wirePart: null });
          return;
        }
        beginGesture();
        setGesture({ kind: 'polyPart', id: pp.id, base: pp.pts, idx: pp.idx, edge: false, start: w, moved: false });
        return;
      }
      if (pp.part === 'mid' || isDouble || e.altKey) {
        // a new corner on the edge, dragged straight away
        const at = sp(projectOnSegment(w, pp.pts[pp.idx], pp.pts[(pp.idx + 1) % pp.pts.length]).pt);
        const base = [...pp.pts.slice(0, pp.idx + 1), at, ...pp.pts.slice(pp.idx + 1)];
        beginGesture();
        gestureUpdate((d) => setPolyPoints(d.items[pp.id] as ShapeItem, base));
        set({ wirePart: { wire: pp.id, kind: 'node', index: pp.idx + 1 } });
        setGesture({ kind: 'polyPart', id: pp.id, base, idx: pp.idx + 1, edge: false, start: at, moved: true });
        return;
      }
      set({ wirePart: null });
      beginGesture();
      setGesture({ kind: 'polyPart', id: pp.id, base: pp.pts, idx: pp.idx, edge: true, start: w, moved: false });
      return;
    }
    if (singleShape && !singleShape.locked && singleShape.kind !== 'polygon') {
      const hh = shapeHandles(singleShape).find((h) => dist(h.p, w) < 7 / v.zoom);
      if (hh) {
        beginGesture();
        setGesture({ kind: 'resize', id: singleShape.id, handle: hh.h, base: singleShape, start: w });
        return;
      }
    }
    const n = nodeAt(w);
    if (n) {
      const last = n.pts.length - 1;
      if (!selSet.has(n.wire)) select([n.wire]);
      // a node is a selectable part: click it, then Del removes it (drag still moves it)
      set({ wirePart: { wire: n.wire, kind: 'node', index: n.idx } });
      if (isDouble) {
        // double-click a bend removes it (same as selecting it and pressing Del)
        mutate((d) => deleteWirePart(d as CircuitDoc, { wire: n.wire, kind: 'node', index: n.idx }));
        set({ wirePart: null });
        return;
      }
      if (n.idx === 0 || n.idx === last) {
        beginGesture();
        setGesture({ kind: 'endpoint', wire: n.wire, end: n.idx === 0 ? 'a' : 'b', cur: { kind: 'grid', pt: n.pts[n.idx] }, moved: false });
        return;
      }
      beginGesture();
      setGesture({ kind: 'node', wire: n.wire, idx: n.idx, base: n.pts, cur: n.pts[n.idx], free: false, moved: false });
      return;
    }
    const hit = hitItem(w);
    const item = hit ? S().doc.items[hit] : null;
    if (item?.type === 'wire' && item.routing === 'straight') {
      // straight wires: grabbing a segment drops a new bend there and drags it
      const pts = data.polys.get(item.id) ?? [];
      const h = hitWire(new Map([[item.id, pts]]), w, Infinity);
      if (h) {
        if (!selSet.has(item.id)) select([item.id]);
        const at = sp(h.pt);
        const base = [...pts.slice(0, h.seg + 1), at, ...pts.slice(h.seg + 1)];
        beginGesture();
        setGesture({ kind: 'node', wire: item.id, idx: h.seg + 1, base, cur: at, free: true, moved: false });
        return;
      }
    }
    if (hit) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) select([hit], 'toggle');
      else if (!selSet.has(hit)) select([hit]);
      return;
    }
    set({ wirePart: null });
    setGesture({ kind: 'marquee', start: w, cur: w, additive: e.shiftKey || e.ctrlKey || e.metaKey });
  };

  /** Writes a node drag into the wire (always recomputed from the gesture's base polyline). */
  const applyNode = (d: CircuitDoc, g: Extract<Gesture, { kind: 'node' }>) => {
    const wire = d.items[g.wire] as WireItem | undefined;
    if (!wire) return;
    wire.pts = moveWireNode(g.base, g.idx, g.cur, g.free || wire.routing === 'straight').slice(1, -1);
  };

  /* ------------------------- wire commit ------------------------- */

  const wirePreview = (g: Extract<Gesture, { kind: 'wire' }>): Point[] => {
    const angle = S().prefs.wireAngle;
    if (angle !== 'ortho') return buildAngledPreview(g.start.pt, g.pts, g.cur.pt, angle, g.hFirst);
    return buildWirePreview(g.start.pt, g.pts, g.hFirst, g.cur.pt, routeObs ? wireRouter(S().doc, g.start, g.cur, grid, routeObs) : undefined);
  };

  /* ------------------------------ polygon ------------------------------ */

  /** Next corner under the pointer: on the grid, at 45° steps with Shift, and pulled onto the first corner when close. */
  const polygonPoint = (g: Extract<Gesture, { kind: 'polygon' }>, w: Point, shift: boolean): Point => {
    const first = g.pts[0];
    if (g.pts.length >= 3 && dist(first, w) < (8 / S().view.zoom) * hitSlop()) return first;
    const p = sp(w);
    return shift ? constrain45(g.pts[g.pts.length - 1], p) : p;
  };

  const closesPolygon = (g: Extract<Gesture, { kind: 'polygon' }>, p: Point) => g.pts.length > 1 && eq(p, g.pts[0]);

  const commitPolygon = (pts: Point[]) => {
    setGesture(null);
    if (pts.length < 3) return;
    let id = '';
    mutate((d) => {
      const s = makeShape(d as CircuitDoc, 'polygon', 0, 0, 1, 1);
      Object.assign(s, packPoly(pts));
      s.group = S().scope;
      d.items[s.id] = s;
      id = s.id;
    });
    set({ selection: [id] });
  };

  // switching tools drops a half-drawn polygon
  useEffect(() => {
    if (gRef.current?.kind === 'polygon' && tool !== 'polygon') setGesture(null);
  }, [tool]);

  const commitWire = (g: Extract<Gesture, { kind: 'wire' }>, end: Target) => {
    const brush = S().wireBrush;
    let newId: string | null = null;
    mutate((dd) => {
      newId = commitWireDoc(dd as CircuitDoc, g.start, end, {
        via: g.pts,
        hFirst: g.hFirst,
        angle: S().prefs.wireAngle,
        straight: g.angled,
        group: S().scope,
        routeGrid: S().prefs.wireAvoid ? grid : undefined,
        bus: S().prefs.drawBus,
        ...(brush ? { style: { ...brush } } : {}),
      });
    });
    // a new bus is selected so it can be named straight away
    if (newId && S().doc.items[newId]) set({ selection: S().prefs.drawBus ? [newId] : [] });
    return newId !== null;
  };

  /** After a click adds vertices, the next leg should turn 90° (at 45°: a diagonal is followed by a straight run). */
  const nextHFirst = (pts: Point[]) => {
    if (pts.length < 2) return true;
    const a = pts[pts.length - 2];
    const b = pts[pts.length - 1];
    if (S().prefs.wireAngle === '45') return isDiagonal(a, b);
    return Math.abs(a.y - b.y) > ORTHO_EPS; // last leg vertical → go horizontal first
  };

  const startWire = (t: Target, fromDrag: boolean, client: Point) => {
    let hFirst = true;
    if (t.kind === 'port') hFirst = t.dir.x !== 0;
    else if (t.kind === 'wire') {
      const pts = data.polys.get(t.wire)!;
      const horiz = Math.abs(pts[t.seg].y - pts[t.seg + 1].y) < ORTHO_EPS;
      hFirst = !horiz; // branch off perpendicular
    }
    setGesture({ kind: 'wire', start: t, pts: [], hFirst, fromDrag, downClient: client, cur: t, dragging: false });
  };

  /* ------------------------ pointer-carried move ------------------------ */

  /**
   * Cadence m / Shift+m / c, as in current Virtuoso: nothing moves until a click
   * picks the reference point (with nothing selected, that click also picks
   * what to move); from then on the selection follows the pointer until the
   * next click drops it.
   */
  const armMove = (detach: boolean, copy: boolean) => {
    if (gRef.current) return;
    set({ wirePart: null });
    setGesture({ kind: 'arm', detach, copy });
    const what = copy ? 'copy' : 'move';
    toast(S().selection.length ? `Click the reference point to ${what} from · Esc cancels` : `Click the item to ${what} · Esc cancels`);
  };

  /** The reference click of an armed move: starts the pointer-carried move from `at`. */
  const floatMove = (detach: boolean, copy: boolean, at: Point) => {
    if (!S().selection.length) {
      const hit = hitItem(at);
      if (!hit) return false;
      select([hit]);
    }
    const before = S().doc;
    if (copy) A.copyInPlace();
    const ids = new Set(S().selection.filter((id) => !S().doc.items[id]?.locked));
    if (!ids.size) {
      setGesture(null);
      toast('The selection is locked');
      return true;
    }
    set({ wirePart: null });
    beginGesture(before);
    setGesture({ kind: 'move', start: sp(at), ids, moved: true, client: at, detach, dx: 0, dy: 0, floating: true });
    return true;
  };

  /** Rotates what a pointer-carried move is holding (Cadence: R or the right mouse button). */
  const rotateFloating = (g: Extract<Gesture, { kind: 'move' }>) => {
    alignRef.current = null;
    rebaseGesture();
    A.rotateSelection(90);
    rebaseGesture();
    setGesture({ ...g, start: sp(S().cursor), dx: 0, dy: 0 });
  };

  const finishMove = (g: Extract<Gesture, { kind: 'move' }>) => {
    if (g.detach && g.moved) {
      // wire ends set down exactly on a pin, junction or another wire's end connect to it
      const joins: { wire: string; end: 'a' | 'b'; t: Target }[] = [];
      if (g.rejoin) {
        for (const id of g.ids) {
          const wi = S().doc.items[id];
          if (wi?.type !== 'wire') continue;
          for (const end of ['a', 'b'] as const) {
            const ep = wi[end];
            if (ep.kind !== 'free') continue;
            const t = findTarget(ep, id);
            if ((t.kind === 'port' || t.kind === 'junction' || t.kind === 'wireEnd') && eq(t.pt, ep)) joins.push({ wire: id, end, t });
          }
        }
      }
      // alt move: drop junctions that lost their wires and rejoin split runs, in the same undo step
      gestureUpdate((d, base) => {
        translateDetached(base, d as CircuitDoc, g.ids, g.dx, g.dy);
        for (const j of joins) reconnectWireEnd(d as CircuitDoc, j.wire, j.end, j.t);
        cleanup(d as CircuitDoc);
      });
    }
    endGesture(true);
    setGesture(null);
    if (!g.moved && g.pick) select([g.pick]);
  };

  /* ---------------------------- keyboard ---------------------------- */

  useEffect(() => {
    canvasKeys.handle = (combo: string) => {
      if (hotMenu && combo === 'Escape') {
        closeHotMenu();
        return true;
      }
      if (S().exportArea) {
        if (combo === 'Escape') {
          set({ exportArea: null });
          setGesture(null);
        }
        return true;
      }
      const g = gRef.current;
      if (g?.kind === 'move' && g.floating && (combo === 'R' || combo === 'Space')) {
        rotateFloating(g);
        return true;
      }
      if (g?.kind === 'wire' || (combo === 'Tab' && !g && tool === 'wire')) {
        if (combo === 'Tab') {
          A.setWireAngle();
          return true;
        }
      }
      if (g?.kind === 'polygon') {
        if (combo === 'Escape') {
          setGesture(null);
          return true;
        }
        if (combo === 'Backspace' || combo === 'Delete') {
          setGesture(g.pts.length > 1 ? { ...g, pts: g.pts.slice(0, -1) } : null);
          return true;
        }
        if (combo === 'Enter') {
          commitPolygon(g.pts);
          return true;
        }
      }
      if (g?.kind === 'wire') {
        if (combo === 'Escape') {
          setGesture(null);
          return true;
        }
        if (combo === 'Backspace' || combo === 'Delete') {
          if (g.pts.length) setGesture({ ...g, pts: g.pts.slice(0, -1) });
          else setGesture(null);
          return true;
        }
        if (combo === 'Space' || combo === '/') {
          setGesture({ ...g, hFirst: !g.hFirst, postureSet: true });
          return true;
        }
        if (combo === 'Enter') {
          commitWire(g, g.cur);
          setGesture(null);
          return true;
        }
      }
      if (g && combo === 'Escape') {
        if (g.kind === 'move' || g.kind === 'polyPart' || g.kind === 'segment' || g.kind === 'resize' || g.kind === 'scale' || g.kind === 'label' || g.kind === 'shapeTitle' || g.kind === 'node' || g.kind === 'endpoint') endGesture(false);
        setGesture(null);
        // a cancelled copy takes its staged items with it
        if (g.kind === 'move' && g.floating) set({ selection: S().selection.filter((id) => S().doc.items[id]) });
        set({ wirePart: null });
        return true;
      }
      return false;
    };
    canvasActions.floatMove = ({ detach, copy }) => armMove(detach, copy);
    return () => {
      canvasKeys.handle = null;
      canvasActions.floatMove = null;
    };
  });

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e) && !gRef.current) {
        setSpaceDown(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  /* ---------------------------- pointer ---------------------------- */

  const onPointerDown = (e: React.PointerEvent) => {
    if (editingText || editingLabel) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const w = toWorldPt(e.clientX, e.clientY);
    const client = { x: e.clientX, y: e.clientY };
    set({ contextMenu: null });
    closeHotMenu();
    if (e.button === 2) return;
    const v = S().view;
    if (e.button === 1 || spaceDown || tool === 'pan') {
      setGesture({ kind: 'pan', client, view: { x: v.x, y: v.y } });
      return;
    }
    if (e.button !== 0) return;
    const carried = gRef.current;
    if (carried?.kind === 'move' && carried.floating) {
      finishMove(carried);
      return;
    }
    if (carried?.kind === 'arm') {
      // a click on empty canvas with nothing selected keeps waiting for something to move
      if (!floatMove(carried.detach, carried.copy, w)) toast(carried.copy ? 'Click the item to copy' : 'Click the item to move');
      return;
    }
    const now = performance.now();
    const isDouble = now - lastClick.current.t < 350 && dist(lastClick.current.p, client) < 6 * hitSlop() ** 2;
    lastClick.current = { t: now, p: client };

    // export-area mode: any drag defines the export rectangle
    if (S().exportArea) {
      setGesture({ kind: 'exportArea', start: sp(w), cur: sp(w) });
      return;
    }

    // ongoing click-to-click wire
    const g = gRef.current;
    if (g?.kind === 'wire') {
      const t = findTarget(w);
      // clicking back on a loose start closes the loop (the wire isn't in the doc yet, so it is no target)
      const closes = t.kind === 'grid' && g.start.kind === 'grid' && g.pts.length >= 2 && eq(t.pt, g.start.pt);
      if (isDouble || t.kind !== 'grid' || closes) {
        commitWire(g, closes ? g.start : t);
        setGesture(null);
        return;
      }
      const pts = wirePreview({ ...g, cur: t });
      const committed = pts.slice(1);
      if (committed.length && eq(committed[committed.length - 1], g.pts[g.pts.length - 1] ?? g.start.pt)) {
        // clicking the same spot twice finishes the wire
        commitWire(g, t);
        setGesture(null);
        return;
      }
      const angled = g.angled || pts.some((p, i) => i > 0 && isDiagonal(pts[i - 1], p));
      setGesture({ ...g, pts: committed, hFirst: nextHFirst(pts), cur: t, postureSet: false, angled });
      return;
    }

    if (g?.kind === 'polygon') {
      const p = polygonPoint(g, w, e.shiftKey);
      if (closesPolygon(g, p)) {
        if (g.pts.length >= 3) commitPolygon(g.pts);
        return;
      }
      if (isDouble) {
        commitPolygon(eq(p, g.pts[g.pts.length - 1]) ? g.pts : [...g.pts, p]);
        return;
      }
      if (!eq(p, g.pts[g.pts.length - 1])) setGesture({ ...g, pts: [...g.pts, p], cur: p });
      return;
    }

    if (placing) {
      const p = sp(w);
      A.placeComponent(placing.symbol, p.x, p.y, placing.rot, placing.flipX);
      // Cadence keeps placing copies until Esc; Nodal places one (Shift for more)
      if (!e.shiftKey && S().prefs.shortcuts !== 'cadence') set({ placing: null });
      return;
    }

    if (tool === 'wire') {
      // press-drag-release draws a wire in one go; a plain click starts click-to-click mode
      startWire(findTarget(w), true, client);
      return;
    }
    if (tool === 'text') {
      const p = sp(w);
      let id = '';
      mutate((d) => {
        const s = makeShape(d as CircuitDoc, 'text', p.x, p.y, 40, 20);
        const m = measureRich(s.text ?? '', s.fontSize ?? 16, s.bold ? 700 : 400);
        s.w = m.w;
        s.h = m.h;
        s.group = S().scope;
        d.items[s.id] = s;
        id = s.id;
      });
      set({ selection: [id] });
      setEditingText(id);
      return;
    }
    if (tool === 'node') {
      onNodeDown(w, e, isDouble);
      return;
    }
    if (tool === 'solder') {
      const h = hotSpotAt(w);
      if (!h || !solderActionFor(h)) return;
      let err: string | null = null;
      mutate((d) => {
        err = applySolder(d as CircuitDoc, h, data);
      });
      if (err) toast(err, 'error');
      return;
    }
    if (tool === 'polygon') {
      const p = sp(w);
      setGesture({ kind: 'polygon', pts: [p], cur: p });
      return;
    }
    if (tool !== 'select') {
      const p = sp(w);
      setGesture({ kind: 'shape', shape: tool as ShapeKind, start: p, cur: p });
      return;
    }

    // ---- select tool ----
    if (singleComp && !singleComp.locked && compHandles(singleComp).some((h) => dist(h, w) < 7 / v.zoom)) {
      beginGesture();
      setGesture({ kind: 'scale', id: singleComp.id, base: singleComp.scale ?? 1, d0: Math.max(1, dist(w, singleComp)) });
      return;
    }
    if (singleShape && !singleShape.locked && hasMovableTitle(singleShape) && pointInRect(w, shapeTitle(singleShape).box, 3)) {
      beginGesture();
      setGesture({ kind: 'shapeTitle', id: singleShape.id, start: w, base: { dx: singleShape.textDx ?? 0, dy: singleShape.textDy ?? 0 } });
      return;
    }
    if (singleShape && !singleShape.locked) {
      const hh = shapeHandles(singleShape).find((h) => dist(h.p, w) < 7 / v.zoom);
      if (hh) {
        beginGesture();
        setGesture({ kind: 'resize', id: singleShape.id, handle: hh.h, base: singleShape, start: w });
        return;
      }
    }
    if (singleWire && !singleWire.locked) {
      const pts = data.polys.get(singleWire.id) ?? [];
      if (pts.length >= 2) {
        const end = dist(pts[0], w) < 7 / v.zoom ? 'a' : dist(pts[pts.length - 1], w) < 7 / v.zoom ? 'b' : null;
        if (end) {
          beginGesture();
          setGesture({ kind: 'endpoint', wire: singleWire.id, end, cur: { kind: 'grid', pt: end === 'a' ? pts[0] : pts[pts.length - 1] }, moved: false });
          return;
        }
      }
    }
    // drag from a port starts a wire
    const pi = findPort(w);
    if (pi && !e.shiftKey) {
      const portItem = S().doc.items[pi.comp];
      if (portItem && !portItem.locked) {
        startWire({ kind: 'port', comp: pi.comp, port: pi.port, pt: pi.pt, dir: portDir(pi) }, true, client);
        return;
      }
    }
    const wireLabel = tool === 'select' ? hitWireLabel(w) : null;
    if (wireLabel) {
      // other wires of the net that carry a label of their own are not landing spots; only
      // physically connected wires qualify (same-label wires elsewhere join the net by name)
      const d0 = S().doc;
      const net = (netOfWire(computeNets(d0, { ignoreLabels: true }), wireLabel)?.wires ?? [wireLabel]).filter((id) => id === wireLabel || !(d0.items[id] as WireItem | undefined)?.label);
      select([wireLabel]);
      beginGesture();
      setGesture({ kind: 'wireLabel', id: wireLabel, net });
      return;
    }
    const labelEdit = isDouble ? hitLabel(w, true) : null;
    if (labelEdit && !S().doc.items[labelEdit.id]?.locked) {
      select([labelEdit.id]);
      setEditingLabel(labelEdit);
      return;
    }
    const labelOf = hitLabel(w);
    const stack = hitItems(w);
    let hit: string | null = stack[0] ?? null;
    if (labelOf && (!hit || hit === labelOf.id || S().doc.items[hit]?.type !== 'component')) {
      const c = S().doc.items[labelOf.id] as ComponentItem;
      const frozen = frozenLabelOffsets(c, instanceSymbol(S().doc, c));
      const base = labelOf.which === 'ref' ? { dx: frozen.labelDx, dy: frozen.labelDy } : { dx: frozen.valueDx, dy: frozen.valueDy };
      beginGesture();
      setGesture({ kind: 'label', id: labelOf.id, which: labelOf.which, start: w, base, frozen });
      return;
    }
    if (hit) {
      const item = S().doc.items[hit];
      if (isDouble) {
        onDoubleClick(hit);
        return;
      }
      if (e.altKey && item.type === 'wire') {
        startWire(findTarget(w), true, client);
        return;
      }
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        select([hit], 'toggle');
        return;
      }
      // clicking again where several items overlap steps down to the next one; pressing still drags the current one
      const sole = S().selection.length === 1 ? S().selection[0] : null;
      const at = sole ? stack.indexOf(sole) : -1;
      const next = stack.length > 1 && at >= 0 ? stack[(at + 1) % stack.length] : undefined;
      if (next) hit = sole!;
      // clicking a wire that is already the sole selection selects one of its segments
      // pressing an item of a multi-selection keeps the whole selection so it all moves together
      const wasSelected = selSet.has(hit) || !!next;
      const wasSoleWire = wasSelected && S().selection.length === 1;
      if (!wasSelected) select([hit]);
      const cur = S().selection;
      if (S().doc.items[hit].type === 'wire' && cur.length === 1 && cur[0] === hit) {
        const pts = data.polys.get(hit) ?? [];
        const h = hitWire(new Map([[hit, pts]]), w, Infinity);
        if (wasSoleWire && h && !next) set({ wirePart: { wire: hit, kind: 'segment', index: h.seg } });
        beginGesture();
        setGesture({ kind: 'segment', wire: hit, seg: h?.seg ?? 0, base: pts, start: w, moved: false, pick: next });
        return;
      }
      beginGesture();
      setGesture(moveGesture(cur, w, client, next ?? (wasSelected && cur.length > 1 ? hit : undefined)));
      return;
    }
    // pressing inside the selection's box (not on another item) moves the whole selection, keeping its shape
    const inBox = isDouble || e.altKey ? null : unionBounds(S().doc, S().selection.filter((id) => !S().doc.items[id]?.locked));
    if (inBox && pointInRect(w, inBox, 4 / v.zoom)) {
      beginGesture();
      setGesture(moveGesture(S().selection, w, client));
      return;
    }
    if (isDouble && S().scope) {
      A.exitGroup();
      return;
    }
    set({ wirePart: null });
    setGesture({ kind: 'marquee', start: w, cur: w, additive: e.shiftKey || e.ctrlKey || e.metaKey });
  };

  /**
   * Moving the selection. Wires alone move rigidly (their shape is kept), letting go of whatever
   * they were attached to; together with parts they stretch to stay connected, as before.
   */
  const moveGesture = (sel: string[], w: Point, client: Point, pick?: string): Gesture => {
    const d = S().doc;
    const ids = new Set(sel.filter((id) => d.items[id] && !d.items[id].locked));
    const wiresOnly = ids.size > 0 && [...ids].every((id) => d.items[id].type === 'wire');
    return { kind: 'move', start: w, ids, moved: false, client, detach: S().altMove || wiresOnly, dx: 0, dy: 0, pick, rejoin: wiresOnly };
  };

  const onDoubleClick = (id: string) => {
    const d = S().doc;
    const it = d.items[id];
    if (!it) return;
    const scope = S().scope;
    const chainTop = it.group && it.group !== scope;
    if (chainTop) {
      A.enterGroup(id);
      return;
    }
    if (it.type === 'shape' && (it.kind === 'text' || it.kind === 'rect' || it.kind === 'zone' || it.kind === 'ellipse' || it.kind === 'polygon') && !it.locked) {
      setEditingText(id);
      return;
    }
    if (it.type === 'shape' && it.kind === 'callout' && !it.locked) {
      setX({ editing: id });
      return;
    }
    if (it.type === 'component' || it.type === 'wire' || it.type === 'shape') {
      set({ rightPanel: true });
      setTimeout(() => {
        const el = document.querySelector<HTMLInputElement>('[data-focus="value"]');
        el?.focus();
        el?.select();
      }, 30);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const w = toWorldPt(e.clientX, e.clientY);
    setCursor(w);
    set(S().pointerOnCanvas ? { cursor: w } : { cursor: w, pointerOnCanvas: true });
    const g = gRef.current;
    if (!g || g.kind === 'arm') {
      if (tool === 'select' || tool === 'wire' || tool === 'node' || g) {
        const pi = findPort(w);
        const item = pi ? null : hitItem(w);
        if (pi?.comp !== hover.port?.comp || pi?.port !== hover.port?.port || item !== hover.item) setHover({ port: pi, item });
      }
      if (!placing && !S().exportArea && !g) trackHotSpot(w);
      return;
    }
    const v = S().view;
    switch (g.kind) {
      case 'pan':
        set({ view: { ...v, x: g.view.x + e.clientX - g.client.x, y: g.view.y + e.clientY - g.client.y } });
        break;
      case 'marquee':
        setGesture({ ...g, cur: w });
        break;
      case 'move': {
        if (!g.moved && dist(g.client, { x: e.clientX, y: e.clientY }) < 3) return;
        let dx = w.x - g.start.x;
        let dy = w.y - g.start.y;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const step = snapOn ? grid : 1;
        dx = snap(dx, step);
        dy = snap(dy, step);
        if (S().prefs.alignGuides) {
          if (alignRef.current?.ids !== g.ids) alignRef.current = { ids: g.ids, ...alignAnchors(gestureBaseDoc() ?? S().doc, g.ids) };
          // off the grid, guides also pull the selection onto them; on it they just show what lines up
          const a = alignMove(alignRef.current.moving, alignRef.current.index, dx, dy, 6 / S().view.zoom, !snapOn);
          if (!e.shiftKey || dx) dx = a.dx;
          if (!e.shiftKey || dy) dy = a.dy;
          setGuides(a.guides);
        } else if (guides.length) setGuides([]);
        gestureUpdate((d, base) => (g.detach ? translateDetached : translateItems)(base, d as CircuitDoc, g.ids, dx, dy));
        if (!g.moved || dx !== g.dx || dy !== g.dy) setGesture({ ...g, moved: true, dx, dy });
        break;
      }
      case 'wire': {
        const cur = findTarget(w);
        // only a held button counts as dragging; plain mouse moves in click-to-click mode don't
        const dragging = g.dragging || (!!(e.buttons & 1) && dist(g.downClient, { x: e.clientX, y: e.clientY }) > 5);
        // Cadence-style posture: the way the pointer first heads off the last
        // point decides which way the wire leaves it; it locks once the pointer
        // is a grid step and a half away, and is re-read when it comes back
        const anchor = g.pts.length ? g.pts[g.pts.length - 1] : g.start.pt;
        const ox = w.x - anchor.x;
        const oy = w.y - anchor.y;
        const r = Math.max(Math.abs(ox), Math.abs(oy));
        // at 45°: heading off along an axis runs straight first, heading off diagonally starts with the diagonal
        const fresh = !g.postureSet && r > grid * 0.3 && r <= grid * 1.5;
        const hFirst = !fresh ? g.hFirst : S().prefs.wireAngle === '45' ? Math.min(Math.abs(ox), Math.abs(oy)) < r * 0.4 : Math.abs(ox) >= Math.abs(oy);
        setGesture({ ...g, cur, dragging, hFirst });
        break;
      }
      case 'segment': {
        const a = g.base[g.seg];
        const b = g.base[g.seg + 1];
        if (!a || !b) return;
        const horiz = Math.abs(a.y - b.y) < ORTHO_EPS;
        const vert = Math.abs(a.x - b.x) < ORTHO_EPS;
        const step = snapOn ? grid : 1;
        const dx = vert || !horiz ? snap(w.x - g.start.x, step) : 0;
        const dy = horiz || !vert ? snap(w.y - g.start.y, step) : 0;
        if (!dx && !dy && !g.moved) return;
        gestureUpdate((d, baseDoc) => {
          moveWireSegment(d as CircuitDoc, g.wire, g.base, g.seg, dx, dy, baseDoc);
        });
        if (!g.moved) {
          set({ wirePart: null }); // dragging a segment reshapes it instead of selecting it
          setGesture({ ...g, moved: true });
        }
        break;
      }
      case 'endpoint': {
        const cur = findTarget(w, g.wire);
        if (!g.moved) set({ wirePart: null });
        setGesture({ ...g, cur, moved: true });
        gestureUpdate((d) => {
          const wire = d.items[g.wire] as WireItem;
          wire[g.end] = { kind: 'free', ...cur.pt };
        });
        break;
      }
      case 'node': {
        if (!g.moved) set({ wirePart: null });
        const next = { ...g, cur: sp(w), free: e.altKey, moved: true };
        gestureUpdate((d) => applyNode(d as CircuitDoc, next));
        setGesture(next);
        break;
      }
      case 'shape':
        setGesture({ ...g, cur: e.altKey ? w : sp(w) });
        break;
      case 'polygon':
        setGesture({ ...g, cur: polygonPoint(g, w, e.shiftKey) });
        break;
      case 'polyPart': {
        // corners land on the grid (Alt: anywhere); edges move by whole grid steps
        let d: Point;
        if (g.edge) {
          const step = snapOn && !e.altKey ? grid : 1;
          d = { x: snap(w.x - g.start.x, step), y: snap(w.y - g.start.y, step) };
          if (e.shiftKey) Math.abs(d.x) > Math.abs(d.y) ? (d.y = 0) : (d.x = 0);
        } else {
          const prev = g.base[(g.idx - 1 + g.base.length) % g.base.length];
          let p = e.altKey ? { x: Math.round(w.x), y: Math.round(w.y) } : sp(w);
          if (e.shiftKey) p = constrain45(prev, p);
          d = { x: p.x - g.base[g.idx].x, y: p.y - g.base[g.idx].y };
        }
        if (!g.moved && !d.x && !d.y) return;
        gestureUpdate((doc) => setPolyPoints(doc.items[g.id] as ShapeItem, dragPolyPart(g.base, g.idx, g.edge, d)));
        if (!g.moved) setGesture({ ...g, moved: true });
        break;
      }
      case 'exportArea':
        setGesture({ ...g, cur: sp(w) });
        break;
      case 'scale': {
        const c = S().doc.items[g.id] as ComponentItem | undefined;
        if (!c) return;
        const raw = Math.min(10, Math.max(0.1, (g.base * dist(w, c)) / g.d0));
        // only sizes that keep every pin on the grid (quarter steps for single-pin parts)
        const def = getSymbol(S().doc, c.symbol);
        const k = scaleStep(def) ? gridScale(def, raw) : Math.max(0.25, Math.round(raw * 4) / 4);
        gestureUpdate((d) => {
          (d.items[g.id] as ComponentItem).scale = k === 1 ? undefined : k;
        });
        break;
      }
      case 'resize': {
        const p = snapOn ? sp(w) : w;
        gestureUpdate((d) => {
          const s = d.items[g.id] as ShapeItem;
          const b = g.base;
          if (g.handle === 'p1') {
            s.x = p.x;
            s.y = p.y;
            s.w = b.x + b.w - p.x;
            s.h = b.y + b.h - p.y;
            return;
          }
          if (g.handle === 'p2') {
            s.w = p.x - b.x;
            s.h = p.y - b.y;
            return;
          }
          let x1 = b.x,
            y1 = b.y,
            x2 = b.x + b.w,
            y2 = b.y + b.h;
          if (g.handle.includes('w')) x1 = p.x;
          if (g.handle.includes('e')) x2 = p.x;
          if (g.handle.includes('n')) y1 = p.y;
          if (g.handle.includes('s')) y2 = p.y;
          s.x = Math.min(x1, x2);
          s.y = Math.min(y1, y2);
          s.w = Math.max(grid, Math.abs(x2 - x1));
          s.h = Math.max(grid, Math.abs(y2 - y1));
        });
        break;
      }
      case 'shapeTitle': {
        gestureUpdate((d) => {
          const s = d.items[g.id] as ShapeItem;
          const o = clampTitleOffset(s, Math.round(g.base.dx + w.x - g.start.x), Math.round(g.base.dy + w.y - g.start.y));
          s.textDx = Math.round(o.dx);
          s.textDy = Math.round(o.dy);
        });
        break;
      }
      case 'wireLabel': {
        // nearest spot on any wire of the net; the pointer's side of the wire picks the label side
        let best: { wire: string; t: number; d: number; pt: Point; horiz: boolean } | null = null;
        const d0 = S().doc;
        for (const id of g.net) {
          const o = d0.items[id];
          if (!o || o.type !== 'wire' || o.hidden) continue;
          const pr = projectAlong(data.polys.get(id) ?? [], w);
          if (pr && (!best || pr.d < best.d)) best = { wire: id, ...pr };
        }
        if (!best) break;
        const b = best;
        const side: LabelSide = b.horiz ? (w.y < b.pt.y ? 'above' : 'below') : w.x < b.pt.x ? 'left' : 'right';
        gestureUpdate((d) => {
          const from = d.items[g.id] as WireItem;
          const to = d.items[b.wire] as WireItem;
          if (to.id !== from.id) {
            to.label = from.label;
            delete from.label;
            delete from.labelAt;
            delete from.labelSide;
            delete from.labelHidden;
          }
          to.labelAt = Math.round(b.t * 1000) / 1000;
          to.labelSide = side;
        });
        if (b.wire !== S().selection[0]) set({ selection: [b.wire] });
        break;
      }
      case 'label': {
        const dx = Math.round(w.x - g.start.x);
        const dy = Math.round(w.y - g.start.y);
        gestureUpdate((d) => {
          const c = d.items[g.id] as ComponentItem;
          // first drag: pin both labels where they are drawn now, so neither jumps
          if (c.labelDx === undefined && c.labelDy === undefined && c.valueDx === undefined && c.valueDy === undefined) Object.assign(c, g.frozen);
          if (g.which === 'value') {
            c.valueDx = g.base.dx + dx;
            c.valueDy = g.base.dy + dy;
          } else {
            // moving the reference alone: pin the value where it is if it was still following
            if (c.valueDx === undefined) c.valueDx = c.labelDx ?? 0;
            if (c.valueDy === undefined) c.valueDy = c.labelDy ?? 0;
            c.labelDx = g.base.dx + dx;
            c.labelDy = g.base.dy + dy;
          }
        });
        break;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gRef.current;
    if (!g) return;
    const w = toWorldPt(e.clientX, e.clientY);
    switch (g.kind) {
      case 'pan':
        setGesture(null);
        break;
      case 'marquee': {
        const r = rectFromPoints(g.start, w);
        if (r.w < 2 && r.h < 2) {
          if (!g.additive) set({ selection: [] });
        } else {
          const crossing = w.x < g.start.x;
          const ids = marqueeHits(S().doc, data.polys, r, crossing);
          select(ids, g.additive ? 'add' : 'replace');
        }
        setGesture(null);
        break;
      }
      case 'move':
        if (!g.floating) finishMove(g);
        break;
      case 'scale':
      case 'segment':
      case 'resize':
      case 'label':
      case 'wireLabel':
      case 'shapeTitle':
        endGesture(true);
        if (g.kind === 'segment' && g.moved) mutate((d) => cleanup(d as CircuitDoc));
        if (g.kind === 'segment' && !g.moved && g.pick) select([g.pick]);
        setGesture(null);
        break;
      case 'polyPart':
        endGesture(g.moved);
        setGesture(null);
        break;
      case 'node':
        if (g.moved) {
          // final shape plus cleanup in the same undo step
          gestureUpdate((d) => {
            applyNode(d as CircuitDoc, g);
            cleanup(d as CircuitDoc);
          });
        }
        endGesture(true);
        setGesture(null);
        break;
      case 'endpoint': {
        endGesture(false);
        // plain click without a drag: keep the existing endpoint (the initial
        // 'grid' target would otherwise resolve to 'free' and detach it)
        if (!g.moved) {
          setGesture(null);
          break;
        }
        const t = g.cur;
        mutate((dd) => {
          reconnectWireEnd(dd as CircuitDoc, g.wire, g.end, t);
        });
        setGesture(null);
        break;
      }
      case 'wire':
        if (g.fromDrag && g.dragging) {
          const t = findTarget(w);
          const moved = dist(g.start.pt, t.pt) >= grid;
          if (moved) commitWire(g, t);
          setGesture(null);
        } else if (g.fromDrag) {
          // released without dragging: continue in click-to-click mode
          setGesture({ ...g, fromDrag: false });
        }
        break;
      case 'shape': {
        const r = rectFromPoints(g.start, g.cur);
        if (g.shape === 'line' || g.shape === 'arrow') {
          if (dist(g.start, g.cur) >= grid) {
            let id = '';
            mutate((d) => {
              const s = makeShape(d as CircuitDoc, g.shape, g.start.x, g.start.y, g.cur.x - g.start.x, g.cur.y - g.start.y);
              s.group = S().scope;
              d.items[s.id] = s;
              id = s.id;
            });
            set({ selection: [id] });
          }
        } else if (g.shape === 'frame') {
          // a bare click frames what is on screen
          const fr = r.w >= grid && r.h >= grid ? r : A.visibleFrameRect();
          set({ selection: [A.addFrame(fr)] });
        } else if (r.w >= grid && r.h >= grid) {
          let id = '';
          mutate((d) => {
            const s = makeShape(d as CircuitDoc, g.shape, r.x, r.y, r.w, r.h);
            s.group = S().scope;
            d.items[s.id] = s;
            id = s.id;
          });
          set({ selection: [id] });
        }
        setGesture(null);
        break;
      }
      case 'exportArea': {
        // start and cur are already grid-snapped; a bare click (empty rect) cancels
        setGesture(null);
        runAreaExport(rectFromPoints(g.start, g.cur));
        break;
      }
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    const zoomMode = e.ctrlKey || e.metaKey || S().prefs.wheel === 'zoom';
    if (zoomMode && !e.shiftKey) {
      const factor = Math.exp(-e.deltaY * (e.ctrlKey && Math.abs(e.deltaY) < 50 ? 0.01 : 0.0015));
      A.zoomBy(factor, e.clientX - r.left, e.clientY - r.top);
    } else {
      const v = S().view;
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      set({ view: { ...v, x: v.x - dx, y: v.y - dy } });
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (S().exportArea) {
      set({ exportArea: null });
      return;
    }
    const g0 = gRef.current;
    if (g0?.kind === 'move' && g0.floating) {
      rotateFloating(g0);
      return;
    }
    if (g0?.kind === 'wire') {
      // Cadence: the right button flips which way the wire bends; elsewhere it cancels the wire
      if (S().prefs.shortcuts === 'cadence') setGesture({ ...g0, hFirst: !g0.hFirst, postureSet: true });
      else setGesture(null);
      return;
    }
    const pl = S().placing;
    if (pl) {
      // Cadence: the right button rotates the instance being placed
      if (S().prefs.shortcuts === 'cadence') set({ placing: { ...pl, rot: (((pl.rot ?? 0) + 90) % 360) as typeof pl.rot } });
      else set({ placing: null });
      return;
    }
    const w = toWorldPt(e.clientX, e.clientY);
    const hit = hitItem(w);
    if (hit && !selSet.has(hit)) select([hit]);
    if (!hit) set({ selection: [] });
    set({ contextMenu: { x: e.clientX, y: e.clientY, world: w, target: hit } });
  };

  const onDrop = (e: React.DragEvent) => {
    setFileDrag(false);
    if (e.dataTransfer.files.length) {
      e.preventDefault();
      void importDroppedFiles(e.dataTransfer.files, toWorldPt(e.clientX, e.clientY));
      return;
    }
    const sym = e.dataTransfer.getData('application/x-nodal-symbol');
    if (!sym) return;
    e.preventDefault();
    const p = sp(toWorldPt(e.clientX, e.clientY));
    A.placeComponent(sym, p.x, p.y);
  };

  /* ---------------------------- render ---------------------------- */

  const z = view.zoom;
  const gs = grid * z;
  const showGrid = doc.settings.showGrid;
  const majorEvery = 5;
  const dotGrid = gs >= 7;

  const g = gesture;
  // a lone wire shows its box too: pressing anywhere inside moves the whole wire
  const selectionBounds = selection.length > 1 || doc.items[selection[0]]?.type === 'wire' ? unionBounds(doc, selection) : null;
  const overScale = g?.kind === 'scale' || (tool === 'select' && !g && !placing && !!singleComp && !singleComp.locked && compHandles(singleComp).some((h) => dist(h, cursor) < 7 / z));
  const cursorStyle: string = overScale
    ? 'nwse-resize'
    : g?.kind === 'pan' || spaceDown || tool === 'pan'
      ? g?.kind === 'pan'
        ? 'grabbing'
        : 'grab'
      : exportAreaJob
        ? badgeCursor('area', prefs.theme) ?? 'crosshair'
        : g?.kind === 'arm'
          ? hover.item && !selection.length ? 'pointer' : 'crosshair'
        : g?.kind === 'move' || g?.kind === 'shapeTitle' || (tool === 'select' && !placing && !g && singleShape && hasMovableTitle(singleShape) && pointInRect(cursor, shapeTitle(singleShape).box, 3))
          ? 'move'
          : tool === 'node' && !placing
            ? g?.kind === 'node' || g?.kind === 'endpoint' || g?.kind === 'polyPart' || nodeAt(cursor) || (!g && polyPartAt(cursor))
              ? 'move'
              : hover.item
                ? 'pointer'
                : 'default'
          : placing || tool !== 'select'
            ? badgeCursor(tool === 'select' ? 'plus' : tool, prefs.theme) ?? 'crosshair'
            : g?.kind === 'wire'
              ? badgeCursor(tool, prefs.theme) ?? 'crosshair'
              : hover.port
                ? 'crosshair'
                : hover.item
                  ? 'pointer'
                  : tool === 'select' && !g && selectionBounds && pointInRect(cursor, selectionBounds, 4 / z)
                    ? 'move'
                    : 'default';

  const ghost: ComponentItem | null = placing
    ? {
        id: '__ghost',
        type: 'component',
        symbol: placing.symbol,
        x: sp(cursor).x,
        y: sp(cursor).y,
        rot: placing.rot,
        flipX: placing.flipX,
        ref: getSymbol(doc, placing.symbol).prefix + '?',
        value: getSymbol(doc, placing.symbol).value ?? '',
        props: {},
        showRef: !getSymbol(doc, placing.symbol).hideLabels,
        showValue: !!getSymbol(doc, placing.symbol).valueIsLabel,
      }
    : null;

  const scopeBounds = scope ? groupBounds(doc, scope) : null;
  const connectedPorts = data.portDegree;
  const showErc = useStore((s) => s.leftPanel && s.leftTab === 'check');
  const ercIssues = useErcIssues(showErc);

  return (
    <div
      ref={wrapRef}
      className={fileDrag ? 'canvas-wrap file-drop' : 'canvas-wrap'}
      style={{ cursor: cursorStyle }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        set({ pointerOnCanvas: false });
        setHover({ item: null, port: null });
        clearHotTimer('open');
        setHotPending(null);
        if (hotMenu) scheduleHotClose();
      }}
      onWheel={onWheel}
      onContextMenu={onContextMenu}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-nodal-symbol')) {
          e.preventDefault();
          setCursor(toWorldPt(e.clientX, e.clientY));
        } else if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setFileDrag(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileDrag(false);
      }}
      onDrop={onDrop}
    >
      <svg className="canvas" width="100%" height="100%">
        <defs>
          <pattern id="grid-minor" width={gs} height={gs} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
            {dotGrid ? <circle cx={0.75} cy={0.75} r={0.85} className="grid-dot" /> : null}
          </pattern>
          <pattern id="grid-major" width={gs * majorEvery} height={gs * majorEvery} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
            <circle cx={1} cy={1} r={1.4} className="grid-dot-major" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" className="canvas-bg" style={doc.settings.background ? { fill: doc.settings.background } : undefined} />
        {showGrid && (
          <>
            {dotGrid && <rect width="100%" height="100%" fill="url(#grid-minor)" />}
            <rect width="100%" height="100%" fill="url(#grid-major)" />
          </>
        )}
        <g transform={`translate(${view.x} ${view.y}) scale(${z})`}>
          {scopeBounds && (
            <rect x={scopeBounds.x - 16} y={scopeBounds.y - 16} width={scopeBounds.w + 32} height={scopeBounds.h + 32} rx={10} className="scope-box" strokeWidth={1.5 / z} />
          )}
          <Scene doc={doc} data={data} palette={EDITOR_PALETTE} highlight={highlight} frames={!presenting} />

          {/* unconnected port markers */}
          {prefs.showPortMarkers && z > 0.45 && (
            <g className="port-markers">
              {ports.map((p) =>
                connectedPorts.get(`${p.comp}:${p.port}`) || data.touching.has(`${p.comp}:${p.port}`) ? null : (
                  <circle key={`${p.comp}:${p.port}`} cx={p.pt.x} cy={p.pt.y} r={2.4} strokeWidth={1 / z} className="port-marker" />
                ),
              )}
            </g>
          )}

          {/* rule-check findings, while the Check tab is open */}
          {ercIssues.map((i) =>
            i.at ? (
              <g key={i.key} className={`erc-marker ${i.severity}`} transform={`translate(${i.at.x} ${i.at.y}) scale(${1 / z})`}>
                <title>{i.message}</title>
                <circle r={7} strokeWidth={1.5} />
                <text y={3.5} fontSize={10}>
                  !
                </text>
              </g>
            ) : null,
          )}

          {/* hover */}
          {hover.item && !selSet.has(hover.item) && !g && <HoverOutline doc={doc} id={hover.item} polys={data.polys} z={z} />}
          {/* items hovered in the layers panel */}
          {layerHover.map((id) => (
            <HoverOutline key={`lh-${id}`} doc={doc} id={id} polys={data.polys} z={z} />
          ))}

          {/* selection */}
          {/* a text item being typed into is framed by its editor, not its stale bounds */}
          {selection.map((id) => (id === editingText && (doc.items[id] as ShapeItem).kind === 'text' ? null : <SelectionOutline key={id} doc={doc} id={id} polys={data.polys} z={z} />))}
          {selectionBounds && <rect x={selectionBounds.x - 6} y={selectionBounds.y - 6} width={selectionBounds.w + 12} height={selectionBounds.h + 12} className="multi-sel" strokeWidth={1 / z} rx={4 / z} />}
          {/* selected wire node / segment (Del removes it) */}
          {(() => {
            if (!wirePart || !singleWire || wirePart.wire !== singleWire.id) return null;
            const pts = data.polys.get(wirePart.wire) ?? [];
            if (wirePart.kind === 'segment' && pts[wirePart.index] && pts[wirePart.index + 1]) {
              const a = pts[wirePart.index];
              const b = pts[wirePart.index + 1];
              return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="wire-part-seg" strokeWidth={7} strokeLinecap="round" />;
            }
            if (wirePart.kind === 'node' && pts[wirePart.index]) {
              const p = pts[wirePart.index];
              return <circle cx={p.x} cy={p.y} r={5.5 / z} className="wire-part-node" strokeWidth={2 / z} />;
            }
            return null;
          })()}
          {singleComp &&
            !singleComp.locked &&
            tool === 'select' &&
            compHandles(singleComp).map((h, i) => (
              <rect key={i} x={h.x - 4 / z} y={h.y - 4 / z} width={8 / z} height={8 / z} rx={2 / z} className="handle scale-handle" strokeWidth={1.5 / z} />
            ))}
          {singleShape &&
            !singleShape.locked &&
            !(singleShape.id === editingText && singleShape.kind === 'text') &&
            !(tool === 'node' && singleShape.kind === 'polygon') &&
            shapeHandles(singleShape).map((h) => (
              <rect key={h.h} x={h.p.x - 4 / z} y={h.p.y - 4 / z} width={8 / z} height={8 / z} rx={2 / z} className="handle" strokeWidth={1.5 / z} />
            ))}
          {tool === 'node' &&
            (() => {
              const hot = !g ? polyPartAt(cursor) : null;
              return [...new Set([...selection, ...(hover.item && !g ? [hover.item] : [])])].map((id) => {
                const it = doc.items[id];
                if (it?.type !== 'shape' || it.kind !== 'polygon' || it.locked) return null;
                const pts = polyPoints(it);
                return (
                  <g key={id} className="node-handles">
                    {(hot?.id === id && hot.part === 'edge') || (g?.kind === 'polyPart' && g.id === id && g.edge)
                      ? (() => {
                          const i = hot?.id === id ? hot.idx : (g as Extract<Gesture, { kind: 'polyPart' }>).idx;
                          const a = pts[i];
                          const b = pts[(i + 1) % pts.length];
                          return a && b ? <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="wire-part-seg" strokeWidth={7} strokeLinecap="round" /> : null;
                        })()
                      : null}
                    {pts.map((a, i) => {
                      const b = pts[(i + 1) % pts.length];
                      const on = hot?.id === id && hot.part === 'mid' && hot.idx === i;
                      return <circle key={`m${i}`} cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} r={(on ? 4 : 2.75) / z} className={on ? 'handle poly-mid active' : 'handle poly-mid'} strokeWidth={1.2 / z} />;
                    })}
                    {pts.map((p, i) => {
                      const active = (hot?.id === id && hot.part === 'corner' && hot.idx === i) || (g?.kind === 'polyPart' && g.id === id && !g.edge && g.idx === i);
                      const selected = wirePart?.wire === id && wirePart.kind === 'node' && wirePart.index === i;
                      const r = (active ? 5 : 3.75) / z;
                      return <rect key={i} x={p.x - r} y={p.y - r} width={2 * r} height={2 * r} rx={1 / z} className={active ? 'handle node active' : selected ? 'handle node selected' : 'handle node'} strokeWidth={1.5 / z} />;
                    })}
                  </g>
                );
              });
            })()}
          {tool === 'node' &&
            (() => {
              const hot = !g ? nodeAt(cursor) : null;
              return [...new Set([...selection, ...(hover.item && !g ? [hover.item] : [])])].map((id) => {
              const it = doc.items[id];
              if (it?.type !== 'wire' || it.locked) return null;
              const pts = data.polys.get(id) ?? [];
              return (
                <g key={id} className="node-handles">
                  {pts.map((p, i) => {
                    const end = i === 0 || i === pts.length - 1;
                    const active = (hot?.wire === id && hot.idx === i) || (g?.kind === 'node' && g.wire === id && g.idx === i);
                    const selected = wirePart?.wire === id && wirePart.kind === 'node' && wirePart.index === i;
                    const r = (active ? 5 : 3.75) / z;
                    const cls = (base: string) => (active ? `${base} active` : selected ? `${base} selected` : base);
                    return end ? (
                      <circle key={i} cx={p.x} cy={p.y} r={r + 0.75 / z} className={cls('handle')} strokeWidth={1.5 / z} />
                    ) : (
                      <rect key={i} x={p.x - r} y={p.y - r} width={2 * r} height={2 * r} rx={1 / z} className={cls('handle node')} strokeWidth={1.5 / z} />
                    );
                  })}
                </g>
              );
            });
            })()}
          {singleWire &&
            tool !== 'node' &&
            (() => {
              const pts = data.polys.get(singleWire.id) ?? [];
              if (pts.length < 2) return null;
              return [pts[0], pts[pts.length - 1]].map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={4.5 / z} className="handle" strokeWidth={1.5 / z} />);
            })()}

          {/* hover-menu hints: faint rings on nearby hot spots; the one being rested on fills up */}
          {tool === 'solder' && !g && !placing && (() => {
            const h = hotSpotAt(cursor);
            const act = h && solderActionFor(h);
            if (!h || !act) return null;
            const r = Math.max(doc.settings.junctionSize, 3);
            return act === 'solder' ? (
              <circle cx={h.pt.x} cy={h.pt.y} r={r} className="solder-preview" />
            ) : (
              <circle cx={h.pt.x} cy={h.pt.y} r={r + 3 / z} className="unsolder-preview" strokeWidth={1.5 / z} strokeDasharray={`${3 / z} ${2 / z}`} />
            );
          })()}
          {(tool === 'select' || tool === 'node' || tool === 'solder') && !g && !placing && !exportAreaJob &&
            hotSpots.map((h) => {
              if (tool === 'solder' && !solderActionFor(h)) return null;
              const reach = 90 / z;
              const d = dist(h.pt, cursor);
              const key = hotSpotKey(h);
              const open = hotMenu && hotSpotKey(hotMenu) === key;
              const pending = hotPending === key;
              if (d > reach && !open) return null;
              const r = h.kind === 'junction' ? Math.max(doc.settings.junctionSize + 3, 6 / z) : h.kind === 'end' ? 5 / z : 7 / z;
              return (
                <g key={key} className={open ? 'hot-ring open' : pending ? 'hot-ring pending' : 'hot-ring'} style={{ opacity: open || pending ? 1 : 0.55 * (1 - d / reach) }}>
                  <circle cx={h.pt.x} cy={h.pt.y} r={r} className="hot-ring-base" strokeWidth={1.2 / z} />
                  {(pending || open) && (
                    <circle cx={h.pt.x} cy={h.pt.y} r={r} pathLength={1} className="hot-ring-fill" strokeWidth={1.6 / z} transform={`rotate(-90 ${h.pt.x} ${h.pt.y})`} />
                  )}
                </g>
              );
            })}

          {/* hovered port */}
          {hover.port && (!g || g.kind === 'wire') && <circle cx={hover.port.pt.x} cy={hover.port.pt.y} r={6 / z + 2} className="port-hover" strokeWidth={2 / z} />}

          {/* gestures */}
          {g?.kind === 'marquee' && (() => {
            const r = rectFromPoints(g.start, g.cur);
            const crossing = g.cur.x < g.start.x;
            return <rect x={r.x} y={r.y} width={r.w} height={r.h} className={crossing ? 'marquee crossing' : 'marquee'} strokeWidth={1 / z} strokeDasharray={crossing ? `${4 / z} ${3 / z}` : undefined} />;
          })()}
          {g?.kind === 'exportArea' && (() => {
            const r = rectFromPoints(g.start, g.cur);
            return <rect x={r.x} y={r.y} width={r.w} height={r.h} className="marquee crossing" strokeWidth={1.5 / z} strokeDasharray={`${5 / z} ${4 / z}`} />;
          })()}
          {g?.kind === 'move' && g.moved && prefs.alignGuides &&
            guides.map((gd) =>
              gd.axis === 'x' ? (
                <line key={`x${gd.v}`} x1={gd.v} x2={gd.v} y1={gd.from - 12 / z} y2={gd.to + 12 / z} className="align-guide" strokeWidth={1 / z} strokeDasharray={`${4 / z} ${3 / z}`} />
              ) : (
                <line key={`y${gd.v}`} y1={gd.v} y2={gd.v} x1={gd.from - 12 / z} x2={gd.to + 12 / z} className="align-guide" strokeWidth={1 / z} strokeDasharray={`${4 / z} ${3 / z}`} />
              ),
            )}
          {g?.kind === 'wire' && (() => {
            const pts = wirePreview(g);
            const st = wireStyleFor(doc.settings, { bus: prefs.drawBus, style: S().wireBrush ?? undefined });
            return (
              <g className="wire-preview">
                <path d={buildWirePath(pts, st.radius)} fill="none" stroke={inkColor(st.color, EDITOR_PALETTE)} strokeWidth={st.width} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} strokeDasharray={dashArray(st.dash, st.width)} />
                <path d={buildWirePath(pts, st.radius)} fill="none" className="wire-preview-glow" strokeWidth={st.width + 6 / z} />
                <TargetMarker t={g.cur} z={z} />
                <TargetMarker t={g.start} z={z} />
              </g>
            );
          })()}
          {g?.kind === 'endpoint' && <TargetMarker t={g.cur} z={z} />}
          {g?.kind === 'shape' && <ShapePreview g={g} />}
          {g?.kind === 'polygon' && <PolygonPreview g={g} z={z} closing={closesPolygon(g, g.cur) && g.pts.length >= 3} />}
          {tool === 'wire' && !g && <TargetMarker t={findTarget(cursor)} z={z} subtle />}
          {ghost && (
            <g opacity={0.55} pointerEvents="none">
              <ComponentView c={ghost} def={instanceSymbol(doc, ghost)} settings={doc.settings} palette={EDITOR_PALETTE} ghost />
            </g>
          )}
          <RemotePresence doc={doc} polys={data.polys} z={z} />
        </g>
      </svg>
      <ExplainLayer data={data} wrapRef={wrapRef} />
      <FollowFrame />
      {scope && (
        <div className="scope-banner">
          Editing group <b>{doc.groups[scope]?.name ?? ''}</b>
          <button onClick={() => A.exitGroup()}>Done (Esc)</button>
        </div>
      )}
      {editingText && <TextEditor id={editingText} onDone={() => setEditingText(null)} />}
      {editingLabel && <LabelEditor {...editingLabel} onDone={() => setEditingLabel(null)} />}
      {prefs.showMinimap && <Minimap data={data} />}
      {hotMenu && !g && (
        <HotSpotMenu
          spot={hotMenu}
          doc={doc}
          data={data}
          onEnter={() => clearHotTimer('close')}
          onLeave={scheduleHotClose}
          onClose={closeHotMenu}
          onContinueWire={continueWire}
          onHold={(hold) => {
            hotHold.current = hold;
            if (hold) clearHotTimer('close');
          }}
        />
      )}
      {tool === 'select' && altMove && !exportAreaJob && g?.kind !== 'wire' && (
        <div className="canvas-hint">
          <b>Alt move</b> · only the selection moves; wires to it are left behind (unsoldered) · <kbd>M</kbd> normal move
        </div>
      )}
      {tool === 'solder' && !g && !exportAreaJob && (
        <div className="canvas-hint">
          Click a crossing, a touching end or a pin on a wire to <b>solder</b> · click a junction or wired pin to <b>unsolder</b> · <kbd>Esc</kbd> back to select
        </div>
      )}
      {tool === 'node' && !g && !exportAreaJob && (
        <div className="canvas-hint">
          Drag a bend or wire end to move it · click a node to select it, then <kbd>Del</kbd> removes it
          (double-click also removes) · <kbd>Alt</kbd> drag freely · <kbd>Esc</kbd> back to select
        </div>
      )}
      {exportAreaJob && (
        <div className="canvas-hint">
          Drag a rectangle over the region to export · <kbd>Esc</kbd>/<kbd>right-click</kbd> cancel
        </div>
      )}
      {g?.kind === 'wire' && (
        <div className="canvas-hint">
          Click to add bends · click a pin, wire or junction to connect · <kbd>Space</kbd> flip elbow · <kbd>⌫</kbd> undo bend · <kbd>Enter</kbd>/double-click to finish · <kbd>Esc</kbd> cancel
        </div>
      )}
      {placing && !g && (
        <div className="canvas-hint">
          Click to place · <kbd>R</kbd> rotate · <kbd>X</kbd>/<kbd>Y</kbd> flip · hold <kbd>Shift</kbd> to place several · <kbd>Esc</kbd> cancel
        </div>
      )}
    </div>
  );
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function groupBounds(doc: CircuitDoc, gid: string): Rect | null {
  const ids = Object.values(doc.items)
    .filter((i) => {
      let g = i.group;
      while (g) {
        if (g === gid) return true;
        g = doc.groups[g]?.group;
      }
      return false;
    })
    .map((i) => i.id);
  return unionBounds(doc, ids);
}

function unionBounds(doc: CircuitDoc, ids: string[]): Rect | null {
  const rects = ids.map((id) => doc.items[id] && itemBounds(doc, doc.items[id])).filter((r): r is Rect => !!r);
  if (!rects.length) return null;
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function TargetMarker({ t, z, subtle }: { t: Target; z: number; subtle?: boolean }) {
  if (t.kind === 'grid') return subtle ? <circle cx={t.pt.x} cy={t.pt.y} r={3 / z} className="target grid" /> : null;
  if (t.kind === 'wire' || t.kind === 'wireEnd')
    return <rect x={t.pt.x - 5 / z} y={t.pt.y - 5 / z} width={10 / z} height={10 / z} transform={`rotate(45 ${t.pt.x} ${t.pt.y})`} className="target wire" strokeWidth={2 / z} />;
  return <circle cx={t.pt.x} cy={t.pt.y} r={7 / z} className="target port" strokeWidth={2 / z} />;
}

/** Corners clicked so far, the rubber band to the pointer and, about to close, a ring on the first corner. */
function PolygonPreview({ g, z, closing }: { g: Extract<Gesture, { kind: 'polygon' }>; z: number; closing: boolean }) {
  const pts = [...g.pts, g.cur].map((p) => `${p.x},${p.y}`).join(' ');
  const first = g.pts[0];
  return (
    <g pointerEvents="none">
      <polyline points={pts} className="shape-preview" fill="none" />
      {g.pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.5 / z} className="polygon-vertex" />
      ))}
      {g.pts.length >= 3 && <circle cx={first.x} cy={first.y} r={(closing ? 7 : 5) / z} className={closing ? 'polygon-close on' : 'polygon-close'} strokeWidth={1.5 / z} />}
    </g>
  );
}

function ShapePreview({ g }: { g: Extract<Gesture, { kind: 'shape' }> }) {
  const r = rectFromPoints(g.start, g.cur);
  if (g.shape === 'line' || g.shape === 'arrow') {
    const len = Math.hypot(g.cur.x - g.start.x, g.cur.y - g.start.y) || 1;
    const ux = (g.cur.x - g.start.x) / len;
    const uy = (g.cur.y - g.start.y) / len;
    return (
      <g>
        <line x1={g.start.x} y1={g.start.y} x2={g.cur.x} y2={g.cur.y} className="shape-preview" />
        {g.shape === 'arrow' && <ArrowHeadEl tip={g.cur} x={ux} y={uy} size={12} kind="open" color="var(--accent)" sw={1.5} />}
      </g>
    );
  }
  if (g.shape === 'ellipse') return <ellipse cx={r.x + r.w / 2} cy={r.y + r.h / 2} rx={r.w / 2} ry={r.h / 2} className="shape-preview" />;
  if (g.shape === 'frame') return <rect x={r.x} y={r.y} width={r.w} height={r.h} className="shape-preview frame" />;
  return <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={g.shape === 'zone' ? 8 : 6} className={g.shape === 'zone' ? 'shape-preview zone' : 'shape-preview'} />;
}

function HoverOutline({ doc, id, polys, z }: { doc: CircuitDoc; id: string; polys: Map<string, Point[]>; z: number }) {
  const it = doc.items[id];
  if (!it) return null;
  if (it.type === 'wire') {
    const pts = polys.get(id) ?? [];
    return <path d={buildWirePath(pts, 0)} className="hover-wire" strokeWidth={8 / z} fill="none" />;
  }
  const b = itemBounds(doc, it);
  if (!b) return null;
  return <rect x={b.x - 4} y={b.y - 4} width={b.w + 8} height={b.h + 8} rx={4} className="hover-box" strokeWidth={1 / z} />;
}

function SelectionOutline({ doc, id, polys, z }: { doc: CircuitDoc; id: string; polys: Map<string, Point[]>; z: number }) {
  const it = doc.items[id];
  if (!it) return null;
  if (it.type === 'wire') {
    const pts = polys.get(id) ?? [];
    return <path d={buildWirePath(pts, 0)} className="sel-wire" strokeWidth={Math.max(6 / z, 4)} fill="none" />;
  }
  const b = itemBounds(doc, it);
  if (!b) return null;
  if (it.type === 'shape' && (it.kind === 'line' || it.kind === 'arrow')) {
    return <line x1={it.x} y1={it.y} x2={it.x + it.w} y2={it.y + it.h} className="sel-wire" strokeWidth={Math.max(6 / z, 4)} />;
  }
  const pad = it.type === 'junction' ? 3 : 4;
  return (
    <rect
      x={b.x - pad}
      y={b.y - pad}
      width={b.w + pad * 2}
      height={b.h + pad * 2}
      rx={3}
      className={it.locked ? 'sel-box locked' : 'sel-box'}
      strokeWidth={1.5 / z}
      strokeDasharray={it.locked ? `${4 / z} ${3 / z}` : undefined}
    />
  );
}

/** Inline editor for free text and for rectangle / zone / ellipse titles. */
function TextEditor({ id, onDone }: { id: string; onDone: () => void }) {
  const doc = useStore((s) => s.doc);
  const view = useStore((s) => s.view);
  const it = doc.items[id] as ShapeItem | undefined;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(it?.text ?? '');
  const done = useRef(false);
  useEffect(() => {
    // focus after the opening click has settled, or its default action steals focus back
    const t = setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, []);
  if (!it) return null;
  const isText = it.kind === 'text';
  const size = it.fontSize ?? (isText ? 16 : 13);
  const weight = isText ? (it.bold ? 700 : 400) : it.bold !== false ? 600 : 400;
  const m = measureRich(value, size, weight);
  const width = Math.max(80, m.w * view.zoom + 20);
  let at = { x: it.x, y: it.y };
  if (!isText) {
    const t = shapeTitle({ ...it, text: value || ' ' });
    at = { x: t.anchor === 'middle' ? t.x - width / view.zoom / 2 : t.box.x, y: t.box.y };
  }
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const text = value;
    mutate((d) => {
      const s = d.items[id] as ShapeItem;
      if (!s) return;
      if (!text.trim()) {
        if (s.kind === 'text') delete d.items[id];
        else delete s.text;
        return;
      }
      s.text = text;
      if (s.kind === 'text') Object.assign(s, measureRich(text, s.fontSize ?? 16, s.bold ? 700 : 400));
    });
    onDone();
  };
  const cancel = () => {
    done.current = true;
    onDone();
  };
  return (
    <textarea
      ref={ref}
      className="text-editor"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          if (value === (it.text ?? '')) cancel();
          else commit();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (!isText && !e.shiftKey))) {
          e.preventDefault();
          commit();
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{
        left: at.x * view.zoom + view.x - 4,
        top: at.y * view.zoom + view.y - 2,
        fontSize: size * view.zoom,
        lineHeight: 1.3,
        minWidth: width,
        height: m.h * view.zoom + 12,
        fontWeight: weight,
        color: it.textColor || undefined,
      }}
    />
  );
}

/** In-place editor for a part's reference or value, opened by double-clicking the label. */
function LabelEditor({ id, which, onDone }: { id: string; which: 'ref' | 'value'; onDone: () => void }) {
  const doc = useStore((s) => s.doc);
  const view = useStore((s) => s.view);
  const c = doc.items[id] as ComponentItem | undefined;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(c?.[which] ?? '');
  const done = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, []);
  if (!c) return null;
  const def = instanceSymbol(doc, c);
  const at = labelLayout(c, def)[which];
  if (!at) return null;
  // edit the bare text (no prefix/suffix/caps) at the label's own size
  const key = which === 'ref' ? 'refStyle' : 'valueStyle';
  const st = { ...c[key], prefix: undefined, suffix: undefined, allCaps: undefined };
  const look = labelLook({ ...c, [which]: value || ' ', [key]: st }, which, def);
  const box = labelBox(at, look);
  const width = Math.max(60, box.w * view.zoom + 24);
  const anchor = st.align ?? at.anchor;
  const left = anchor === 'start' ? at.x * view.zoom + view.x - 5 : anchor === 'middle' ? at.x * view.zoom + view.x - width / 2 : at.x * view.zoom + view.x - width + 5;
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const text = value.trim() ? value : '';
    if (text !== c[which]) mutate((d) => void ((d.items[id] as ComponentItem)[which] = text));
    onDone();
  };
  return (
    <textarea
      ref={ref}
      className="text-editor"
      value={value}
      placeholder={which === 'ref' ? 'Reference' : def.valueIsLabel ? 'Net name' : 'Value'}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          done.current = true;
          onDone();
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commit();
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{
        left,
        top: box.y * view.zoom + view.y - 3,
        fontSize: look.size * view.zoom,
        lineHeight: 1.3,
        width,
        height: box.h * view.zoom + 10,
        fontWeight: look.weight,
        textAlign: anchor === 'start' ? 'left' : anchor === 'middle' ? 'center' : 'right',
      }}
    />
  );
}
