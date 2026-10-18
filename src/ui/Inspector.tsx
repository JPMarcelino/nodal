import {
  AlignCenterHorizontal,
  ChevronsDownUp,
  ChevronsUpDown,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDownToLine,
  ArrowUpToLine,
  BringToFront,
  FlipHorizontal2,
  FlipVertical2,
  Group,
  Lock,
  Pencil,
  RotateCcw,
  RotateCw,
  SendToBack,
  Ungroup,
  ExternalLink,
  Plus,
  X,
} from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { defaultHeadSize, frozenLabelOffsets, labelLook } from '../canvas/Scene';
import { SymbolPreview } from '../canvas/SymbolGraphic';
import { wireStyleFor } from '../model/wires';
import { computeNets, netOfWire } from '../model/netlist';
import { measureRich } from '../model/richText';
import { DNP, PART_FIELDS, customFieldKeys, hasPartFields, isDnp } from '../model/partFields';
import { getSymbol, stateSymbol } from '../model/registry';
import { gridScale } from '../model/symbols/scale';
import type { CircuitDoc, ComponentItem, LabelSide, LabelSpotName, LabelStyle, SymbolDef, Dash, DocSettings, HeadKind, SheetSettings, SheetSize, ShapeItem, WireItem, WireStyle } from '../model/types';
import { SHEET_SIZES, centredSheet, sheetOf, todayText } from '../model/sheet';
import { docBounds, selectedGroup } from '../model/doc';
import { scaleItems, selectionPivot } from '../model/ops';
import * as A from '../store/actions';
import { S, mutate, set, toast, useStore } from '../store/store';
import { ColorInput, Field, More, NumberInput, Section, Segmented, Slider, TextInput, Toggle, setFolds } from './controls';
import { ExplainShapePanel, FramePanel } from './ExplainInspector';
import { Row, StyleSection } from './StyleSection';
import { PanelResizer, usePanelWidth } from './PanelResizer';

/** Small sample of a line style (fits narrow panels better than words). */
function DashIcon({ dash }: { dash: Dash }) {
  return (
    <svg width={28} height={10} viewBox="0 0 28 10" style={{ display: 'block', margin: '0 auto' }}>
      <line x1={2} y1={5} x2={26} y2={5} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeDasharray={dash === 'dashed' ? '6 4' : dash === 'dotted' ? '0.01 4' : undefined} />
    </svg>
  );
}

const DASHES: { value: Dash; label: JSX.Element; title: string }[] = [
  { value: 'solid', label: <DashIcon dash="solid" />, title: 'Solid' },
  { value: 'dashed', label: <DashIcon dash="dashed" />, title: 'Dashed' },
  { value: 'dotted', label: <DashIcon dash="dotted" />, title: 'Dotted' },
];

const HEAD_TITLES: Record<HeadKind, string> = {
  none: 'None — plain end',
  open: 'Open — V arrowhead',
  filled: 'Solid — filled triangle',
  circle: 'Dot',
  bar: 'Bar — perpendicular tick',
};

/** Tiny preview of an arrowhead; `flip` points it left (for the start end). */
function HeadIcon({ kind, flip }: { kind: HeadKind; flip?: boolean }) {
  const head =
    kind === 'open' ? <path d="M15 2.5L20 6L15 9.5" fill="none" /> :
    kind === 'filled' ? <path d="M14.5 2.5L20.5 6L14.5 9.5Z" fill="currentColor" /> :
    kind === 'circle' ? <circle cx="18.5" cy="6" r="2.5" fill="currentColor" stroke="none" /> :
    kind === 'bar' ? <path d="M20 2v8" /> :
    null;
  return (
    <svg width={22} height={12} viewBox="0 0 22 12" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', margin: '0 auto', transform: flip ? 'scaleX(-1)' : undefined }}>
      <path d={`M2 6H${kind === 'filled' ? 16 : kind === 'circle' ? 17 : 20}`} />
      {head}
    </svg>
  );
}

const headOptions = (flip: boolean) =>
  (Object.keys(HEAD_TITLES) as HeadKind[]).map((k) => ({ value: k, label: <HeadIcon kind={k} flip={flip} />, title: HEAD_TITLES[k] }));

function ArrangeBar({ count, transform = true }: { count: number; transform?: boolean }) {
  return (
    <div className="arrange-bar">
      {transform && (
        <>
          <button title="Rotate counter-clockwise (Alt+R)" onClick={() => A.rotateSelection(-90)}>
            <RotateCcw size={15} />
          </button>
          <button title="Rotate clockwise (R)" onClick={() => A.rotateSelection(90)}>
            <RotateCw size={15} />
          </button>
          <button title="Flip horizontally (X)" onClick={() => A.flipSelection('x')}>
            <FlipHorizontal2 size={15} />
          </button>
          <button title="Flip vertically (Y)" onClick={() => A.flipSelection('y')}>
            <FlipVertical2 size={15} />
          </button>
          <span className="sep" />
        </>
      )}
      <button title="Bring to front (Ctrl+Shift+])" onClick={() => A.reorder('front')}>
        <BringToFront size={15} />
      </button>
      <button title="Bring forward (Ctrl+])" onClick={() => A.reorder('forward')}>
        <ArrowUpToLine size={15} />
      </button>
      <button title="Send backward (Ctrl+[)" onClick={() => A.reorder('backward')}>
        <ArrowDownToLine size={15} />
      </button>
      <button title="Send to back (Ctrl+Shift+[)" onClick={() => A.reorder('back')}>
        <SendToBack size={15} />
      </button>
      <span className="sep" />
      <button title="Group (Ctrl+G)" disabled={count < 2} onClick={A.groupSelection}>
        <Group size={15} />
      </button>
      <button title="Ungroup (Ctrl+Shift+G)" onClick={A.ungroupSelection}>
        <Ungroup size={15} />
      </button>
      <button title="Lock / unlock (Ctrl+Shift+L)" onClick={A.toggleLock}>
        <Lock size={15} />
      </button>
    </div>
  );
}

