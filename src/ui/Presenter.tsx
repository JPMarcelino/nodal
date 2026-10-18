import { ChevronLeft, ChevronRight, Pause, PenLine, Play, Timer, TimerOff, Waypoints, X as Close, Zap } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { EXPLAIN_COLORS } from '../model/ink';
import { RichText } from '../canvas/RichText';
import { inkColor, EDITOR_PALETTE } from '../canvas/Scene';
import { presentationSteps, stepShot, transitionOf } from '../model/presentation';
import { measureRich } from '../model/richText';
import type { ShapeItem, Tool } from '../model/types';
import * as A from '../store/actions';
import { X, setX, useExplain } from '../store/explain';
import { S, set, toast, useStore, type View, vdoc, useViewDoc } from '../store/store';
import { flyTo, flyToShot, pause, playPlan, seek, stepTime, stepTraces, togglePlay } from './playback';

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
  pause();
  setX({ presenting: -1, traces: [], editing: null, playT: 0 });
  document.body.classList.add('is-presenting');
  wentFullscreen = false;
  document.documentElement
    .requestFullscreen?.()
    .then(() => (wentFullscreen = true))
    .catch(() => undefined);
  if (!presentationSteps(vdoc()).length) toast('Nothing to step through yet. Draw frames (Shift+F) or add callouts (C).');
}

export function stopPresenting() {
  if (X().presenting === null) return;
  pause();
  setX({ presenting: null, traces: [] });
  document.body.classList.remove('is-presenting');
  if (saved) {
    set({ leftPanel: saved.left, rightPanel: saved.right });
    A.setTool(saved.tool === 'laser' ? 'select' : saved.tool);
    flyTo(saved.view, 450);
  }
  saved = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
}

function toggleVanish() {
  const on = !X().presentVanish;
  setX({ presentVanish: on });
  toast(on ? 'Pen strokes fade away' : 'Pen strokes stay in the drawing');
}

/* ------------------------------------------------------------------ */
/* Overlay                                                             */
/* ------------------------------------------------------------------ */

