import { ChevronLeft, ChevronRight, PenLine, Waypoints, X as Close, Zap } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { RichText } from '../canvas/RichText';
import { inkColor, EDITOR_PALETTE } from '../canvas/Scene';
import { calloutAnchor, callouts } from '../model/callout';
import { docBounds, itemBounds } from '../model/doc';
import { unionRects } from '../model/geometry';
import { computeNets } from '../model/netlist';
import { measureRich } from '../model/richText';
import { resolveNet } from '../model/trace';
import type { Rect, ShapeItem, Tool } from '../model/types';
import * as A from '../store/actions';
import { TRACE_COLORS, X, setX, useExplain, type Trace } from '../store/explain';
import { S, set, toast, useStore, type View } from '../store/store';

/* ------------------------------------------------------------------ */
/* Starting and stopping                                               */
/* ------------------------------------------------------------------ */

let saved: { left: boolean; right: boolean; tool: Tool; view: View } | null = null;
let wentFullscreen = false;

export function startPresenting() {
  if (X().presenting !== null) return;
  const s = S();
  saved = { left: s.leftPanel, right: s.rightPanel, tool: s.tool, view: s.view };
  set({ leftPanel: false, rightPanel: false, contextMenu: null, selection: [], wirePart: null, highlight: null });
  A.setTool('laser');
  setX({ presenting: -1, traces: [], focus: [], regions: [], editing: null });
  document.body.classList.add('is-presenting');
  wentFullscreen = false;
  document.documentElement
    .requestFullscreen?.()
    .then(() => (wentFullscreen = true))
    .catch(() => undefined);
  if (!callouts(s.doc).length) toast('No callouts to step through. Add some with the Callout tool (C).');
}