function AlignBar() {
  return (
    <div className="arrange-bar">
      <button title="Align left (Alt+←)" onClick={() => A.align('left')}>
        <AlignStartVertical size={15} />
      </button>
      <button title="Align centres horizontally (Alt+H)" onClick={() => A.align('hcenter')}>
        <AlignCenterVertical size={15} />
      </button>
      <button title="Align right (Alt+→)" onClick={() => A.align('right')}>
        <AlignEndVertical size={15} />
      </button>
      <button title="Align top (Alt+↑)" onClick={() => A.align('top')}>
        <AlignStartHorizontal size={15} />
      </button>
      <button title="Align centres vertically (Alt+V)" onClick={() => A.align('vcenter')}>
        <AlignCenterHorizontal size={15} />
      </button>
      <button title="Align bottom (Alt+↓)" onClick={() => A.align('bottom')}>
        <AlignEndHorizontal size={15} />
      </button>
      <span className="sep" />
      <button title="Distribute horizontally (Alt+Shift+H)" onClick={() => A.distribute('x')}>
        <AlignHorizontalDistributeCenter size={15} />
      </button>
      <button title="Distribute vertically (Alt+Shift+V)" onClick={() => A.distribute('y')}>
        <AlignVerticalDistributeCenter size={15} />
      </button>
    </div>
  );
}

/** `corners`: only the corner settings (colour, width and dash come from the Style section). */
function WireStyleEditor({ style, onChange, corners }: { style: WireStyle; onChange: (p: Partial<WireStyle>) => void; corners?: boolean }) {
  return (
    <>
      {!corners && (
        <>
          <Field label="Line colour">
            <ColorInput value={style.color} onChange={(color) => onChange({ color })} />
          </Field>
          <Field label="Line width">
            <NumberInput value={style.width} min={0.5} max={20} step={0.5} suffix="px" onChange={(width) => onChange({ width })} />
          </Field>
        </>
      )}
      <Field label="Corner radius" hint="0 for sharp corners">
        <NumberInput value={style.radius} min={0} max={60} suffix="px" onChange={(radius) => onChange({ radius })} />
      </Field>
      {!corners && (
        <Field label="Line style">
          <Segmented value={style.dash} options={DASHES} onChange={(dash) => onChange({ dash })} />
        </Field>
      )}
    </>
  );
}

/** Drawing frame: sheet size, orientation and title block fields. */
function SheetSection() {
  const doc = useStore((s) => s.doc);
  const on = doc.settings.titleBlock;
  const sheet = sheetOf(doc);
  const setSheet = (patch: Partial<SheetSettings>) => mutate((d) => void (d.settings.sheet = { ...sheetOf(d as CircuitDoc), ...patch }));
  const centre = (d: CircuitDoc) => {
    d.settings.sheet = { ...sheetOf(d), ...centredSheet(d.settings, docBounds(d)) };
  };
  return (
    <Section title="Drawing frame" defaultOpen={false} summary={on ? `${sheet.size} · ${sheet.orientation}` : 'off'}>
      <Field label="Frame & title block" hint="Sheet border with zone markers and a title block, used for printing and export">
        <Toggle
          checked={on}
          onChange={(v) => {
            mutate((d) => {
              d.settings.titleBlock = v;
              // first time on: put the sheet around the circuit
              if (v && !d.settings.sheet) centre(d as CircuitDoc);
            });
            if (v) setTimeout(() => A.fitView(), 0);
          }}
        />
      </Field>
      {on && (
        <>
          <Field label="Size">
            <select className="input" value={sheet.size} onChange={(e) => setSheet({ size: e.target.value as SheetSize })}>
              {Object.entries(SHEET_SIZES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label} · {v.w} × {v.h} mm
                </option>
              ))}
            </select>
          </Field>
          <Field label="Orientation">
            <Segmented
              value={sheet.orientation}
              options={[
                { value: 'landscape', label: 'Landscape' },
                { value: 'portrait', label: 'Portrait' },
              ]}
              onChange={(orientation) => setSheet({ orientation })}
            />
          </Field>
          <Field label="Company">
            <TextInput value={sheet.company} placeholder="Company or project" onChange={(company) => setSheet({ company })} />
          </Field>
          <Field label="Description">
            <TextInput value={sheet.description} placeholder="Shown in the title block" onChange={(description) => setSheet({ description })} />
          </Field>
          <Field label="Date">
            <TextInput value={sheet.date} placeholder={`Today (${todayText()})`} onChange={(date) => setSheet({ date })} />
          </Field>
          <Field label="Sheet">
            <TextInput value={sheet.sheetNo} placeholder="1 / 1" onChange={(sheetNo) => setSheet({ sheetNo })} />
          </Field>
          <Field label="Position">
            <span className="row-gap">
              <NumberInput value={sheet.x} step={10} suffix="x" onChange={(x) => setSheet({ x })} />
              <NumberInput value={sheet.y} step={10} suffix="y" onChange={(y) => setSheet({ y })} />
            </span>
          </Field>
          <button
            className="secondary-btn full"
            onClick={() => {
              mutate((d) => centre(d as CircuitDoc));
              setTimeout(() => A.fitView(), 0);
            }}
          >
            Centre the sheet on the circuit
          </button>
        </>
      )}
    </Section>
  );
}

