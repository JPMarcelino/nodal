import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { itemBounds, makeShape, uid } from '../model/doc';
import { dist, eq, pointInRect, projectOnSegment, rectContains, rectFromPoints, rectsIntersect, simplify, snap, toWorld } from '../model/geometry';
import { cleanup, splitWire, translateItems } from '../model/ops';
import { getSymbol } from '../model/registry';
import type { CircuitDoc, ComponentItem, Endpoint, Point, Rect, ShapeItem, ShapeKind, WireItem } from '../model/types';
import { buildWirePath, endpointInfo, hitWire, snapOnSegment, wirePolyline } from '../model/wires';
import * as A from '../store/actions';
import { S, beginGesture, endGesture, gestureUpdate, mutate, select, set, useStore } from '../store/store';
import { ComponentView, EDITOR_PALETTE, Scene, dashArray, measureText, useSceneData } from './Scene';
import { Minimap } from './Minimap';

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
  | { kind: 'move'; start: Point; ids: Set<string>; moved: boolean; client: Point }
  | { kind: 'wire'; start: Target; pts: Point[]; hFirst: boolean; fromDrag: boolean; downClient: Point; cur: Target; dragging: boolean }
  | { kind: 'segment'; wire: string; seg: number; base: Point[]; start: Point; moved: boolean }
  | { kind: 'endpoint'; wire: string; end: 'a' | 'b'; cur: Target }
  | { kind: 'shape'; shape: ShapeKind; start: Point; cur: Point }
  | { kind: 'resize'; id: string; handle: Handle; base: ShapeItem; start: Point }
  | { kind: 'label'; id: string; start: Point; base: { dx: number; dy: number } };

const ORTHO_EPS = 0.01;

/** Live hooks for the global keyboard handler. */
export const canvasKeys: { handle: ((combo: string) => boolean) | null } = { handle: null };

