import { Play } from 'lucide-react';
import { EXPLAIN_COLORS } from '../model/ink';
import type { ShapeItem } from '../model/types';
import { setX } from '../store/explain';
import { mutate } from '../store/store';
import { ColorInput, Field, NumberInput, Section, TextInput, Toggle } from './controls';
import { renumberCallouts } from './ExplainDock';
import { startPresenting } from './Presenter';

/** Properties of hand-drawn ink and numbered callouts. */
export function ExplainShapePanel({ shapes }: { shapes: ShapeItem[] }) {
  const first = shapes[0];
  const ids = shapes.map((s) => s.id);
  const upd = (fn: (s: ShapeItem) => void) => mutate((d) => ids.forEach((id) => fn(d.items[id] as ShapeItem)));
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
            <Field label="Highlighter" hint="Drawn under the circuit">
              <Toggle
                checked={!!first.highlighter}
                onChange={(v) =>
                  upd((s) => {
                    s.highlighter = v || undefined;
                    s.layer = v ? 'below' : 'above';
                  })
                }
              />
            </Field>
          </>
        )}
      </Section>
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