function DocumentPanel() {
  const settings = useStore((s) => s.doc.settings);
  const items = useStore((s) => s.doc.items);
  const name = useStore((s) => s.doc.name);
  const upd = (fn: (s: DocSettings) => void) => mutate((d) => fn(d.settings));
  const brush = useStore((s) => s.wireBrush);
  const counts = useMemo(() => {
    const c = { component: 0, wire: 0, shape: 0, junction: 0 };
    for (const i of Object.values(items)) c[i.type]++;
    return c;
  }, [items]);
  return (
    <>
      <Section title="Circuit">
        <Field label="Name">
          <TextInput value={name} onChange={(v) => mutate((d) => void (d.name = v || 'Untitled circuit'))} />
        </Field>
        <Field label="Author">
          <TextInput value={settings.author} onChange={(v) => upd((s) => (s.author = v))} placeholder="Your name" />
        </Field>
        <Field label="Revision">
          <TextInput value={settings.revision} onChange={(v) => upd((s) => (s.revision = v))} />
        </Field>
        <div className="stats">
          <span>
            <b>{counts.component}</b> parts
          </span>
          <span>
            <b>{counts.wire}</b> wires
          </span>
          <span>
            <b>{counts.junction}</b> junctions
          </span>
          <span>
            <b>{counts.shape}</b> shapes
          </span>
        </div>
      </Section>
      <Section title="Default wire style" defaultOpen={false} summary={`${settings.wire.width}px · ${settings.hops === 'arc' ? 'hops' : settings.hops === 'gap' ? 'gaps' : 'no crossings'}`}>
        {brush && (
          <div className="btn-row">
            <span className="small">New wires use a picked style</span>
            <button className="secondary-btn" onClick={() => set({ wireBrush: null })}>
              Stop
            </button>
          </div>
        )}
        <WireStyleEditor style={settings.wire} onChange={(p) => upd((s) => Object.assign(s.wire, p))} />
        <Field label="Crossing style">
          <Segmented
            value={settings.hops}
            options={[
              { value: 'arc', label: 'Hop', title: 'Draw a small arc where wires cross' },
              { value: 'gap', label: 'Gap', title: 'Break the wire where it crosses' },
              { value: 'none', label: 'None', title: 'Wires cross with no marking' },
            ]}
            onChange={(hops) => upd((s) => (s.hops = hops))}
          />
        </Field>
        {settings.hops !== 'none' && (
          <Field label="Hop size">
            <NumberInput value={settings.hopSize} min={2} max={20} suffix="px" onChange={(v) => upd((s) => (s.hopSize = v))} />
          </Field>
        )}
        <Field label="Junction dot size">
          <NumberInput value={settings.junctionSize} min={1} max={12} step={0.5} suffix="px" onChange={(v) => upd((s) => (s.junctionSize = v))} />
        </Field>
        <button
          className="secondary-btn full"
          onClick={() => {
            mutate((d) => Object.values(d.items).forEach((i) => i.type === 'wire' && delete (i as WireItem).style));
            toast('All wires now use the default style');
          }}
        >
          Reset all wires to default style
        </button>
      </Section>
      <Section title="Show">
        <Field label="Part names">
          <Toggle checked={!settings.hideRefs} onChange={(v) => upd((s) => (s.hideRefs = !v))} />
        </Field>
        <Field label="Part values">
          <Toggle checked={!settings.hideValues} onChange={(v) => upd((s) => (s.hideValues = !v))} />
        </Field>
        <Field label="Wire names">
          <Toggle checked={!settings.hideWireLabels} onChange={(v) => upd((s) => (s.hideWireLabels = !v))} />
        </Field>
      </Section>
      <SheetSection />
      <Section title="Canvas (saved with this drawing)">
        <Field label="Grid">
          <NumberInput value={settings.grid} min={2} max={100} suffix="px" onChange={(v) => upd((s) => (s.grid = v))} />
        </Field>
        <Field label="Show grid">
          <Toggle checked={settings.showGrid} onChange={(v) => upd((s) => (s.showGrid = v))} />
        </Field>
        <Field label="Snap to grid">
          <Toggle checked={settings.snap} onChange={(v) => upd((s) => (s.snap = v))} />
        </Field>
        <Field label="Symbol colour">
          <ColorInput value={settings.componentColor} allowNone onChange={(v) => upd((s) => (s.componentColor = v))} />
        </Field>
        <Field label="Label colour">
          <ColorInput value={settings.labelColor} allowNone onChange={(v) => upd((s) => (s.labelColor = v))} />
        </Field>
        <Field label="Background">
          <ColorInput value={settings.background} allowNone onChange={(v) => upd((s) => (s.background = v))} />
        </Field>
      </Section>
      <div className="inspector-tip">
        Tip: select something to edit it. Press <kbd>?</kbd> for all shortcuts, <kbd>Ctrl+K</kbd> for the command palette.
      </div>
    </>
  );
}

/** Footprint, sourcing, DNP and the user's own fields of a part. */
function PartDetails({ c }: { c: ComponentItem }) {
  const doc = useStore((s) => s.doc);
  const def = getSymbol(doc, c.symbol);
  const upd = (fn: (c: ComponentItem) => void) => mutate((d) => fn(d.items[c.id] as ComponentItem));
  const [adding, setAdding] = useState(false);
  const custom = customFieldKeys(c, def);
  const setProp = (k: string, v: string) =>
    upd((x) => {
      if (v.trim()) x.props[k] = v.trim();
      else delete x.props[k];
    });
  const addField = (name: string) => {
    const k = name.trim();
    setAdding(false);
    if (!k) return;
    if (k in c.props || PART_FIELDS.some((f) => f.label.toLowerCase() === k.toLowerCase())) return toast(`“${k}” is already a field of this part`);
    upd((x) => (x.props[k] = ''));
  };
  const datasheet = c.props.datasheet?.trim();
  const filled = PART_FIELDS.filter((f) => c.props[f.key]?.trim()).length + custom.filter((k) => c.props[k]?.trim()).length;
  return (
    <Section title="Part details" defaultOpen={false} summary={[filled ? `${filled} filled` : 'empty', isDnp(c) && 'DNP'].filter(Boolean).join(' · ')}>
      {PART_FIELDS.map((f) => (
        <Field key={f.key} label={f.label}>
          <TextInput value={c.props[f.key] ?? ''} placeholder={f.placeholder} onChange={(v) => setProp(f.key, v)} />
          {f.key === 'datasheet' && datasheet && /^(https?:\/\/|www\.)/i.test(datasheet) && (
            <a className="icon-btn field-link" href={/^www\./i.test(datasheet) ? `https://${datasheet}` : datasheet} target="_blank" rel="noreferrer" title="Open datasheet">
              <ExternalLink size={14} />
            </a>
          )}
        </Field>
      ))}
      {custom.map((k) => (
        <Field key={k} label={k}>
          <TextInput value={c.props[k] ?? ''} onChange={(v) => upd((x) => (x.props[k] = v))} />
          <button className="icon-btn field-link" title={`Remove the “${k}” field`} onClick={() => upd((x) => delete x.props[k])}>
            <X size={14} />
          </button>
        </Field>
      ))}
      {adding ? (
        <Field label="New field">
          <input
            className="input"
            autoFocus
            placeholder="Name, e.g. Tolerance"
            onBlur={(e) => addField(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addField((e.target as HTMLInputElement).value);
              if (e.key === 'Escape') setAdding(false);
            }}
          />
        </Field>
      ) : (
        <button className="link-btn add-field" onClick={() => setAdding(true)}>
          <Plus size={12} /> Add field
        </button>
      )}
      <Field label="Do not populate" hint="Keep the part in the drawing but leave it off the board and out of the BOM quantities">
        <Toggle checked={isDnp(c)} onChange={(v) => upd((x) => (v ? (x.props[DNP] = '1') : delete x.props[DNP]))} />
      </Field>
    </Section>
  );
}

const SPOTS: { value: LabelSpotName | ''; label: string }[] = [
  { value: '', label: 'Automatic' },
  { value: 'split', label: 'Name above, value below' },
  { value: 'above', label: 'Both above' },
  { value: 'below', label: 'Both below' },
  { value: 'right', label: 'Both right' },
  { value: 'left', label: 'Both left' },
  { value: 'topRight', label: 'Top right corner' },
  { value: 'topLeft', label: 'Top left corner' },
  { value: 'bottomRight', label: 'Bottom right corner' },
  { value: 'bottomLeft', label: 'Bottom left corner' },
];

