import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { itemBounds, makeShape, uid } from '../model/doc';
import { dist, eq, pointInRect, projectOnSegment, rectContains, rectFromPoints, rectsIntersect, simplify, snap, toWorld } from '../model/geometry';
import { cleanup, splitWire, translateDetached, translateItems } from '../model/ops';
import { getSymbol } from '../model/registry';
import type { CircuitDoc, ComponentItem, Endpoint, Point, Rect, ShapeItem, ShapeKind, Tool, WireItem } from '../model/types';
import { buildWirePath, endpointInfo, hitWire, moveWireNode, snapOnSegment, wirePolyline } from '../model/wires';
import { runAreaExport } from '../io/fileActions';
import * as A from '../store/actions';
import { S, beginGesture, endGesture, gestureUpdate, mutate, select, set, toast, useStore } from '../store/store';
import { ArrowHeadEl, ComponentView, EDITOR_PALETTE, Scene, clampTitleOffset, dashArray, hasMovableTitle, inkColor, labelLayout, labelOffsets, measureText, shapeTitle, useSceneData } from './Scene';
import { Minimap } from './Minimap';
import { HotSpotMenu } from './HotSpotMenu';
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
  | { kind: 'move'; start: Point; ids: Set<string>; moved: boolean; client: Point; detach: boolean; dx: number; dy: number }
  | { kind: 'wire'; start: Target; pts: Point[]; hFirst: boolean; fromDrag: boolean; downClient: Point; cur: Target; dragging: boolean }
  | { kind: 'segment'; wire: string; seg: number; base: Point[]; start: Point; moved: boolean }
  | { kind: 'endpoint'; wire: string; end: 'a' | 'b'; cur: Target }
  | { kind: 'node'; wire: string; idx: number; base: Point[]; cur: Point; free: boolean; moved: boolean }
  | { kind: 'shape'; shape: ShapeKind; start: Point; cur: Point }
  | { kind: 'exportArea'; start: Point; cur: Point }
  | { kind: 'resize'; id: string; handle: Handle; base: ShapeItem; start: Point }
  | { kind: 'label'; id: string; which: 'ref' | 'value'; start: Point; base: { dx: number; dy: number } }
  | { kind: 'shapeTitle'; id: string; start: Point; base: { dx: number; dy: number } };

const ORTHO_EPS = 0.01;

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
  line: '<path d="M3 9.5L9.5 3.5" stroke="#1f2433" stroke-width="1.4" stroke-linecap="round"/>',
  arrow: '<path d="M3 9.5L9 3.5M6.4 3.5H9v2.6" fill="none" stroke="#1f2433" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  solder: '<circle cx="6.5" cy="6.5" r="4.3" fill="none" stroke="#1f2433" stroke-width="1.1"/><circle cx="6.5" cy="6.5" r="2.3" fill="#1f2433"/>',
  text: '<text x="6.5" y="9.8" font-family="sans-serif" font-size="9" fill="#1f2433" text-anchor="middle" stroke="none">T</text>',
};

