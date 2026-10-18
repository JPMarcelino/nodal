import { ClipboardPaste, Copy } from 'lucide-react';
import { applyLook, commonLook, lookOf, type Look } from '../model/style';
import type { Dash, Item } from '../model/types';
import { S, mutate, toast, useStore } from '../store/store';
import type { ReactNode } from 'react';
import { NumberInput, SWATCHES, Section, Segmented, Slider } from './controls';

/** Style copied with "Copy style", ready to paste onto other items. */
let copied: Partial<Look> | null = null;

/** Applies style properties to every given item, as one undo step. */
export function restyle(ids: string[], p: Partial<Look>) {
  mutate((d) => {
    for (const id of ids) {
      const it = d.items[id];
      if (it && !it.locked) applyLook(it as Item, p);
    }
  });
}

/** Copies the style of the first selected item that has one. */
export function copyStyle() {
  const d = S().doc;
  const it = S().selection.map((id) => d.items[id]).find((i) => i && i.type !== 'junction');
  if (!it) return toast('Select something to copy its style from');
  copied = lookOf(d, it);
  toast('Style copied · Paste style applies it to the selection');
}

export function pasteStyle() {
  if (!copied) return toast('Copy a style first');
  if (!S().selection.length) return toast('Select what to paste the style onto');
  restyle(S().selection, copied);
}

/**
 * A full-width labelled row. Not a <label>: a click between the swatches
 * would otherwise press the first button in the row.
 */
export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field wide" title={hint}>
      <span className="field-label">{label}</span>
      <span className="field-control">{children}</span>
    </div>
  );
}

const DASH_OPTIONS: { value: Dash; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
];

/** One-click colours: automatic / none, the palette, and any colour. */
function SwatchRow({ value, onChange, noneTitle, mixed }: { value: string; onChange: (v: string) => void; noneTitle: string; mixed?: boolean }) {
  const cur = mixed ? null : value.toLowerCase();
  return (
    <span className="swatch-row">
      <button type="button" className={`swatch none${cur === '' ? ' picked' : ''}`} title={noneTitle} onClick={() => onChange('')} />
      {SWATCHES.map((c) => (
        <button key={c} type="button" className={`swatch${cur === c ? ' picked' : ''}`} style={{ background: c }} title={c} onClick={() => onChange(c)} />
      ))}
      <label className={`swatch custom${cur && !SWATCHES.includes(cur) ? ' picked' : ''}`} title="Any colour" style={cur && !SWATCHES.includes(cur) ? { background: cur } : undefined}>
        +
        <input type="color" value={cur && /^#[0-9a-f]{6}$/.test(cur) ? cur : '#7aa2f7'} onChange={(e) => onChange(e.target.value)} />
      </label>
    </span>
  );
}

/**
 * Colours, fill, line width and dashes for whatever is selected — parts, wires
 * and shapes alike, all at once. Each item takes the properties it has.
 */
export function StyleSection({ ids, title = 'Style' }: { ids: string[]; title?: string }) {
  const doc = useStore((s) => s.doc);
  const items = ids.map((id) => doc.items[id]).filter(Boolean);
  const { value, keys, mixed } = commonLook(doc, items);
  if (!keys.size) return null;
  const set = (p: Partial<Look>) => restyle(ids, p);
  const hint = (k: keyof Look) => (mixed.has(k) ? ' (mixed)' : '');
  return (
    <Section
      title={title}
      id="Style"
      actions={
        <span className="row-gap">
          <button className="icon-btn" title="Copy style (Ctrl+Shift+Alt+C)" onClick={copyStyle}>
            <Copy size={13} />
          </button>
          <button className="icon-btn" title="Paste style (Ctrl+Shift+Alt+V)" onClick={pasteStyle}>
            <ClipboardPaste size={13} />
          </button>
        </span>
      }
    >
      {keys.has('line') && (
        <Row label={`Line colour${hint('line')}`}>
          <SwatchRow value={value.line ?? ''} mixed={mixed.has('line')} onChange={(line) => set({ line })} noneTitle="Default colour" />
        </Row>
      )}
      {keys.has('fill') && (
        <Row label={`Fill colour${hint('fill')}`}>
          <SwatchRow value={value.fill ?? ''} mixed={mixed.has('fill')} onChange={(fill) => set({ fill })} noneTitle="No fill" />
        </Row>
      )}
      {keys.has('fillOpacity') && !!value.fill && (
        <Row label={`Fill opacity${hint('fillOpacity')}`}>
          <span className="row-gap">
            <Slider value={value.fillOpacity ?? 1} min={0} max={1} onChange={(fillOpacity) => set({ fillOpacity })} />
            <span className="mono small">{Math.round((value.fillOpacity ?? 1) * 100)}%</span>
          </span>
        </Row>
      )}
      {keys.has('width') && (
        <Row label={`Line width${hint('width')}`}>
          <span className="stack">
            <NumberInput value={value.width ?? 2} min={0.25} max={30} step={0.25} suffix="px" onChange={(width) => set({ width })} />
          </span>
        </Row>
      )}
      {keys.has('dash') && (
        <Row label={`Line style${hint('dash')}`}>
          <Segmented value={mixed.has('dash') ? ('' as Dash) : (value.dash ?? 'solid')} options={DASH_OPTIONS} onChange={(dash) => set({ dash })} />
        </Row>
      )}
      {keys.has('text') && (
        <Row label={`Text colour${hint('text')}`}>
          <SwatchRow value={value.text ?? ''} mixed={mixed.has('text')} onChange={(text) => set({ text })} noneTitle="Default text colour" />
        </Row>
      )}
    </Section>
  );
}
