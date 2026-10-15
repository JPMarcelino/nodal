import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useCollab } from '../collab/session';
import { calloutAnchor, calloutLayout, makeAnchor, nextStep } from '../model/callout';
import { itemBounds, makeShape } from '../model/doc';
import { pointInRect } from '../model/geometry';
import { EXPLAIN_COLORS, inkHit, inkOutline, inkCenterPath, packInk, recognizeInk, type InkPoint, type InkShape } from '../model/ink';
import { computeNets, type Net } from '../model/netlist';
import { instanceSymbol } from '../model/registry';
import { measureRich } from '../model/richText';
import { netFlow, resolveNet, type NetFlow, type TraceSeed } from '../model/trace';
import type { CircuitDoc, Item, Point, ShapeItem } from '../model/types';
import { buildWirePath, hitWire, portPosition } from '../model/wires';
import { TRACE_COLORS, X, isExplainTool, setX, useExplain, type Trace } from '../store/explain';
import { S, beginGesture, endGesture, gestureUpdate, inGesture, mutate, useStore } from '../store/store';
import { EDITOR_PALETTE, inkColor, type SceneData } from './Scene';
import { gestureSlots } from './touch';
import { ExplainDock, TracePanel } from '../ui/ExplainDock';

/** How long a laser trail / vanishing stroke stays on screen (ms). */
const LASER_LIFE = 750;
const VANISH_LIFE = 2600;
const VANISH_FADE = 700;
/** Hold the pen still this long to snap a scribble into a clean shape. */
const HOLD_MS = 520;
/** Reveal speed of a traced net (world units / s). */
const TRACE_SPEED = 900;

type G =
  | { kind: 'ink'; pts: InkPoint[]; highlighter: boolean; color: string; width: number; snapped: InkShape | null; still: Point }
  | { kind: 'laser' }
  | { kind: 'erase'; hits: Set<string>; last: Point }
  | { kind: 'callout-new'; at: Point; target: string | null; cur: Point; client: Point }
  | { kind: 'callout-move'; id: string; start: Point }
  | { kind: 'callout-anchor'; id: string };

interface Fading {
  id: number;
  d: string;
  color: string;
  born: number;
}

let fadeId = 0;