export function stopPresenting() {
  if (X().presenting === null) return;
  setX({ presenting: null, traces: [], focus: [], regions: [] });
  document.body.classList.remove('is-presenting');
  if (saved) {
    set({ leftPanel: saved.left, rightPanel: saved.right });
    A.setTool(saved.tool === 'laser' ? 'select' : saved.tool);
    flyTo(saved.view, 450);
  }
  saved = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

let flight = 0;
/** Glides the view to `to` (ease in-out). */
function flyTo(to: View, ms = 650) {
  const id = ++flight;
  const from = S().view;
  const t0 = performance.now();
  // zoom interpolates in log space, so it feels even whether zooming in or out
  const lz0 = Math.log(from.zoom);
  const lz1 = Math.log(to.zoom);
  const step = () => {
    if (id !== flight) return;
    const k = Math.min(1, (performance.now() - t0) / ms);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const zoom = Math.exp(lz0 + (lz1 - lz0) * e);
    // keep the world point at the screen centre moving in a straight line
    const { w, h } = S().canvasSize;
    const c0 = { x: (w / 2 - from.x) / from.zoom, y: (h / 2 - from.y) / from.zoom };
    const c1 = { x: (w / 2 - to.x) / to.zoom, y: (h / 2 - to.y) / to.zoom };
    const cx = c0.x + (c1.x - c0.x) * e;
    const cy = c0.y + (c1.y - c0.y) * e;
    set({ view: { x: w / 2 - cx * zoom, y: h / 2 - cy * zoom, zoom } });
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** View that frames `r` above the caption. */
function frame(r: Rect, maxZoom = 2.4): View {
  const { w, h } = S().canvasSize;
  const capH = 170;
  const avail = Math.max(120, h - capH);
  const pad = 70;
  const zoom = Math.max(0.15, Math.min(maxZoom, (w - 2 * pad) / Math.max(r.w, 1), (avail - 2 * pad) / Math.max(r.h, 1)));
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return { x: w / 2 - cx * zoom, y: avail / 2 + 10 - cy * zoom, zoom };
}

/** Shows one step: spotlights its target (a wire's whole net, traced) and frames it with the note. */
function showStep(c: ShapeItem) {
  const doc = S().doc;
  const anchor = calloutAnchor(doc, c);
  const target = c.anchor?.id ? doc.items[c.anchor.id] : undefined;
  const focus = [c.id];
  const traces: Trace[] = [];
  const regions: Rect[] = [];
  if (target?.type === 'wire') {
    const net = resolveNet(computeNets(doc), { wire: target.id });
    focus.push(...(net?.wires ?? [target.id]));
    traces.push({ id: `p${c.id}`, seed: { wire: target.id }, color: c.stroke === '#000000' ? TRACE_COLORS[0] : c.stroke, origin: anchor ?? { x: 0, y: 0 } });
  } else if (target) {
    focus.push(target.id);
  } else if (anchor) {
    regions.push({ x: anchor.x - 50, y: anchor.y - 50, w: 100, h: 100 });
  }
  setX({ focus, traces, regions });
  const rects = focus.map((id) => (doc.items[id] ? itemBounds(doc, doc.items[id]) : null)).filter((r): r is Rect => !!r);
  if (anchor) rects.push({ x: anchor.x - 20, y: anchor.y - 20, w: 40, h: 40 });
  const r = unionRects([...rects, ...regions]);
  if (r) flyTo(frame(r));
}

function showAll() {
  setX({ focus: [], traces: [], regions: [] });
  const r = docBounds(S().doc);
  if (r) flyTo(frame(r, 1.6));
}

/* ------------------------------------------------------------------ */
/* Overlay                                                             */
/* ------------------------------------------------------------------ */

export function Presenter() {
  const idx = useExplain((s) => s.presenting);
  const doc = useStore((s) => s.doc);
  const tool = useStore((s) => s.tool);
  const theme = useStore((s) => s.prefs.theme);
  const steps = useMemo(() => callouts(doc), [doc]);
  const n = steps.length;

  // move the camera when the step changes (after the panels have collapsed)
  const stepId = idx !== null && idx >= 0 && idx < n ? steps[idx].id : null;
  useEffect(() => {
    if (idx === null) return;
    const t = window.setTimeout(() => {
      const c = stepId ? (S().doc.items[stepId] as ShapeItem | undefined) : undefined;
      if (c) showStep(c);
      else showAll();
    }, 60);
    return () => window.clearTimeout(t);
  }, [idx, stepId]);

  useEffect(() => {
    if (idx === null) return;
    const go = (d: number) => setX((s) => ({ presenting: Math.max(-1, Math.min(callouts(S().doc).length, (s.presenting ?? -1) + d)) }));
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      let handled = true;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) go(1);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) go(-1);
      else if (e.key === 'Home') setX({ presenting: -1 });
      else if (e.key === 'End') setX({ presenting: callouts(S().doc).length - 1 });
      else if (e.key === 'Escape') stopPresenting();
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onFs = () => {
      // leaving full screen (the browser eats that Esc) ends the show too
      if (!document.fullscreenElement && wentFullscreen) stopPresenting();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, [idx !== null]);

  if (idx === null) return null;
  const cur = idx >= 0 && idx < n ? steps[idx] : null;
  const color = cur ? inkColor(cur.stroke, EDITOR_PALETTE) : 'var(--accent)';
  const fs = 21;
  const text = cur ? (cur.text ?? '').trim() || `Step ${cur.step ?? idx + 1}` : '';
  const m = cur ? measureRich(text, fs, 500) : { w: 0, h: 0 };

  return (
    <div className="presenter">
      <div className="presenter-top">
        <span className="presenter-title">{doc.name}</span>
        <div className="presenter-tools">
          {(
            [
              ['laser', <Zap size={16} key="l" />, 'Laser (K)'],
              ['pen', <PenLine size={16} key="p" />, 'Vanishing pen (D)'],
              ['trace', <Waypoints size={16} key="t" />, 'Trace a net (Q)'],
            ] as const
          ).map(([t, icon, label]) => (
            <button key={t} className={tool === t ? 'active' : ''} title={label} onClick={() => A.setTool(t)}>
              {icon}
            </button>
          ))}
          <button title="End (Esc)" onClick={stopPresenting}>
            <Close size={16} />
          </button>
        </div>
      </div>

      <div className="presenter-caption" key={idx} style={{ ['--c' as string]: color }}>
        {cur ? (
          <div className="presenter-step">
            <span className="presenter-badge" style={{ background: color, color: cur.stroke === '#000000' ? 'var(--canvas)' : '#fff' }}>
              {cur.step ?? idx + 1}
            </span>
            <svg width={m.w + 4} height={m.h + 8} className="presenter-text">
              <RichText text={text} x={2} y={fs} fontSize={fs} fill={theme === 'dark' ? '#f4efe4' : '#1d1a14'} fontWeight={500} />
            </svg>
          </div>
        ) : idx < 0 ? (
          <div className="presenter-intro">
            <b>{doc.name}</b>
            <span>{n ? `${n} step${n === 1 ? '' : 's'} · → next` : 'No callouts · K laser · D pen · Q trace'}</span>
          </div>
        ) : (
          <div className="presenter-intro">
            <b>End</b>
            <span>← to go back · Esc to finish</span>
          </div>
        )}
        <div className="presenter-nav">
          <button onClick={() => setX({ presenting: Math.max(-1, idx - 1) })} disabled={idx <= -1} title="Back (←)">
            <ChevronLeft size={18} />
          </button>
          <div className="presenter-dots">
            {steps.map((s, i) => (
              <button key={s.id} className={i === idx ? 'on' : i < idx ? 'done' : ''} onClick={() => setX({ presenting: i })} title={(s.text ?? '').split('\n')[0] || `Step ${i + 1}`} />
            ))}
          </div>
          <button onClick={() => setX({ presenting: Math.min(n, idx + 1) })} disabled={idx >= n} title="Next (→ / Space)">
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