export function Presenter() {
  const idx = useExplain((s) => s.presenting);
  const doc = useViewDoc();
  const tool = useStore((s) => s.tool);
  const theme = useStore((s) => s.prefs.theme);
  const playing = useExplain((s) => s.playing);
  const playT = useExplain((s) => s.playT);
  const penColor = useExplain((s) => s.color);
  const vanish = useExplain((s) => s.presentVanish);
  const steps = useMemo(() => presentationSteps(doc), [doc]);
  const n = steps.length;

  // move the camera when the step changes by hand (after the panels have collapsed); playback drives it itself
  const stepId = idx !== null && idx >= 0 && idx < n ? steps[idx].id : null;
  useEffect(() => {
    if (idx === null || X().playing) return;
    const t = window.setTimeout(() => {
      const d = vdoc();
      const c = stepId ? (d.items[stepId] as ShapeItem | undefined) : undefined;
      setX({ traces: stepTraces(d, c) });
      if (c) flyToShot(stepShot(d, c), Math.max(250, transitionOf(c) * 1000));
      else flyToShot(playPlan(d).overview, 650);
    }, 60);
    return () => window.clearTimeout(t);
  }, [idx, stepId]);

  // the stage changes size after the show starts (panels fold away, full screen kicks in late):
  // keep the step on screen fitted rather than leaving it framed for the old size
  const canvasSize = useStore((s) => s.canvasSize);
  useEffect(() => {
    if (idx === null || X().playing) return;
    const t = window.setTimeout(() => {
      const d = vdoc();
      const c = stepId ? (d.items[stepId] as ShapeItem | undefined) : undefined;
      flyToShot(c ? stepShot(d, c) : playPlan(d).overview, 200);
    }, 120);
    return () => window.clearTimeout(t);
  }, [canvasSize.w, canvasSize.h]);

  useEffect(() => {
    if (idx === null) return;
    // stepping by hand stops the clock; play resumes from the step on screen
    const goTo = (i: number) => {
      pause();
      const to = Math.max(-1, Math.min(presentationSteps(vdoc()).length, i));
      setX({ presenting: to, playT: to < 0 ? 0 : stepTime(Math.min(to, playPlan().entries.length - 1)) });
    };
    const go = (d: number) => goTo((X().presenting ?? -1) + d);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      let handled = true;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) go(1);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) go(-1);
      else if (e.key === 'Home') goTo(-1);
      else if (e.key === 'End') goTo(presentationSteps(vdoc()).length - 1);
      else if (e.key === 'p' || e.key === 'P' || e.key === 'MediaPlayPause') togglePlay();
      else if (e.key === 'Escape') stopPresenting();
      else if (e.key === 'v' || e.key === 'V') toggleVanish();
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
  const { entries, total } = playPlan(doc);
  const goTo = (i: number) => {
    pause();
    setX({ presenting: i, playT: i < 0 ? 0 : stepTime(Math.min(i, n - 1)) });
  };
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
              ['pen', <PenLine size={16} key="p" />, vanish ? 'Vanishing pen (D)' : 'Pen (D) — strokes stay in the drawing'],
              ['trace', <Waypoints size={16} key="t" />, 'Trace a net (Q)'],
            ] as const
          ).map(([t, icon, label]) => (
            <button key={t} className={tool === t ? 'active' : ''} title={label} onClick={() => A.setTool(t)}>
              {icon}
            </button>
          ))}
          <span className="presenter-sep" />
          {EXPLAIN_COLORS.map((c, i) => (
            <button
              key={c}
              className={`presenter-swatch${penColor === c ? ' on' : ''}`}
              title={`Pen colour (${i + 1})`}
              onClick={() => {
                setX({ color: c });
                if (tool !== 'pen') A.setTool('pen');
              }}
            >
              <i style={{ background: inkColor(c, EDITOR_PALETTE) }} />
            </button>
          ))}
          <button className={vanish ? 'active' : ''} title={vanish ? 'Pen strokes fade away (V) — click to keep them' : 'Pen strokes are kept (V) — click to make them fade'} onClick={toggleVanish}>
            {vanish ? <Timer size={16} /> : <TimerOff size={16} />}
          </button>
          <span className="presenter-sep" />
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
            <span>{n ? `${n} step${n === 1 ? '' : 's'} · → next · P play` : 'No frames or callouts · K laser · D pen · 1–7 colour · V fade · Q trace'}</span>
          </div>
        ) : (
          <div className="presenter-intro">
            <b>End</b>
            <span>← to go back · Esc to finish</span>
          </div>
        )}
        <div className="presenter-nav">
          <button onClick={() => goTo(Math.max(-1, idx - 1))} disabled={idx <= -1} title="Back (←)">
            <ChevronLeft size={18} />
          </button>
          <div className="presenter-dots">
            {steps.map((s, i) => (
              <button key={s.id} className={i === idx ? 'on' : i < idx ? 'done' : ''} onClick={() => goTo(i)} title={(s.text ?? '').split('\n')[0] || `Step ${i + 1}`} />
            ))}
          </div>
          <button onClick={() => goTo(Math.min(n, idx + 1))} disabled={idx >= n} title="Next (→ / Space)">
            <ChevronRight size={18} />
          </button>
          {total > 0 && (
            <button className="presenter-play" onClick={togglePlay} title={playing ? 'Pause (P)' : 'Play the timeline (P)'}>
              {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
            </button>
          )}
        </div>
        {total > 0 && (
          <div
            className="presenter-progress"
            title="Click to jump"
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              seek(((e.clientX - r.left) / r.width) * total);
            }}
          >
            {entries.map((en) => (
              <span key={en.id} style={{ left: `${(en.start / total) * 100}%`, width: `${((en.end - en.start) / total) * 100}%` }} />
            ))}
            <i style={{ width: `${(playT / total) * 100}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}
