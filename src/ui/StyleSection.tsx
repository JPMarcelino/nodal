import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react';
import { TEXT_KEYS, applyLook, commonLook, lookOf, strokeNounOf, type Look, type LookKey } from '../model/style';
import { DASH_OPTIONS, dashArray } from '../model/dash';
import { FONT_OPTIONS } from '../model/fonts';
import { measureTextShape } from '../model/shapeText';
import type { Dash, Item, ShapeItem } from '../model/types';
import { S, mutate, toast, useViewDoc, vdoc } from '../store/store';
import type { ReactNode } from 'react';
import { ColorInput, More, NumberInput, Section, Segmented, Slider, Toggle, type MenuItem } from './controls';

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
 * A labelled row: label on the left, control on the right (`stacked` puts the
 * label above, for controls that need the full width). Not a <label>: a click
 * on the label would otherwise press the first button in the row.
 */
export function Row({ label, hint, children, stacked }: { label: string; hint?: string; children: ReactNode; stacked?: boolean }) {
  return (
    <div className={stacked ? 'field wide' : 'field'} title={hint}>
      <span className="field-label">{label}</span>
      <span className="field-control">{children}</span>
    </div>
  );
}

/** Line style as five little pictures of the line. */
export function DashSelect({ value, mixed, onChange }: { value: Dash; mixed?: boolean; onChange: (d: Dash) => void }) {
  return (
    <Segmented
      value={mixed ? ('' as Dash) : value}
      className="dash-seg"
      options={DASH_OPTIONS.map((o) => ({
        value: o.value,
        title: o.label,
        label: (
          <svg width="22" height="8" viewBox="0 0 22 8" aria-label={o.label}>
            <line x1="2" y1="4" x2="20" y2="4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeDasharray={dashArray(o.value, 1.1)} />
          </svg>
        ),
      }))}
      onChange={onChange}
    />
  );
}

