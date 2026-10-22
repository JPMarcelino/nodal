import { ClipboardPaste, Copy } from 'lucide-react';
import { TEXT_KEYS, applyLook, commonLook, lookOf, type Look, type LookKey } from '../model/style';
import { DASH_OPTIONS } from '../model/dash';
import { FONT_OPTIONS } from '../model/fonts';
import { measureTextShape } from '../model/shapeText';
import type { Dash, Item, ShapeItem } from '../model/types';
import { S, mutate, toast, useViewDoc, vdoc } from '../store/store';
import type { ReactNode } from 'react';
import { EyedropperButton, NumberInput, SWATCHES, Section, Segmented, Slider, Toggle, swatchBg, swatchTitle } from './controls';

/** Style copied with "Copy style", ready to paste onto other items. */
let copied: Partial<Look> | null = null;

/** Applies style properties to every given item, as one undo step. */
export function restyle(ids: string[], p: Partial<Look>) {
  mutate((d) => {
    for (const id of ids) {
      const it = d.items[id];
      if (!it || it.locked) continue;
      applyLook(it as Item, p);
      // free text is sized by its content
      if (it.type === 'shape' && it.kind === 'text') Object.assign(it, measureTextShape(it as ShapeItem));
    }
  });
}

/** Copies the style of the first selected item that has one. */
export function copyStyle() {
  const d = vdoc();
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

/** Line style as a dropdown (five styles don't fit a button row). */
export function DashSelect({ value, mixed, onChange }: { value: Dash; mixed?: boolean; onChange: (d: Dash) => void }) {
  return (
    <select className="input" value={mixed ? '' : value} onChange={(e) => onChange(e.target.value as Dash)}>
      {mixed && (
        <option value="" disabled>
          Mixed
        </option>
      )}
      {DASH_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const ALIGNS: { value: Look['align']; label: string; title?: string }[] = [
  { value: '', label: 'Auto', title: 'The default for this kind of text' },
  { value: 'start', label: 'Left' },
  { value: 'middle', label: 'Centre' },
  { value: 'end', label: 'Right' },
];
const VALIGNS: { value: Look['valign']; label: string }[] = [
  { value: 'top', label: 'Top' },
  { value: 'middle', label: 'Middle' },
  { value: 'bottom', label: 'Bottom' },
];
const CAPS: { value: Look['cap']; label: string }[] = [
  { value: 'butt', label: 'Butt' },
  { value: 'round', label: 'Round' },
  { value: 'square', label: 'Square' },
];
const JOINS: { value: Look['join']; label: string }[] = [
  { value: 'miter', label: 'Miter' },
  { value: 'round', label: 'Round' },
  { value: 'bevel', label: 'Bevel' },
];
const FILLS: { value: Look['fillKind']; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'solid', label: 'Solid' },
  { value: 'gradient', label: 'Gradient' },
];

/** One-click colours: automatic / none, the palette, and any colour. */
export function SwatchRow({ value, onChange, noneTitle, mixed }: { value: string; onChange: (v: string) => void; noneTitle: string; mixed?: boolean }) {
  const cur = mixed ? null : value.toLowerCase();
  return (
    <span className="swatch-row">
      <button type="button" className={`swatch none${cur === '' ? ' picked' : ''}`} title={noneTitle} onClick={() => onChange('')} />
      {SWATCHES.map((c) => (
        <button key={c} type="button" className={`swatch${cur === c ? ' picked' : ''}`} style={{ background: swatchBg(c) }} title={swatchTitle(c)} onClick={() => onChange(c)} />
      ))}
      <label className={`swatch custom${cur && !SWATCHES.includes(cur) ? ' picked' : ''}`} title="Any colour" style={cur && !SWATCHES.includes(cur) ? { background: cur } : undefined}>
        +
        <input type="color" value={cur && /^#[0-9a-f]{6}$/.test(cur) ? cur : '#7aa2f7'} onChange={(e) => onChange(e.target.value)} />
      </label>
      <EyedropperButton onPick={onChange} />
    </span>
  );
}

/** Slider with its percentage. */
function Percent({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <span className="row-gap">
      <Slider value={value} min={0} max={1} onChange={onChange} />
      <span className="mono small">{Math.round(value * 100)}%</span>
    </span>
  );
}

/** The formatting every kind of text offers — shape text, part labels and wire labels alike. */
export type TextFormat = Pick<Look, 'font' | 'size' | 'bold' | 'italic' | 'underline' | 'allCaps' | 'text' | 'align'>;

const EMPHASIS = [
  ['bold', 'B', 'Bold'],
  ['italic', 'I', 'Italic'],
  ['underline', 'U', 'Underline'],
  ['allCaps', 'AA', 'All caps'],
] as const;

/**
 * Font, size, emphasis, colour and alignment rows, shared by every text in the
 * inspector so they all look and behave the same. `keys` limits the rows to the
 * properties the text has (wire labels have no alignment).
 */
export function TextFormatRows({
  value,
  onChange,
  mixed = new Set(),
  keys,
}: {
  value: Partial<TextFormat>;
  onChange: (p: Partial<TextFormat>) => void;
  mixed?: Set<LookKey>;
  keys?: Set<LookKey>;
}) {
  const has = (k: keyof TextFormat) => !keys || keys.has(k);
  const hint = (k: keyof TextFormat) => (mixed.has(k) ? ' (mixed)' : '');
  return (
    <>
      {has('font') && (
        <Row label={`Font${hint('font')}`}>
          <Segmented value={mixed.has('font') ? ('none' as Look['font']) : (value.font ?? '')} options={FONT_OPTIONS} onChange={(font) => onChange({ font })} />
        </Row>
      )}
      {has('size') && (
        <Row label={`Size${hint('size')}`}>
          <NumberInput value={value.size ?? 13} min={4} max={120} step={0.5} suffix="px" onChange={(size) => onChange({ size })} />
        </Row>
      )}
      <Row label="Style">
        <span className="type-buttons">
          {EMPHASIS.filter(([k]) => has(k)).map(([k, glyph, name]) => {
            const on = !!value[k] && !mixed.has(k);
            return (
              <button
                key={k}
                type="button"
                className={`type-btn ${k}${on ? ' active' : ''}`}
                title={`${name}${hint(k)}`}
                aria-pressed={on}
                onClick={() => onChange({ [k]: !on })}
              >
                {glyph}
              </button>
            );
          })}
        </span>
      </Row>
      {has('text') && (
        <Row label={`Colour${hint('text')}`}>
          <SwatchRow value={value.text ?? ''} mixed={mixed.has('text')} onChange={(text) => onChange({ text })} noneTitle="Default text colour" />
        </Row>
      )}
      {has('align') && (
        <Row label={`Align${hint('align')}`}>
          <Segmented value={mixed.has('align') ? ('none' as Look['align']) : (value.align ?? '')} options={ALIGNS} onChange={(align) => onChange({ align })} />
        </Row>
      )}
    </>
  );
}

/** Extra content a panel can add to the sections of a style section. */
export interface StyleExtras {
  /** First in "Text" (e.g. the content field). */
  textTop?: ReactNode;
  /** Last in "Text". */
  text?: ReactNode;
  /** Last in "Line" (e.g. arrowheads). */
  line?: ReactNode;
}

/**
 * Colours, fill, line width and dashes for whatever is selected — parts, wires
 * and shapes alike, all at once. Each item takes the properties it has. Shapes
 * get their text, line, fill and effect options in sections of their own.
 */
export function StyleSection({ ids, title = 'Style', extras = {}, noText }: { ids: string[]; title?: string; extras?: StyleExtras; noText?: boolean }) {
  const doc = useViewDoc();
  const items = ids.map((id) => doc.items[id]).filter(Boolean);
  const { value, keys, mixed } = commonLook(doc, items);
  // a panel with text controls of its own (a part's labels) leaves them out here
  if (noText) for (const k of TEXT_KEYS) keys.delete(k);
  if (!keys.size) return null;
  const set = (p: Partial<Look>) => restyle(ids, p);
  const hint = (k: keyof Look) => (mixed.has(k) ? ' (mixed)' : '');
  const copyPaste = (
    <span className="row-gap">
      <button className="icon-btn" title="Copy style (Ctrl+Shift+Alt+C)" onClick={copyStyle}>
        <Copy size={13} />
      </button>
      <button className="icon-btn" title="Paste style (Ctrl+Shift+Alt+V)" onClick={pasteStyle}>
        <ClipboardPaste size={13} />
      </button>
    </span>
  );
  const grouped = keys.has('size') || keys.has('opacity') || keys.has('lineOpacity');
  const fillKind = value.fillKind ?? (value.fill ? 'solid' : 'none');
  const fillShown = keys.has('fillKind') ? fillKind !== 'none' || mixed.has('fillKind') : true;
  const hasFill = keys.has('fill') && fillShown;
  const lineRows = (
    <>
      {keys.has('line') && (
        <Row label={`Line colour${hint('line')}`}>
          <SwatchRow value={value.line ?? ''} mixed={mixed.has('line')} onChange={(line) => set({ line })} noneTitle="Default colour" />
        </Row>
      )}
      {keys.has('width') && (
        <Row label={`Line width${hint('width')}`}>
          <span className="stack">
            <NumberInput value={value.width ?? 2} min={keys.has('lineOpacity') ? 0 : 0.25} max={30} step={0.25} suffix="px" onChange={(width) => set({ width })} />
          </span>
        </Row>
      )}
      {keys.has('dash') && (
        <Row label={`Line style${hint('dash')}`}>
          <DashSelect value={value.dash ?? 'solid'} mixed={mixed.has('dash')} onChange={(dash) => set({ dash })} />
        </Row>
      )}
      {keys.has('lineOpacity') && (
        <Row label={`Line opacity${hint('lineOpacity')}`}>
          <Percent value={value.lineOpacity ?? 1} onChange={(lineOpacity) => set({ lineOpacity })} />
        </Row>
      )}
      {keys.has('cap') && (
        <Row label={`Line cap${hint('cap')}`}>
          <Segmented value={mixed.has('cap') ? ('' as Look['cap']) : (value.cap ?? 'butt')} options={CAPS} onChange={(cap) => set({ cap })} />
        </Row>
      )}
      {keys.has('join') && (
        <Row label={`Line join${hint('join')}`}>
          <Segmented value={mixed.has('join') ? ('' as Look['join']) : (value.join ?? 'miter')} options={JOINS} onChange={(join) => set({ join })} />
        </Row>
      )}
      {keys.has('radius') && (
        <Row label={`Corner radius${hint('radius')}`}>
          <NumberInput value={value.radius ?? 0} min={0} max={200} suffix="px" onChange={(radius) => set({ radius })} />
        </Row>
      )}
    </>
  );
  const fillRows = (
    <>
      {keys.has('fillKind') && (
        <Row label={`Fill${hint('fillKind')}`}>
          <Segmented value={mixed.has('fillKind') ? ('' as Look['fillKind']) : fillKind} options={FILLS} onChange={(k) => set({ fillKind: k })} />
        </Row>
      )}
      {hasFill && (
        <Row label={`Fill colour${hint('fill')}`}>
          <SwatchRow value={value.fill ?? ''} mixed={mixed.has('fill')} onChange={(fill) => set({ fill })} noneTitle="No fill" />
        </Row>
      )}
      {keys.has('fill2') && fillKind === 'gradient' && !mixed.has('fillKind') && (
        <>
          <Row label={`Gradient colour${hint('fill2')}`}>
            <SwatchRow value={value.fill2 ?? ''} mixed={mixed.has('fill2')} onChange={(fill2) => set({ fill2: fill2 || '#bb9af7' })} noneTitle="Default" />
          </Row>
          <Row label={`Gradient angle${hint('gradAngle')}`}>
            <span className="row-gap">
              <Segmented value={value.gradAngle ?? 90} options={[0, 90, 180, 270].map((a) => ({ value: a, label: `${a}°` }))} onChange={(gradAngle) => set({ gradAngle })} />
              <NumberInput value={value.gradAngle ?? 90} min={0} max={360} step={15} suffix="°" onChange={(gradAngle) => set({ gradAngle })} />
            </span>
          </Row>
        </>
      )}
      {keys.has('fillOpacity') && (hasFill ? !!value.fill || mixed.has('fill') : false) && (
        <Row label={`Fill opacity${hint('fillOpacity')}`}>
          <Percent value={value.fillOpacity ?? 1} onChange={(fillOpacity) => set({ fillOpacity })} />
        </Row>
      )}
    </>
  );
  if (!grouped) {
    return (
      <Section title={title} id="Style" actions={copyPaste}>
        {lineRows}
        {fillRows}
        {keys.has('text') && (
          <Row label={`Text colour${hint('text')}`}>
            <SwatchRow value={value.text ?? ''} mixed={mixed.has('text')} onChange={(text) => set({ text })} noneTitle="Default text colour" />
          </Row>
        )}
      </Section>
    );
  }
  const hasLine = keys.has('line') || keys.has('width') || keys.has('dash');
  const hasFillSection = keys.has('fill') || keys.has('fillKind');
  // the copy / paste buttons sit on the first section
  let first = true;
  const actions = () => (first ? ((first = false), copyPaste) : undefined);
  return (
    <>
      {keys.has('size') && (
        <Section title="Text" actions={actions()}>
          {extras.textTop}
          <TextFormatRows value={value} mixed={mixed} keys={keys} onChange={set} />
          {keys.has('valign') && (
            <Row label={`Vertical align${hint('valign')}`}>
              <Segmented value={mixed.has('valign') ? ('' as Look['valign']) : (value.valign ?? 'top')} options={VALIGNS} onChange={(valign) => set({ valign })} />
            </Row>
          )}
          {keys.has('wrapW') && (
            <Row label={`Wrap width${hint('wrapW')}`} hint="Text wraps at this width; 0 keeps each paragraph on one line. Drag the handle on the right edge too">
              <NumberInput value={value.wrapW ?? 0} min={0} max={4000} suffix="px" onChange={(wrapW) => set({ wrapW })} />
            </Row>
          )}
          {extras.text}
        </Section>
      )}
      {hasLine && (
        <Section title="Line" actions={actions()}>
          {lineRows}
          {extras.line}
        </Section>
      )}
      {hasFillSection && (
        <Section title="Fill" actions={actions()}>
          {fillRows}
        </Section>
      )}
      {keys.has('opacity') && (
        <Section title="Effects" actions={actions()}>
          <Row label={`Opacity${hint('opacity')}`}>
            <Percent value={value.opacity ?? 1} onChange={(opacity) => set({ opacity })} />
          </Row>
          <Row label={`Shadow${hint('shadow')}`}>
            <Toggle checked={!!value.shadow} onChange={(shadow) => set({ shadow })} />
          </Row>
        </Section>
      )}
    </>
  );
}