const HIDDEN_HINT = 'Hidden for the whole drawing — turn on in View';

/** Placement and per-label text styling of a part's reference and value. */
function LabelSection({ c, def }: { c: ComponentItem; def: SymbolDef }) {
  const [tab, setTab] = useState<'ref' | 'value'>('ref');
  const which = def.valueIsLabel ? 'value' : tab;
  const key = which === 'ref' ? 'refStyle' : 'valueStyle';
  const st: LabelStyle = c[key] ?? {};
  const look = labelLook(c, which, def);
  const upd = (fn: (c: ComponentItem) => void) => mutate((d) => fn(d.items[c.id] as ComponentItem));
  const docSettings = useStore((s) => s.doc.settings);
  const refOff = !!docSettings.hideRefs;
  const valueOff = !!docSettings.hideValues && !def.valueIsLabel;
  const setStyle = (patch: Partial<LabelStyle>) =>
    upd((x) => {
      const next: LabelStyle = { ...x[key], ...patch };
      for (const k of Object.keys(next) as (keyof LabelStyle)[]) if (next[k] === undefined || next[k] === '') delete next[k];
      if (Object.keys(next).length) x[key] = next;
      else delete x[key];
    });
  const moved = c.labelDx != null || c.labelDy != null || c.valueDx != null || c.valueDy != null;
  const off = which === 'ref' ? { x: c.labelDx ?? 0, y: c.labelDy ?? 0 } : { x: c.valueDx ?? c.labelDx ?? 0, y: c.valueDy ?? c.labelDy ?? 0 };
  const setOffset = (axis: 'x' | 'y', v: number) =>
    upd((x) => {
      // pin both labels where they are drawn now, then move just this one
      Object.assign(x, frozenLabelOffsets(x, def));
      if (which === 'ref') x[axis === 'x' ? 'labelDx' : 'labelDy'] = v;
      else x[axis === 'x' ? 'valueDx' : 'valueDy'] = v;
    });
  const rot = st.rotate ?? 0;
  const advanced = [st.font, st.opacity, st.align, st.rotate, st.backdrop, st.prefix, st.suffix, off.x || undefined, off.y || undefined].filter((v) => v !== undefined).length;
  const spotName = SPOTS.find((o) => o.value === (c.labelSpot ?? ''))!.label;
  const shownNames = def.valueIsLabel ? (c.showValue ? 'shown' : 'hidden') : [c.showRef && 'name', c.showValue && 'value'].filter(Boolean).join(' + ') || 'hidden';
  return (
    <Section
      title="Labels"
      summary={def.valueIsLabel ? shownNames : `${shownNames} · ${spotName.toLowerCase()}`}
      actions={
        (c.refStyle || c.valueStyle || moved || c.labelSpot) && (
          <button
            className="link-btn"
            title="Put both labels back in their default spots with the default look"
            onClick={() =>
              upd((x) => {
                for (const k of ['refStyle', 'valueStyle', 'labelSpot', 'labelDx', 'labelDy', 'valueDx', 'valueDy'] as const) delete x[k];
              })
            }
          >
            <RotateCcw size={11} /> Reset
          </button>
        )
      }
    >
      {def.valueIsLabel ? (
        <Field label="Show name" hint="Hide the name on the canvas; the label still joins the net">
          <Toggle checked={c.showValue} onChange={(v) => upd((x) => (x.showValue = v))} />
        </Field>
      ) : (
        <>
          <Field label="Show" hint={refOff || valueOff ? HIDDEN_HINT : undefined}>
            <span className="row-gap wrap">
              <Toggle checked={c.showRef} disabled={refOff} onChange={(v) => upd((x) => (x.showRef = v))} label="Name" />
              <Toggle checked={c.showValue} disabled={valueOff} onChange={(v) => upd((x) => (x.showValue = v))} label="Value" />
            </span>
            {(refOff || valueOff) && <span className="muted small">{HIDDEN_HINT}</span>}
          </Field>
          <Field label="Placement" hint="Where the name and value sit around the part; dragging a label fine-tunes it">
            <select
              className="input"
              value={c.labelSpot ?? ''}
              onChange={(e) =>
                upd((x) => {
                  const v = e.target.value as LabelSpotName | '';
                  if (v) x.labelSpot = v;
                  else delete x.labelSpot;
                  delete x.labelDx;
                  delete x.labelDy;
                  delete x.valueDx;
                  delete x.valueDy;
                })
              }
            >
              {SPOTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="label-tabs" role="tablist" aria-label="Label to style">
            {(['ref', 'value'] as const).map((w) => (
              <button key={w} type="button" role="tab" aria-selected={tab === w} className={tab === w ? 'active' : ''} onClick={() => setTab(w)}>
                <span className="label-tab-name">{w === 'ref' ? 'Name' : 'Value'}</span>
                <span className="label-tab-text">{(w === 'ref' ? c.ref : c.value) || '—'}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <Field label="Size, colour">
        <span className="row-gap">
          <NumberInput value={look.size} min={4} max={96} step={0.5} suffix="pt" onChange={(size) => setStyle({ size })} />
          <ColorInput value={st.color ?? ''} allowNone onChange={(color) => setStyle({ color: color || undefined })} />
        </span>
      </Field>
      <Field label="Emphasis">
        <span className="type-buttons">
          {(
            [
              ['bold', 'B', 'Bold', look.weight >= 600],
              ['italic', 'I', 'Italic', !!st.italic],
              ['underline', 'U', 'Underline', !!st.underline],
              ['allCaps', 'AA', 'All caps', !!st.allCaps],
            ] as const
          ).map(([k, glyph, name, on]) => (
            <button
              key={k}
              type="button"
              className={`type-btn ${k}${on ? ' active' : ''}`}
              title={name}
              aria-pressed={on}
              onClick={() => setStyle({ [k]: k === 'bold' ? !on : !on || undefined })}
            >
              {glyph}
            </button>
          ))}
        </span>
      </Field>
      <More id="labels" count={advanced}>
        <Field label="Font">
          <Segmented
            value={st.font ?? ''}
            options={[
              { value: '', label: 'Sans' },
              { value: 'serif', label: 'Serif' },
              { value: 'mono', label: 'Mono' },
            ]}
            onChange={(v) => setStyle({ font: v || undefined })}
          />
        </Field>
        <Field label="Align">
          <Segmented
            value={st.align ?? ''}
            options={[
              { value: '', label: 'Auto' },
              { value: 'start', label: 'Left' },
              { value: 'middle', label: 'Centre' },
              { value: 'end', label: 'Right' },
            ]}
            onChange={(v) => setStyle({ align: v || undefined })}
          />
        </Field>
        <Field label="Rotation">
          <span className="row-gap">
            <Segmented value={rot} options={[0, 90, -90].map((r) => ({ value: r, label: `${r}°` }))} onChange={(r) => setStyle({ rotate: r || undefined })} />
            <NumberInput value={rot} min={-360} max={360} step={15} suffix="°" onChange={(r) => setStyle({ rotate: r || undefined })} />
          </span>
        </Field>
        <Field label="Opacity">
          <span className="row-gap">
            <Slider value={st.opacity ?? 1} min={0.1} max={1} onChange={(v) => setStyle({ opacity: v >= 1 ? undefined : v })} />
            <span className="mono small">{Math.round((st.opacity ?? 1) * 100)}%</span>
          </span>
        </Field>
        <Field label="Backdrop" hint="Paint the canvas colour behind the text so it stays legible over wires">
          <Toggle checked={!!st.backdrop} onChange={(v) => setStyle({ backdrop: v || undefined })} />
        </Field>
        <Field label="Before / after" hint="Extra text drawn around the label only, e.g. “R = ” or “ ±5%”">
          <span className="row-gap">
            <TextInput value={st.prefix ?? ''} placeholder="prefix" onChange={(prefix) => setStyle({ prefix })} />
            <TextInput value={st.suffix ?? ''} placeholder="suffix" onChange={(suffix) => setStyle({ suffix })} />
          </span>
        </Field>
        <Field label="Nudge" hint="Shift of this label from its spot; arrow keys step, Shift steps ×10. Or drag the label on the canvas">
          <span className="row-gap">
            <NumberInput value={off.x} step={1} suffix="x" onChange={(v) => setOffset('x', v)} />
            <NumberInput value={off.y} step={1} suffix="y" onChange={(v) => setOffset('y', v)} />
          </span>
        </Field>
      </More>
      <div className="section-note">Double-click a label on the canvas to edit its text; drag it to move it.</div>
    </Section>
  );
}

function ComponentPanel({ c }: { c: ComponentItem }) {
  const doc = useStore((s) => s.doc);
  const def = getSymbol(doc, c.symbol);
  const upd = (fn: (c: ComponentItem) => void) => mutate((d) => fn(d.items[c.id] as ComponentItem));
  const nets = useMemo(() => computeNets(doc), [doc]);
  return (
    <>
      <div className="comp-header">
        <div className="comp-preview">
          <SymbolPreview def={stateSymbol(def, c)} size={64} ports />
        </div>
        <div>
          <div className="comp-title">{def.valueIsLabel ? c.value : c.ref}</div>
          <div className="comp-sub">{def.name}</div>
          <button className="link-btn" onClick={() => set({ dialog: 'symbol-editor', editingSymbol: def.id })}>
            <Pencil size={11} /> {def.custom ? 'Edit symbol' : 'Customise symbol'}
          </button>
        </div>
      </div>
      <ArrangeBar count={1} />
      <Section title="Properties" summary={[!def.valueIsLabel && c.ref, c.value].filter(Boolean).join(' · ')}>
        {!def.valueIsLabel && (
          <Field label="Name">
            <TextInput value={c.ref} onChange={(v) => upd((x) => (x.ref = v))} />
          </Field>
        )}
        <Field label={def.valueIsLabel ? 'Net name' : 'Value'} hint="Supports maths, e.g. $R_{load}$ or $\SI{10}{\kilo\ohm}$">
          <TextInput value={c.value} focusKey="value" onChange={(v) => upd((x) => (x.value = v))} />
        </Field>
        {(def.fields ?? []).map((f) => (
          <Field key={f.key} label={f.label}>
            <TextInput value={c.props[f.key] ?? ''} placeholder={f.default} onChange={(v) => upd((x) => (x.props[f.key] = v))} />
          </Field>
        ))}
        {def.closedPrims && (
          <Field label="Closed" hint="Draw the switch closed instead of open">
            <Toggle checked={!!c.closed} onChange={(v) => upd((x) => (v ? (x.closed = true) : delete x.closed))} />
          </Field>
        )}
      </Section>
      <LabelSection c={c} def={def} />
      <Section title="Transform" summary={`${c.rot}°${c.flipX ? ' · flipped' : ''}${c.scale && c.scale !== 1 ? ` · ×${c.scale}` : ''}`}>
        <Field label="Rotation">
          <Segmented
            value={c.rot}
            options={[0, 90, 180, 270].map((r) => ({ value: r as ComponentItem['rot'], label: `${r}°` }))}
            onChange={(rot) => upd((x) => (x.rot = rot))}
          />
        </Field>
        <Field label="Flipped">
          <Toggle checked={!!c.flipX} onChange={(v) => upd((x) => (x.flipX = v))} />
        </Field>
        <SizeField ids={[c.id]} />
        <Field label="Position">
          <span className="row-gap">
            <NumberInput value={c.x} step={doc.settings.grid} suffix="x" onChange={(v) => upd((x) => (x.x = v))} />
            <NumberInput value={c.y} step={doc.settings.grid} suffix="y" onChange={(v) => upd((x) => (x.y = v))} />
          </span>
        </Field>
      </Section>
      <StyleSection ids={[c.id]} />
      {hasPartFields(def) && <PartDetails c={c} />}
      {def.ports.length > 0 && (
        <Section
          title={`Pins (${def.ports.length})`}
          defaultOpen={false}
          summary={`${def.ports.filter((p) => nets.some((n) => (n.pins.length > 1 || n.wires.length > 0) && n.pins.some((pin) => pin.comp === c.id && pin.port === p.id))).length} connected`}
        >
          <div className="pin-list">
            {def.ports.map((p) => {
              const net = nets.find((n) => n.pins.some((pin) => pin.comp === c.id && pin.port === p.id));
              const connected = net && (net.pins.length > 1 || net.wires.length > 0);
              return (
                <div key={p.id} className="pin-row">
                  <span className={connected ? 'pin-dot on' : 'pin-dot'} />
                  <span className="pin-name">{p.name}</span>
                  <span className="pin-net">{connected ? net!.name : 'unconnected'}</span>
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </>
  );
}

function WirePanel({ wires }: { wires: WireItem[] }) {
  const doc = useStore((s) => s.doc);
  const brush = useStore((s) => s.wireBrush);
  const wireLabelsOff = useStore((s) => !!s.doc.settings.hideWireLabels);
  const first = wires[0];
  const style = wireStyleFor(doc.settings, first);
  const ids = wires.map((w) => w.id);
  const upd = (p: Partial<WireStyle>) => mutate((d) => ids.forEach((id) => ((d.items[id] as WireItem).style = { ...(d.items[id] as WireItem).style, ...p })));
  const net = useMemo(() => netOfWire(computeNets(doc), first.id), [doc, first.id]);
  const updLabel = (fn: (w: WireItem) => void) => mutate((d) => fn(d.items[first.id] as WireItem));
  return (
    <>
      <div className="panel-title">
        {wires.length > 1 ? `${wires.length} wires` : 'Wire'}
        {net && <span className="net-chip">net {net.name}</span>}
      </div>
      <Section title="Style">
        <WireStyleEditor style={style} onChange={upd} />
        <Field label="At crossings" hint="Which wire hops over at crossings. For a single crossing, rest the pointer on it to choose, or to solder it">
          <Segmented
            value={!first.hopLayer ? 0 : first.hopLayer > 0 ? 1 : -1}
            options={[
              { value: 1, label: 'Hop over', title: 'Hop over every other wire' },
              { value: 0, label: 'Auto', title: 'Horizontal segments hop over vertical ones' },
              { value: -1, label: 'Go under', title: 'Let every other wire hop over' },
            ]}
            onChange={(v) =>
              mutate((d) => {
                const layers = Object.values(d.items).flatMap((it) => (it.type === 'wire' && !ids.includes(it.id) && it.hopLayer ? [it.hopLayer] : []));
                const layer = v > 0 ? Math.max(0, ...layers) + 1 : v < 0 ? Math.min(0, ...layers) - 1 : 0;
                for (const id of ids) {
                  const w = d.items[id] as WireItem;
                  if (layer) w.hopLayer = layer;
                  else delete w.hopLayer;
                }
              })
            }
          />
        </Field>
        <div className="btn-row">
          <button className="secondary-btn" onClick={() => mutate((d) => ids.forEach((id) => delete (d.items[id] as WireItem).style))}>
            Use default
          </button>
          <button
            className={brush ? 'secondary-btn active' : 'secondary-btn'}
            title="New wires will be drawn with this style"
            onClick={() => {
              set({ wireBrush: brush ? null : { ...first.style } });
              toast(brush ? 'New wires use the default style' : 'New wires will use this style');
            }}
          >
            {brush ? 'Stop using for new wires' : 'Use for new wires'}
          </button>
        </div>
        <button
          className="secondary-btn full"
          onClick={() => {
            if (!net) return;
            mutate((d) => net.wires.forEach((id) => d.items[id] && ((d.items[id] as WireItem).style = { ...first.style })));
            toast(`Applied to all ${net.wires.length} wires of net ${net.name}`);
          }}
        >
          Apply style to whole net
        </button>
      </Section>
      {wires.length === 1 && (
        <Section title="Label">
          <Field label="Text" hint="Supports maths, e.g. $V_{CC}$">
            <TextInput value={first.label ?? ''} focusKey="value" placeholder="e.g. SDA, 5V, CLK" onChange={(v) => mutate((d) => void ((d.items[first.id] as WireItem).label = v || undefined))} />
          </Field>
          {first.label && (
            <>
              <Field label="Show on canvas" hint={wireLabelsOff ? HIDDEN_HINT : 'A hidden label still names the net in Find and in the lists'}>
                <Toggle checked={!first.labelHidden} disabled={wireLabelsOff} onChange={(v) => updLabel((x) => (v ? delete x.labelHidden : (x.labelHidden = true)))} />
                {wireLabelsOff && <span className="muted small">{HIDDEN_HINT}</span>}
              </Field>
              {!first.labelHidden && (
                <>
                  <Field label="Side">
                    <Segmented
                      value={first.labelSide ?? 'auto'}
                      options={[
                        { value: 'auto', label: 'Auto', title: 'Above horizontal runs, right of vertical ones' },
                        { value: 'above', label: '↑', title: 'Above' },
                        { value: 'below', label: '↓', title: 'Below' },
                        { value: 'left', label: '←', title: 'Left' },
                        { value: 'right', label: '→', title: 'Right' },
                      ]}
                      onChange={(v) => updLabel((x) => (v === 'auto' ? delete x.labelSide : (x.labelSide = v as LabelSide)))}
                    />
                  </Field>
                  <Field label="Along wire" hint="Or drag the label on the canvas — onto any wire of the net, on either side">
                    <span className="row-gap">
                      <Slider value={first.labelAt ?? 0.5} min={0} max={1} step={0.01} onChange={(v) => updLabel((x) => (x.labelAt = v))} />
                      {first.labelAt !== undefined && (
                        <button className="link-btn" title="Back to the middle of the longest segment" onClick={() => updLabel((x) => delete x.labelAt)}>
                          Reset
                        </button>
                      )}
                    </span>
                  </Field>
                </>
              )}
            </>
          )}
        </Section>
      )}
      {net && (
        <Section title="Net">
          <div className="pin-list">
            {net.pins.map((p) => (
              <div key={`${p.comp}:${p.port}`} className="pin-row">
                <span className="pin-dot on" />
                <span className="pin-name">{p.ref}</span>
                <span className="pin-net">pin {p.portName}</span>
              </div>
            ))}
            {!net.pins.length && <div className="empty-note small">No component pins on this net yet.</div>}
          </div>
          <div className="btn-row">
            <button className="secondary-btn" onClick={() => set({ selection: net.wires })}>
              Select net
            </button>
            <button className="secondary-btn" onClick={() => set({ highlight: S().highlight ? null : new Set(net.wires) })}>
              Highlight (N)
            </button>
          </div>
        </Section>
      )}
    </>
  );
}

function ShapePanel({ shapes }: { shapes: ShapeItem[] }) {
  const first = shapes[0];
  const ids = shapes.map((s) => s.id);
  const upd = (fn: (s: ShapeItem) => void) =>
    mutate((d) =>
      ids.forEach((id) => {
        const s = d.items[id] as ShapeItem;
        fn(s);
        if (s.kind === 'text') Object.assign(s, measureRich(s.text ?? '', s.fontSize ?? 16, s.bold ? 700 : 400));
      }),
    );
  const isText = first.kind === 'text';
  const isLine = first.kind === 'line' || first.kind === 'arrow';
  const isImage = first.kind === 'image';
  const title = { rect: 'Rectangle', zone: 'Filled zone', ellipse: 'Ellipse', polygon: 'Polygon', line: 'Line', arrow: 'Arrow', text: 'Text', image: 'Image', ink: 'Ink', callout: 'Callout', frame: 'Frame' }[first.kind];
  return (
    <>
      <div className="panel-title">{shapes.length > 1 ? `${shapes.length} shapes` : title}</div>
      <ArrangeBar count={shapes.length} transform={false} />
      {!isImage && (
        <Section title={isText ? 'Text' : 'Label'}>
          <Field label={isText ? 'Content' : 'Title'} wide hint="Supports maths: $…$ inline, $$…$$ display, \$ for a dollar sign">
            <TextInput value={first.text ?? ''} multiline={isText} focusKey="value" onChange={(v) => upd((s) => (s.text = v))} placeholder={isText ? '' : 'Optional title'} />
          </Field>
          <Field label="Font size">
            <NumberInput value={first.fontSize ?? (isText ? 16 : 13)} min={6} max={120} suffix="px" onChange={(v) => upd((s) => (s.fontSize = v))} />
          </Field>
          <Field label="Bold">
            <Toggle checked={first.bold ?? !(isText || isLine)} onChange={(v) => upd((s) => (s.bold = v))} />
          </Field>
          <Field label="Text colour">
            <ColorInput value={first.textColor ?? ''} allowNone onChange={(v) => upd((s) => (s.textColor = v || undefined))} />
          </Field>
          {!isText && first.kind !== 'line' && first.kind !== 'arrow' && (
            <Field label="Position" hint="Select the shape, then drag its title — inside it or just outside the edge">
              <button
                className="secondary-btn"
                disabled={!first.textDx && !first.textDy}
                onClick={() =>
                  upd((s) => {
                    delete s.textDx;
                    delete s.textDy;
                  })
                }
              >
                Reset
              </button>
            </Field>
          )}
        </Section>
      )}
      {!isText && (
        <Section title={isImage ? 'Border' : 'Line'}>
          <Field label="Line colour">
            <ColorInput value={first.stroke} onChange={(v) => upd((s) => (s.stroke = v))} />
          </Field>
          <Field label="Line width">
            <NumberInput value={first.strokeWidth} min={0} max={30} step={0.5} suffix="px" onChange={(v) => upd((s) => (s.strokeWidth = v))} />
          </Field>
          <Field label="Line style">
            <Segmented value={first.dash} options={DASHES} onChange={(v) => upd((s) => (s.dash = v))} />
          </Field>
          {isLine && (
            <>
              <Field label="Start">
                <Segmented value={first.headStart ?? 'none'} options={headOptions(true)} onChange={(v) => upd((s) => (s.headStart = v))} />
              </Field>
              <Field label="End">
                <Segmented value={first.headEnd ?? (first.kind === 'arrow' ? 'open' : 'none')} options={headOptions(false)} onChange={(v) => upd((s) => (s.headEnd = v))} />
              </Field>
              <Field label="Head size">
                <NumberInput value={first.headSize ?? defaultHeadSize(first.strokeWidth)} min={2} max={80} suffix="px" onChange={(v) => upd((s) => (s.headSize = v))} />
              </Field>
            </>
          )}
          {(first.kind === 'rect' || first.kind === 'zone') && (
            <Field label="Corner radius">
              <NumberInput value={first.radius} min={0} max={200} suffix="px" onChange={(v) => upd((s) => (s.radius = v))} />
            </Field>
          )}
        </Section>
      )}
      {!isLine && !isImage && (
        <Section title="Fill">
          <Field label="Fill colour">
            <ColorInput value={first.fill === 'none' ? '' : first.fill} allowNone onChange={(v) => upd((s) => ((s.fill = v || 'none'), v && s.fillOpacity === 0 && (s.fillOpacity = 0.15)))} />
          </Field>
          <Field label="Fill opacity">
            <span className="row-gap">
              <Slider value={first.fillOpacity} min={0} max={1} onChange={(v) => upd((s) => (s.fillOpacity = v))} />
              <span className="mono small">{Math.round(first.fillOpacity * 100)}%</span>
            </span>
          </Field>
        </Section>
      )}
      {shapes.length === 1 && !isText && (
        <Section title="Geometry">
          <Field label="Position">
            <span className="row-gap">
              <NumberInput value={first.x} suffix="x" onChange={(v) => upd((s) => (s.x = v))} />
              <NumberInput value={first.y} suffix="y" onChange={(v) => upd((s) => (s.y = v))} />
            </span>
          </Field>
          <Field label="Size">
            <span className="row-gap">
              <NumberInput value={first.w} suffix="w" onChange={(v) => upd((s) => (s.w = v))} />
              <NumberInput value={first.h} suffix="h" onChange={(v) => upd((s) => (s.h = v))} />
            </span>
          </Field>
        </Section>
      )}
    </>
  );
}

const SIZES = [0.5, 0.75, 1, 1.5, 2];

/** Size of parts: the drawing, pins and text scale together, line widths don't. */
function SizeField({ ids }: { ids: string[] }) {
  const doc = useStore((s) => s.doc);
  const comps = ids.map((id) => doc.items[id]).filter((i): i is ComponentItem => i?.type === 'component');
  if (!comps.length) return null;
  const k = comps[0].scale ?? 1;
  const same = comps.every((c) => (c.scale ?? 1) === k);
  const setK = (v: number) => {
    const s = Math.min(10, Math.max(0.1, v));
    if (ids.length > 1) {
      // several items (a group): resize them as one, so every part grows alike and the layout spreads with it
      const base = S().doc;
      mutate((d) => void scaleItems(base, d as CircuitDoc, new Set(ids), s / k, selectionPivot(base, ids)));
      return;
    }
    mutate((d) =>
      comps.forEach((c) => {
        // a lone part snaps to the nearest size that keeps its pins on the grid
        const k = gridScale(getSymbol(d, c.symbol), s);
        (d.items[c.id] as ComponentItem).scale = k === 1 ? undefined : k;
      }),
    );
  };
  return (
    <Row
      label={same ? 'Size' : 'Size (mixed)'}
      hint={
        ids.length > 1
          ? 'Resizes the selection as one: every part, text and the spacing between them grow alike (relative to the first part’s size); line widths stay the same. Drag a corner of the selection on the canvas too'
          : 'Scales the drawing, its pins and text; line widths stay the same. Snaps to the nearest size that keeps every pin on the grid. Drag a corner handle on the canvas too'
      }
    >
      <span className="row-gap wrap">
        <Segmented value={same && SIZES.includes(k) ? k : -1} options={SIZES.map((v) => ({ value: v, label: `${v * 100}%` }))} onChange={setK} />
        <NumberInput value={Math.round(k * 100)} min={10} max={1000} step={5} suffix="%" onChange={(v) => setK(v / 100)} />
      </span>
    </Row>
  );
}

function MultiPanel({ ids }: { ids: string[] }) {
  const doc = useStore((s) => s.doc);
  const scope = useStore((s) => s.scope);
  const group = selectedGroup(doc, ids, scope);
  const items = ids.map((id) => doc.items[id]).filter(Boolean);
  const comps = items.filter((i): i is ComponentItem => i.type === 'component');
  const wires = items.filter((i): i is WireItem => i.type === 'wire');
  const shapes = items.filter((i): i is ShapeItem => i.type === 'shape');
  return (
    <>
      {group ? (
        <div className="panel-title">
          Group <span className="net-chip">{doc.groups[group].name}</span>
        </div>
      ) : (
        <div className="panel-title">{items.length} items selected</div>
      )}
      {group && (
        <Section title="Group" summary={doc.groups[group].name}>
          <Field label="Name" hint="Shown faintly above the group on the canvas; double-click it there to rename too">
            <TextInput value={doc.groups[group].name} focusKey="groupName" placeholder="Group name" onChange={(v) => A.renameGroup(group, v)} />
          </Field>
          <div className="btn-row">
            <button className="secondary-btn" onClick={() => A.enterGroup(ids[0])}>
              Enter group
            </button>
            <button className="secondary-btn" onClick={() => A.ungroupSelection()}>
              Ungroup
            </button>
          </div>
        </Section>
      )}
      <div className="stats">
        {comps.length > 0 && (
          <span>
            <b>{comps.length}</b> parts
          </span>
        )}
        {wires.length > 0 && (
          <span>
            <b>{wires.length}</b> wires
          </span>
        )}
        {shapes.length > 0 && (
          <span>
            <b>{shapes.length}</b> shapes
          </span>
        )}
      </div>
      <ArrangeBar count={items.length} />
      <Section title="Align & distribute">
        <AlignBar />
      </Section>
      <StyleSection ids={ids} title={`Style · ${items.length} items`} />
      {comps.length > 0 && (
        <Section title="Parts">
          <SizeField ids={ids} />
        </Section>
      )}
      {wires.length > 0 && (
        <Section title="Wire corners">
          <WireStyleEditor
            style={wireStyleFor(doc.settings, wires[0])}
            corners
            onChange={(p) => mutate((d) => wires.forEach((w) => ((d.items[w.id] as WireItem).style = { ...(d.items[w.id] as WireItem).style, ...p })))}
          />
        </Section>
      )}
    </>
  );
}

interface NavEntry {
  id: string;
  title: string;
  open: boolean;
}

/** Chips that jump to (and unfold) each section of the panel, highlighting the one in view. */
function SectionNav({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement> }) {
  const [list, setList] = useState<NavEntry[]>([]);
  const [active, setActive] = useState('');
  // after a jump, keep the chosen chip lit while the smooth scroll settles
  const pinned = useRef(0);
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const sections = () => [...root.querySelectorAll<HTMLElement>('.section[data-section]')];
    const spy = () => {
      if (performance.now() < pinned.current) return;
      const all = sections();
      const atEnd = root.scrollTop + root.clientHeight >= root.scrollHeight - 4;
      const top = root.getBoundingClientRect().top + 12;
      let cur = all[0];
      for (const el of all) if (el.getBoundingClientRect().top <= top) cur = el;
      if (atEnd && root.scrollTop > 0) cur = all[all.length - 1];
      setActive(cur?.dataset.section ?? '');
    };
    const read = () => {
      const next = sections().map((el) => ({ id: el.dataset.section!, title: el.dataset.title!, open: !el.classList.contains('folded') }));
      setList((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      spy();
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-title'] });
    root.addEventListener('scroll', spy, { passive: true });
    return () => {
      mo.disconnect();
      root.removeEventListener('scroll', spy);
    };
  }, [scrollRef]);
  if (list.length < 3) return null;
  const anyOpen = list.some((e) => e.open);
  const go = (id: string) => {
    setActive(id);
    pinned.current = performance.now() + 800;
    setFolds({ [`s:${id}`]: true });
    requestAnimationFrame(() => {
      const root = scrollRef.current;
      const el = root?.querySelector<HTMLElement>(`.section[data-section="${CSS.escape(id)}"]`);
      if (root && el) root.scrollTo({ top: el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 2, behavior: 'smooth' });
    });
  };
  return (
    <nav className="section-nav" aria-label="Panel sections">
      <div className="section-chips">
        {list.map((e) => (
          <button key={e.id} type="button" className={`section-chip${e.id === active ? ' active' : ''}${e.open ? '' : ' folded'}`} title={e.open ? `Go to ${e.title}` : `Show ${e.title}`} onClick={() => go(e.id)}>
            {e.title}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="icon-btn"
        title={anyOpen ? 'Fold all sections' : 'Unfold all sections'}
        onClick={() => setFolds(Object.fromEntries(list.map((e) => [`s:${e.id}`, !anyOpen])))}
      >
        {anyOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
      </button>
    </nav>
  );
}

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const doc = useStore((s) => s.doc);
  const items = selection.map((id) => doc.items[id]).filter(Boolean);
  const width = usePanelWidth('right', useStore((s) => s.prefs.rightWidth));
  const scrollRef = useRef<HTMLDivElement>(null);
  let body: JSX.Element;
  if (!items.length) body = <DocumentPanel />;
  else if (items.length === 1 && items[0].type === 'component') body = <ComponentPanel c={items[0]} />;
  else if (items.every((i) => i.type === 'wire' || i.type === 'junction') && items.some((i) => i.type === 'wire'))
    body = <WirePanel wires={items.filter((i): i is WireItem => i.type === 'wire')} />;
  else if (items.every((i) => i.type === 'shape' && i.kind === 'frame')) body = <FramePanel shapes={items as ShapeItem[]} />;
  else if (items.every((i) => i.type === 'shape' && (i.kind === 'ink' || i.kind === 'callout'))) body = <ExplainShapePanel shapes={items as ShapeItem[]} />;
  else if (items.every((i) => i.type === 'shape')) body = <ShapePanel shapes={items as ShapeItem[]} />;
  else if (items.length === 1 && items[0].type === 'junction') body = <div className="panel-title">Junction</div>;
  else body = <MultiPanel ids={selection} />;
  return (
    <aside className="panel right-panel" style={{ width }}>
      <PanelResizer side="right" />
      <div className="tabs">
        <button className="active">{items.length ? 'Properties' : 'Document'}</button>
      </div>
      <SectionNav scrollRef={scrollRef} />
      <div className="inspector-scroll" ref={scrollRef}>
        {body}
      </div>
    </aside>
  );
}