const ALIGNS: { value: Look['align']; label: ReactNode; title?: string }[] = [
  { value: '', label: 'Auto', title: 'The default for this kind of text' },
  { value: 'start', label: <AlignLeft size={14} />, title: 'Left' },
  { value: 'middle', label: <AlignCenter size={14} />, title: 'Centre' },
  { value: 'end', label: <AlignRight size={14} />, title: 'Right' },
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

/** A small chip of a colour, for folded section summaries. */
function ColourDot({ c }: { c: string }) {
  return <span className={c ? 'colour-dot' : 'colour-dot none'} style={c ? { background: c === '#000000' ? 'var(--ink)' : c } : undefined} />;
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
          <ColorInput value={value.text ?? ''} mixed={mixed.has('text')} allowNone noneTitle="Default" onChange={(text) => onChange({ text })} />
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
  /** Last in the "Line" / "Outline" section (e.g. arrowheads). */
  line?: ReactNode;
  /** More entries for the style's ⋯ menu. */
  menu?: MenuItem[];
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
  // a line is the stroke itself; an outline goes round a closed shape
  const noun = strokeNounOf(items);
  const copyPaste: MenuItem[] = [
    { label: 'Copy style', hint: 'Ctrl+Alt+Shift+C', onClick: copyStyle },
    { label: 'Paste style', hint: 'Ctrl+Alt+Shift+V', onClick: pasteStyle, disabled: !copied },
    ...(extras.menu ?? []),
  ];
  const grouped = keys.has('size') || keys.has('opacity') || keys.has('lineOpacity');
  const fillKind = value.fillKind ?? (value.fill ? 'solid' : 'none');
  const fillShown = keys.has('fillKind') ? fillKind !== 'none' || mixed.has('fillKind') : true;
  const hasFill = keys.has('fill') && fillShown;
  const lineRows = (
    <>
      {keys.has('line') && (
        <Row label={`${noun} colour${hint('line')}`}>
          <ColorInput value={value.line ?? ''} mixed={mixed.has('line')} allowNone noneTitle="Default" onChange={(line) => set({ line })} />
        </Row>
      )}
      {keys.has('width') && (
        <Row label={`${noun} width${hint('width')}`}>
          <span className="stack">
            <NumberInput value={value.width ?? 2} min={keys.has('lineOpacity') ? 0 : 0.25} max={30} step={0.25} suffix="px" onChange={(width) => set({ width })} />
          </span>
        </Row>
      )}
      {keys.has('dash') && (
        <Row label={`${noun} style${hint('dash')}`}>
          <DashSelect value={value.dash ?? 'solid'} mixed={mixed.has('dash')} onChange={(dash) => set({ dash })} />
        </Row>
      )}
      {keys.has('radius') && (
        <Row label={`Corner radius${hint('radius')}`}>
          <NumberInput value={value.radius ?? 0} min={0} max={200} suffix="px" onChange={(radius) => set({ radius })} />
        </Row>
      )}
      {(keys.has('lineOpacity') || keys.has('cap') || keys.has('join')) && (
        <More id="line-ends" label="Ends, joins & opacity" count={[value.lineOpacity !== undefined && value.lineOpacity < 1, value.cap && value.cap !== 'butt', value.join && value.join !== 'miter'].filter(Boolean).length}>
        {keys.has('lineOpacity') && (
          <Row label={`${noun} opacity${hint('lineOpacity')}`}>
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
        </More>
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
          <ColorInput value={value.fill ?? ''} mixed={mixed.has('fill')} allowNone noneTitle="No fill" onChange={(fill) => set({ fill })} />
        </Row>
      )}
      {keys.has('fill2') && fillKind === 'gradient' && !mixed.has('fillKind') && (
        <>
          <Row label={`Gradient colour${hint('fill2')}`}>
            <ColorInput value={value.fill2 ?? ''} mixed={mixed.has('fill2')} onChange={(fill2) => set({ fill2: fill2 || '#bb9af7' })} />
          </Row>
          <Row label={`Gradient angle${hint('gradAngle')}`} stacked>
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
      <Section title={title} id="Style" menu={copyPaste}>
        {lineRows}
        {fillRows}
        {keys.has('text') && (
          <Row label={`Text colour${hint('text')}`}>
            <ColorInput value={value.text ?? ''} mixed={mixed.has('text')} allowNone noneTitle="Default" onChange={(text) => set({ text })} />
          </Row>
        )}
      </Section>
    );
  }
  const hasLine = keys.has('line') || keys.has('width') || keys.has('dash');
  const hasFillSection = keys.has('fill') || keys.has('fillKind');
  // free text leads with its text; anything else with how it looks
  const freeText = keys.has('wrapW');
  const order = (freeText ? ['text', 'fill', 'line'] : ['fill', 'line', 'text']).filter((k) =>
    k === 'text' ? keys.has('size') : k === 'fill' ? hasFillSection : hasLine,
  );
  // the lead section starts open and carries the copy / paste menu
  const lead = (k: string) => (k === (order[0] ?? 'effects') ? { menu: copyPaste, defaultOpen: true } : {});
  const text = keys.has('size') && (
    <Section key="text" title="Text" {...lead('text')}>
      {extras.textTop}
      <TextFormatRows value={value} mixed={mixed} keys={keys} onChange={set} />
      {keys.has('valign') && (
        <Row label={`Vertical${hint('valign')}`}>
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
  );
  const fill = hasFillSection && (
    <Section key="fill" title="Fill" {...lead('fill')} summary={mixed.has('fillKind') ? 'mixed' : fillKind === 'none' ? 'none' : fillKind === 'gradient' ? 'gradient' : <ColourDot c={value.fill ?? ''} />}>
      {fillRows}
    </Section>
  );
  const line = hasLine && (
    <Section key="line" title={noun} {...lead('line')} summary={<>{!mixed.has('line') && <ColourDot c={value.line ?? ''} />}{!mixed.has('width') && value.width !== undefined && ` ${+value.width.toFixed(2)}px`}</>}>
      {lineRows}
      {extras.line}
    </Section>
  );
  const sections = { text, fill, line };
  return (
    <>
      {order.map((k) => sections[k as keyof typeof sections])}
      {keys.has('opacity') && (
        <Section title="Effects" {...lead('effects')} summary={[value.opacity !== undefined && value.opacity < 1 && `${Math.round(value.opacity * 100)}%`, value.shadow && 'shadow'].filter(Boolean).join(' · ') || undefined}>
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
