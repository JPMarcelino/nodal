import { Clapperboard, Eye, Film, Play } from 'lucide-react';
import { EXPLAIN_COLORS } from '../model/ink';
import { DEFAULT_HOLD, DEFAULT_TRANSITION, normRect, presentationSteps } from '../model/presentation';
import { restackItems } from '../model/ops';
import type { CircuitDoc, ShapeItem } from '../model/types';
import * as A from '../store/actions';
import { X, setX } from '../store/explain';
import { S, mutate, set, vdoc } from '../store/store';
import { ColorInput, Field, NumberInput, Section, TextInput, Toggle } from './controls';
import { renumberCallouts } from './ExplainDock';
import { seek, stepTime } from './playback';
import { startPresenting } from './Presenter';
import { toggleTimeline } from './Timeline';

/** Properties of hand-drawn ink and numbered callouts. */
export function ExplainShapePanel({ shapes }: { shapes: ShapeItem[] }) {
  const first = shapes[0];
  const ids = shapes.map((s) => s.id);
  const upd = (fn: (s: ShapeItem) => void) => A.updateItems(ids, (it) => {
    if (it.type === 'shape') fn(it);
  });
  const allCallouts = shapes.every((s) => s.kind === 'callout');
  const allInk = shapes.every((s) => s.kind === 'ink');
  const title = allCallouts ? (shapes.length > 1 ? `${shapes.length} callouts` : `Callout ${first.step ?? ''}`) : allInk ? (shapes.length > 1 ? `${shapes.length} strokes` : first.highlighter ? 'Highlighter stroke' : 'Ink stroke') : `${shapes.length} annotations`;
  return (
    <>
      <div className="panel-title">{title}</div>
      {allCallouts && shapes.length === 1 && (
        <Section title="Note">
          <Field label="Text" wide hint="Also the caption when presenting · supports $LaTeX$">
            <TextInput value={first.text ?? ''} multiline focusKey="value" onChange={(v) => upd((s) => (s.text = v))} placeholder="Note" />
          </Field>
          <Field label="Step">
            <NumberInput value={first.step ?? 1} min={1} max={999} onChange={(v) => upd((s) => (s.step = Math.round(v)))} />
          </Field>
          <Field label="Font size">
            <NumberInput value={first.fontSize ?? 14} min={8} max={48} suffix="px" onChange={(v) => upd((s) => (s.fontSize = v))} />
          </Field>
          <Field label="Edit on canvas">
            <button className="secondary-btn" onClick={() => setX({ editing: first.id })}>
              Type note
            </button>
          </Field>
        </Section>
      )}
      <Section title="Colour">
        <div className="xi-swatches">
          {EXPLAIN_COLORS.map((c) => (
            <button key={c} className={first.stroke === c ? 'xi-swatch active' : 'xi-swatch'} style={{ background: c === '#000000' ? 'var(--ink)' : c }} onClick={() => upd((s) => (s.stroke = c))} />
          ))}
        </div>
        <Field label="Custom">
          <ColorInput value={first.stroke} onChange={(v) => upd((s) => (s.stroke = v))} />
        </Field>
        {allInk && (
          <>
            <Field label="Width">
              <NumberInput value={first.strokeWidth} min={0.5} max={80} step={0.5} suffix="px" onChange={(v) => upd((s) => (s.strokeWidth = v))} />
            </Field>
            <Field label="Highlighter" hint="Sends it behind everything (pen ink comes to the front)">
              <Toggle
                checked={!!first.highlighter}
                onChange={(v) =>
                  mutate((d) => {
                    const targets = ids.filter((id) => {
                      const s = d.items[id];
                      return s && !s.locked;
                    });
                    targets.forEach((id) => ((d.items[id] as ShapeItem).highlighter = v || undefined));
                    restackItems(d as CircuitDoc, targets, v ? 'back' : 'front');
                  })
                }
              />
            </Field>
          </>
        )}
      </Section>
      {allCallouts && <TimingSection shapes={shapes} upd={upd} />}
      {allCallouts && (
        <Section title="Walkthrough">
          <div className="xi-row">
            <button className="secondary-btn" onClick={() => renumberCallouts()}>
              Renumber 1, 2, 3…
            </button>
            <button className="secondary-btn" onClick={() => startPresenting()}>
              <Play size={12} fill="currentColor" /> Present
            </button>
          </div>
        </Section>
      )}
    </>
  );
}

