import { Clapperboard, Frame, Minus, Pause, Play, Plus, Presentation, X as Close } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_HOLD, DEFAULT_TRANSITION, holdOf, renumberSteps, transitionOf } from '../model/presentation';
import type { CircuitDoc, ShapeItem } from '../model/types';
import * as A from '../store/actions';
import { setX, useExplain } from '../store/explain';
import { beginGesture, endGesture, gestureUpdate, mutate, select, set, useStore } from '../store/store';
import { pause, playPlan, seek, stepTime, togglePlay } from './playback';
import { startPresenting } from './Presenter';

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
const round = (v: number) => Math.round(v * 10) / 10;
export const fmtTime = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

type Drag =
  | { kind: 'hold' | 'transition'; id: string; x0: number; v0: number }
  | { kind: 'move'; id: string; x0: number; moved: boolean; to: number }
  | { kind: 'scrub' };

/**
 * Presentation timeline: every frame / callout as a block whose striped part
 * is the camera glide and solid part the time spent there. Drag the edges to
 * retime, drag a block to reorder, click the ruler to scrub.
 */
export function Timeline() {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const playing = useExplain((s) => s.playing);
  const playT = useExplain((s) => s.playT);
  const [pps, setPps] = useState(36); // pixels per second
  const [drag, setDrag] = useState<Drag | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const { steps, entries, total } = playPlan(doc);
  const sel = new Set(selection);
  // true while this component holds an open edge-drag gesture (beginGesture
  // without its matching endGesture). The unmount cleanup cancels only a
  // gesture this component owns, so it never clobbers a canvas gesture.
  const edgeDrag = useRef(false);

  useEffect(
    () => () => {
      pause();
      if (edgeDrag.current) endGesture(false);
    },
    [],
  );

  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + track.current!.scrollLeft - 12) / pps);
  };

  /** Where among the other blocks one dragged to x would land. */
  const dropIndex = (clientX: number, id: string) => {
    const t = timeAt(clientX);
    const others = entries.filter((e) => e.id !== id);
    const i = others.findIndex((e) => t < (e.start + e.end) / 2);
    return i < 0 ? others.length : i;
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.kind === 'scrub') return seek(timeAt(e.clientX));
    if (drag.kind === 'move') {
      const moved = drag.moved || Math.abs(e.clientX - drag.x0) > 4;
      setDrag({ ...drag, moved, to: dropIndex(e.clientX, drag.id) });
      return;
    }
    const v = round(Math.max(drag.kind === 'hold' ? 0.2 : 0, drag.v0 + (e.clientX - drag.x0) / pps));
    gestureUpdate((d) => void ((d.items[drag.id] as ShapeItem)[drag.kind] = v));
  };

  const onUp = () => {
    if (!drag) return;
    if (drag.kind === 'hold' || drag.kind === 'transition') {
      endGesture(true);
      edgeDrag.current = false;
    }
    if (drag.kind === 'move') {
      const i = steps.findIndex((s) => s.id === drag.id);
      if (drag.moved) {
        const order = steps.map((s) => s.id).filter((id) => id !== drag.id);
        order.splice(drag.to, 0, drag.id);
        if (order.join() !== steps.map((s) => s.id).join()) mutate((d) => renumberSteps(d as CircuitDoc, order));
      } else {
        // a click: select it and show it
        select([drag.id]);
        seek(stepTime(i));
      }
    }
    setDrag(null);
  };

  const startEdge = (e: React.PointerEvent, s: ShapeItem, kind: 'hold' | 'transition') => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    beginGesture();
    edgeDrag.current = true;
    setDrag({ kind, id: s.id, x0: e.clientX, v0: kind === 'hold' ? holdOf(s) : transitionOf(s) });
  };

  const width = Math.max(total, 10) * pps + 120;
  const ticks: number[] = [];
  const every = pps >= 30 ? 1 : pps >= 12 ? 5 : 10;
  for (let t = 0; t <= Math.max(total, 10) + every; t += every) ticks.push(t);
  // insertion marker while reordering
  let dropAt: number | null = null;
  if (drag?.kind === 'move' && drag.moved) {
    const others = entries.filter((e) => e.id !== drag.id);
    dropAt = drag.to < others.length ? others[drag.to].start : (others[others.length - 1]?.end ?? 0);
  }

  return (
    <div className="timeline" onPointerDown={stop} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={stop}>
      <div className="tl-head">
        <button className="tl-btn primary" onClick={togglePlay} disabled={!total} title={playing ? 'Pause preview' : 'Preview the timeline here'}>
          {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
        </button>
        <span className="tl-time mono">
          {fmtTime(playT)} <span className="muted">/ {fmtTime(total)}</span>
        </span>
        <span className="tl-sep" />
        <button className="tl-btn" onClick={() => select([A.addFrame(A.visibleFrameRect())])} title="Add a frame around what is on screen (or drag one with the Frame tool, Shift+F)">
          <Frame size={14} /> Frame this view
        </button>
        <button className="tl-btn" onClick={() => A.setTool('frame')} title="Frame tool (Shift+F): drag a rectangle on the canvas">
          <Plus size={14} /> Draw frame
        </button>
        <span className="tl-sep" />
        <button className="tl-btn" onClick={() => startPresenting()} disabled={!steps.length} title="Present (F5) · step by hand or press P to play">
          <Presentation size={14} /> Present
        </button>
        <button className="tl-btn" onClick={() => set({ dialog: 'video' })} disabled={!steps.length} title="Render the timeline to a video file">
          <Clapperboard size={14} /> Export video
        </button>
        <span className="tl-grow" />
        <button className="tl-btn icon" onClick={() => setPps((p) => Math.max(6, p / 1.5))} title="Zoom out">
          <Minus size={14} />
        </button>
        <button className="tl-btn icon" onClick={() => setPps((p) => Math.min(160, p * 1.5))} title="Zoom in">
          <Plus size={14} />
        </button>
        <button className="tl-btn icon" onClick={() => setX({ timelineOpen: false })} title="Close the timeline">
          <Close size={14} />
        </button>
      </div>
      <div className="tl-track" ref={track}>
        <div className="tl-inner" style={{ width }}>
          <div
            className="tl-ruler"
            onPointerDown={(e) => {
              (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
              setDrag({ kind: 'scrub' });
              seek(timeAt(e.clientX));
            }}
          >
            {ticks.map((t) => (
              <span key={t} style={{ left: 12 + t * pps }}>
                {t % (every * (every === 1 ? 5 : 2)) === 0 ? `${t}s` : ''}
              </span>
            ))}
          </div>
          <div className="tl-row">
            {!steps.length && (
              <div className="tl-empty muted">
                No steps yet. Frame a view, draw frames with <kbd>Shift</kbd>+<kbd>F</kbd>, or add numbered callouts (<kbd>C</kbd>). Default: {DEFAULT_TRANSITION}s glide, {DEFAULT_HOLD}s hold.
              </div>
            )}
            {steps.map((s, i) => {
              const en = entries[i];
              const tw = en.transition * pps;
              const label = (s.text ?? '').split('\n')[0] || (s.kind === 'frame' ? 'Frame' : 'Callout');
              const cls = ['tl-block', s.kind, sel.has(s.id) ? 'sel' : '', drag?.kind === 'move' && drag.id === s.id && drag.moved ? 'dragging' : '']
                .filter(Boolean)
                .join(' ');
              return (
                <div
                  key={s.id}
                  className={cls}
                  style={{ left: 12 + en.start * pps, width: Math.max(8, (en.end - en.start) * pps), ['--c' as string]: s.stroke }}
                  title={`${s.step ?? i + 1}. ${label}\nGlide ${en.transition}s · stay ${en.hold}s\nDrag to reorder · drag the edges to retime`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
                    setDrag({ kind: 'move', id: s.id, x0: e.clientX, moved: false, to: i });
                  }}
                >
                  <div className="tl-trans" style={{ width: tw }} />
                  <div className="tl-hold">
                    <b>{s.step ?? i + 1}</b> {label}
                    <small>{en.hold}s</small>
                  </div>
                  <span className="tl-handle trans" style={{ left: tw - 3 }} onPointerDown={(e) => startEdge(e, s, 'transition')} title="Drag: glide time" />
                  <span className="tl-handle hold" onPointerDown={(e) => startEdge(e, s, 'hold')} title="Drag: time spent here" />
                </div>
              );
            })}
            {dropAt !== null && <div className="tl-drop" style={{ left: 12 + dropAt * pps - 2 }} />}
          </div>
          <div className="tl-playhead" style={{ left: 12 + playT * pps }} />
        </div>
      </div>
    </div>
  );
}

/** Opens / closes the timeline (closing stops a running preview). */
export function toggleTimeline() {
  const open = !useExplain.getState().timelineOpen;
  if (!open) pause();
  setX({ timelineOpen: open });
}