export function Canvas() {
  const doc = useStore((s) => s.doc);
  const view = useStore((s) => s.view);
  const selection = useStore((s) => s.selection);
  const tool = useStore((s) => s.tool);
  const placing = useStore((s) => s.placing);
  const highlight = useStore((s) => s.highlight);
  const prefs = useStore((s) => s.prefs);
  const scope = useStore((s) => s.scope);
  const data = useSceneData(doc);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gRef = useRef<Gesture | null>(null);
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  const [hover, setHover] = useState<{ item: string | null; port: PortInfo | null }>({ item: null, port: null });
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [editingText, setEditingText] = useState<string | null>(null);
  const lastClick = useRef<{ t: number; p: Point }>({ t: 0, p: { x: 0, y: 0 } });

  const setGesture = useCallback((g: Gesture | null) => {
    gRef.current = g;
    setGestureState(g);
  }, []);

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
        if (s.kind === 'line' || s.kind === 'arrow') return projectOnSegment(p, { x: s.x, y: s.y }, { x: s.x + s.w, y: s.y + s.h }).d < t + s.strokeWidth;
        if (s.kind === 'text') return pointInRect(p, r, 4);
        const inside = pointInRect(p, r, t);
        if (!inside) return false;
        if (s.fillOpacity > 0) return true;
        const titleBox = s.text ? { x: r.x, y: r.y, w: Math.min(r.w, measureText(s.text, s.fontSize ?? 13).w + 20), h: (s.fontSize ?? 13) + 12 } : null;
        if (titleBox && pointInRect(p, titleBox)) return true;
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

  const hitLabel = useCallback((p: Point): string | null => {
    const d = S().doc;
    for (const id of S().selection) {
      const c = d.items[id];
      if (c?.type !== 'component' || !c.showRef) continue;
      const def = getSymbol(d, c.symbol);
      const b = itemBounds(d, c)!;
      const box = { x: b.x - 40, y: b.y - 20, w: b.w + 80, h: b.h + 40 };
      if (pointInRect(p, box) && !pointInRect(p, b, 2) && !def.valueIsLabel) return c.id;
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

  /* ------------------------- wire commit ------------------------- */

  const resolveEndpoint = (d: CircuitDoc, t: Target): Endpoint => {
    switch (t.kind) {
      case 'port':
        return { kind: 'port', comp: t.comp, port: t.port };
      case 'junction':
        return { kind: 'junction', id: t.id };
      case 'wireEnd': {
        const w = d.items[t.wire] as WireItem | undefined;
        if (!w) return { kind: 'free', ...t.pt };
        const jid = uid('j');
        d.items[jid] = { id: jid, type: 'junction', x: t.pt.x, y: t.pt.y, group: w.group };
        w.pts = wirePolyline(d, w).slice(1, -1);
        w[t.end] = { kind: 'junction', id: jid };
        return { kind: 'junction', id: jid };
      }
      case 'wire': {
        // re-locate the wire under the point (ids may have changed after a previous split)
        const polys = new Map<string, Point[]>();
        for (const it of Object.values(d.items)) if (it.type === 'wire') polys.set(it.id, wirePolyline(d, it));
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
    if (Math.abs(last.x - c.x) > ORTHO_EPS && Math.abs(last.y - c.y) > ORTHO_EPS) out.push(g.hFirst ? { x: c.x, y: last.y } : { x: last.x, y: c.y });
    out.push(c);
    return simplify(out);
  };

  const commitWire = (g: Extract<Gesture, { kind: 'wire' }>, end: Target) => {
    const pts = wirePreview({ ...g, cur: end });
    if (pts.length < 2 || (pts.length === 2 && eq(pts[0], pts[1]))) return false;
    if (sameTarget(g.start, end)) return false;
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
        if (g.kind === 'move' || g.kind === 'segment' || g.kind === 'resize' || g.kind === 'label') endGesture(false);
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
      startWire(findTarget(w), false, client);
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
    if (tool !== 'select') {
      const p = sp(w);
      setGesture({ kind: 'shape', shape: tool as ShapeKind, start: p, cur: p });
      return;
    }

    // ---- select tool ----
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
    if (labelOf && (!hit || hit === labelOf || S().doc.items[hit]?.type !== 'component')) {
      const c = S().doc.items[labelOf] as ComponentItem;
      beginGesture();
      setGesture({ kind: 'label', id: labelOf, start: w, base: { dx: c.labelDx ?? 0, dy: c.labelDy ?? 0 } });
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
      setGesture({ kind: 'move', start: w, ids: new Set(cur.filter((id) => !S().doc.items[id]?.locked)), moved: false, client });
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
      if (tool === 'select' || tool === 'wire') {
        const pi = findPort(w);
        const item = pi ? null : hitItem(w);
        if (pi?.comp !== hover.port?.comp || pi?.port !== hover.port?.port || item !== hover.item) setHover({ port: pi, item });
      }
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
        gestureUpdate((d, base) => translateItems(base, d as CircuitDoc, g.ids, dx, dy));
        if (!g.moved) setGesture({ ...g, moved: true });
        break;
      }
      case 'wire': {
        const cur = findTarget(w);
        const dragging = g.dragging || dist(g.downClient, { x: e.clientX, y: e.clientY }) > 5;
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
          let seg = g.seg;
          if (seg === 0) {
            pts.splice(1, 0, { ...pts[0] });
            seg = 1;
          }
          if (seg === pts.length - 2) pts.splice(pts.length - 1, 0, { ...pts[pts.length - 1] });
          pts[seg] = { x: pts[seg].x + dx, y: pts[seg].y + dy };
          pts[seg + 1] = { x: pts[seg + 1].x + dx, y: pts[seg + 1].y + dy };
          wire.pts = simplify(pts).slice(1, -1);
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
      case 'shape':
        setGesture({ ...g, cur: e.altKey ? w : sp(w) });
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
      case 'label': {
        const dx = Math.round(w.x - g.start.x);
        const dy = Math.round(w.y - g.start.y);
        gestureUpdate((d) => {
          const c = d.items[g.id] as ComponentItem;
          c.labelDx = g.base.dx + dx;
          c.labelDy = g.base.dy + dy;
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
      case 'segment':
      case 'resize':
      case 'label':
        endGesture(true);
        if (g.kind === 'segment' && g.moved) mutate((d) => cleanup(d as CircuitDoc));
        setGesture(null);
        break;
      case 'endpoint': {
        endGesture(false);
        const t = g.cur;
        mutate((dd) => {
          const d = dd as CircuitDoc;
          const wire = d.items[g.wire] as WireItem;
          if (!wire) return;
          const before = wirePolyline(d, wire);
          wire[g.end] = resolveEndpoint(d, t);
          // keep the interior route
          wire.pts = before.slice(1, -1);
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
        }
        // otherwise stay in click-to-click mode
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
  const cursorStyle =
    g?.kind === 'pan' || spaceDown || tool === 'pan'
      ? g?.kind === 'pan'
        ? 'grabbing'
        : 'grab'
      : placing || tool !== 'select'
        ? 'crosshair'
        : hover.port
          ? 'crosshair'
          : g?.kind === 'move'
            ? 'move'
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
      onPointerLeave={() => setHover({ item: null, port: null })}
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
          {singleWire &&
            (() => {
              const pts = data.polys.get(singleWire.id) ?? [];
              if (pts.length < 2) return null;
              return [pts[0], pts[pts.length - 1]].map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={4.5 / z} className="handle" strokeWidth={1.5 / z} />);
            })()}

          {/* hovered port */}
          {hover.port && (!g || g.kind === 'wire') && <circle cx={hover.port.pt.x} cy={hover.port.pt.y} r={6 / z + 2} className="port-hover" strokeWidth={2 / z} />}

          {/* gestures */}
          {g?.kind === 'marquee' && (() => {
            const r = rectFromPoints(g.start, g.cur);
            const crossing = g.cur.x < g.start.x;
            return <rect x={r.x} y={r.y} width={r.w} height={r.h} className={crossing ? 'marquee crossing' : 'marquee'} strokeWidth={1 / z} strokeDasharray={crossing ? `${4 / z} ${3 / z}` : undefined} />;
          })()}
          {g?.kind === 'wire' && (() => {
            const pts = wirePreview(g);
            const st = { ...doc.settings.wire, ...S().wireBrush };
            return (
              <g className="wire-preview">
                <path d={buildWirePath(pts, st.radius)} fill="none" stroke={st.color} strokeWidth={st.width} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} strokeDasharray={dashArray(st.dash, st.width)} />
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
  if (g.shape === 'line' || g.shape === 'arrow') return <line x1={g.start.x} y1={g.start.y} x2={g.cur.x} y2={g.cur.y} className="shape-preview" />;
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
