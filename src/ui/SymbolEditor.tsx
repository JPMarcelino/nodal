import { ArrowLeft, Code2, Cpu, History, Layers, Pencil, Pin, Save, Trash2, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SymbolPreview } from '../canvas/SymbolGraphic';
import { compileSource, parseDraw, parsePorts } from '../model/symbols/dsl';
import { baseSymbols, getSymbol, variantDefs } from '../model/registry';
import { CATEGORY_ORDER } from '../model/symbols';
import { PIN_SYMBOL, pagePins, pageToSymbol, pinId } from '../model/symbolPage';
import { inferSide } from '../model/symbols/dsl';
import type { ComponentItem, PortDef, Prim, SymbolDef } from '../model/types';
import * as A from '../store/actions';
import { S, mutate, select, set, toast, useStore } from '../store/store';
import {
  closeSymbolEditor,
  dismissSymbolDraft,
  openSymbolEditor,
  removeSymbolType,
  replaceSymbolPage,
  restoreSymbolDraft,
  saveSymbolEditor,
  setSymbolMeta,
  symbolCode,
  symbolDirty,
} from '../store/symbolSession';
import { svgToPrims } from '../io/svgImport';
import { Modal } from './Dialogs';
import { Field, NumberInput, Section, TextInput } from './controls';

/*
 * The symbol editor is a page on the canvas (see store/symbolSession): every
 * drawing tool, the parts library and the side panels work on it as on any
 * circuit. This file holds its bar along the top of the canvas, the Symbol tab
 * of the right panel (name, prefix, types…), the pin panel and the generator
 * tools (chip builder, SVG import, code).
 */

type ToolTab = 'chip' | 'svg' | 'code';

const r20 = (v: number) => Math.max(20, Math.round(v / 20) * 20);