const CURSOR_THEMES = {
  light: { ink: '#1f2433', halo: '#ffffff', badge: '#ffffff', border: '#cfd4e0' },
  dark: { ink: '#d5dbef', halo: '#10141e', badge: '#1a1f2c', border: '#3a4258' },
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
  const tool = useStore((s) => s.tool);
  const placing = useStore((s) => s.placing);
  const highlight = useStore((s) => s.highlight);
  const prefs = useStore((s) => s.prefs);
  const scope = useStore((s) => s.scope);
  const exportAreaJob = useStore((s) => s.exportArea);
  const altMove = useStore((s) => s.altMove);
  const layerHover = useStore((s) => s.layerHover);
  const data = useSceneData(doc);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gRef = useRef<Gesture | null>(null);
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  const [hover, setHover] = useState<{ item: string | null; port: PortInfo | null }>({ item: null, port: null });
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [editingText, setEditingText] = useState<string | null>(null);
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

  const hotSpots = useMemo(() => computeHotSpots(doc, data.polys, data.crossings), [doc, data]);

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
      const def = getSymbol(doc, it.symbol);
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
      let bd = Math.max(8, 10 / S().view.zoom);
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
      const t = Math.max(6, 9 / z);
      for (const it of Object.values(d.items)) {
        if (it.type === 'junction' && dist(it, raw) < t) return { kind: 'junction', id: it.id, pt: { x: it.x, y: it.y } };
      }
      for (const it of Object.values(d.items)) {
        if (it.type !== 'wire' || it.id === excludeWire) continue;
        for (const end of ['a', 'b'] as const) {
          const ep = it[end];
          if (ep.kind === 'free' && dist(ep, raw) < t) return { kind: 'wireEnd', wire: it.id, end, pt: { x: ep.x, y: ep.y } };
        }
      }
      const polys = new Map(data.polys);
      if (excludeWire) polys.delete(excludeWire);
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

  const hitItem = useCallback(
    (p: Point): string | null => {
      const d = S().doc;
      const z = S().view.zoom;
      const t = 6 / z;
      const items = Object.values(d.items).filter((i) => !i.hidden && !i.locked);
      const shapes = items.filter((i): i is ShapeItem => i.type === 'shape').sort((a, b) => b.z - a.z);
      const shapeHit = (s: ShapeItem) => {
        const r = itemBounds(d, s)!;
        if (hasMovableTitle(s) && pointInRect(p, shapeTitle(s).box, 3)) return true;
        if (s.kind === 'line' || s.kind === 'arrow') return projectOnSegment(p, { x: s.x, y: s.y }, { x: s.x + s.w, y: s.y + s.h }).d < t + s.strokeWidth;
        if (s.kind === 'text') return pointInRect(p, r, 4);
        const inside = pointInRect(p, r, t);
        if (!inside) return false;
        if (s.fillOpacity > 0) return true;
        return !pointInRect(p, { x: r.x + t, y: r.y + t, w: r.w - 2 * t, h: r.h - 2 * t });
      };
      for (const s of shapes) if (s.layer === 'above' && shapeHit(s)) return s.id;
      for (const it of items) if (it.type === 'junction' && dist(it, p) < t + 2) return it.id;
      const comps = items.filter((i): i is ComponentItem => i.type === 'component').reverse();
      for (const c of comps) if (pointInRect(p, itemBounds(d, c)!, 1)) return c.id;
      const hit = hitWire(data.polys, p, Math.max(4, t));
      if (hit && !d.items[hit.wire].locked) return hit.wire;
      for (const s of shapes) if (s.layer === 'below' && shapeHit(s)) return s.id;
      return null;
    },
    [data],
  );

  /** Selected component label (reference or value *text*) under the pointer; dragging it moves just that label. */
  const hitLabel = useCallback((p: Point): { id: string; which: 'ref' | 'value' } | null => {
    const d = S().doc;
    for (const id of S().selection) {
      const c = d.items[id];
      if (c?.type !== 'component') continue;
      const def = getSymbol(d, c.symbol);
      if (def.valueIsLabel) continue;
      const L = labelLayout(c, def);
      const texts: [{ x: number; y: number; anchor: 'start' | 'middle' | 'end' } | null | undefined, string, number, 'ref' | 'value'][] = [];
      if (c.showRef) texts.push([L.ref, c.ref, 11, 'ref']);
      if (c.showValue && c.value) texts.push([L.value, c.value, 10.5, 'value']);
      for (const [at, text, size, which] of texts) {
        if (!at) continue;
        const m = measureText(text, size);
        const x = at.anchor === 'start' ? at.x : at.anchor === 'middle' ? at.x - m.w / 2 : at.x - m.w;
        if (pointInRect(p, { x, y: at.y - size, w: m.w, h: size * 1.3 }, 2)) return { id: c.id, which };
      }
    }
    return null;
  }, []);

  /* ------------------------ selection handles ------------------------ */

  const singleShape = selection.length === 1 && doc.items[selection[0]]?.type === 'shape' ? (doc.items[selection[0]] as ShapeItem) : null;
  const singleWire = selection.length === 1 && doc.items[selection[0]]?.type === 'wire' ? (doc.items[selection[0]] as WireItem) : null;

  const shapeHandles = (s: ShapeItem): { h: Handle; p: Point }[] => {
    if (s.kind === 'line' || s.kind === 'arrow')
      return [
        { h: 'p1', p: { x: s.x, y: s.y } },
        { h: 'p2', p: { x: s.x + s.w, y: s.y + s.h } },
      ];
    if (s.kind === 'text') return [];
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
    const tol = 7 / S().view.zoom;
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

  const onNodeDown = (w: Point, e: React.PointerEvent, isDouble: boolean) => {
    const v = S().view;
    if (singleShape && !singleShape.locked) {
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
      if (n.idx === 0 || n.idx === last) {
        beginGesture();
        setGesture({ kind: 'endpoint', wire: n.wire, end: n.idx === 0 ? 'a' : 'b', cur: { kind: 'grid', pt: n.pts[n.idx] } });
        return;
      }
      if (isDouble) {
        // double-click a bend removes it
        mutate((dd) => {
          const d = dd as CircuitDoc;
          const wire = d.items[n.wire] as WireItem;
          wire.pts = simplify(n.pts.filter((_, i) => i !== n.idx)).slice(1, -1);
          cleanup(d);
        });
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
    setGesture({ kind: 'marquee', start: w, cur: w, additive: e.shiftKey || e.ctrlKey || e.metaKey });
  };

  /** Writes a node drag into the wire (always recomputed from the gesture's base polyline). */
  const applyNode = (d: CircuitDoc, g: Extract<Gesture, { kind: 'node' }>) => {
    const wire = d.items[g.wire] as WireItem | undefined;
    if (!wire) return;
    wire.pts = moveWireNode(g.base, g.idx, g.cur, g.free || wire.routing === 'straight').slice(1, -1);
  };

  /* ------------------------- wire commit ------------------------- */

  /** Turns a target into a wire endpoint; `self` is a wire being reconnected, which must never be split onto itself. */
  const resolveEndpoint = (d: CircuitDoc, t: Target, self?: string): Endpoint => {
    switch (t.kind) {
      case 'port':
        return { kind: 'port', comp: t.comp, port: t.port };
      case 'junction':
        return { kind: 'junction', id: t.id };
      case 'wireEnd': {
        const w = d.items[t.wire] as WireItem | undefined;
        if (!w) return { kind: 'free', ...t.pt };
        // already connected earlier in this same commit (a loop closing where it started)
        if (w[t.end].kind !== 'free') return w[t.end];
        const jid = uid('j');
        d.items[jid] = { id: jid, type: 'junction', x: t.pt.x, y: t.pt.y, group: w.group };
        w.pts = wirePolyline(d, w).slice(1, -1);
        w[t.end] = { kind: 'junction', id: jid };
        return { kind: 'junction', id: jid };
      }
      case 'wire': {
        // re-locate the wire under the point (ids may have changed after a previous split)
        const polys = new Map<string, Point[]>();
        for (const it of Object.values(d.items)) if (it.type === 'wire' && it.id !== self) polys.set(it.id, wirePolyline(d, it));
        const hit = hitWire(polys, t.pt, 0.5);
        if (!hit) return { kind: 'free', ...t.pt };
        const pts = polys.get(hit.wire)!;
        if (eq(pts[0], t.pt) || eq(pts[pts.length - 1], t.pt)) {
          const w = d.items[hit.wire] as WireItem;
          const end = eq(pts[0], t.pt) ? 'a' : 'b';
          if (w[end].kind !== 'free') return w[end];
          return resolveEndpoint(d, { kind: 'wireEnd', wire: w.id, end, pt: t.pt });
        }
        return { kind: 'junction', id: splitWire(d, hit.wire, hit.seg, t.pt) };
      }
      case 'grid':
        return { kind: 'free', ...t.pt };
    }
  };

  const wirePreview = (g: Extract<Gesture, { kind: 'wire' }>): Point[] => {
    const start = g.start.pt;
    const last = g.pts.length ? g.pts[g.pts.length - 1] : start;
    const c = g.cur.pt;
    const out = [start, ...g.pts];
    if (Math.abs(last.x - c.x) > ORTHO_EPS && Math.abs(last.y - c.y) > ORTHO_EPS) {
      let elbow = g.hFirst ? { x: c.x, y: last.y } : { x: last.x, y: c.y };
      // never run back over the leg just drawn: take the other elbow instead
      const prev = out.length >= 2 ? out[out.length - 2] : null;
      if (prev && (elbow.x - last.x) * (last.x - prev.x) + (elbow.y - last.y) * (last.y - prev.y) < 0) {
        elbow = g.hFirst ? { x: last.x, y: c.y } : { x: c.x, y: last.y };
      }
      out.push(elbow);
    }
    out.push(c);
    return simplify(out);
  };

  const commitWire = (g: Extract<Gesture, { kind: 'wire' }>, end: Target) => {
    const pts = wirePreview({ ...g, cur: end });
    if (pts.length < 2 || (pts.length === 2 && eq(pts[0], pts[1]))) return false;
    // same start and end is only fine when the wire goes somewhere and comes back (a loop)
    if (sameTarget(g.start, end) && pts.length < 4) return false;
    const brush = S().wireBrush;
    let newId = '';
    mutate((dd) => {
      const d = dd as CircuitDoc;
      const a = resolveEndpoint(d, g.start);
      const b = resolveEndpoint(d, end);
      const w: WireItem = { id: uid('w'), type: 'wire', a, b, pts: pts.slice(1, -1), group: S().scope };
      if (brush) w.style = { ...brush };
      d.items[w.id] = w;
      newId = w.id;
      cleanup(d);
    });
    if (S().doc.items[newId]) set({ selection: [] });
    return true;
  };

  const sameTarget = (a: Target, b: Target) =>
    (a.kind === 'port' && b.kind === 'port' && a.comp === b.comp && a.port === b.port) || (a.kind === 'junction' && b.kind === 'junction' && a.id === b.id);

  /** Port/junction target matching an existing endpoint (for same-target checks). */
  const endpointTarget = (ep: Endpoint): Target =>
    ep.kind === 'port'
      ? { kind: 'port', comp: ep.comp, port: ep.port, pt: { x: 0, y: 0 }, dir: { x: 0, y: 0 } }
      : ep.kind === 'junction'
        ? { kind: 'junction', id: ep.id, pt: { x: 0, y: 0 } }
        : { kind: 'grid', pt: { x: ep.x, y: ep.y } };

  /**
   * Whether the wire being drawn has reached a point that should end it:
   * another wire's end or bend, a junction, a pin that already has a wire,
   * or the drawn wire's own start / earlier bends.
   */
  const reachesEnd = (g: Extract<Gesture, { kind: 'wire' }>, cur: Target): boolean => {
    const last = g.pts.length ? g.pts[g.pts.length - 1] : g.start.pt;
    if (eq(cur.pt, last)) return false;
    // back at the start: closes a loop once there is more than one leg
    if (eq(cur.pt, g.start.pt)) return g.pts.length >= 2;
    switch (cur.kind) {
      case 'wireEnd':
      case 'junction':
        return true;
      case 'port':
        return (data.portDegree.get(`${cur.comp}:${cur.port}`) ?? 0) > 0;
      case 'wire':
        return (data.polys.get(cur.wire) ?? []).some((q) => eq(q, cur.pt));
      case 'grid':
        return g.pts.slice(0, -1).some((q) => eq(q, cur.pt));
    }
  };

  /** After a click adds vertices, the next leg should turn 90°. */
  const nextHFirst = (pts: Point[]) => {
    if (pts.length < 2) return true;
    const a = pts[pts.length - 2];
    const b = pts[pts.length - 1];
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
          setGesture({ ...g, hFirst: !g.hFirst });
          return true;
        }
        if (combo === 'Enter') {
          commitWire(g, g.cur);
          setGesture(null);
          return true;
        }
      }
      if (g && combo === 'Escape') {
        if (g.kind === 'move' || g.kind === 'segment' || g.kind === 'resize' || g.kind === 'label' || g.kind === 'shapeTitle' || g.kind === 'node' || g.kind === 'endpoint') endGesture(false);
        setGesture(null);
        return true;
      }
      return false;
    };
    return () => {
      canvasKeys.handle = null;
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
    if (editingText) return;
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
    const now = performance.now();
    const isDouble = now - lastClick.current.t < 350 && dist(lastClick.current.p, client) < 6;
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
      if (isDouble || t.kind !== 'grid') {
        commitWire(g, t);
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
      setGesture({ ...g, pts: committed, hFirst: nextHFirst(pts), cur: t });
      return;
    }

    if (placing) {
      const p = sp(w);
      A.placeComponent(placing.symbol, p.x, p.y, placing.rot, placing.flipX);
      if (!e.shiftKey) set({ placing: null });
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
        const m = measureText(s.text ?? '', s.fontSize ?? 16);
        s.w = m.w;
        s.h = m.h;
        s.group = S().scope;
        d.items[s.id] = s;
        id = s.id;
      });
      set({ selection: [id], tool: 'select' });
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
    if (tool !== 'select') {
      const p = sp(w);
      setGesture({ kind: 'shape', shape: tool as ShapeKind, start: p, cur: p });
      return;
    }

    // ---- select tool ----
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
          setGesture({ kind: 'endpoint', wire: singleWire.id, end, cur: { kind: 'grid', pt: end === 'a' ? pts[0] : pts[pts.length - 1] } });
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
    const labelOf = hitLabel(w);
    const hit = hitItem(w);
    if (labelOf && (!hit || hit === labelOf.id || S().doc.items[hit]?.type !== 'component')) {
      const c = S().doc.items[labelOf.id] as ComponentItem;
      const o = labelOffsets(c)[labelOf.which];
      beginGesture();
      setGesture({ kind: 'label', id: labelOf.id, which: labelOf.which, start: w, base: { dx: o.x, dy: o.y } });
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
      if (!selSet.has(hit)) select([hit]);
      const cur = S().selection;
      if (item.type === 'wire' && cur.length === 1 && cur[0] === hit) {
        const pts = data.polys.get(hit) ?? [];
        const h = hitWire(new Map([[hit, pts]]), w, Infinity);
        beginGesture();
        setGesture({ kind: 'segment', wire: hit, seg: h?.seg ?? 0, base: pts, start: w, moved: false });
        return;
      }
      beginGesture();
      setGesture({ kind: 'move', start: w, ids: new Set(cur.filter((id) => !S().doc.items[id]?.locked)), moved: false, client, detach: S().altMove, dx: 0, dy: 0 });
      return;
    }
    if (isDouble && S().scope) {
      A.exitGroup();
      return;
    }
    setGesture({ kind: 'marquee', start: w, cur: w, additive: e.shiftKey || e.ctrlKey || e.metaKey });
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
    if (it.type === 'shape' && it.kind === 'text') {
      setEditingText(id);
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
    set({ cursor: w });
    const g = gRef.current;
    if (!g) {
      if (tool === 'select' || tool === 'wire' || tool === 'node') {
        const pi = findPort(w);
        const item = pi ? null : hitItem(w);
        if (pi?.comp !== hover.port?.comp || pi?.port !== hover.port?.port || item !== hover.item) setHover({ port: pi, item });
      }
      if (!placing && !S().exportArea) trackHotSpot(w);
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
        gestureUpdate((d, base) => (g.detach ? translateDetached : translateItems)(base, d as CircuitDoc, g.ids, dx, dy));
        if (!g.moved || dx !== g.dx || dy !== g.dy) setGesture({ ...g, moved: true, dx, dy });
        break;
      }
      case 'wire': {
        const cur = findTarget(w);
        // only a held button counts as dragging; plain mouse moves in click-to-click mode don't
        const dragging = g.dragging || (!!(e.buttons & 1) && dist(g.downClient, { x: e.clientX, y: e.clientY }) > 5);
        // click-to-click mode (no button held): reaching a connection point ends the wire
        if (S().prefs.autoFinishWire && !(e.buttons & 1) && reachesEnd(g, cur)) {
          commitWire(g, cur);
          setGesture(null);
          break;
        }
        setGesture({ ...g, cur, dragging });
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
        gestureUpdate((d) => {
          const wire = d.items[g.wire] as WireItem;
          const pts = g.base.map((p) => ({ ...p }));
          // attached ends stay put (a stub keeps the connection); free ends travel with the segment
          const freeA = wire.a.kind === 'free';
          const freeB = wire.b.kind === 'free';
          let seg = g.seg;
          if (seg === 0 && !freeA) {
            pts.splice(1, 0, { ...pts[0] });
            seg = 1;
          }
          if (seg === pts.length - 2 && !freeB) pts.splice(pts.length - 1, 0, { ...pts[pts.length - 1] });
          pts[seg] = { x: pts[seg].x + dx, y: pts[seg].y + dy };
          pts[seg + 1] = { x: pts[seg + 1].x + dx, y: pts[seg + 1].y + dy };
          const full = simplify(pts);
          if (freeA) wire.a = { kind: 'free', ...full[0] };
          if (freeB) wire.b = { kind: 'free', ...full[full.length - 1] };
          wire.pts = full.slice(1, -1);
        });
        if (!g.moved) setGesture({ ...g, moved: true });
        break;
      }
      case 'endpoint': {
        const cur = findTarget(w, g.wire);
        setGesture({ ...g, cur });
        gestureUpdate((d) => {
          const wire = d.items[g.wire] as WireItem;
          wire[g.end] = { kind: 'free', ...cur.pt };
        });
        break;
      }
      case 'node': {
        const next = { ...g, cur: sp(w), free: e.altKey, moved: true };
        gestureUpdate((d) => applyNode(d as CircuitDoc, next));
        setGesture(next);
        break;
      }
      case 'shape':
        setGesture({ ...g, cur: e.altKey ? w : sp(w) });
        break;
      case 'exportArea':
        setGesture({ ...g, cur: sp(w) });
        break;
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
      case 'label': {
        const dx = Math.round(w.x - g.start.x);
        const dy = Math.round(w.y - g.start.y);
        gestureUpdate((d) => {
          const c = d.items[g.id] as ComponentItem;
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
          const d = S().doc;
          const ids = Object.values(d.items)
            .filter((it) => !it.hidden && !it.locked)
            .filter((it) => {
              const b = itemBounds(d, it);
              if (!b) return false;
              if (it.type === 'wire') {
                const pts = data.polys.get(it.id) ?? [];
                if (crossing) return pts.some((p) => pointInRect(p, r)) || rectsIntersect(b, r);
                return pts.every((p) => pointInRect(p, r));
              }
              return crossing ? rectsIntersect(b, r) : rectContains(r, b);
            })
            .map((it) => it.id);
          select(ids, g.additive ? 'add' : 'replace');
        }
        setGesture(null);
        break;
      }
      case 'move':
        if (g.detach && g.moved) {
          // alt move: drop junctions that lost their wires and rejoin split runs, in the same undo step
          gestureUpdate((d, base) => {
            translateDetached(base, d as CircuitDoc, g.ids, g.dx, g.dy);
            cleanup(d as CircuitDoc);
          });
        }
        endGesture(true);
        setGesture(null);
        break;
      case 'segment':
      case 'resize':
      case 'label':
      case 'shapeTitle':
        endGesture(true);
        if (g.kind === 'segment' && g.moved) mutate((d) => cleanup(d as CircuitDoc));
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
        const t = g.cur;
        mutate((dd) => {
          const d = dd as CircuitDoc;
          const wire = d.items[g.wire] as WireItem;
          if (!wire) return;
          const other = g.end === 'a' ? wire.b : wire.a;
          // dropping onto the wire's own other end would make a zero-length loop
          if (sameTarget(t, endpointTarget(other))) return;
          // bake the exact route shown while dragging, so the wire doesn't jump on release
          const shown = wirePolyline(d, { ...wire, [g.end]: { kind: 'free', ...t.pt } });
          wire[g.end] = resolveEndpoint(d, t, g.wire);
          wire.pts = shown.slice(1, -1);
          cleanup(d);
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
        if (!e.shiftKey) A.setTool('select');
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
    if (gRef.current?.kind === 'wire') {
      setGesture(null);
      return;
    }
    if (S().placing) {
      set({ placing: null });
      return;
    }
    const w = toWorldPt(e.clientX, e.clientY);
    const hit = hitItem(w);
    if (hit && !selSet.has(hit)) select([hit]);
    if (!hit) set({ selection: [] });
    set({ contextMenu: { x: e.clientX, y: e.clientY, world: w, target: hit } });
  };

  const onDrop = (e: React.DragEvent) => {
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
  const cursorStyle: string =
    g?.kind === 'pan' || spaceDown || tool === 'pan'
      ? g?.kind === 'pan'
        ? 'grabbing'
        : 'grab'
      : exportAreaJob
        ? badgeCursor('area', prefs.theme) ?? 'crosshair'
        : g?.kind === 'move' || g?.kind === 'shapeTitle' || (tool === 'select' && !placing && !g && singleShape && hasMovableTitle(singleShape) && pointInRect(cursor, shapeTitle(singleShape).box, 3))
          ? 'move'
          : tool === 'node' && !placing
            ? g?.kind === 'node' || g?.kind === 'endpoint' || nodeAt(cursor)
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
        showValue: true,
      }
    : null;

  const scopeBounds = scope ? groupBounds(doc, scope) : null;
  const selectionBounds = selection.length > 1 ? unionBounds(doc, selection) : null;
  const connectedPorts = data.portDegree;

  return (
    <div
      ref={wrapRef}
      className="canvas-wrap"
      style={{ cursor: cursorStyle }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
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
        }
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
          <Scene doc={doc} data={data} palette={EDITOR_PALETTE} highlight={highlight} />

          {/* unconnected port markers */}
          {prefs.showPortMarkers && z > 0.45 && (
            <g className="port-markers">
              {ports.map((p) =>
                connectedPorts.get(`${p.comp}:${p.port}`) ? null : (
                  <circle key={`${p.comp}:${p.port}`} cx={p.pt.x} cy={p.pt.y} r={2.4} strokeWidth={1 / z} className="port-marker" />
                ),
              )}
            </g>
          )}

          {/* hover */}
          {hover.item && !selSet.has(hover.item) && !g && <HoverOutline doc={doc} id={hover.item} polys={data.polys} z={z} />}
          {/* items hovered in the layers panel */}
          {layerHover.map((id) => (
            <HoverOutline key={`lh-${id}`} doc={doc} id={id} polys={data.polys} z={z} />
          ))}

          {/* selection */}
          {selection.map((id) => (
            <SelectionOutline key={id} doc={doc} id={id} polys={data.polys} z={z} />
          ))}
          {selectionBounds && <rect x={selectionBounds.x - 6} y={selectionBounds.y - 6} width={selectionBounds.w + 12} height={selectionBounds.h + 12} className="multi-sel" strokeWidth={1 / z} rx={4 / z} />}
          {singleShape &&
            !singleShape.locked &&
            shapeHandles(singleShape).map((h) => (
              <rect key={h.h} x={h.p.x - 4 / z} y={h.p.y - 4 / z} width={8 / z} height={8 / z} rx={2 / z} className="handle" strokeWidth={1.5 / z} />
            ))}
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
                    const r = (active ? 5 : 3.75) / z;
                    return end ? (
                      <circle key={i} cx={p.x} cy={p.y} r={r + 0.75 / z} className={active ? 'handle active' : 'handle'} strokeWidth={1.5 / z} />
                    ) : (
                      <rect key={i} x={p.x - r} y={p.y - r} width={2 * r} height={2 * r} rx={1 / z} className={active ? 'handle node active' : 'handle node'} strokeWidth={1.5 / z} />
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
          {g?.kind === 'wire' && (() => {
            const pts = wirePreview(g);
            const st = { ...doc.settings.wire, ...S().wireBrush };
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
          {tool === 'wire' && !g && <TargetMarker t={findTarget(cursor)} z={z} subtle />}
          {ghost && (
            <g opacity={0.55} pointerEvents="none">
              <ComponentView c={ghost} def={getSymbol(doc, ghost.symbol)} settings={doc.settings} palette={EDITOR_PALETTE} ghost />
            </g>
          )}
        </g>
      </svg>
      {scope && (
        <div className="scope-banner">
          Editing group <b>{doc.groups[scope]?.name ?? ''}</b>
          <button onClick={() => A.exitGroup()}>Done (Esc)</button>
        </div>
      )}
      {editingText && <TextEditor id={editingText} onDone={() => setEditingText(null)} />}
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
          Drag a bend or wire end to move it · <kbd>Alt</kbd> drag freely · double-click a bend to remove it{' '}
          · <kbd>Esc</kbd> back to select
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

function TextEditor({ id, onDone }: { id: string; onDone: () => void }) {
  const doc = useStore((s) => s.doc);
  const view = useStore((s) => s.view);
  const it = doc.items[id] as ShapeItem | undefined;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(it?.text ?? '');
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  if (!it) return null;
  const fs = (it.fontSize ?? 16) * view.zoom;
  const commit = () => {
    const text = value;
    mutate((d) => {
      const s = d.items[id] as ShapeItem;
      if (!s) return;
      if (!text.trim()) {
        delete d.items[id];
        return;
      }
      s.text = text;
      const m = measureText(text, s.fontSize ?? 16);
      s.w = m.w;
      s.h = m.h;
    });
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
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) commit();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        left: it.x * view.zoom + view.x - 4,
        top: it.y * view.zoom + view.y - 2,
        fontSize: fs,
        lineHeight: 1.3,
        minWidth: Math.max(80, measureText(value, it.fontSize ?? 16).w * view.zoom + 20),
        height: measureText(value, it.fontSize ?? 16).h * view.zoom + 12,
        fontWeight: it.bold ? 700 : 400,
        color: it.textColor || undefined,
      }}
    />
  );
}
