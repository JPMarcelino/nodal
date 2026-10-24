import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { measureRich } from '../model/richText';
import { measureTextShape, textFaceStyle, textSize, textWeight } from '../model/shapeText';
import { drawOrderCached, groupMembers, groupTags, itemBounds, labelsShown, makeShape, selectedGroup } from '../model/doc';
import { withContents } from '../model/containers';
import { getPreset, makePresetShape } from '../model/shapePresets';
import { PresetShape } from './PresetShape';
import { componentBounds, dist, eq, measureText, pointInRect, projectOnSegment, rectFromPoints, snap, toWorld } from '../model/geometry';
import { cleanup, deleteWirePart, rotateShapeBy, scaleItems, selectionPivot, translateDetached, translateItems } from '../model/ops';
import { dragRotation, fromShapeFrame, HANDLE_ROT_KINDS, rectCentre, resizeInFrame, rotateDeg, shapeBox, shapeRot, shapeTransform, toShapeFrame } from '../model/rotation';
import { getSymbol, instanceSymbol } from '../model/registry';
import { gridScale, scaleStep } from '../model/symbols/scale';
import type { CircuitDoc, ComponentItem, Endpoint, Item, LabelSide, Point, Rect, ShapeItem, ShapeKind, Tool, WireItem } from '../model/types';
import { buildWirePath, endpointInfo, hitWire, moveWireNode, projectAlong, snapOnSegment, wireStyle, wireStyleFor } from '../model/wires';
import { computeNets, netOfWire } from '../model/netlist';
import { buildAngledPreview, buildWirePreview, commitWire as commitWireDoc, moveWireSegment, reconnectWireEnd, wireRouter } from '../model/wireCommit';
import { routeObstacles } from '../model/route';
import { runAreaExport } from '../io/fileActions';
import { importDroppedFiles } from '../io/importFiles';
import * as A from '../store/actions';
import { S, beginGesture, endGesture, gestureBaseDoc, gestureUpdate, inGesture, mutate, readOnly, rebaseGesture, select, set, toast, useStore, useViewDoc, vdoc, withGestureMutate } from '../store/store';
import { viewDoc } from '../model/pages';
import { pageCrossRefs } from '../model/pageRefs';
import { alignAnchors, alignMove, rectPoints, spaceMove, type AlignIndex, type Guide, type SpaceGuide } from '../model/align';
import { canvasActions } from '../store/canvasActions';
import { ArrowHeadEl, ComponentView, EDITOR_PALETTE, Scene, clampTitleOffset, dashArray, hasMovableTitle, frameTag, frozenLabelOffsets, inkColor, labelBox, labelLayout, labelLook, partLabelRects, shapeTitle, useSceneData, wireLabelAt, wireLabelLook, type SceneData } from './Scene';
import { Minimap } from './Minimap';
import { ExplainLayer } from './ExplainLayer';
import { inkHit } from '../model/ink';
import { constrain45, packPoly, polyHit } from '../model/polygon';
import { cubicAt, dragHandle, insertNode, isSmooth, minNodes, moveNode, nearestOnPath, pathD, pathNodes, pathSegs, setNodeKind, setPathNodes, type PathNode } from '../model/path';
import { X, setX, useExplain } from '../store/explain';
import { FollowFrame, RemotePresence } from './RemotePresence';
import { useErcIssues } from '../ui/CheckPanel';
import { HotSpotMenu } from './HotSpotMenu';
import { HintBar, WelcomeScreen } from '../ui/CanvasGuides';
import { marqueeHits } from '../model/marquee';
import { gestureSlots, hitSlop, useTouchInput } from './touch';
import { applySolder, solderActionFor } from './solder';
import { computeHotSpots, hotSpotKey, type HotSpot } from '../model/hotspots';
import { attachSpots, bendSlots, findGlue, isConnector, isFixed, resolveConnector, type GlueHit } from '../model/connectors';

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
  | { kind: 'marquee'; start: Point; cur: Point; additive: boolean; keep?: boolean }
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
  /** Lines and arrows: `glueA` / `glueB` are what the start / end would be glued to. */
  | { kind: 'shape'; shape: ShapeKind; start: Point; cur: Point; preset?: string; glueA?: GlueHit | null; glueB?: GlueHit | null }
  /** Dragging a selected connector's end (re-gluing it to what it is dropped on) or bend `idx`. */
  | { kind: 'conn'; id: string; part: 'start' | 'end' | 'bend'; idx: number; moved: boolean; glue: GlueHit | null }
  /**
   * Edit points on a polygon / path: dragging node `idx`, one of its handles
   * (`in` / `out`; Alt breaks a smooth pair), or the stretch from node `idx`
   * to the next one (`edge`). `click`: where on that stretch a click without a
   * drag adds a node.
   */
  | { kind: 'polyPart'; id: string; base: PathNode[]; idx: number; part: 'node' | 'edge' | 'in' | 'out'; start: Point; moved: boolean; click?: { seg: number; t: number } }
  /** Polygon being clicked out corner by corner; it closes when a click lands back on the first corner. */
  | { kind: 'polygon'; pts: Point[]; cur: Point }
  /**
   * Path tool: nodes placed so far; `drag` while the button is held on the
   * newest node (pulling out its handles), `closing` when that press landed
   * back on the first node.
   */
  | { kind: 'path'; nodes: PathNode[]; cur: Point; drag: boolean; closing: boolean }
  | { kind: 'exportArea'; start: Point; cur: Point }
  | { kind: 'resize'; id: string; handle: Handle; base: ShapeItem; start: Point }
  /** Turning a lone shape by its rotation handle about `centre`; `base` is its rotation when the drag began. */
  | { kind: 'rotate'; id: string; centre: Point; start: Point; base: number }
  /** Resizing a part from a corner handle: its size follows the distance from its centre. */
  | { kind: 'scale'; id: string; base: number; d0: number }
  /** Resizing a multi-selection (a group) as one by a corner of its box, about `pivot`. */
  | { kind: 'groupScale'; ids: Set<string>; pivot: Point; d0: number }
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
  path: '<path d="M2.8 10C3.5 5 9.5 8 10.2 3" fill="none" stroke="#1f2433" stroke-width="1.3" stroke-linecap="round"/><rect x="1.8" y="9" width="2" height="2" fill="#1f2433"/><rect x="9.2" y="2" width="2" height="2" fill="#1f2433"/>',
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
  const doc = useViewDoc();
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
  const xrefs = useStore((s) => pageCrossRefs(s.doc, s.page));
  const wireAvoid = useStore((s) => s.prefs.wireAvoid);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gRef = useRef<Gesture | null>(null);
  /** Where the pointer last moved, and the move handler, so a modifier key can replay the move. */
  const lastMove = useRef<{ clientX: number; clientY: number } | null>(null);
  const moveRef = useRef<((e: React.PointerEvent) => void) | null>(null);
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  const [hover, setHover] = useState<{ item: string | null; port: PortInfo | null }>({ item: null, port: null });
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 });
  const [guides, setGuides] = useState<Guide[]>([]);
  const [spaceGuides, setSpaceGuides] = useState<SpaceGuide[]>([]);
  /** Alignment anchors of the running move (or label drag), keyed by its id set (or gesture). */
  const alignRef = useRef<{ ids: Set<string> | object; moving: Point[]; index: AlignIndex; box: Rect | null; others: Rect[] } | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [fileDrag, setFileDrag] = useState(false);
  const [editingText, setEditingText] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState<{ id: string; which: 'ref' | 'value' } | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
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
        // only a wire, polygon or path being clicked out survives between touches; anything else is dropped
        setGesture(before?.kind === 'wire' || before?.kind === 'polygon' || before?.kind === 'path' ? before : null);
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
    const h = (tool === 'select' || tool === 'node') && !readOnly() ? hotSpotAt(w) : null;
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
    const w = vdoc().items[wire];
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
    const c = vdoc().items[pi.comp] as ComponentItem;
    const info = endpointInfo(vdoc(), { kind: 'port', comp: c.id, port: pi.port });
    return info?.dir ?? { x: 0, y: 0 };
  };

  const findTarget = useCallback(
    (raw: Point, excludeWire?: string): Target => {
      const d = vdoc();
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
      const pw = p;
      const d = vdoc();
      const z = S().view.zoom;
      const t = (6 / z) * hitSlop();
      // locked items stay selectable (to inspect or unlock them); they just don't move or edit
      const items = Object.values(d.items).filter((i) => !i.hidden);
      // frames are not drawn (so not clickable) while presenting
      const shapes = items.filter((i): i is ShapeItem => i.type === 'shape' && (X().presenting === null || i.kind !== 'frame'));
      /**
       * 'strong' for a hit on what the shape visibly draws; 'weak' for a click
       * inside a see-through fill (tinted zones, highlighter), which never
       * steals the click from wires and parts drawn inside it.
       */
      const shapeHit = (s: ShapeItem): 'strong' | 'weak' | false => {
        // a turned shape is tested in its own frame, against its unturned box
        const turned = shapeRot(s) !== 0;
        const p = turned ? toShapeFrame(s, pw) : pw;
        const r = turned ? shapeBox(s) : itemBounds(d, s)!;
        if (hasMovableTitle(s) && pointInRect(p, shapeTitle(s).box, 3)) return 'strong';
        if (s.kind === 'frame' && pointInRect(p, frameTag(s), 2)) return 'strong';
        if (s.kind === 'line' || s.kind === 'arrow') {
          // along the drawn path: bends, elbows and curves, glued ends where their targets are
          const f = resolveConnector(d, s).flat;
          let best = Infinity;
          for (let i = 0; i < f.length - 1; i++) best = Math.min(best, projectOnSegment(p, f[i], f[i + 1]).d);
          return best < t + s.strokeWidth && 'strong';
        }
        if (s.kind === 'text' || s.kind === 'image' || s.kind === 'callout') return pointInRect(p, r, 4) && 'strong';
        if (s.kind === 'ink') return inkHit(s, p, t) && (s.highlighter ? 'weak' : 'strong');
        const seeThrough = s.fillOpacity < 0.5;
        if (s.kind === 'polygon') {
          if (!polyHit(s, p, t)) return false;
          // inside the outline only through the fill: see-through fills are weak
          return seeThrough && polyHit({ ...s, fillOpacity: 0 }, p, t) === false ? 'weak' : 'strong';
        }
        const inside = pointInRect(p, r, t);
        if (!inside) return false;
        const onEdge = !pointInRect(p, { x: r.x + t, y: r.y + t, w: r.w - 2 * t, h: r.h - 2 * t });
        if (onEdge) return 'strong';
        return s.fillOpacity > 0 && (seeThrough ? 'weak' : 'strong');
      };
      const out: string[] = [];
      for (const it of items) if (it.type === 'junction' && dist(it, p) < t + 2) out.push(it.id);
      // shapes, parts and wires in their shared stacking order, front first (as drawn)
      const rank = drawOrderCached(d);
      const strong: string[] = [];
      const weak: string[] = [];
      for (const s of shapes) {
        const h = shapeHit(s);
        if (h) (h === 'weak' ? weak : strong).push(s.id);
      }
      for (const c of items) if (c.type === 'component' && pointInRect(p, itemBounds(d, c)!, 1)) strong.push(c.id);
      for (const [id, pts] of data.polys) {
        if (!d.items[id] || d.items[id].hidden) continue;
        let best = Infinity;
        for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, projectOnSegment(p, pts[i], pts[i + 1]).d);
        if (best <= Math.max(4, t)) strong.push(id);
      }
      const front = (a: string, b: string) => rank.get(b)! - rank.get(a)!;
      out.push(...strong.sort(front), ...weak.sort(front));
      return out;
    },
    [data],
  );
  const hitItem = useCallback((p: Point): string | null => hitItems(p)[0] ?? null, [hitItems]);

  /** Selected component label (reference or value *text*) under the pointer; dragging it moves just that label. `any` looks at every part. */
  const hitLabel = useCallback((p: Point, any = false): { id: string; which: 'ref' | 'value' } | null => {
    const d = vdoc();
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
      const d = vdoc();
      for (const it of Object.values(d.items)) {
        if (it.type !== 'wire' || !it.label || it.labelHidden || it.hidden || it.locked || d.settings.hideWireLabels) continue;
        const spot = wireLabelAt(it, data.polys.get(it.id) ?? [], wireStyle(d, it).width);
        if (!spot) continue;
        const look = wireLabelLook(it);
        const m = measureRich(look.text, look.size, look.weight, look.st.font);
        const x = spot.anchor === 'start' ? spot.x : spot.anchor === 'middle' ? spot.x - m.w / 2 : spot.x - m.w;
        if (pointInRect(p, { x, y: spot.y - look.size, w: m.w, h: look.size * 1.3 }, 2)) return it.id;
      }
      return null;
    },
    [data],
  );

  /* ------------------------ selection handles ------------------------ */

  const singleShape = selection.length === 1 && doc.items[selection[0]]?.type === 'shape' ? (doc.items[selection[0]] as ShapeItem) : null;
  const singleWire = selection.length === 1 && doc.items[selection[0]]?.type === 'wire' ? (doc.items[selection[0]] as WireItem) : null;
  const singleComp = selection.length === 1 && doc.items[selection[0]]?.type === 'component' ? (doc.items[selection[0]] as ComponentItem) : null;
  /** Group name tags shown while outside the group (hidden when presenting). */
  const tags = useMemo(
    () =>
      presenting
        ? []
        : groupTags(doc, scope).map((t) => {
            // sit above the parts' names and values too, not just their bodies
            let y = t.y;
            for (const id of groupMembers(doc, t.id)) {
              const c = doc.items[id];
              if (c?.type !== 'component' || c.hidden) continue;
              const def = instanceSymbol(doc, c);
              const lay = labelLayout(c, def);
              const shown = labelsShown(doc.settings, c, def);
              for (const which of ['ref', 'value'] as const) {
                const at = lay[which];
                if (at && shown[which] && c[which]) y = Math.min(y, labelBox(at, labelLook(c, which, def)).y);
              }
            }
            return { ...t, y };
          }),
    [doc, scope, presenting],
  );
  const TAG_SIZE = 10;
  const tagBox = (t: (typeof tags)[number], z: number) => ({ x: t.x, y: t.y - (TAG_SIZE + 6) / z, w: (measureText(t.name, TAG_SIZE, 600).w + 4) / z, h: (TAG_SIZE + 4) / z });
  const groupTagAt = (w: Point) => {
    const z = S().view.zoom;
    return tags.find((t) => pointInRect(w, tagBox(t, z), 1 / z));
  };

  /** Corner handles of a multi-selection holding parts (a group): dragging one resizes it all. */
  const groupHandles = (): Point[] => {
    const sel = S().selection;
    const d = vdoc();
    if (S().tool !== 'select' || S().placing || sel.length < 2 || !sel.some((id) => d.items[id]?.type === 'component' && !d.items[id].locked)) return [];
    const b = unionBounds(d, sel);
    if (!b) return [];
    const o = 6;
    return [
      { x: b.x - o, y: b.y - o },
      { x: b.x + b.w + o, y: b.y - o },
      { x: b.x + b.w + o, y: b.y + b.h + o },
      { x: b.x - o, y: b.y + b.h + o },
    ];
  };
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
    if (s.kind === 'line' || s.kind === 'arrow') {
      const r = resolveConnector(vdoc(), s);
      return [
        { h: 'p1', p: r.start },
        { h: 'p2', p: r.end },
      ];
    }
    // free text: one handle on the right edge sets the width it wraps at
    if (s.kind === 'text') {
      const b = shapeBox(s);
      return [{ h: 'e', p: fromShapeFrame(s, { x: b.x + b.w, y: b.y + b.h / 2 }) }];
    }
    if (s.kind === 'callout') return [];
    const { x, y, w, h } = s;
    const out: { h: Handle; p: Point }[] = [
      { h: 'nw', p: { x, y } },
      { h: 'n', p: { x: x + w / 2, y } },
      { h: 'ne', p: { x: x + w, y } },
      { h: 'e', p: { x: x + w, y: y + h / 2 } },
      { h: 'se', p: { x: x + w, y: y + h } },
      { h: 's', p: { x: x + w / 2, y: y + h } },
      { h: 'sw', p: { x, y: y + h } },
      { h: 'w', p: { x, y: y + h / 2 } },
    ];
    // a turned shape's handles sit on its turned outline
    return shapeRot(s) ? out.map((o) => ({ h: o.h, p: fromShapeFrame(s, o.p) })) : out;
  };

  /** The round rotation handle on a short stalk above a lone shape's top edge (turning with the shape). */
  const rotHandle = (s: ShapeItem): { at: Point; foot: Point } | null => {
    if (!HANDLE_ROT_KINDS.has(s.kind) || s.locked || S().tool !== 'select') return null;
    const b = shapeBox(s);
    const foot = { x: b.x + b.w / 2, y: b.y };
    return { foot: fromShapeFrame(s, foot), at: fromShapeFrame(s, { x: foot.x, y: b.y - 22 / view.zoom }) };
  };

  /**
   * A selected connector's handles: its ends (drag to glue or unglue), its bends
   * (drag; double-click removes) and a "+" in the middle of each stretch (drag
   * to add a bend there).
   */
  const connHandles = (s: ShapeItem) => {
    const r = resolveConnector(vdoc(), s);
    return {
      ends: [
        { part: 'start' as const, p: r.start, glued: !!s.from },
        { part: 'end' as const, p: r.end, glued: !!s.to },
      ],
      bends: (s.pts ?? []).map((p, idx) => ({ idx, p })),
      mids: bendSlots(r),
    };
  };

  /** Connector handle under the pointer (ends first, then bends, then the "+" knobs). */
  const connHandleAt = (s: ShapeItem, w: Point): { part: 'start' | 'end' | 'bend' | 'mid'; idx: number; p: Point } | null => {
    const tol = (7 / S().view.zoom) * hitSlop();
    const h = connHandles(s);
    const end = h.ends.find((e) => dist(e.p, w) < tol);
    if (end) return { part: end.part, idx: 0, p: end.p };
    const bend = h.bends.find((b) => dist(b.p, w) < tol);
    if (bend) return { part: 'bend', idx: bend.idx, p: bend.p };
    const mid = h.mids.find((m) => dist(m.pt, w) < tol * 0.8);
    return mid ? { part: 'mid', idx: mid.idx, p: mid.pt } : null;
  };

  /** What a connector end dropped at `w` would glue to (Alt: nothing). */
  const glueAt = (w: Point, alt: boolean, exclude?: string): GlueHit | null => (alt ? null : findGlue(vdoc(), w, (8 / S().view.zoom) * hitSlop(), exclude));

  /* -------------------------- edit points -------------------------- */

  /** Wire vertex (end or bend) under the pointer; selected wires win over the rest. */
  const nodeAt = (p: Point): { wire: string; idx: number; pts: Point[] } | null => {
    const d = vdoc();
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
   * Polygon / path part under the pointer in the edit points tool: a handle of
   * a selected outline, a node, a stretch's midpoint knob (dragging it adds a
   * node) or anywhere along a stretch. Selected outlines win over the rest.
   */
  const polyPartAt = (p: Point): { id: string; idx: number; part: 'in' | 'out' | 'corner' | 'mid' | 'edge'; nodes: PathNode[]; t: number } | null => {
    const d = vdoc();
    const tol = (7 / S().view.zoom) * hitSlop();
    const sel = new Set(S().selection);
    const polys = Object.values(d.items).filter((i): i is ShapeItem => i.type === 'shape' && i.kind === 'polygon' && !i.hidden && !i.locked);
    polys.sort((a, b) => Number(sel.has(b.id)) - Number(sel.has(a.id)));
    for (const part of ['handle', 'corner', 'mid', 'edge'] as const) {
      for (const s of polys) {
        const nodes = pathNodes(s);
        if (part === 'handle') {
          if (!sel.has(s.id)) continue;
          for (let i = 0; i < nodes.length; i++)
            for (const which of ['out', 'in'] as const) {
              const h = nodes[i][which];
              if (h && dist(h, p) < tol) return { id: s.id, idx: i, part: which, nodes, t: 0 };
            }
          continue;
        }
        if (part === 'corner') {
          const i = nodes.findIndex((n) => dist(n, p) < tol);
          if (i >= 0) return { id: s.id, idx: i, part, nodes, t: 0 };
          continue;
        }
        if (part === 'mid') {
          const i = pathSegs(nodes, s.open).findIndex((g) => dist(cubicAt(g, 0.5), p) < tol * 0.8);
          if (i >= 0) return { id: s.id, idx: i, part, nodes, t: 0.5 };
          continue;
        }
        const near = nearestOnPath(nodes, s.open, p);
        if (near && near.d < tol * 0.7 + s.strokeWidth / 2) return { id: s.id, idx: near.seg, part, nodes, t: near.t };
      }
    }
    return null;
  };

  /** Adds a node to a polygon / path at `t` along stretch `seg` (the curve keeps its shape); returns the new node's index. */
  const insertPathNode = (d: CircuitDoc, id: string, seg: number, t: number, snapTo?: Point): number => {
    const s = d.items[id] as ShapeItem;
    const r = insertNode(pathNodes(s), s.open, seg, t);
    // a straight stretch takes the node on the grid; a curve keeps it on the curve
    if (snapTo && r.index >= 0 && !r.nodes[r.index].in && !r.nodes[r.index].out) Object.assign(r.nodes[r.index], snapTo);
    setPathNodes(s, r.nodes);
    return r.index;
  };

  const onNodeDown = (w: Point, e: React.PointerEvent, isDouble: boolean) => {
    const v = S().view;
    const pp = polyPartAt(w);
    if (pp) {
      if (!selSet.has(pp.id)) select([pp.id]);
      if (pp.part === 'in' || pp.part === 'out') {
        set({ wirePart: { wire: pp.id, kind: 'node', index: pp.idx } });
        beginGesture();
        setGesture({ kind: 'polyPart', id: pp.id, base: pp.nodes, idx: pp.idx, part: pp.part, start: w, moved: false });
        return;
      }
      if (pp.part === 'corner') {
        set({ wirePart: { wire: pp.id, kind: 'node', index: pp.idx } });
        if (isDouble) {
          // double-click a node switches it between corner and smooth (Del removes it)
          mutate((d) => {
            const s = d.items[pp.id] as ShapeItem;
            const ns = pathNodes(s);
            setPathNodes(s, setNodeKind(ns, s.open, pp.idx, ns[pp.idx].in || ns[pp.idx].out ? 'corner' : 'smooth'));
          });
          return;
        }
        beginGesture();
        setGesture({ kind: 'polyPart', id: pp.id, base: pp.nodes, idx: pp.idx, part: 'node', start: w, moved: false });
        return;
      }
      if (pp.part === 'mid' || isDouble || e.altKey) {
        // a new node on the stretch, dragged straight away
        beginGesture();
        let idx = -1;
        const straight = pathSegs(pp.nodes, (vdoc().items[pp.id] as ShapeItem).open)[pp.idx]?.line;
        gestureUpdate((d) => void (idx = insertPathNode(d as CircuitDoc, pp.id, pp.idx, pp.t, straight ? sp(w) : undefined)));
        if (idx < 0) {
          endGesture(false);
          return;
        }
        const base = pathNodes(vdoc().items[pp.id] as ShapeItem);
        set({ wirePart: { wire: pp.id, kind: 'node', index: idx } });
        setGesture({ kind: 'polyPart', id: pp.id, base, idx, part: 'node', start: base[idx] ?? w, moved: true });
        return;
      }
      set({ wirePart: null });
      beginGesture();
      // dragging a stretch moves it; a plain click adds a node there
      setGesture({ kind: 'polyPart', id: pp.id, base: pp.nodes, idx: pp.idx, part: 'edge', start: w, moved: false, click: selSet.has(pp.id) ? { seg: pp.idx, t: pp.t } : undefined });
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
    const item = hit ? vdoc().items[hit] : null;
    if (item?.type === 'wire' && item.routing === 'straight' && !item.locked) {
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
    return buildWirePreview(g.start.pt, g.pts, g.hFirst, g.cur.pt, routeObs ? wireRouter(vdoc(), g.start, g.cur, grid, routeObs) : undefined);
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
    if (id) set({ selection: [id] });
  };

  // switching tools drops a half-drawn polygon or path
  useEffect(() => {
    if (gRef.current?.kind === 'polygon' && tool !== 'polygon') setGesture(null);
    if (gRef.current?.kind === 'path' && tool !== 'path') setGesture(null);
  }, [tool]);

  /* ------------------------------ path ------------------------------ */

  /** Where the next path node goes: on the grid (Alt: anywhere), at 45° steps from the last node with Shift. */
  const pathPoint = (g: Extract<Gesture, { kind: 'path' }> | null, w: Point, e: { shiftKey: boolean; altKey: boolean }): Point => {
    const p = e.altKey ? w : sp(w);
    const last = g?.nodes[g.nodes.length - 1];
    return e.shiftKey && last ? constrain45(last, p) : p;
  };

  /** A press on the first node of a path being drawn closes it. */
  const onFirstNode = (g: Extract<Gesture, { kind: 'path' }>, w: Point) => g.nodes.length >= 3 && dist(g.nodes[0], w) < (8 / S().view.zoom) * hitSlop();

  const commitPath = (nodes: PathNode[], open: boolean) => {
    setGesture(null);
    if (nodes.length < minNodes(open)) return;
    let id = '';
    mutate((d) => {
      const s = makeShape(d as CircuitDoc, 'polygon', 0, 0, 1, 1);
      setPathNodes(s, nodes, open);
      s.group = S().scope;
      d.items[s.id] = s;
      id = s.id;
    });
    if (id) set({ selection: [id] });
  };

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
        ...(brush ? { style: { ...brush } } : {}),
      });
    });
    if (newId && vdoc().items[newId]) set({ selection: [] });
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
    const before = S().doc; // the whole document: the undo point
    if (copy) A.copyInPlace();
    const ids = new Set(S().selection.filter((id) => !vdoc().items[id]?.locked));
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
    withGestureMutate(() => A.rotateSelection(90));
    rebaseGesture();
    setGesture({ ...g, start: sp(S().cursor), dx: 0, dy: 0 });
  };

  const finishMove = (g: Extract<Gesture, { kind: 'move' }>) => {
    if (g.detach && g.moved) {
      // wire ends set down exactly on a pin, junction or another wire's end connect to it
      const joins: { wire: string; end: 'a' | 'b'; t: Target }[] = [];
      if (g.rejoin) {
        for (const id of g.ids) {
          const wi = vdoc().items[id];
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

  /** Drops the gesture in progress, undoing what it changed so far (Esc, or the system cancelling the pointer). */
  const abortGesture = () => {
    const g = gRef.current;
    if (!g) return;
    if (g.kind === 'move' || g.kind === 'conn' || g.kind === 'polyPart' || g.kind === 'segment' || g.kind === 'resize' || g.kind === 'rotate' || g.kind === 'scale' || g.kind === 'groupScale' || g.kind === 'label' || g.kind === 'shapeTitle' || g.kind === 'node' || g.kind === 'endpoint') endGesture(false);
    setGesture(null);
    // a cancelled copy takes its staged items with it
    if (g.kind === 'move' && g.floating) set({ selection: S().selection.filter((id) => vdoc().items[id]) });
    set({ wirePart: null });
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
      if (g?.kind === 'path') {
        if (combo === 'Escape') {
          setGesture(null);
          return true;
        }
        if (combo === 'Backspace' || combo === 'Delete') {
          setGesture(g.nodes.length > 1 ? { ...g, nodes: g.nodes.slice(0, -1), drag: false, closing: false } : null);
          return true;
        }
        if (combo === 'Enter') {
          commitPath(g.nodes, true);
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
        abortGesture();
        return true;
      }
      return false;
    };
    canvasActions.floatMove = ({ detach, copy }) => armMove(detach, copy);
    canvasActions.renameGroup = setRenamingGroup;
    return () => {
      canvasKeys.handle = null;
      canvasActions.floatMove = null;
      canvasActions.renameGroup = null;
    };
  });

  // pressing or letting go of Shift / Ctrl mid-resize reshapes at once, without waiting for the pointer to move
  useEffect(() => {
    const remod = (e: KeyboardEvent) => {
      if (gRef.current?.kind !== 'resize' || !lastMove.current) return;
      if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Meta') return;
      moveRef.current?.({ ...lastMove.current, buttons: 1, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey } as unknown as React.PointerEvent);
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e) && !gRef.current) {
        setSpaceDown(true);
      }
      remod(e);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
      remod(e);
    };
    // the Space key-up never arrives when the window loses focus while it is held
    const blur = () => setSpaceDown(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  /* ---------------------------- pointer ---------------------------- */

  /** The selected locked item whose lock badge is under the pointer. */
  const lockBadgeAt = (p: Point): string | null => {
    const d = vdoc();
    const z = S().view.zoom;
    for (const id of S().selection) {
      const r = lockBadge(d, id, z);
      if (r && pointInRect(p, r, 2 / z)) return id;
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (editingText || editingLabel || renamingGroup) return;
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
    // the lock badge of a selected locked item unlocks it
    const badge = tool === 'select' && !placing && !gRef.current && !readOnly() ? lockBadgeAt(w) : null;
    if (badge) {
      mutate((d) => d.items[badge] && (d.items[badge].locked = false));
      toast('Unlocked');
      return;
    }
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

    // View mode (or a view-only session): a click selects (Shift / Ctrl adds), a double-click
    // goes into a group or back out, a drag draws a marquee; nothing is moved or edited
    if (readOnly() && !gRef.current) {
      const hit = hitItems(w)[0] ?? null;
      const it = hit ? vdoc().items[hit] : undefined;
      if (it && isDouble) {
        if (it.group && it.group !== S().scope) A.enterGroup(hit!);
        return;
      }
      if (hit) {
        select([hit], e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : 'replace');
        return;
      }
      if (isDouble && S().scope) {
        A.exitGroup();
        return;
      }
      set({ wirePart: null });
      setGesture({ kind: 'marquee', start: w, cur: w, additive: e.shiftKey || e.ctrlKey || e.metaKey });
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

    if (g?.kind === 'path') {
      if (onFirstNode(g, w)) {
        // closes on release; a drag first pulls out the first node's handles
        setGesture({ ...g, drag: true, closing: true, cur: g.nodes[0] });
        return;
      }
      const p = pathPoint(g, w, e);
      const last = g.nodes[g.nodes.length - 1];
      if (isDouble) {
        commitPath(eq(p, last) ? g.nodes : [...g.nodes, { x: p.x, y: p.y }], true);
        return;
      }
      // pressing on the newest node again pulls its handles out afresh
      setGesture(eq(p, last) ? { ...g, drag: true, closing: false } : { ...g, nodes: [...g.nodes, { x: p.x, y: p.y }], cur: p, drag: true, closing: false });
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
      // one part, then back to Select; Shift, the tool lock or the Cadence scheme keep placing copies until Esc
      A.placeArmed(p.x, p.y, e.shiftKey);
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
      if (!id) return;
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
    if (tool === 'path') {
      const p = pathPoint(null, w, e);
      setGesture({ kind: 'path', nodes: [{ x: p.x, y: p.y }], cur: p, drag: true, closing: false });
      return;
    }
    if (tool === 'line' || tool === 'arrow') {
      // pressing on a shape or part glues the start to it (Alt: don't)
      const glueA = glueAt(w, e.altKey);
      const p = glueA && isFixed(glueA.attach) ? glueA.pt : e.altKey ? w : sp(w);
      setGesture({ kind: 'shape', shape: tool, start: p, cur: p, glueA, glueB: null });
      return;
    }
    if (tool !== 'select') {
      const p = sp(w);
      setGesture({ kind: 'shape', shape: tool as ShapeKind, start: p, cur: p, preset: tool === 'rect' ? S().shapePreset ?? undefined : undefined });
      return;
    }

    // ---- select tool ----
    // a group's name tag: click selects the group, double-click renames it
    const tag = groupTagAt(w);
    if (tag) {
      if (isDouble) setRenamingGroup(tag.id);
      else select(groupMembers(vdoc(), tag.id), e.shiftKey ? 'toggle' : 'replace');
      return;
    }
    if (groupHandles().some((h) => dist(h, w) < 7 / v.zoom)) {
      const ids = new Set(S().selection);
      const pivot = selectionPivot(vdoc(), ids);
      beginGesture();
      setGesture({ kind: 'groupScale', ids, pivot, d0: Math.max(1, dist(w, pivot)) });
      return;
    }
    if (singleComp && !singleComp.locked && compHandles(singleComp).some((h) => dist(h, w) < 7 / v.zoom)) {
      beginGesture();
      setGesture({ kind: 'scale', id: singleComp.id, base: singleComp.scale ?? 1, d0: Math.max(1, dist(w, singleComp)) });
      return;
    }
    const rh = singleShape && rotHandle(singleShape);
    if (singleShape && rh && dist(rh.at, w) < 7 / v.zoom) {
      beginGesture();
      setGesture({ kind: 'rotate', id: singleShape.id, centre: rectCentre(shapeBox(singleShape)), start: w, base: shapeRot(singleShape) });
      return;
    }
    if (singleShape && !singleShape.locked && hasMovableTitle(singleShape) && pointInRect(toShapeFrame(singleShape, w), shapeTitle(singleShape).box, 3)) {
      beginGesture();
      setGesture({ kind: 'shapeTitle', id: singleShape.id, start: w, base: { dx: singleShape.textDx ?? 0, dy: singleShape.textDy ?? 0 } });
      return;
    }
    const ch = singleShape && !singleShape.locked && isConnector(singleShape) ? connHandleAt(singleShape, w) : null;
    if (singleShape && ch) {
      const id = singleShape.id;
      if (ch.part === 'bend' && isDouble) {
        // double-click a bend removes it
        mutate((d) => {
          const s = d.items[id] as ShapeItem;
          s.pts?.splice(ch.idx, 1);
          if (!s.pts?.length) delete s.pts;
        });
        return;
      }
      beginGesture();
      if (ch.part === 'mid') {
        // a new bend in the middle of the stretch, dragged straight away
        gestureUpdate((d) => {
          const s = d.items[id] as ShapeItem;
          s.pts = [...(s.pts ?? []).slice(0, ch.idx), { x: Math.round(ch.p.x), y: Math.round(ch.p.y) }, ...(s.pts ?? []).slice(ch.idx)];
        });
        setGesture({ kind: 'conn', id, part: 'bend', idx: ch.idx, moved: true, glue: null });
        return;
      }
      setGesture({ kind: 'conn', id, part: ch.part, idx: ch.idx, moved: false, glue: null });
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
      const portItem = vdoc().items[pi.comp];
      if (portItem && !portItem.locked) {
        startWire({ kind: 'port', comp: pi.comp, port: pi.port, pt: pi.pt, dir: portDir(pi) }, true, client);
        return;
      }
    }
    const wireLabel = tool === 'select' ? hitWireLabel(w) : null;
    if (wireLabel) {
      // other wires of the net that carry a label of their own are not landing spots; only
      // physically connected wires qualify (same-label wires elsewhere join the net by name)
      const d0 = vdoc();
      const net = (netOfWire(computeNets(d0, { ignoreLabels: true }), wireLabel)?.wires ?? [wireLabel]).filter((id) => id === wireLabel || !(d0.items[id] as WireItem | undefined)?.label);
      select([wireLabel]);
      beginGesture();
      setGesture({ kind: 'wireLabel', id: wireLabel, net });
      return;
    }
    const labelEdit = isDouble ? hitLabel(w, true) : null;
    if (labelEdit && !vdoc().items[labelEdit.id]?.locked) {
      select([labelEdit.id]);
      setEditingLabel(labelEdit);
      return;
    }
    const labelOf = hitLabel(w);
    const stack = hitItems(w);
    let hit: string | null = stack[0] ?? null;
    if (labelOf && (!hit || hit === labelOf.id || vdoc().items[hit]?.type !== 'component')) {
      const c = vdoc().items[labelOf.id] as ComponentItem;
      const frozen = frozenLabelOffsets(c, instanceSymbol(vdoc(), c));
      const base = labelOf.which === 'ref' ? { dx: frozen.labelDx, dy: frozen.labelDy } : { dx: frozen.valueDx, dy: frozen.valueDy };
      beginGesture();
      setGesture({ kind: 'label', id: labelOf.id, which: labelOf.which, start: w, base, frozen });
      return;
    }
    if (hit) {
      const item = vdoc().items[hit];
      if (isDouble) {
        onDoubleClick(hit, w);
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
      // a locked item is only selected; dragging from it still draws a marquee
      if (vdoc().items[hit].locked && !next && cur.length === 1) {
        set({ wirePart: null });
        setGesture({ kind: 'marquee', start: w, cur: w, additive: false, keep: true });
        return;
      }
      if (!vdoc().items[hit].locked && vdoc().items[hit].type === 'wire' && cur.length === 1 && cur[0] === hit) {
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
    const inBox = isDouble || e.altKey ? null : unionBounds(vdoc(), S().selection.filter((id) => !vdoc().items[id]?.locked));
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
    const d = vdoc();
    const picked = new Set(sel.filter((id) => d.items[id] && !d.items[id].locked));
    const wiresOnly = picked.size > 0 && [...picked].every((id) => d.items[id].type === 'wire');
    // a container carries what lies inside it as it was when the drag began
    const ids = wiresOnly ? picked : withContents(d, picked);
    return { kind: 'move', start: w, ids, moved: false, client, detach: S().altMove || wiresOnly, dx: 0, dy: 0, pick, rejoin: wiresOnly };
  };

  const onDoubleClick = (id: string, at?: Point) => {
    const d = vdoc();
    const it = d.items[id];
    if (!it) return;
    const scope = S().scope;
    const chainTop = it.group && it.group !== scope;
    if (chainTop) {
      A.enterGroup(id);
      return;
    }
    // a polygon's outline (or any open path) opens its nodes in the edit points tool; inside it edits the title
    if (it.type === 'shape' && it.kind === 'polygon' && !it.locked && at && (it.open || polyHit({ ...it, fillOpacity: 0 }, at, (6 / S().view.zoom) * hitSlop()))) {
      A.setTool('node');
      select([id]);
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

  const hoverAt = useRef<Point | null>(null);
  const hoverFrame = useRef<number>();
  useEffect(() => () => void (hoverFrame.current !== undefined && cancelAnimationFrame(hoverFrame.current)), []);
  /** The latest render's hover update (tool, hover menu and gesture state as they are now). */
  const hoverRef = useRef((_w: Point) => {});
  hoverRef.current = (w: Point) => {
    setCursor(w);
    const g = gRef.current;
    if (g && g.kind !== 'arm') return;
    if (tool === 'select' || tool === 'wire' || tool === 'node' || g) {
      const pi = findPort(w);
      const item = pi ? null : hitItem(w);
      if (pi?.comp !== hover.port?.comp || pi?.port !== hover.port?.port || item !== hover.item) setHover({ port: pi, item });
    }
    if (!placing && !S().exportArea && !g) trackHotSpot(w);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    lastMove.current = { clientX: e.clientX, clientY: e.clientY };
    const w = toWorldPt(e.clientX, e.clientY);
    set(S().pointerOnCanvas ? { cursor: w } : { cursor: w, pointerOnCanvas: true });
    // the drawn cursor feedback and hover hit-testing run at most once per frame, not per pointer event
    hoverAt.current = w;
    if (hoverFrame.current === undefined) {
      hoverFrame.current = requestAnimationFrame(() => {
        hoverFrame.current = undefined;
        const at = hoverAt.current;
        if (at) hoverRef.current(at);
      });
    }
    const g = gRef.current;
    if (!g || g.kind === 'arm') return;
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
        const { alignGuides, spacingGuides, labelGuides } = S().prefs;
        if (alignGuides || spacingGuides) {
          if (alignRef.current?.ids !== g.ids) {
            const base = viewDoc(gestureBaseDoc() ?? S().doc, S().page);
            const labels = labelGuides ? (it: Item) => (it.type === 'component' ? partLabelRects(base, it).map((l) => l.rect) : []) : undefined;
            alignRef.current = { ids: g.ids, ...alignAnchors(base, g.ids, labels) };
          }
          const { moving, index, box, others } = alignRef.current;
          const tol = 6 / S().view.zoom;
          // off the grid, guides also pull the selection onto them; on it they just show what lines up
          const magnet = !snapOn;
          const hold = { x: e.shiftKey && !dx, y: e.shiftKey && !dy };
          let pulled = { x: false, y: false };
          if (alignGuides) {
            const a = alignMove(moving, index, dx, dy, tol, magnet);
            if (!hold.x) dx = a.dx;
            if (!hold.y) dy = a.dy;
            pulled = { x: a.guides.some((gd) => gd.axis === 'x'), y: a.guides.some((gd) => gd.axis === 'y') };
          }
          if (spacingGuides) {
            // a line-up wins over an even spacing on the same axis
            const sp = spaceMove(box, others, dx, dy, tol, magnet, { x: hold.x || pulled.x, y: hold.y || pulled.y });
            dx = sp.dx;
            dy = sp.dy;
            setSpaceGuides(sp.guides);
          } else setSpaceGuides([]);
          setGuides(alignGuides ? alignMove(moving, index, dx, dy, tol, false).guides : []);
        } else if (guides.length || spaceGuides.length) {
          setGuides([]);
          setSpaceGuides([]);
        }
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
      case 'shape': {
        if (g.shape === 'line' || g.shape === 'arrow') {
          // over a shape or part the end glues to it: onto a connection point, or floating on its outline
          const glueB = glueAt(w, e.altKey);
          const cur = glueB && isFixed(glueB.attach) ? glueB.pt : e.altKey ? w : sp(w);
          setGesture({ ...g, cur, glueB });
          break;
        }
        let cur = e.altKey ? w : sp(w);
        // Shift keeps the box square (a circle, a square)
        if (e.shiftKey) {
          const side = Math.max(Math.abs(cur.x - g.start.x), Math.abs(cur.y - g.start.y));
          cur = { x: g.start.x + side * (cur.x < g.start.x ? -1 : 1), y: g.start.y + side * (cur.y < g.start.y ? -1 : 1) };
        }
        setGesture({ ...g, cur });
        break;
      }
      case 'polygon':
        setGesture({ ...g, cur: polygonPoint(g, w, e.shiftKey) });
        break;
      case 'path': {
        if (!g.drag) {
          setGesture({ ...g, cur: onFirstNode(g, w) ? g.nodes[0] : pathPoint(g, w, e) });
          break;
        }
        // pulling handles out of the newest node (the first when closing): symmetric, Shift at 45° steps
        const i = g.closing ? 0 : g.nodes.length - 1;
        const n = g.nodes[i];
        const h = e.shiftKey ? constrain45(n, w) : w;
        const nodes = g.nodes.slice();
        nodes[i] = dist(h, n) > 3 / S().view.zoom ? { x: n.x, y: n.y, out: h, in: { x: 2 * n.x - h.x, y: 2 * n.y - h.y } } : { x: n.x, y: n.y };
        setGesture({ ...g, nodes, cur: w });
        break;
      }
      case 'conn': {
        // Alt: off the grid and without gluing
        const p = e.altKey ? w : sp(w);
        if (g.part === 'bend') {
          gestureUpdate((d) => {
            const s = d.items[g.id] as ShapeItem;
            if (s.pts?.[g.idx]) s.pts[g.idx] = p;
          });
          if (!g.moved) setGesture({ ...g, moved: true });
          break;
        }
        const glue = glueAt(w, e.altKey, g.id);
        const at = glue && isFixed(glue.attach) ? glue.pt : p;
        gestureUpdate((d, base) => {
          const s = d.items[g.id] as ShapeItem;
          const b = base.items[g.id] as ShapeItem;
          if (g.part === 'start') {
            // the end stays where it is
            Object.assign(s, { x: at.x, y: at.y, w: b.x + b.w - at.x, h: b.y + b.h - at.y });
            if (glue) s.from = glue.attach;
            else delete s.from;
          } else {
            s.w = at.x - b.x;
            s.h = at.y - b.y;
            if (glue) s.to = glue.attach;
            else delete s.to;
          }
        });
        setGesture({ ...g, moved: true, glue });
        break;
      }
      case 'polyPart': {
        let nodes: PathNode[];
        if (g.part === 'in' || g.part === 'out') {
          // handles go anywhere (Shift: 45° steps from their node); Alt breaks a smooth pair
          const n = g.base[g.idx];
          const p = e.shiftKey ? constrain45(n, w) : w;
          nodes = dragHandle(g.base, g.idx, g.part, p, e.altKey);
        } else {
          // nodes land on the grid (Alt: anywhere); stretches move by whole grid steps
          let d: Point;
          if (g.part === 'edge') {
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
          nodes = moveNode(g.base, g.idx, d);
          if (g.part === 'edge') nodes = moveNode(nodes, (g.idx + 1) % g.base.length, d);
        }
        if (!g.moved && g.part !== 'node' && g.part !== 'edge' && dist(w, g.start) < 2 / S().view.zoom) return;
        gestureUpdate((doc) => setPathNodes(doc.items[g.id] as ShapeItem, nodes));
        if (!g.moved) setGesture({ ...g, moved: true });
        break;
      }
      case 'exportArea':
        setGesture({ ...g, cur: sp(w) });
        break;
      case 'scale': {
        const c = vdoc().items[g.id] as ComponentItem | undefined;
        if (!c) return;
        const raw = Math.min(10, Math.max(0.1, (g.base * dist(w, c)) / g.d0));
        // only sizes that keep every pin on the grid (quarter steps for single-pin parts)
        const def = getSymbol(vdoc(), c.symbol);
        const k = scaleStep(def) ? gridScale(def, raw) : Math.max(0.25, Math.round(raw * 4) / 4);
        gestureUpdate((d) => {
          (d.items[g.id] as ComponentItem).scale = k === 1 ? undefined : k;
        });
        break;
      }
      case 'groupScale': {
        // 5% steps, so sizes come out round
        const r = Math.max(0.05, Math.round((dist(w, g.pivot) / g.d0) * 20) / 20);
        gestureUpdate((d, base) => void scaleItems(base, d as CircuitDoc, g.ids, r, g.pivot));
        break;
      }
      case 'rotate': {
        // Shift snaps the angle to 15° steps
        const r = dragRotation(g.centre, g.start, w, g.base, e.shiftKey ? 15 : 0);
        gestureUpdate((d, base) => rotateShapeBy(base, d as CircuitDoc, g.id, r - g.base, g.centre));
        break;
      }
      case 'resize': {
        // a turned shape snaps in its own frame (inside resizeInFrame), where the world grid doesn't line up
        const turned = shapeRot(g.base);
        const p = snapOn && !turned ? sp(w) : w;
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
          if (b.kind === 'text') {
            // the left edge stays put on screen while the wrap width follows the pointer
            const bb = shapeBox(b);
            const q = rotateDeg(p, -turned, rectCentre(bb));
            s.wrapW = Math.max(30, Math.round(q.x - bb.x));
            Object.assign(s, measureTextShape(s));
            if (turned) {
              const was = fromShapeFrame(b, { x: bb.x, y: bb.y });
              const now = rotateDeg({ x: s.x, y: s.y }, turned, rectCentre(shapeBox(s)));
              s.x += was.x - now.x;
              s.y += was.y - now.y;
            }
            return;
          }
          // the side or corner opposite the handle stays put, turned or not; Shift keeps the proportions, Ctrl the centre
          const opts = { aspect: e.shiftKey, centre: e.ctrlKey || e.metaKey };
          Object.assign(s, resizeInFrame({ x: b.x, y: b.y, w: b.w, h: b.h }, turned, g.handle, p, grid, snapOn && turned ? grid : 0, opts));
        });
        break;
      }
      case 'shapeTitle': {
        gestureUpdate((d) => {
          const s = d.items[g.id] as ShapeItem;
          // the offset lives in the shape's own (unturned) frame
          const m = rotateDeg({ x: w.x - g.start.x, y: w.y - g.start.y }, -shapeRot(s));
          const o = clampTitleOffset(s, Math.round(g.base.dx + m.x), Math.round(g.base.dy + m.y));
          s.textDx = Math.round(o.dx);
          s.textDy = Math.round(o.dy);
        });
        break;
      }
      case 'wireLabel': {
        // nearest spot on any wire of the net; the pointer's side of the wire picks the label side
        let best: { wire: string; t: number; d: number; pt: Point; horiz: boolean } | null = null;
        const d0 = vdoc();
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
            if (from.labelStyle) to.labelStyle = from.labelStyle;
            else delete to.labelStyle;
            delete from.label;
            delete from.labelStyle;
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
        let dx = Math.round(w.x - g.start.x);
        let dy = Math.round(w.y - g.start.y);
        const { alignGuides, labelGuides } = S().prefs;
        if (alignGuides && labelGuides) {
          // the dragged text lines up with every part, shape and other label that stays put
          if (alignRef.current?.ids !== g.frozen) {
            const base = viewDoc(gestureBaseDoc() ?? S().doc, S().page);
            const c = base.items[g.id] as ComponentItem;
            const own = c && partLabelRects(base, c).find((l) => l.which === g.which)?.rect;
            const others = (it: Item) => (it.type === 'component' ? partLabelRects(base, it).filter((l) => it.id !== g.id || l.which !== g.which).map((l) => l.rect) : []);
            alignRef.current = { ids: g.frozen, ...alignAnchors(base, new Set(), others), moving: own ? rectPoints(own) : [] };
          }
          const a = alignMove(alignRef.current.moving, alignRef.current.index, dx, dy, 6 / S().view.zoom, true);
          dx = a.dx;
          dy = a.dy;
          setGuides(a.guides);
        } else if (guides.length) setGuides([]);
        if (spaceGuides.length) setSpaceGuides([]);
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
  moveRef.current = onPointerMove;

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
          if (!g.additive && !g.keep) set({ selection: [] });
        } else {
          const crossing = w.x < g.start.x;
          const ids = marqueeHits(vdoc(), data.polys, r, crossing);
          select(ids, g.additive ? 'add' : 'replace');
        }
        setGesture(null);
        break;
      }
      case 'move':
        if (!g.floating) finishMove(g);
        break;
      case 'scale':
      case 'groupScale':
      case 'segment':
      case 'resize':
      case 'rotate':
      case 'label':
      case 'wireLabel':
      case 'shapeTitle':
        endGesture(true);
        if (g.kind === 'segment' && g.moved) mutate((d) => cleanup(d as CircuitDoc));
        if (g.kind === 'segment' && !g.moved && g.pick) select([g.pick]);
        setGesture(null);
        break;
      case 'path':
        if (g.closing) commitPath(g.nodes, false);
        else setGesture({ ...g, drag: false });
        break;
      case 'polyPart':
        endGesture(g.moved);
        setGesture(null);
        if (!g.moved && g.click && vdoc().items[g.id]) {
          // a click on a stretch adds a node there (picked, ready to drag or switch)
          const c = g.click;
          let idx = -1;
          mutate((d) => void (idx = insertPathNode(d as CircuitDoc, g.id, c.seg, c.t)));
          if (idx >= 0) set({ wirePart: { wire: g.id, kind: 'node', index: idx } });
        }
        break;
      case 'conn':
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
          // both ends floating on the same target would have nowhere to go
          const glueB = g.glueB && !(g.glueA && g.glueB.attach.id === g.glueA.attach.id && !isFixed(g.glueA.attach) && !isFixed(g.glueB.attach)) ? g.glueB : null;
          if (dist(g.start, g.cur) >= grid || (glueB && g.glueA && glueB.attach.id !== g.glueA.attach.id)) {
            let id = '';
            mutate((d) => {
              const s = makeShape(d as CircuitDoc, g.shape, g.start.x, g.start.y, g.cur.x - g.start.x, g.cur.y - g.start.y);
              if (g.glueA) s.from = g.glueA.attach;
              if (glueB) s.to = glueB.attach;
              s.group = S().scope;
              d.items[s.id] = s;
              id = s.id;
            });
            if (id) set({ selection: [id] });
          }
        } else if (g.shape === 'frame') {
          // a bare click frames what is on screen
          const fr = r.w >= grid && r.h >= grid ? r : A.visibleFrameRect();
          set({ selection: [A.addFrame(fr)] });
        } else if (g.preset && (r.w < grid || r.h < grid)) {
          // a bare click drops a library shape at its default size, centred on the click
          set({ selection: [A.addPresetShape(g.preset, g.start) ?? ''].filter(Boolean) });
        } else if (r.w >= grid && r.h >= grid) {
          let id = '';
          const preset = getPreset(g.preset);
          mutate((d) => {
            const s = preset ? makePresetShape(d as CircuitDoc, preset, r.x, r.y, r.w, r.h, S().prefs.theme) : makeShape(d as CircuitDoc, g.shape, r.x, r.y, r.w, r.h);
            s.group = S().scope;
            d.items[s.id] = s;
            id = s.id;
          });
          if (id) set({ selection: [id] });
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

  // a native, non-passive listener: React's passive onWheel can't stop Ctrl+wheel / pinch from zooming the whole page
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // HTML on top of the drawing (minimap, text editors, menus) keeps its own wheel behaviour
      // (the explain tools' input surface is the drawing, so it zooms and pans like it)
      if (e.target instanceof HTMLElement && e.target !== el && !e.target.classList.contains('explain-input')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // Firefox reports mouse wheels in lines (or pages); work in pixels
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? r.height : 1;
      const deltaX = e.deltaX * unit;
      const deltaY = e.deltaY * unit;
      const zoomMode = e.ctrlKey || e.metaKey || S().prefs.wheel === 'zoom';
      if (zoomMode && !e.shiftKey) {
        const factor = Math.exp(-deltaY * (e.ctrlKey && Math.abs(deltaY) < 50 ? 0.01 : 0.0015));
        A.zoomBy(factor, e.clientX - r.left, e.clientY - r.top);
      } else {
        const v = S().view;
        const dx = e.shiftKey && !deltaX ? deltaY : deltaX;
        const dy = e.shiftKey && !deltaX ? 0 : deltaY;
        set({ view: { ...v, x: v.x - dx, y: v.y - dy } });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

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
    if (readOnly()) {
      e.preventDefault();
      A.readOnlyNotice();
      return;
    }
    if (e.dataTransfer.files.length) {
      e.preventDefault();
      void importDroppedFiles(e.dataTransfer.files, toWorldPt(e.clientX, e.clientY));
      return;
    }
    const shapeId = e.dataTransfer.getData('application/x-nodal-shape');
    if (shapeId) {
      e.preventDefault();
      A.addPresetShape(shapeId, toWorldPt(e.clientX, e.clientY));
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
  const overScale = g?.kind === 'scale' || g?.kind === 'groupScale' || (tool === 'select' && !g && !placing && groupHandles().some((h) => dist(h, cursor) < 7 / z)) || (tool === 'select' && !g && !placing && !!singleComp && !singleComp.locked && compHandles(singleComp).some((h) => dist(h, cursor) < 7 / z));
  const overBadge = tool === 'select' && !g && !placing && selection.some((id) => doc.items[id]?.locked) && lockBadgeAt(cursor) !== null;
  const overRot = g?.kind === 'rotate' || (tool === 'select' && !g && !placing && !!singleShape && (() => {
    const rh = rotHandle(singleShape);
    return !!rh && dist(rh.at, cursor) < 7 / z;
  })());
  const cursorStyle: string = overScale
    ? 'nwse-resize'
    : overRot
      ? g?.kind === 'rotate' ? 'grabbing' : 'grab'
    : overBadge
      ? 'pointer'
    : g?.kind === 'pan' || spaceDown || tool === 'pan'
      ? g?.kind === 'pan'
        ? 'grabbing'
        : 'grab'
      : exportAreaJob
        ? badgeCursor('area', prefs.theme) ?? 'crosshair'
        : g?.kind === 'arm'
          ? hover.item && !selection.length ? 'pointer' : 'crosshair'
        : g?.kind === 'move' || g?.kind === 'shapeTitle' || (tool === 'select' && !placing && !g && singleShape && hasMovableTitle(singleShape) && pointInRect(toShapeFrame(singleShape, cursor), shapeTitle(singleShape).box, 3))
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
  const showErc = useStore((s) => s.leftPanel && s.leftTab === 'check');
  const ercAll = useErcIssues(showErc);
  // markers only for findings about this page's items
  const ercIssues = useMemo(() => ercAll.filter((i) => !i.items.length || i.items.some((id) => doc.items[id])), [ercAll, doc]);

  return (
    <div
      ref={wrapRef}
      className={fileDrag ? 'canvas-wrap file-drop' : 'canvas-wrap'}
      style={{ cursor: cursorStyle }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={abortGesture}
      onPointerLeave={() => {
        // a hover still queued for this frame would bring the outline back
        if (hoverFrame.current !== undefined) cancelAnimationFrame(hoverFrame.current);
        hoverFrame.current = undefined;
        set({ pointerOnCanvas: false });
        setHover({ item: null, port: null });
        clearHotTimer('open');
        setHotPending(null);
        if (hotMenu) scheduleHotClose();
      }}
      onContextMenu={onContextMenu}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-nodal-symbol') || e.dataTransfer.types.includes('application/x-nodal-shape')) {
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
          <Scene doc={doc} data={data} palette={EDITOR_PALETTE} highlight={highlight} frames={!presenting} xrefs={xrefs} />

          {/* unconnected port markers */}
          {prefs.showPortMarkers && z > 0.45 && <PortMarkers ports={ports} data={data} z={z} />}

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

          {/* group names, faint, just above each group */}
          {tags.map((t) => {
            const on = selectedGroup(doc, selection, scope) === t.id;
            return (
              <text key={`tag-${t.id}`} x={t.x} y={t.y - 6 / z} fontSize={TAG_SIZE / z} className={on ? 'group-tag active' : 'group-tag'}>
                {t.name}
              </text>
            );
          })}

          {/* hover */}
          {hover.item && !selSet.has(hover.item) && !g && <HoverOutline doc={doc} id={hover.item} polys={data.polys} z={z} />}
          {/* items hovered in the layers panel */}
          {layerHover.map((id) => (
            <HoverOutline key={`lh-${id}`} doc={doc} id={id} polys={data.polys} z={z} />
          ))}

          {/* selection */}
          {/* a text item being typed into is framed by its editor, not its stale bounds */}
          {selection.map((id) => (id === editingText && (doc.items[id] as ShapeItem).kind === 'text' ? null : <SelectionOutline key={id} doc={doc} id={id} polys={data.polys} z={z} />))}
          {selection.map((id) => {
            const r = lockBadge(doc, id, z);
            return r && <LockBadge key={`lock-${id}`} r={r} />;
          })}
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
          {groupHandles().map((h, i) => (
            <rect key={`g${i}`} x={h.x - 4 / z} y={h.y - 4 / z} width={8 / z} height={8 / z} rx={2 / z} className="handle scale-handle" strokeWidth={1.5 / z} />
          ))}
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
            !(tool === 'select' && isConnector(singleShape)) &&
            shapeHandles(singleShape).map((h) => (
              <rect key={h.h} x={h.p.x - 4 / z} y={h.p.y - 4 / z} width={8 / z} height={8 / z} rx={2 / z} className="handle" strokeWidth={1.5 / z} />
            ))}
          {singleShape &&
            !singleShape.locked &&
            tool === 'select' &&
            isConnector(singleShape) &&
            (() => {
              const h = connHandles(singleShape);
              const busy = g?.kind === 'conn';
              return (
                <g className="conn-handles">
                  {!busy &&
                    h.mids.map((m) => (
                      <g key={`m${m.idx}`}>
                        <circle cx={m.pt.x} cy={m.pt.y} r={4.5 / z} className="conn-mid" strokeWidth={1.2 / z} />
                        <path d={`M${m.pt.x - 2.5 / z} ${m.pt.y}h${5 / z}M${m.pt.x} ${m.pt.y - 2.5 / z}v${5 / z}`} className="conn-mid-plus" strokeWidth={1.2 / z} />
                      </g>
                    ))}
                  {h.bends.map((b) => {
                    const r = 3.75 / z;
                    return <rect key={`b${b.idx}`} x={b.p.x - r} y={b.p.y - r} width={2 * r} height={2 * r} rx={1 / z} className="handle node" strokeWidth={1.5 / z} />;
                  })}
                  {h.ends.map((e) => (
                    <circle key={e.part} cx={e.p.x} cy={e.p.y} r={4.5 / z} className={e.glued ? 'handle glued' : 'handle'} strokeWidth={1.5 / z} />
                  ))}
                </g>
              );
            })()}
          {singleShape &&
            !(singleShape.id === editingText && singleShape.kind === 'text') &&
            (() => {
              const rh = rotHandle(singleShape);
              return (
                rh && (
                  <g className="rot-handle">
                    <line x1={rh.foot.x} y1={rh.foot.y} x2={rh.at.x} y2={rh.at.y} className="rot-stalk" strokeWidth={1 / z} />
                    <circle cx={rh.at.x} cy={rh.at.y} r={4.5 / z} className="handle" strokeWidth={1.5 / z} />
                  </g>
                )
              );
            })()}
          {tool === 'node' &&
            (() => {
              const hot = !g ? polyPartAt(cursor) : null;
              const gp = g?.kind === 'polyPart' ? g : null;
              return [...new Set([...selection, ...(hover.item && !g ? [hover.item] : [])])].map((id) => {
                const it = doc.items[id];
                if (it?.type !== 'shape' || it.kind !== 'polygon' || it.locked) return null;
                const nodes = pathNodes(it);
                const segs = pathSegs(nodes, it.open);
                const segD = (k: number) => {
                  const q = segs[k];
                  return q ? `M${q.a.x} ${q.a.y}C${q.c1.x} ${q.c1.y} ${q.c2.x} ${q.c2.y} ${q.b.x} ${q.b.y}` : '';
                };
                // handles only on outlines that are selected (hovered ones just show their nodes)
                const showHandles = selSet.has(id);
                const edgeIdx = hot?.id === id && hot.part === 'edge' ? hot.idx : gp?.id === id && gp.part === 'edge' ? gp.idx : -1;
                return (
                  <g key={id} className="node-handles">
                    {edgeIdx >= 0 && <path d={segD(edgeIdx)} className="wire-part-seg" fill="none" strokeWidth={7} strokeLinecap="round" />}
                    {!gp &&
                      segs.map((q, i) => {
                        const m = cubicAt(q, 0.5);
                        const on = hot?.id === id && hot.part === 'mid' && hot.idx === i;
                        return <circle key={`m${i}`} cx={m.x} cy={m.y} r={(on ? 4 : 2.75) / z} className={on ? 'handle poly-mid active' : 'handle poly-mid'} strokeWidth={1.2 / z} />;
                      })}
                    {showHandles &&
                      nodes.map((n, i) =>
                        (['in', 'out'] as const).map((which) => {
                          const h = n[which];
                          if (!h) return null;
                          const active = (hot?.id === id && hot.part === which && hot.idx === i) || (gp?.id === id && gp.part === which && gp.idx === i);
                          return (
                            <g key={`${which}${i}`}>
                              <line x1={n.x} y1={n.y} x2={h.x} y2={h.y} className="rot-stalk" strokeWidth={1 / z} />
                              <circle cx={h.x} cy={h.y} r={(active ? 4.5 : 3.25) / z} className={active ? 'handle active' : 'handle'} strokeWidth={1.2 / z} />
                            </g>
                          );
                        }),
                      )}
                    {nodes.map((p, i) => {
                      const active = (hot?.id === id && hot.part === 'corner' && hot.idx === i) || (gp?.id === id && gp.part === 'node' && gp.idx === i);
                      const selected = wirePart?.wire === id && wirePart.kind === 'node' && wirePart.index === i;
                      const r = (active ? 5 : 3.75) / z;
                      const cls = active ? 'handle node active' : selected ? 'handle node selected' : 'handle node';
                      // smooth nodes are round, corners square
                      return isSmooth(p) ? (
                        <circle key={i} cx={p.x} cy={p.y} r={r} className={cls} strokeWidth={1.5 / z} />
                      ) : (
                        <rect key={i} x={p.x - r} y={p.y - r} width={2 * r} height={2 * r} rx={1 / z} className={cls} strokeWidth={1.5 / z} />
                      );
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
          {((g?.kind === 'move' && g.moved) || g?.kind === 'label') &&
            guides.map((gd) =>
              gd.axis === 'x' ? (
                <line key={`x${gd.v}`} x1={gd.v} x2={gd.v} y1={gd.from - 12 / z} y2={gd.to + 12 / z} className="align-guide" strokeWidth={1 / z} strokeDasharray={`${4 / z} ${3 / z}`} />
              ) : (
                <line key={`y${gd.v}`} y1={gd.v} y2={gd.v} x1={gd.from - 12 / z} x2={gd.to + 12 / z} className="align-guide" strokeWidth={1 / z} strokeDasharray={`${4 / z} ${3 / z}`} />
              ),
            )}
          {g?.kind === 'move' && g.moved &&
            spaceGuides.flatMap((sg) =>
              sg.gaps.map((gp, n) => {
                const t = 4 / z;
                // a measured gap, just past the items: a line along the axis with a tick at each end
                const at = gp.at + 8 / z;
                const d =
                  sg.axis === 'x'
                    ? `M${gp.from} ${at}H${gp.to}M${gp.from} ${at - t}v${2 * t}M${gp.to} ${at - t}v${2 * t}`
                    : `M${at} ${gp.from}V${gp.to}M${at - t} ${gp.from}h${2 * t}M${at - t} ${gp.to}h${2 * t}`;
                return <path key={`s${sg.axis}${n}`} d={d} className="space-guide" strokeWidth={1.25 / z} />;
              }),
            )}
          {g?.kind === 'wire' && (() => {
            const pts = wirePreview(g);
            const st = wireStyleFor(doc.settings, { style: S().wireBrush ?? undefined });
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
          {/* what a connector end would glue to: its outline and connection points */}
          {g?.kind === 'shape' && g.glueA && <GlueMarkers doc={doc} glue={g.glueA} z={z} />}
          {g?.kind === 'shape' && g.glueB && <GlueMarkers doc={doc} glue={g.glueB} z={z} />}
          {g?.kind === 'conn' && g.glue && <GlueMarkers doc={doc} glue={g.glue} z={z} />}
          {(tool === 'line' || tool === 'arrow') && !g && (() => {
            const glue = glueAt(cursor, false);
            return glue && <GlueMarkers doc={doc} glue={glue} z={z} />;
          })()}
          {g?.kind === 'polygon' && <PolygonPreview g={g} z={z} closing={closesPolygon(g, g.cur) && g.pts.length >= 3} />}
          {g?.kind === 'path' && <PathPreview g={g} z={z} />}
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
      {renamingGroup && <GroupNameEditor gid={renamingGroup} onDone={() => setRenamingGroup(null)} />}
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
      {exportAreaJob && (
        <div className="canvas-hint">
          Drag a rectangle over the region to export · <kbd>Esc</kbd>/<kbd>right-click</kbd> cancel
        </div>
      )}
      <WelcomeScreen />
      <HintBar
        gesture={!g ? null : g.kind === 'wire' || g.kind === 'polygon' || g.kind === 'path' ? g.kind : g.kind === 'shape' && (g.shape === 'line' || g.shape === 'arrow') ? 'connector' : 'other'}
        editingText={!!editingText}
      />
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

/** Path tool: the outline so far, the next stretch to the pointer, the handles being pulled and, about to close, a ring on the first node. */
function PathPreview({ g, z }: { g: Extract<Gesture, { kind: 'path' }>; z: number }) {
  const last = g.nodes[g.nodes.length - 1];
  const first = g.nodes[0];
  const closing = g.nodes.length >= 3 && (g.closing || eq(g.cur, first));
  let d = pathD(g.nodes, !g.closing);
  if (!g.drag) {
    // the stretch the next click would add (bending out of the last node's handle)
    const end = closing ? first : g.cur;
    const c2 = closing && first.in ? first.in : end;
    d += last.out ? `M${last.x} ${last.y}C${last.out.x} ${last.out.y} ${c2.x} ${c2.y} ${end.x} ${end.y}` : `M${last.x} ${last.y}L${end.x} ${end.y}`;
  }
  const busy = g.drag ? g.nodes[g.closing ? 0 : g.nodes.length - 1] : last;
  return (
    <g pointerEvents="none">
      <path d={d} className="shape-preview" fill="none" />
      {(['in', 'out'] as const).map((k) => {
        const h = busy[k];
        return h ? (
          <g key={k}>
            <line x1={busy.x} y1={busy.y} x2={h.x} y2={h.y} className="rot-stalk" strokeWidth={1 / z} />
            <circle cx={h.x} cy={h.y} r={3 / z} className="polygon-vertex" />
          </g>
        ) : null;
      })}
      {g.nodes.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.5 / z} className="polygon-vertex" />
      ))}
      {g.nodes.length >= 3 && <circle cx={first.x} cy={first.y} r={(closing ? 7 : 5) / z} className={closing ? 'polygon-close on' : 'polygon-close'} strokeWidth={1.5 / z} />}
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
  const preset = getPreset(g.preset);
  if (preset) return <PresetShape preset={preset} x={r.x} y={r.y} w={r.w} h={r.h} className="shape-preview" />;
  if (g.shape === 'ellipse') return <ellipse cx={r.x + r.w / 2} cy={r.y + r.h / 2} rx={r.w / 2} ry={r.h / 2} className="shape-preview" />;
  if (g.shape === 'frame') return <rect x={r.x} y={r.y} width={r.w} height={r.h} className="shape-preview frame" />;
  return <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={g.shape === 'zone' ? 8 : 6} className={g.shape === 'zone' ? 'shape-preview zone' : 'shape-preview'} />;
}

/** What a connector end would glue to: the target's outline and its connection points (the one in use filled). */
function GlueMarkers({ doc, glue, z }: { doc: CircuitDoc; glue: GlueHit; z: number }) {
  const it = doc.items[glue.attach.id];
  if (!it) return null;
  const turned = it.type === 'shape' && shapeRot(it) ? it : null;
  const b = turned ? shapeBox(turned) : itemBounds(doc, it);
  const a = glue.attach;
  return (
    <g pointerEvents="none">
      {b && <rect x={b.x - 3} y={b.y - 3} width={b.w + 6} height={b.h + 6} rx={4} className="glue-outline" strokeWidth={1.5 / z} transform={turned ? shapeTransform(turned) : undefined} />}
      {attachSpots(doc, it).map((s, i) => {
        const on = isFixed(a) && Math.abs(s.fx - a.fx!) < 1e-3 && Math.abs(s.fy - a.fy!) < 1e-3;
        return <circle key={i} cx={s.pt.x} cy={s.pt.y} r={(on ? 4.5 : 3) / z} className={on ? 'glue-spot active' : 'glue-spot'} strokeWidth={1.2 / z} />;
      })}
    </g>
  );
}

/** Lines and arrows are outlined along their drawn path. */
const connectorOutline = (doc: CircuitDoc, s: ShapeItem) => buildWirePath(resolveConnector(doc, s).flat, 0);

/** Rings on the pins nothing is wired to; memoised, as there is one per free pin and the canvas re-renders as the pointer moves. */
const PortMarkers = memo(function PortMarkers({ ports, data, z }: { ports: PortInfo[]; data: SceneData; z: number }) {
  return (
    <g className="port-markers">
      {ports.map((p) =>
        data.portDegree.get(`${p.comp}:${p.port}`) || data.touching.has(`${p.comp}:${p.port}`) ? null : (
          <circle key={`${p.comp}:${p.port}`} cx={p.pt.x} cy={p.pt.y} r={2.4} strokeWidth={1 / z} className="port-marker" />
        ),
      )}
    </g>
  );
});

function HoverOutline({ doc, id, polys, z }: { doc: CircuitDoc; id: string; polys: Map<string, Point[]>; z: number }) {
  const it = doc.items[id];
  if (!it) return null;
  if (isConnector(it)) return <path d={connectorOutline(doc, it)} className="hover-wire" strokeWidth={8 / z} fill="none" />;
  if (it.type === 'wire') {
    const pts = polys.get(id) ?? [];
    return <path d={buildWirePath(pts, 0)} className="hover-wire" strokeWidth={8 / z} fill="none" />;
  }
  // a turned shape is outlined along its turned box
  const turned = it.type === 'shape' && shapeRot(it) ? it : null;
  const b = turned ? shapeBox(turned) : itemBounds(doc, it);
  if (!b) return null;
  return <rect x={b.x - 4} y={b.y - 4} width={b.w + 8} height={b.h + 8} rx={4} className="hover-box" strokeWidth={1 / z} transform={turned ? shapeTransform(turned) : undefined} />;
}

/** Where a selected locked item's lock badge sits: just off its top-right corner, a constant size on screen. */
function lockBadge(doc: CircuitDoc, id: string, z: number): Rect | null {
  const it = doc.items[id];
  if (!it?.locked) return null;
  const b = itemBounds(doc, it);
  if (!b) return null;
  const s = 18 / z;
  return { x: b.x + b.w + 4 + 2 / z, y: b.y - 4 - s - 2 / z, w: s, h: s };
}

/** A semi-transparent padlock; clicking it unlocks (handled in the canvas pointer-down). */
function LockBadge({ r }: { r: Rect }) {
  const k = r.w / 24;
  return (
    <g className="lock-badge" transform={`translate(${r.x} ${r.y}) scale(${k})`}>
      <rect x={0} y={0} width={24} height={24} rx={6} className="lock-badge-bg" />
      <rect x={6} y={11} width={12} height={8} rx={1.5} className="lock-badge-icon" strokeWidth={1.8} />
      <path d="M8.5 11V8.5a3.5 3.5 0 0 1 7 0V11" className="lock-badge-icon" strokeWidth={1.8} fill="none" />
    </g>
  );
}

function SelectionOutline({ doc, id, polys, z }: { doc: CircuitDoc; id: string; polys: Map<string, Point[]>; z: number }) {
  const it = doc.items[id];
  if (!it) return null;
  if (it.type === 'wire') {
    const pts = polys.get(id) ?? [];
    return <path d={buildWirePath(pts, 0)} className={it.locked ? 'sel-wire locked' : 'sel-wire'} strokeWidth={Math.max(6 / z, 4)} fill="none" />;
  }
  const turned = it.type === 'shape' && shapeRot(it) ? it : null;
  const b = turned ? shapeBox(turned) : itemBounds(doc, it);
  if (!b) return null;
  if (isConnector(it)) {
    return <path d={connectorOutline(doc, it)} className={it.locked ? 'sel-wire locked' : 'sel-wire'} strokeWidth={Math.max(6 / z, 4)} fill="none" />;
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
      transform={turned ? shapeTransform(turned) : undefined}
    />
  );
}

/** Inline editor for free text and for rectangle / zone / ellipse titles. */
function TextEditor({ id, onDone }: { id: string; onDone: () => void }) {
  const doc = useViewDoc();
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
  const size = textSize(it);
  const weight = textWeight(it);
  const m = measureRich(value, size, weight, it.font);
  // a free text with a wrap width edits at that width
  const width = it.wrapW && isText ? it.wrapW * view.zoom : Math.max(80, m.w * view.zoom + 20);
  let at = { x: it.x, y: it.y };
  if (isText) {
    const a = it.align ?? 'start';
    if (a !== 'start') at = { x: it.x + (a === 'middle' ? measureTextShape(it).w / 2 - width / view.zoom / 2 : measureTextShape(it).w - width / view.zoom), y: it.y };
  } else {
    const t = shapeTitle({ ...it, text: value || ' ' });
    const w = width / view.zoom;
    at = { x: t.anchor === 'start' ? t.box.x : t.anchor === 'middle' ? t.x - w / 2 : t.x - w, y: t.box.y };
  }
  // a turned shape is edited turned too, about the shape's centre
  const rot = shapeRot(it);
  const ctr = rectCentre(shapeBox(it));
  const left = at.x * view.zoom + view.x - 4;
  const top = at.y * view.zoom + view.y - 2;
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
      if (s.kind === 'text') Object.assign(s, measureTextShape(s));
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
        left,
        top,
        fontSize: size * view.zoom,
        lineHeight: 1.3,
        minWidth: width,
        height: m.h * view.zoom + 12,
        fontWeight: weight,
        color: it.textColor || undefined,
        ...textFaceStyle(it),
        textAlign: it.align === 'middle' ? 'center' : it.align === 'end' ? 'right' : it.align === 'start' ? 'left' : !isText && (it.kind === 'ellipse' || it.kind === 'polygon') ? 'center' : undefined,
        transform: rot ? `rotate(${rot}deg)` : undefined,
        transformOrigin: rot ? `${ctr.x * view.zoom + view.x - left}px ${ctr.y * view.zoom + view.y - top}px` : undefined,
      }}
    />
  );
}

/** In-place editor for a group's name, over its tag. */
function GroupNameEditor({ gid, onDone }: { gid: string; onDone: () => void }) {
  const doc = useViewDoc();
  const view = useStore((s) => s.view);
  const scope = useStore((s) => s.scope);
  const g = doc.groups[gid];
  const tag = groupTags(doc, scope).find((t) => t.id === gid) ?? groupTags(doc, g?.group).find((t) => t.id === gid);
  const [value, setValue] = useState(g?.name ?? '');
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  // focus after the double-click that opened it has finished, so the canvas can't take focus back
  useEffect(() => {
    const t = setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, []);
  if (!g) return null;
  const commit = () => {
    if (done.current) return;
    done.current = true;
    A.renameGroup(gid, value);
    onDone();
  };
  const at = tag ?? { x: (-view.x + 40) / view.zoom, y: (-view.y + 60) / view.zoom };
  return (
    <input
      ref={ref}
      className="text-editor group-name-editor"
      value={value}
      placeholder="Group name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          done.current = true;
          onDone();
        } else if (e.key === 'Enter') commit();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ left: at.x * view.zoom + view.x - 5, top: at.y * view.zoom + view.y - 30, width: Math.max(140, value.length * 8 + 30), height: 24, fontSize: 12 }}
    />
  );
}

/** In-place editor for a part's reference or value, opened by double-clicking the label. */
function LabelEditor({ id, which, onDone }: { id: string; which: 'ref' | 'value'; onDone: () => void }) {
  const doc = useViewDoc();
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