type Upd = (fn: (s: ShapeItem) => void) => void;

/** How long the presentation glides to and stays on a step. */
function TimingSection({ shapes, upd }: { shapes: ShapeItem[]; upd: Upd }) {
  const first = shapes[0];
  return (
    <Section title="Timing">
      <Field label="Glide in" hint="Seconds the camera takes to move here (0 = cut)">
        <NumberInput value={first.transition ?? DEFAULT_TRANSITION} min={0} max={30} step={0.1} suffix="s" onChange={(v) => upd((s) => (s.transition = Math.max(0, v)))} />
      </Field>
      <Field label="Stay" hint="Seconds spent here when the timeline plays">
        <NumberInput value={first.hold ?? DEFAULT_HOLD} min={0.2} max={600} step={0.5} suffix="s" onChange={(v) => upd((s) => (s.hold = Math.max(0.2, v)))} />
      </Field>
    </Section>
  );
}

/** Presentation frames: the exact area the camera shows for a step. */
export function FramePanel({ shapes }: { shapes: ShapeItem[] }) {
  const first = shapes[0];
  const ids = shapes.map((s) => s.id);
  const upd: Upd = (fn) => A.updateItems(ids, (it) => {
    if (it.type === 'shape') fn(it);
  });
  /** Reshape around the centre to an aspect ratio (keeps the area roughly the same). */
  const aspect = (a: number) =>
    upd((s) => {
      const r = normRect(s);
      const area = r.w * r.h;
      const w = Math.sqrt(area * a);
      const h = w / a;
      Object.assign(s, { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h });
    });
  const screen = () => {
    const { w, h } = S().canvasSize;
    return w / Math.max(1, h);
  };
  const show = () => {
    const i = presentationSteps(vdoc()).findIndex((s) => s.id === first.id);
    if (!X().timelineOpen) toggleTimeline();
    if (i >= 0) seek(stepTime(i));
  };
  return (
    <>
      <div className="panel-title">{shapes.length > 1 ? `${shapes.length} frames` : `Frame ${first.step ?? ''}`}</div>
      {shapes.length === 1 && (
        <Section title="Frame">
          <Field label="Title" wide hint="Caption while presenting and in the video · supports $LaTeX$">
            <TextInput value={first.text ?? ''} multiline focusKey="value" onChange={(v) => upd((s) => (s.text = v))} placeholder="Optional" />
          </Field>
          <Field label="Step">
            <NumberInput value={first.step ?? 1} min={1} max={999} onChange={(v) => upd((s) => (s.step = Math.round(v)))} />
          </Field>
        </Section>
      )}
      <TimingSection shapes={shapes} upd={upd} />
      <Section title="Shape">
        <div className="xi-row wrap">
          <button className="secondary-btn" onClick={() => aspect(16 / 9)}>
            16:9
          </button>
          <button className="secondary-btn" onClick={() => aspect(4 / 3)}>
            4:3
          </button>
          <button className="secondary-btn" onClick={() => aspect(screen())} title="Same proportions as this screen">
            Screen
          </button>
          {shapes.length === 1 && (
            <button className="secondary-btn" onClick={() => upd((s) => Object.assign(s, A.visibleFrameRect()))} title="Make the frame cover what is on screen now">
              <Eye size={12} /> Fit view
            </button>
          )}
        </div>
        <Field label="Colour">
          <ColorInput value={first.stroke} onChange={(v) => upd((s) => (s.stroke = v))} />
        </Field>
      </Section>
      <Section title="Presentation">
        <div className="xi-row wrap">
          {shapes.length === 1 && (
            <button className="secondary-btn" onClick={show}>
              <Film size={12} /> Show in timeline
            </button>
          )}
          <button className="secondary-btn" onClick={() => startPresenting()}>
            <Play size={12} fill="currentColor" /> Present
          </button>
          <button className="secondary-btn" onClick={() => set({ dialog: 'video' })}>
            <Clapperboard size={12} /> Video
          </button>
          <button className="secondary-btn" onClick={() => renumberCallouts()}>
            Renumber
          </button>
        </div>
      </Section>
    </>
  );
}