export function ExplainLayer({ data, wrapRef }: { data: SceneData; wrapRef: RefObject<HTMLDivElement> }) {
  const tool = useStore((s) => s.tool);
  const view = useStore((s) => s.view);
  const doc = useStore((s) => s.doc);
  const theme = useStore((s) => s.prefs.theme);
  const ex = useExplain();
  const active = isExplainTool(tool);
  const z = view.zoom;

  const gRef = useRef<G | null>(null);
  const [g, setG] = useState<G | null>(null);
  const setGesture = (next: G | null) => {
    gRef.current = next;
    setG(next ? { ...next } : null);
  };
  const [cursor, setCursor] = useState<Point | null>(null);
  const [hover, setHover] = useState<{ item: string | null; seed: TraceSeed | null }>({ item: null, seed: null });
  const [snapFlash, setSnapFlash] = useState(0);
  const holdTimer = useRef<number>();

  useEffect(() => {
    gestureSlots.explain = {
      get: () => gRef.current,
      restore: (before) => {
        window.clearTimeout(holdTimer.current);
        if (gRef.current === before) return;
        if (inGesture()) endGesture(false);
        gRef.current = null;
        setG(null);
      },
    };
    return () => {
      gestureSlots.explain = null;
    };
  }, []);
  /** Laser trails, one per press, so separate strokes are never joined. */
  const laser = useRef<LaserPt[][]>([]);
  const [fading, setFading] = useState<Fading[]>([]);
  const [, setTick] = useState(0);

  const needNets = ex.traces.length > 0 || tool === 'trace' || ex.presenting !== null;
  const nets = useMemo(() => (needNets ? computeNets(doc) : []), [doc, needNets]);

  /* ----------------------------- frame loop ----------------------------- */

  // animates laser trails and vanishing ink; idles when there is nothing to fade
  const peers = useCollab((s) => s.peers);
  const remoteLaser = Object.values(peers).some((p) => p.laser);
  const fadingRef = useRef(false);
  fadingRef.current = fading.length > 0;
  const remoteLaserRef = useRef(false);
  remoteLaserRef.current = remoteLaser;
  useEffect(() => {
    if (!laser.current.length && !fading.length && tool !== 'laser' && !remoteLaser) return;
    let raf = 0;
    let painted = false;
    const loop = () => {
      const now = performance.now();
      // the trail being drawn stays even when the pointer rests and its points fade
      laser.current = fadeTrails(laser.current, now, gRef.current?.kind === 'laser');
      setFading((f) => (f.some((s) => now - s.born > VANISH_LIFE) ? f.filter((s) => now - s.born <= VANISH_LIFE) : f));
      // repaint while something is moving or fading, plus one last frame to clear what just faded out
      const busy = laser.current.length > 0 || fadingRef.current || remoteLaserRef.current;
      if (busy || painted) setTick((t) => (t + 1) % 1e6);
      painted = busy;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [fading.length > 0, tool, remoteLaser, g?.kind === 'laser']);

  /* ---------------------------- keyboard ---------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!isExplainTool(S().tool)) return;
      const n = /^Digit([1-7])$/.exec(e.code);
      if (n) {
        const c = EXPLAIN_COLORS[Number(n[1]) - 1];
        setX(S().tool === 'highlighter' ? { highlightColor: c } : { color: c });
        e.preventDefault();
      } else if (e.key === '[' || e.key === ']') {
        setX((s) => ({ size: Math.max(1, Math.min(16, s.size + (e.key === ']' ? 1 : -1))) }));
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // a tool change mid-gesture drops the gesture
  useEffect(() => {
    if (gRef.current?.kind === 'callout-move' || gRef.current?.kind === 'callout-anchor') endGesture();
    setGesture(null);
    setHover({ item: null, seed: null });
    setX({ laserDown: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  /* --------------------------- hit testing --------------------------- */

  const toWorld = (cx: number, cy: number): Point => {
    const r = wrapRef.current!.getBoundingClientRect();
    const v = S().view;
    return { x: (cx - r.left - v.x) / v.zoom, y: (cy - r.top - v.y) / v.zoom };
  };

  const hitPin = (p: Point, d: CircuitDoc): { comp: string; port: string; pt: Point } | null => {
    const tol = 6 / S().view.zoom;
    let best: { comp: string; port: string; pt: Point } | null = null;
    let bd = tol;
    for (const it of Object.values(d.items)) {
      if (it.type !== 'component' || it.hidden) continue;
      for (const port of instanceSymbol(d, it).ports) {
        const at = portPosition(d, it, port.id);
        if (!at) continue;
        const dd = Math.hypot(at.pt.x - p.x, at.pt.y - p.y);
        if (dd < bd) {
          bd = dd;
          best = { comp: it.id, port: port.id, pt: at.pt };
        }
      }
    }
    return best;
  };

  const hitComp = (p: Point, d: CircuitDoc): string | null => {
    const comps = Object.values(d.items).filter((i) => i.type === 'component' && !i.hidden);
    for (let i = comps.length - 1; i >= 0; i--) {
      const b = itemBounds(d, comps[i]);
      if (b && pointInRect(p, b, 1)) return comps[i].id;
    }
    return null;
  };

  const hitCallout = (p: Point, d: CircuitDoc): ShapeItem | null => {
    const list = Object.values(d.items).filter((i): i is ShapeItem => i.type === 'shape' && i.kind === 'callout' && !i.hidden && !i.locked);
    list.sort((a, b) => b.z - a.z);
    return list.find((c) => pointInRect(p, calloutLayout(c).box, 3)) ?? null;
  };

  /** Pin seed, plus a wire ending on the pin (rails and labels are not listed as net pins). */
  const pinSeed = (comp: string, port: string, pt: Point): TraceSeed => {
    for (const [id, pts] of data.polys) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      if ((a && Math.hypot(a.x - pt.x, a.y - pt.y) < 0.6) || (b && Math.hypot(b.x - pt.x, b.y - pt.y) < 0.6)) return { comp, port, wire: id };
    }
    return { comp, port };
  };

  /** Anything that can be explained: a pin's part, a wire, or a part. */
  const hitThing = (p: Point, d: CircuitDoc): { item: string | null; seed: TraceSeed | null; pt: Point } => {
    const pin = hitPin(p, d);
    if (pin) return { item: pin.comp, seed: pinSeed(pin.comp, pin.port, pin.pt), pt: pin.pt };
    const w = hitWire(data.polys, p, Math.max(4, 7 / S().view.zoom));
    if (w) return { item: w.wire, seed: { wire: w.wire }, pt: w.pt };
    const c = hitComp(p, d);
    return { item: c, seed: null, pt: p };
  };

  /* --------------------------- trace helpers --------------------------- */

  const sameNet = (a: TraceSeed, b: TraceSeed) => {
    const na = resolveNet(nets, a);
    return !!na && na === resolveNet(nets, b);
  };

  const toggleTraces = (seeds: { seed: TraceSeed; origin: Point }[]) => {
    const cur = X().traces;
    const fresh = seeds.filter((s) => !cur.some((t) => sameNet(t.seed, s.seed)));
    if (!fresh.length) {
      // every one of them is already lit: clicking again turns them off
      setX({ traces: cur.filter((t) => !seeds.some((s) => sameNet(t.seed, s.seed))) });
      return;
    }
    const used = new Set(cur.map((t) => t.color));
    const next: Trace[] = [...cur];
    const seenNets = new Set<Net | undefined>();
    for (const s of fresh) {
      const net = resolveNet(nets, s.seed);
      if (!net || seenNets.has(net)) continue;
      seenNets.add(net);
      const color = TRACE_COLORS.find((c) => !used.has(c)) ?? TRACE_COLORS[next.length % TRACE_COLORS.length];
      used.add(color);
      next.push({ id: `t${Date.now().toString(36)}${next.length}`, seed: s.seed, color, origin: s.origin });
    }
    setX({ traces: next });
  };

  /* ----------------------------- pointer ----------------------------- */

  const pressure = (e: React.PointerEvent) => (e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5);

  const resetHold = (p: Point) => {
    window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      const cur = gRef.current;
      if (cur?.kind !== 'ink' || cur.snapped || cur.pts.length < 4) return;
      const r = recognizeInk(cur.pts);
      if (!r) return;
      setGesture({ ...cur, pts: r.pts, snapped: r.kind });
      setSnapFlash(Date.now());
    }, HOLD_MS);
    const cur = gRef.current;
    if (cur?.kind === 'ink') cur.still = p;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return; // middle-drag pans and right-click opens the menu, as usual
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    const d = S().doc;
    const zz = S().view.zoom;
    if (X().editing) {
      (document.activeElement as HTMLElement | null)?.blur?.();
      return;
    }
    switch (tool) {
      case 'pen':
      case 'highlighter': {
        const hl = tool === 'highlighter';
        const width = hl ? (X().size * 4 + 8) / zz : X().size / zz;
        setGesture({ kind: 'ink', pts: [{ ...w, p: pressure(e) }], highlighter: hl, color: hl ? X().highlightColor : X().color, width, snapped: null, still: w });
        resetHold(w);
        return;
      }
      case 'laser':
        laser.current.push([{ ...w, t: performance.now() }]);
        setX({ laserDown: true });
        setGesture({ kind: 'laser' });
        return;
      case 'eraser': {
        const hits = new Set<string>();
        eraseAt(w, w, hits);
        setGesture({ kind: 'erase', hits, last: w });
        return;
      }
      case 'trace': {
        const pin = hitPin(w, d);
        if (pin) return toggleTraces([{ seed: pinSeed(pin.comp, pin.port, pin.pt), origin: pin.pt }]);
        const hit = hitWire(data.polys, w, Math.max(4, 7 / zz));
        if (hit) return toggleTraces([{ seed: { wire: hit.wire }, origin: hit.pt }]);
        const c = hitComp(w, d);
        if (c) {
          const comp = d.items[c];
          if (comp.type !== 'component') return;
          // a part: light every net it touches, each in its own colour
          const seeds = instanceSymbol(d, comp).ports.flatMap((p) => {
            const at = portPosition(d, comp, p.id);
            return at ? [{ seed: pinSeed(c, p.id, at.pt), origin: at.pt }] : [];
          });
          toggleTraces(seeds);
        }
        return;
      }
      case 'callout': {
        const hitC = hitCallout(w, d);
        if (hitC) {
          beginGesture();
          setGesture({ kind: 'callout-move', id: hitC.id, start: w });
          return;
        }
        // grab a leader's end to re-point it
        for (const it of Object.values(d.items)) {
          if (it.type !== 'shape' || it.kind !== 'callout' || it.locked) continue;
          const a = calloutAnchor(d, it);
          if (a && Math.hypot(a.x - w.x, a.y - w.y) < 8 / zz) {
            beginGesture();
            setGesture({ kind: 'callout-anchor', id: it.id });
            return;
          }
        }
        const t = hitThing(w, d);
        setGesture({ kind: 'callout-new', at: t.seed?.comp ? t.pt : w, target: t.item, cur: w, client: { x: e.clientX, y: e.clientY } });
        return;
      }
    }
  };

  /** Marks ink and callouts touched by the eraser between two points. */
  const eraseAt = (a: Point, b: Point, hits: Set<string>) => {
    const d = S().doc;
    const tol = 8 / S().view.zoom;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (tol / 2)));
    for (const it of Object.values(d.items)) {
      if (it.type !== 'shape' || it.hidden || it.locked || hits.has(it.id)) continue;
      if (it.kind !== 'ink' && it.kind !== 'callout') continue;
      for (let i = 0; i <= steps; i++) {
        const p = { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps };
        if (it.kind === 'ink' ? inkHit(it, p, tol) : pointInRect(p, calloutLayout(it).box, tol / 2)) {
          hits.add(it.id);
          break;
        }
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const w = toWorld(e.clientX, e.clientY);
    setCursor(w);
    const cur = gRef.current;
    if (!cur) {
      if (tool === 'trace' || tool === 'callout') {
        const t = hitThing(w, S().doc);
        if (t.item !== hover.item || JSON.stringify(t.seed) !== JSON.stringify(hover.seed)) setHover({ item: t.item, seed: t.seed });
      }
      return;
    }
    switch (cur.kind) {
      case 'ink': {
        if (cur.snapped === 'ellipse' || cur.snapped === 'rect') return;
        if (cur.snapped === 'line' || e.shiftKey) {
          setGesture({ ...cur, pts: [cur.pts[0], { ...w, p: pressure(e) }] });
        } else {
          const evs = (e.nativeEvent.getCoalescedEvents?.() ?? []) as PointerEvent[];
          const add = evs.length ? evs.map((ev) => ({ ...toWorld(ev.clientX, ev.clientY), p: ev.pointerType === 'pen' ? ev.pressure || 0.5 : 0.5 })) : [{ ...w, p: pressure(e) }];
          cur.pts.push(...add);
          setGesture(cur);
        }
        // holding still (after moving) snaps the scribble into a shape
        if (Math.hypot(w.x - cur.still.x, w.y - cur.still.y) * S().view.zoom > 3) resetHold(w);
        return;
      }
      case 'laser':
        laser.current[laser.current.length - 1]?.push({ ...w, t: performance.now() });
        return;
      case 'erase':
        eraseAt(cur.last, w, cur.hits);
        setGesture({ ...cur, last: w });
        return;
      case 'callout-new':
        setGesture({ ...cur, cur: w });
        return;
      case 'callout-move': {
        const dx = w.x - cur.start.x;
        const dy = w.y - cur.start.y;
        gestureUpdate((d, base) => {
          const b = base.items[cur.id] as ShapeItem;
          const s = d.items[cur.id] as ShapeItem;
          s.x = b.x + dx;
          s.y = b.y + dy;
        });
        return;
      }
      case 'callout-anchor': {
        const t = hitThing(w, S().doc);
        gestureUpdate((d) => {
          const s = d.items[cur.id] as ShapeItem;
          const target = t.item ? (d.items[t.item] as Item) : null;
          s.anchor = makeAnchor(d as CircuitDoc, target, t.seed?.comp ? t.pt : w);
        });
        return;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    window.clearTimeout(holdTimer.current);
    const cur = gRef.current;
    setGesture(null);
    if (!cur) return;
    switch (cur.kind) {
      case 'ink': {
        const pts = cur.pts;
        if (!cur.highlighter && (X().presenting !== null ? X().presentVanish : X().vanish)) {
          // vanishing ink is kept out of the document
          setFading((f) => [...f, { id: ++fadeId, d: inkOutline(pts, cur.width), color: cur.color, born: performance.now() }]);
          return;
        }
        mutate((d) => {
          const s = makeShape(d as CircuitDoc, 'ink', 0, 0, 1, 1);
          Object.assign(s, packInk(pts), {
            stroke: cur.color,
            strokeWidth: Math.round(cur.width * 100) / 100,
            highlighter: cur.highlighter || undefined,
            layer: cur.highlighter ? 'below' : 'above',
            group: S().scope,
          });
          d.items[s.id] = s;
        });
        return;
      }
      case 'laser':
        setX({ laserDown: false });
        return;
      case 'erase':
        if (cur.hits.size) mutate((d) => cur.hits.forEach((id) => delete d.items[id]), S().selection.filter((id) => !cur.hits.has(id)));
        return;
      case 'callout-new': {
        const dragged = Math.hypot(e.clientX - cur.client.x, e.clientY - cur.client.y) > 6;
        const badge = dragged ? cur.cur : { x: cur.at.x + 36, y: cur.at.y - 54 };
        let id = '';
        mutate((d) => {
          const s = makeShape(d as CircuitDoc, 'callout', badge.x - 12, badge.y - 12, 24, 24);
          s.stroke = X().color;
          s.step = nextStep(d as CircuitDoc);
          s.anchor = makeAnchor(d as CircuitDoc, cur.target ? (d.items[cur.target] as Item) : null, cur.at);
          s.group = S().scope;
          d.items[s.id] = s;
          id = s.id;
        });
        setX({ editing: id });
        return;
      }
      case 'callout-move':
      case 'callout-anchor':
        endGesture();
        return;
    }
  };

  /* ----------------------------- render ----------------------------- */

  const palette = EDITOR_PALETTE;
  const now = performance.now();
  const flows = useMemo(() => {
    const out: { t: Trace; net: Net; flow: NetFlow }[] = [];
    for (const t of ex.traces) {
      const net = resolveNet(nets, t.seed);
      if (net) out.push({ t, net, flow: netFlow(doc, net, data.polys, t.origin) });
    }
    return out;
  }, [ex.traces, nets, doc, data]);

  const hoverNet = tool === 'trace' && hover.seed && !g ? resolveNet(nets, hover.seed) : undefined;
  const hoverTraced = hoverNet && flows.some((f) => f.net === hoverNet);

  const eraseHits = g?.kind === 'erase' ? [...g.hits] : [];
  const laserColor = '#ff2b2b';

  const editing = ex.editing ? (doc.items[ex.editing] as ShapeItem | undefined) : undefined;

  const cursorCss = !active
    ? undefined
    : tool === 'laser'
      ? 'none'
      : tool === 'pen' || tool === 'highlighter'
        ? penCursor(tool === 'highlighter' ? ex.highlightColor : ex.color, theme, tool === 'highlighter')
        : tool === 'eraser'
          ? ERASER_CURSOR
          : tool === 'trace'
            ? hover.item
              ? 'pointer'
              : 'crosshair'
            : 'crosshair';

  return (
    <>
      {/* eraser preview: the strokes about to go fade out */}
      {eraseHits.length > 0 && <style>{eraseHits.map((id) => `.canvas [data-id="${id}"]`).join(',') + '{opacity:.18;transition:opacity .12s}'}</style>}

      {/* world-space overlays: traces, previews, laser */}
      <svg className="explain-svg" width="100%" height="100%">
        <defs>
          <filter id="trace-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={3.2 / z} />
          </filter>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${z})`}>
          {/* hover preview for the trace tool */}
          {hoverNet && !hoverTraced && (
            <g className="trace-hover">
              {hoverNet.wires.map((id) => (
                <path key={id} d={buildWirePath(data.polys.get(id) ?? [], 0)} fill="none" stroke={TRACE_COLORS[flows.length % TRACE_COLORS.length]} strokeOpacity={0.45} strokeWidth={7 / z} strokeLinecap="round" strokeLinejoin="round" />
              ))}
            </g>
          )}
          {flows.map(({ t, flow }) => (
            <TraceView key={t.id} t={t} flow={flow} z={z} />
          ))}

          {/* hover outline for callout targets */}
          {tool === 'callout' && !g && hover.item && (() => {
            const it = doc.items[hover.item];
            if (!it) return null;
            if (it.type === 'wire') return <path d={buildWirePath(data.polys.get(it.id) ?? [], 0)} className="explain-hover" fill="none" strokeWidth={6 / z} strokeLinecap="round" />;
            const b = itemBounds(doc, it);
            return b ? <rect x={b.x - 6 / z} y={b.y - 6 / z} width={b.w + 12 / z} height={b.h + 12 / z} rx={6 / z} className="explain-hover" fill="none" strokeWidth={1.5 / z} /> : null;
          })()}

          {/* stroke being drawn */}
          {g?.kind === 'ink' &&
            (g.highlighter ? (
              <path d={inkCenterPath(g.pts)} fill="none" stroke={inkColor(g.color, palette)} strokeOpacity={0.36} strokeWidth={g.width} strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <path d={inkOutline(g.pts, g.width)} fill={inkColor(g.color, palette)} />
            ))}
          {g?.kind === 'ink' && g.snapped && (
            <path key={snapFlash} d={g.highlighter ? inkCenterPath(g.pts) : inkOutline(g.pts, g.width)} className="ink-snap-flash" fill={g.highlighter ? 'none' : inkColor(g.color, palette)} stroke={inkColor(g.color, palette)} strokeWidth={g.highlighter ? g.width : 0} strokeLinecap="round" />
          )}

          {/* vanishing ink */}
          {fading.map((f) => {
            const age = now - f.born;
            const o = age < VANISH_LIFE - VANISH_FADE ? 1 : Math.max(0, (VANISH_LIFE - age) / VANISH_FADE);
            return <path key={f.id} d={f.d} fill={inkColor(f.color, palette)} opacity={o} />;
          })}

          {/* callout being placed */}
          {g?.kind === 'callout-new' && (() => {
            const dragged = Math.hypot(g.cur.x - g.at.x, g.cur.y - g.at.y) * z > 6;
            const badge = dragged ? g.cur : { x: g.at.x + 36, y: g.at.y - 54 };
            const c = inkColor(ex.color, palette);
            return (
              <g className="callout-ghost">
                <path d={`M${badge.x},${badge.y}L${g.at.x},${g.at.y}`} stroke={c} strokeWidth={1.5} strokeDasharray="4 4" />
                <circle cx={g.at.x} cy={g.at.y} r={3.5} fill={c} />
                <circle cx={badge.x} cy={badge.y} r={12} fill={c} opacity={0.85} />
                <text x={badge.x} y={badge.y + 4.4} textAnchor="middle" fontSize={12.5} fontWeight={700} fill="#fff">
                  {nextStep(doc)}
                </text>
              </g>
            );
          })()}

          {/* laser pointer */}
          {laser.current.map((tr, i) => (
            <LaserTrail key={i} pts={tr} now={now} z={z} color={laserColor} />
          ))}
          {tool === 'laser' && cursor && <LaserDot p={cursor} z={z} color={laserColor} />}
          <RemoteLasers z={z} />

          {/* eraser ring */}
          {tool === 'eraser' && cursor && <circle cx={cursor.x} cy={cursor.y} r={8 / z} className="eraser-ring" strokeWidth={1.5 / z} />}
        </g>
      </svg>

      {/* input surface: only catches the pointer while an explain tool is active */}
      <div
        className="explain-input"
        style={{ pointerEvents: active ? 'auto' : 'none', cursor: cursorCss }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setCursor(null)}
      />

      {editing && editing.kind === 'callout' && <CalloutEditor s={editing} />}
      {flows.length > 0 && ex.presenting === null && <TracePanel flows={flows} />}
      {(active || flows.length > 0) && ex.presenting === null && <ExplainDock />}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

/** A lit net: glow + draw-on reveal spreading from the click, then current dots flowing along. */
const TraceView = memo(function TraceView({ t, flow, z }: { t: Trace; flow: NetFlow; z: number }) {
  const scale = Math.max(1, flow.reach / (TRACE_SPEED * 1.1));
  const speed = TRACE_SPEED * scale;
  const period = 22 / z;
  return (
    <g className="trace" style={{ color: t.color }}>
      {flow.wires.map((w) => {
        const d = buildWirePath(w.pts, 0);
        const delay = w.start / speed;
        const dur = Math.max(0.05, w.len / speed);
        return (
          <g key={w.id}>
            <path d={d} pathLength={1} className="trace-glow" filter="url(#trace-glow)" strokeWidth={10 / z} style={{ animationDelay: `${delay}s`, animationDuration: `${dur}s` }} />
            <path d={d} pathLength={1} className="trace-core" strokeWidth={Math.max(3 / z, 2.6)} style={{ animationDelay: `${delay}s`, animationDuration: `${dur}s` }} />
            <path d={d} className="trace-flow" strokeWidth={4.2 / z} strokeDasharray={`0 ${period}`} style={{ animationDelay: `${delay + dur}s` }}>
              <animate attributeName="stroke-dashoffset" from={period} to={0} dur="0.55s" repeatCount="indefinite" />
            </path>
          </g>
        );
      })}
      {flow.pins.map((p) => (
        <g key={p.key} transform={`translate(${p.pt.x} ${p.pt.y}) scale(${1 / z})`}>
          <circle r={6} className="trace-pin" style={{ animationDelay: `${p.at / speed}s` }} />
          <circle r={6} className="trace-pin-ring" style={{ animationDelay: `${p.at / speed}s` }} />
        </g>
      ))}
      <g transform={`translate(${t.origin.x} ${t.origin.y}) scale(${1 / z})`}>
        <circle r={5} className="trace-origin" />
        <circle r={5} className="trace-origin-ripple" />
      </g>
    </g>
  );
});

interface LaserPt {
  x: number;
  y: number;
  t: number;
}

/** Drops faded points, and trails that have faded completely (keeping the one being drawn). */
function fadeTrails(trails: LaserPt[][], now: number, keepLast = false): LaserPt[][] {
  return trails
    .map((tr) => tr.filter((p) => now - p.t < LASER_LIFE))
    .filter((tr, i, all) => tr.length > 0 || (keepLast && i === all.length - 1));
}

function LaserTrail({ pts, now, z, color }: { pts: { x: number; y: number; t: number }[]; now: number; z: number; color: string }) {
  if (pts.length < 2) return null;
  const ink = pts.map((p) => ({ x: p.x, y: p.y, p: Math.max(0, 1 - (now - p.t) / LASER_LIFE) }));
  return (
    <g className="laser-trail" pointerEvents="none">
      <path d={inkOutline(ink, 12 / z, { taper: false, pressure: true })} fill={color} opacity={0.35} filter="url(#trace-glow)" />
      <path d={inkOutline(ink, 5 / z, { taper: false, pressure: true })} fill={color} />
      <path d={inkOutline(ink, 1.8 / z, { taper: false, pressure: true })} fill="#fff" opacity={0.85} />
    </g>
  );
}

function LaserDot({ p, z, color }: { p: Point; z: number; color: string }) {
  return (
    <g transform={`translate(${p.x} ${p.y}) scale(${1 / z})`} pointerEvents="none">
      <circle r={11} fill={color} opacity={0.25} filter="url(#trace-glow)" />
      <circle r={5} fill={color} />
      <circle r={2} fill="#fff" />
    </g>
  );
}

/** Collaborators' laser pointers: a dot, and a fading trail for each press of the button. */
function RemoteLasers({ z }: { z: number }) {
  const peers = useCollab((s) => s.peers);
  const trails = useRef(new Map<string, { strokes: LaserPt[][]; down: boolean }>());
  const now = performance.now();
  const out: JSX.Element[] = [];
  for (const p of Object.values(peers)) {
    if (!p.laser || !p.cursor) {
      trails.current.delete(p.id);
      continue;
    }
    const st = trails.current.get(p.id) ?? { strokes: [], down: false };
    const down = p.laser === 2;
    // a fresh press starts a new trail instead of joining the last one
    if (down && !st.down) st.strokes.push([]);
    st.down = down;
    const cur = st.strokes[st.strokes.length - 1];
    const last = cur?.[cur.length - 1];
    if (down && cur && (!last || last.x !== p.cursor.x || last.y !== p.cursor.y)) cur.push({ ...p.cursor, t: now });
    st.strokes = fadeTrails(st.strokes, now, down);
    trails.current.set(p.id, st);
    out.push(
      <g key={p.id}>
        {st.strokes.map((tr, i) => (
          <LaserTrail key={i} pts={tr} now={now} z={z} color={p.color} />
        ))}
        <LaserDot p={p.cursor} z={z} color={p.color} />
      </g>,
    );
  }
  return <>{out}</>;
}

/** Inline note editor for a callout (Enter saves, Shift+Enter breaks the line). */
function CalloutEditor({ s }: { s: ShapeItem }) {
  const view = useStore((st) => st.view);
  const [text, setText] = useState(s.text ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    const v = text.replace(/\s+$/, '');
    if (v !== (s.text ?? '')) mutate((d) => void ((d.items[s.id] as ShapeItem).text = v));
    setX({ editing: null });
  };
  const fs = (s.fontSize ?? 14) * view.zoom;
  const m = measureRich(text || 'M', s.fontSize ?? 14, 500);
  const left = (s.x + 30) * view.zoom + view.x;
  const top = s.y * view.zoom + view.y;
  return (
    <textarea
      ref={ref}
      className="callout-editor"
      style={{
        left,
        top,
        fontSize: fs,
        borderColor: inkColor(s.stroke, EDITOR_PALETTE),
        width: Math.max(180, (m.w + 40) * view.zoom),
        height: Math.max(28 * view.zoom, (m.h + 14) * view.zoom),
      }}
      value={text}
      placeholder="Note"
      onChange={(e) => setText(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={finish}
      onKeyDown={(e) => {
        e.stopPropagation();
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') {
          e.preventDefault();
          finish();
        }
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Cursors                                                             */
/* ------------------------------------------------------------------ */

const cursorCache = new Map<string, string>();
function penCursor(color: string, theme: 'light' | 'dark', wide: boolean): string {
  const k = `${color}|${theme}|${wide}`;
  const hit = cursorCache.get(k);
  if (hit) return hit;
  const fill = color === '#000000' ? (theme === 'dark' ? '#ece6d8' : '#1d1a14') : color;
  const ring = theme === 'dark' ? '#0c0b09' : '#ffffff';
  const svg = wide
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect x="6" y="9" width="12" height="6" rx="2" fill="${fill}" fill-opacity=".7" stroke="${ring}" stroke-width="1.5"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="4" fill="${fill}" stroke="${ring}" stroke-width="2"/></svg>`;
  const css = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 12 12, crosshair`;
  cursorCache.set(k, css);
  return css;
}

const ERASER_CURSOR = 'none';