/** The strip along the top of the canvas while a symbol is open: pins, generators, cancel and save. */
export function SymbolBar() {
  const session = useStore((s) => s.symbolSession);
  const doc = useStore((s) => s.doc);
  const placingPins = useStore((s) => s.placing?.symbol === PIN_SYMBOL);
  const past = useStore((s) => s.past.length);
  const [tools, setTools] = useState<ToolTab | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pins = useMemo(() => pagePins(doc), [doc]);
  const problem = useMemo(() => {
    try {
      pageToSymbol(doc);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, [doc]);
  if (!session) return null;
  void past;
  const { meta, editing, seedIds, draft } = session;
  const title = seedIds ? 'New symbol from the selection' : editing ? (session.customising ? `Customising “${getSymbol(session.stash.doc, editing).name}”` : 'Editing symbol') : 'New symbol';
  const save = (asNew = false) => {
    const err = saveSymbolEditor(asNew);
    setError(err);
    if (err) toast(err, 'error');
  };
  const cancel = () => (symbolDirty() ? setConfirm(true) : closeSymbolEditor());
  const togglePins = () => (placingPins ? set({ placing: null }) : A.startPlacing(PIN_SYMBOL));
  return (
    <div className="symbol-bar" role="toolbar" aria-label="Symbol editor">
      <button className="secondary-btn" onClick={cancel} title="Back to the circuit without saving">
        <ArrowLeft size={14} /> Circuit
      </button>
      <div className="symbol-bar-title">
        <span className="symbol-bar-kicker">{title}</span>
        <input className="input symbol-bar-name" value={meta.name} aria-label="Symbol name" onChange={(e) => setSymbolMeta({ name: e.target.value })} />
      </div>
      <span className="divider" />
      <button className={placingPins ? 'secondary-btn active' : 'secondary-btn'} onClick={togglePins} title="Add pins: click where wires should connect — near a lead's end it snaps onto it (N; Esc to stop)">
        <Pin size={14} /> Add pins
      </button>
      <span className={pins.length ? 'symbol-bar-count' : 'symbol-bar-count warn'} title="Pins of the symbol (select one to rename it)">
        {pins.length} pin{pins.length === 1 ? '' : 's'}
      </span>
      <span className="divider" />
      <button className="icon-btn" title="Chip / IC builder: generate an IC outline from pin names" onClick={() => setTools('chip')}>
        <Cpu size={15} />
      </button>
      <button className="icon-btn" title="Import an SVG drawing as the symbol" onClick={() => setTools('svg')}>
        <Upload size={15} />
      </button>
      <button className="icon-btn" title="Symbol code (drawing commands and pin list)" onClick={() => setTools('code')}>
        <Code2 size={15} />
      </button>
      <span className="grow" />
      {(error || problem) && <span className="symbol-bar-error">{problem ?? error}</span>}
      {meta.id && !meta.variantOf && (
        <button className="secondary-btn" onClick={() => save(true)}>
          Save as copy
        </button>
      )}
      <button className="primary-btn" onClick={() => save(false)} disabled={!!problem} title="Save the symbol and go back to the circuit (Ctrl+S)">
        <Save size={14} /> {meta.variantOf ? (meta.id ? 'Save this type' : 'Add this type') : meta.id ? 'Save symbol' : 'Add to My symbols'}
      </button>
      {draft && (
        <div className="symbol-bar-banner">
          <History size={14} />
          <span>Unsaved changes from {new Date(draft.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} were kept.</span>
          <button className="primary-btn" onClick={restoreSymbolDraft}>
            Restore them
          </button>
          <button className="secondary-btn" onClick={dismissSymbolDraft}>
            Discard
          </button>
        </div>
      )}
      {confirm && (
        <div className="se-confirm-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setConfirm(false)}>
          <div className="se-confirm" role="alertdialog" aria-label="Unsaved changes">
            <strong>Save your changes to this symbol?</strong>
            <span className="muted small">If you go back without saving, your changes are lost.</span>
            <div className="btn-row">
              <button className="secondary-btn danger" onClick={closeSymbolEditor}>
                Don’t save
              </button>
              <span className="grow" />
              <button className="secondary-btn" autoFocus onClick={() => setConfirm(false)}>
                Keep editing
              </button>
              <button
                className="primary-btn"
                onClick={() => {
                  setConfirm(false);
                  save(false);
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
      {tools && <SymbolTools tab={tools} setTab={setTools} />}
    </div>
  );
}

/** Generators that replace the page's drawing: chip builder, SVG import, symbol code. */
function SymbolTools({ tab, setTab }: { tab: ToolTab; setTab: (t: ToolTab | null) => void }) {
  const [err, setErr] = useState<string | null>(null);
  const done = () => setTab(null);
  return (
    <Modal title="Symbol generators" onClose={done} width={760} className="symbol-editor">
      <div className="tabs inline">
        <button className={tab === 'chip' ? 'active' : ''} onClick={() => setTab('chip')}>
          <Cpu size={13} /> Chip / IC builder
        </button>
        <button className={tab === 'svg' ? 'active' : ''} onClick={() => setTab('svg')}>
          <Upload size={13} /> Import SVG
        </button>
        <button className={tab === 'code' ? 'active' : ''} onClick={() => setTab('code')}>
          <Code2 size={13} /> Code
        </button>
      </div>
      <p className="muted small">These replace what is on the symbol page (Undo brings it back).</p>
      {tab === 'chip' && (
        <ChipBuilder
          onBuild={(b) => {
            replaceSymbolPage(b.prims, b.ports);
            if (!S().symbolSession?.meta.prefix) setSymbolMeta({ prefix: 'U' });
            done();
          }}
        />
      )}
      {tab === 'svg' && (
        <SvgImport
          onImport={(p) => {
            replaceSymbolPage(p, []);
            done();
            toast('Imported: now add pins where wires should connect');
          }}
        />
      )}
      {tab === 'code' && (
        <CodePane
          src={symbolCode()}
          onApply={(draw, portsText) => {
            try {
              replaceSymbolPage(parseDraw(draw), parsePorts(portsText, 1e6, 1e6));
              done();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        />
      )}
      {err && <div className="error-note">{err}</div>}
    </Modal>
  );
}

/** Symbol tab of the right panel: what the symbol is called and how it is placed. */
export function SymbolProps() {
  const session = useStore((s) => s.symbolSession);
  const doc = useStore((s) => s.doc);
  const pins = useMemo(() => pagePins(doc), [doc]);
  const built = useMemo(() => {
    try {
      return pageToSymbol(doc);
    } catch {
      return null;
    }
  }, [doc]);
  const preview = useMemo<SymbolDef | null>(() => {
    if (!session || !built) return null;
    try {
      const src = { ...session.meta, id: 'preview', w: built.w, h: built.h, draw: '', ports: '' };
      const def = compileSource(src);
      return { ...def, prims: built.prims, ports: built.ports };
    } catch {
      return null;
    }
  }, [session, built]);
  const bases = useMemo(() => baseSymbols({ symbols: session?.stash.doc.symbols ?? {} }), [session?.stash.doc]);
  if (!session) return null;
  const { meta, stash } = session;
  const baseId = meta.variantOf || (session.editing && getSymbol(stash.doc, session.editing).variants?.length ? session.editing : '');
  const manageBase = baseId ? getSymbol(stash.doc, baseId) : null;
  const manageTypes = manageBase ? [manageBase, ...variantDefs({ symbols: stash.doc.symbols }, manageBase)] : [];
  return (
    <div className="symbol-props">
      <div className="se-preview">{preview ? <SymbolPreview def={preview} size={140} ports /> : <span className="muted">Nothing drawn yet</span>}</div>
      {built && (
        <div className="muted small symbol-props-size">
          {built.w} × {built.h} px · {built.ports.length} pin{built.ports.length === 1 ? '' : 's'}
        </div>
      )}
      <Section title="Symbol" defaultOpen id="sym-props">
        <Field label="Name">
          <TextInput value={meta.name} onChange={(name) => setSymbolMeta({ name })} />
        </Field>
        <Field label="Category">
          <select className="input" value={meta.category} onChange={(e) => setSymbolMeta({ category: e.target.value })}>
            {['My symbols', ...CATEGORY_ORDER].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Ref prefix" hint="R for resistors, U for ICs, Q for transistors…">
          <TextInput value={meta.prefix} onChange={(prefix) => setSymbolMeta({ prefix })} />
        </Field>
        <Field label="Default value">
          <TextInput value={meta.value} onChange={(value) => setSymbolMeta({ value })} placeholder="e.g. 10kΩ" />
        </Field>
        <Field label="Fields" hint="Comma separated, e.g. Package=0805, Voltage=50V">
          <TextInput value={meta.fields} onChange={(fields) => setSymbolMeta({ fields })} placeholder="Package=0805, Tolerance=1%" />
        </Field>
        <Field label="Search words">
          <TextInput value={meta.keywords} onChange={(keywords) => setSymbolMeta({ keywords })} />
        </Field>
      </Section>
      <Section title={`Pins (${pins.length})`} defaultOpen id="sym-pins">
        <PinList pins={pins} box={built ? { x: built.origin.x, y: built.origin.y, w: built.w, h: built.h } : null} />
      </Section>
      <Section title="Types" id="sym-types" summary={meta.variantOf ? 'extra type' : 'standalone'}>
        <Field label="Drawing type" hint="Offer this drawing as an extra “type” of an existing symbol">
          <select
            className="input"
            value={meta.variantOf ?? ''}
            onChange={(e) => setSymbolMeta({ variantOf: e.target.value || undefined, ...(e.target.value ? {} : { variantName: '' }) })}
          >
            <option value="">— standalone symbol —</option>
            {bases.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} · {b.category}
              </option>
            ))}
          </select>
        </Field>
        {meta.variantOf && (
          <Field label="Type name" hint="Shown in the type picker, e.g. “Type B · source arrow”">
            <TextInput value={meta.variantName ?? ''} onChange={(variantName) => setSymbolMeta({ variantName })} placeholder="Type B" />
          </Field>
        )}
        {manageBase && (
          <div className="se-type-list">
            <div className="se-type-head">
              <Layers size={12} /> {manageTypes.length} type{manageTypes.length === 1 ? '' : 's'} of {manageBase.name}
            </div>
            {manageTypes.map((t, i) => (
              <div key={t.id} className={t.id === meta.id ? 'se-type-row active' : 'se-type-row'}>
                <span className="se-type-prev">
                  <SymbolPreview def={t} size={28} />
                </span>
                <span className="se-type-label">{i === 0 ? 'Type A · standard' : t.variantName || t.name}</span>
                <button className="mini-btn" title="Edit this type" onClick={() => openSymbolEditor({ editing: t.id })}>
                  <Pencil size={11} />
                </button>
                {t.id !== manageBase.id && (
                  <button className="mini-btn" title="Delete this type" onClick={() => removeSymbolType(manageBase.id, t.id)}>
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="Page" id="sym-page" summary={`grid ${doc.settings.grid}`}>
        <Field label="Grid" hint="Pins stay on the 10 px grid wires use; a finer grid helps with small details">
          <select className="input" value={doc.settings.grid} onChange={(e) => mutate((d) => void (d.settings.grid = +e.target.value), undefined, { allPages: true })}>
            {[1, 2, 5, 10, 20].map((g) => (
              <option key={g} value={g}>
                {g} px
              </option>
            ))}
          </select>
        </Field>
      </Section>
      <p className="muted small symbol-props-help">
        Draw with any tool, place parts from the library (they become part of the drawing), and add pins where wires connect. Save turns the page into the symbol.
      </p>
    </div>
  );
}

/** Pins in order: rename, find, delete; and which side of the outline each leaves from. */
function PinList({ pins, box }: { pins: ComponentItem[]; box: { x: number; y: number; w: number; h: number } | null }) {
  const selection = useStore((s) => s.selection);
  const names = new Map<string, number>();
  for (const p of pins) names.set(pinId(p.ref), (names.get(pinId(p.ref)) ?? 0) + 1);
  return (
    <div className="pin-list">
      {pins.map((p) => (
        <div key={p.id} className={selection.includes(p.id) ? 'pin-row active' : 'pin-row'} onPointerEnter={() => set({ layerHover: [p.id] })} onPointerLeave={() => set({ layerHover: [] })}>
          <button className="mini-btn" title="Select this pin" onClick={() => select([p.id])}>
            <Pin size={11} />
          </button>
          <PinName pin={p} dup={(names.get(pinId(p.ref)) ?? 0) > 1} />
          <span className="pin-side muted small">{box ? inferSide(p.x - box.x, p.y - box.y, box.w, box.h) : ''}</span>
          <button className="mini-btn" title="Delete this pin" onClick={() => mutate((d) => void delete d.items[p.id], S().selection.filter((id) => id !== p.id))}>
            <Trash2 size={11} />
          </button>
        </div>
      ))}
      <button className="secondary-btn" onClick={() => A.startPlacing(PIN_SYMBOL)}>
        <Pin size={13} /> Add pins
      </button>
      {!pins.length && <p className="muted small">No pins yet: a symbol without pins can’t be wired.</p>}
    </div>
  );
}

function PinName({ pin, dup, focusKey }: { pin: ComponentItem; dup: boolean; focusKey?: string }) {
  return (
    <span className={dup ? 'pin-name dup' : 'pin-name'} title={dup ? 'Another pin has this name' : undefined}>
      <TextInput value={pin.ref} focusKey={focusKey} onChange={(v) => renamePin(pin.id, v)} />
    </span>
  );
}

function renamePin(id: string, name: string) {
  const v = name.trim();
  if (!v) return;
  mutate((d) => {
    const c = d.items[id];
    if (c?.type === 'component') c.ref = v;
  });
}

/** Right panel for a selected pin. */
export function PinPanel({ c }: { c: ComponentItem }) {
  const doc = useStore((s) => s.doc);
  const pins = useMemo(() => pagePins(doc), [doc]);
  const dup = pins.filter((p) => pinId(p.ref) === pinId(c.ref)).length > 1;
  const built = useMemo(() => {
    try {
      return pageToSymbol(doc);
    } catch {
      return null;
    }
  }, [doc]);
  const side = built ? inferSide(c.x - built.origin.x, c.y - built.origin.y, built.w, built.h) : null;
  return (
    <div className="symbol-props">
      <Section title="Pin" defaultOpen id="sym-pin">
        <Field label="Name" hint="Wires connect to the pin by this name; double-click a pin to come back here">
          <PinName pin={c} dup={dup} focusKey="value" />
        </Field>
        {dup && <div className="error-note">Another pin is called “{c.ref}”: each pin needs its own name.</div>}
        <div className="muted small">
          At {Math.round(c.x)}, {Math.round(c.y)}
          {side && ` · wires leave it to the ${side}`}
        </div>
        <div className="btn-row">
          <button className="secondary-btn" onClick={() => A.startPlacing(PIN_SYMBOL)}>
            <Pin size={13} /> Add more pins
          </button>
        </div>
        <p className="muted small">Drag pins to move them (arrow keys nudge). Pins sit where wires end, on the outline or anywhere on the drawing.</p>
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chip builder                                                        */
/* ------------------------------------------------------------------ */

export function ChipBuilder({ onBuild }: { onBuild: (b: { w: number; h: number; prims: Prim[]; ports: PortDef[] }) => void }) {
  const [left, setLeft] = useState('VCC\nIN1\nIN2\nGND');
  const [right, setRight] = useState('OUT1\nOUT2');
  const [top, setTop] = useState('');
  const [bottom, setBottom] = useState('');
  const [title, setTitle] = useState('IC');
  const [numbers, setNumbers] = useState(true);
  const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

  const build = () => {
    const L = lines(left);
    const R = lines(right);
    const T = lines(top);
    const B = lines(bottom);
    const lead = 20;
    const rows = Math.max(L.length, R.length, 1);
    const cols = Math.max(T.length, B.length, 0);
    const maxName = Math.max(0, ...L.map((s) => s.length)) + Math.max(0, ...R.map((s) => s.length));
    const bodyW = Math.max(60, Math.ceil((maxName * 6.2 + 30) / 20) * 20, (cols + 1) * 20);
    const bodyH = Math.max(40, (rows + 1) * 20);
    const w = r20(bodyW + (L.length ? lead : 0) + (R.length ? lead : 0));
    const h = r20(bodyH + (T.length ? lead : 0) + (B.length ? lead : 0));
    const x0 = L.length ? lead : 0;
    const y0 = T.length ? lead : 0;
    const x1 = w - (R.length ? lead : 0);
    const y1 = h - (B.length ? lead : 0);
    const prims: Prim[] = [{ t: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0, rx: 2, fill: 'bg' }];
    const ports: PortDef[] = [];
    const used = new Set<string>();
    let num = 1;
    const addPin = (name: string, x: number, y: number, side: PortDef['side']) => {
      let id = name.replace(/[\s:,]/g, '_');
      while (used.has(id)) id += '_';
      used.add(id);
      ports.push({ id, name, x, y, side });
      return num++;
    };
    L.forEach((n, i) => {
      const y = y0 + 20 + i * 20;
      prims.push({ t: 'line', pts: [0, y, x0, y] });
      prims.push({ t: 'text', x: x0 + 4, y: y + 3.5, size: 9, anchor: 'start', text: n });
      const k = addPin(n, 0, y, 'left');
      if (numbers) prims.push({ t: 'text', x: x0 / 2, y: y - 3, size: 7, anchor: 'middle', text: String(k) });
    });
    B.forEach((n, i) => {
      const x = x0 + 20 + i * 20;
      prims.push({ t: 'line', pts: [x, y1, x, h] });
      prims.push({ t: 'text', x, y: y1 - 4, size: 8, anchor: 'middle', text: n });
      addPin(n, x, h, 'bottom');
    });
    [...R].reverse().forEach((n, ri) => {
      const i = R.length - 1 - ri;
      const y = y0 + 20 + i * 20;
      prims.push({ t: 'line', pts: [x1, y, w, y] });
      prims.push({ t: 'text', x: x1 - 4, y: y + 3.5, size: 9, anchor: 'end', text: n });
      const k = addPin(n, w, y, 'right');
      if (numbers) prims.push({ t: 'text', x: x1 + (w - x1) / 2, y: y - 3, size: 7, anchor: 'middle', text: String(k) });
    });
    [...T].reverse().forEach((n, ri) => {
      const i = T.length - 1 - ri;
      const x = x0 + 20 + i * 20;
      prims.push({ t: 'line', pts: [x, 0, x, y0] });
      prims.push({ t: 'text', x, y: y0 + 11, size: 8, anchor: 'middle', text: n });
      addPin(n, x, 0, 'top');
    });
    if (title) prims.push({ t: 'text', x: (x0 + x1) / 2, y: (y0 + y1) / 2 + 4, size: 11, anchor: 'middle', text: title });
    onBuild({ w, h, prims, ports });
  };

  return (
    <div className="chip-builder">
      <p className="muted small">List pin names, one per line (or comma separated). The chip outline, leads, labels and pin numbers are generated for you — tweak the result in Draw afterwards.</p>
      <div className="chip-grid">
        <Field label="Title inside" wide>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div />
        <Field label="Left pins" wide>
          <textarea className="input mono" rows={8} value={left} onChange={(e) => setLeft(e.target.value)} />
        </Field>
        <Field label="Right pins" wide>
          <textarea className="input mono" rows={8} value={right} onChange={(e) => setRight(e.target.value)} />
        </Field>
        <Field label="Top pins" wide>
          <textarea className="input mono" rows={3} value={top} onChange={(e) => setTop(e.target.value)} />
        </Field>
        <Field label="Bottom pins" wide>
          <textarea className="input mono" rows={3} value={bottom} onChange={(e) => setBottom(e.target.value)} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={numbers} onChange={(e) => setNumbers(e.target.checked)} /> Show pin numbers
      </label>
      <button className="primary-btn" onClick={build}>
        <Cpu size={14} /> Generate chip
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SVG import                                                          */
/* ------------------------------------------------------------------ */

export function SvgImport({ onImport }: { onImport: (p: Prim[], w: number, h: number) => void }) {
  const [text, setText] = useState('');
  const [size, setSize] = useState(80);
  const [err, setErr] = useState<string | null>(null);
  const run = () => {
    try {
      const { prims, w, h } = svgToPrims(text, size);
      onImport(prims, w, h);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="svg-import">
      <p className="muted small">Paste SVG markup (or load a file). Shapes are converted to symbol outlines and scaled to fit; then add pins in Draw.</p>
      <textarea className="input mono" rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder="<svg …>…</svg>" />
      <div className="btn-row">
        <label className="secondary-btn">
          Load .svg file
          <input
            type="file"
            accept=".svg,image/svg+xml"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setText(await f.text());
            }}
          />
        </label>
        <Field label="Fit to">
          <NumberInput value={size} min={20} max={300} step={20} suffix="px" onChange={setSize} />
        </Field>
        <button className="primary-btn" disabled={!text.trim()} onClick={run}>
          Convert
        </button>
      </div>
      {err && <div className="error-note">{err}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Code pane                                                           */
/* ------------------------------------------------------------------ */

export function CodePane({ src, onApply }: { src: { draw: string; ports: string }; onApply: (draw: string, ports: string) => void }) {
  const [draw, setDraw] = useState(src.draw);
  const [ports, setPorts] = useState(src.ports);
  return (
    <div className="code-pane">
      <div className="code-help muted small">
        <code>L x1 y1 x2 y2…</code> line · <code>G/GF/GB …</code> polygon (outline / filled / opaque) · <code>R x y w h [rx]</code> rect · <code>C cx cy r</code> circle · <code>E cx cy rx ry</code> ellipse ·{' '}
        <code>A cx cy r a1 a2</code> arc · <code>P d</code> SVG path · <code>T x y size s|m|e text</code> · <code>W width</code> · <code>D …</code> dashed line
      </div>
      <Field label="Drawing" wide>
        <textarea className="input mono" rows={14} value={draw} onChange={(e) => setDraw(e.target.value)} spellCheck={false} />
      </Field>
      <Field label="Pins (name:x,y …)" wide>
        <input className="input mono" value={ports} onChange={(e) => setPorts(e.target.value)} spellCheck={false} />
      </Field>
      <button className="primary-btn" onClick={() => onApply(draw, ports)}>
        Apply
      </button>
    </div>
  );
}
