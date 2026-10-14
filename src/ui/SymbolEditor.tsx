import { Cpu, Code2, History, Layers, PenLine, Pencil, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { SymbolPreview } from '../canvas/SymbolGraphic';
import { uid } from '../model/doc';
import { replaceWithInstance } from '../model/fromSelection';
import { compileSource, parseDraw, parsePorts, primsToDsl, sourceOf, type SymbolSource } from '../model/symbols/dsl';
import { baseSymbols, getSymbol, variantDefs } from '../model/registry';
import { CATEGORY_ORDER } from '../model/symbols';
import type { CircuitDoc, PortDef, Prim, SymbolDef, VariantRef } from '../model/types';
import { S, deleteUserSymbol, mutate, saveUserSymbol, set, toast, useStore } from '../store/store';
import { svgToPrims } from '../io/svgImport';
import { Modal } from './Dialogs';
import { SymbolDrawPane, type Snap } from './SymbolDrawPane';
import { Field, NumberInput, TextInput } from './controls';

type Tab = 'draw' | 'chip' | 'svg' | 'code';

const blank = (): SymbolSource => ({
  id: '',
  name: 'New symbol',
  category: 'My symbols',
  w: 80,
  h: 40,
  draw: 'L 0 20 20 20\nRB 20 10 40 20 3\nL 60 20 80 20',
  ports: '1:0,20 2:80,20',
  prefix: 'U',
  value: '',
  fields: '',
  keywords: '',
  variantOf: '',
  variantName: '',
});

const r20 = (v: number) => Math.max(20, Math.round(v / 20) * 20);

/** Unsaved work in the editor, kept so closing by mistake (or a crash) loses nothing. */
const DRAFT_KEY = 'nodal.symbolDraft';
interface Draft {
  /** Symbol being edited, or '' for a new one. */
  key: string;
  t: number;
  src: SymbolSource;
}
const readDraft = (): Draft | null => {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null');
  } catch {
    return null;
  }
};
const clearDraft = () => localStorage.removeItem(DRAFT_KEY);


export function SymbolEditor() {
  const editing = useStore((s) => s.editingSymbol);
  const original = useMemo<SymbolDef | null>(() => (editing ? getSymbol(S().doc, editing) : null), [editing]);
  /** Set when the editor was opened with "Create symbol from selection". */
  const seed = useMemo(() => (editing ? null : S().symbolSeed), [editing]);
  const [src, setSrc] = useState<SymbolSource>(() => {
    if (!original && seed) return { ...blank(), w: seed.w, h: seed.h, draw: primsToDsl(seed.prims), ports: '' };
    if (!original) return blank();
    const keep = original.custom || !!original.variantOf; // editing a type keeps its id/name
    return {
      ...sourceOf(original),
      id: keep ? original.id : '',
      name: keep ? original.name : `${original.name} (custom)`,
      category: keep ? original.category : 'My symbols',
    };
  });
  const [prims, setPrims] = useState<Prim[]>(() => safePrims(src.draw));
  const [ports, setPorts] = useState<PortDef[]>(() => safePorts(src.ports, src.w, src.h));
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [tab, setTab] = useState<Tab>('draw');
  /** The draw pane uses Esc first (cancel / back to select / deselect); only then does Esc close the editor. */
  const escRef = useRef<(() => boolean) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  /** Key of the last coalescing edit (typing in a field, nudging) so a burst becomes one undo step. */
  const lastKey = useRef<string | null>(null);
  const stateRef = useRef<Snap>({ src, prims, ports });
  stateRef.current = { src, prims, ports };

  const snapshot = (): Snap => ({
    src: { ...stateRef.current.src },
    prims: [...stateRef.current.prims],
    ports: stateRef.current.ports.map((p) => ({ ...p })),
  });

  const write = (n: Snap) => {
    stateRef.current = n;
    setSrc(n.src);
    setPrims(n.prims);
    setPorts(n.ports);
    rerender();
  };

  /**
   * Applies an editing change with the editor's own undo/redo history.
   * `history`: true records an undo step, false doesn't (live drag updates),
   * a string key records one step for a run of edits sharing that key.
   */
  const apply = (mut: (s: Snap) => void, history: boolean | string = true) => {
    const key = typeof history === 'string' ? history : null;
    if (history && (key === null || key !== lastKey.current)) {
      past.current = [...past.current.slice(-150), snapshot()];
      future.current = [];
    }
    if (history) lastKey.current = key;
    const next = snapshot();
    mut(next);
    // keep the DSL text in sync with the structured drawing
    next.src = { ...next.src, draw: primsToDsl(next.prims), ports: next.ports.map((p) => `${p.id}:${p.x},${p.y}`).join(' ') };
    write(next);
  };

  const undoEd = () => {
    const prev = past.current.pop();
    if (!prev) return;
    lastKey.current = null;
    future.current = [...future.current, snapshot()];
    write(prev);
  };

  const redoEd = () => {
    const nxt = future.current.pop();
    if (!nxt) return;
    lastKey.current = null;
    past.current = [...past.current, snapshot()];
    write(nxt);
  };

  const hist = { canUndo: past.current.length > 0, canRedo: future.current.length > 0 };

  /* ---------------------- drafts and closing ---------------------- */

  const draftKey = editing ?? '';
  /** Anything changed since the editor opened. */
  const dirty = past.current.length > 0;
  const [confirmClose, setConfirmClose] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(() => {
    const d = seed ? null : readDraft();
    return d && d.key === draftKey && JSON.stringify(d.src) !== JSON.stringify(src) ? d : null;
  });

  // keep unsaved work while editing
  useEffect(() => {
    if (!dirty || seed) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ key: draftKey, t: Date.now(), src } satisfies Draft));
      } catch {
        /* storage full: nothing to do */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [src, dirty, seed, draftKey]);

  const closeEditor = () => {
    clearDraft();
    set({ dialog: null, editingSymbol: null, symbolSeed: null });
  };
  const requestClose = () => (dirty ? setConfirmClose(true) : closeEditor());
  /** Esc: the draw pane uses it first (cancel, deselect); then it asks before closing with unsaved changes. */
  const onEscape = () => {
    if (confirmClose) {
      setConfirmClose(false);
      return true;
    }
    if (tab === 'draw' && escRef.current?.()) return true;
    if (dirty) {
      setConfirmClose(true);
      return true;
    }
    return false;
  };
  const restoreDraft = (d: Draft) => {
    apply((s) => {
      s.src = { ...d.src };
      s.prims = safePrims(d.src.draw);
      s.ports = safePorts(d.src.ports, d.src.w, d.src.h);
    });
    setDraft(null);
  };

  const preview = useMemo<SymbolDef | null>(() => {
    try {
      return compileSource({ ...src, id: src.id || 'preview' });
    } catch {
      return null;
    }
  }, [src]);

  const validate = () => {
    const problems = ports.filter((p) => !(p.x === 0 || p.y === 0 || p.x === src.w || p.y === src.h));
    if (problems.length) throw new Error(`Pin ${problems[0].name} must sit on the symbol's outline`);
    const ids = new Set<string>();
    for (const p of ports) {
      if (ids.has(p.id)) throw new Error(`Two pins are named "${p.id}"`);
      ids.add(p.id);
    }
  };

  const save = (asNew: boolean) => {
    try {
      validate();
      // ---- Save the drawing as an extra "type" of an existing symbol ----
      if (src.variantOf) {
        const base = getSymbol(S().doc, src.variantOf);
        const vid = !asNew && src.id ? src.id : `user-type-${slug(variantName)}-${uid('').slice(-5)}`;
        const def = compileSource({ ...src, id: vid, name: base.name, category: base.category, prefix: base.prefix, value: src.value || base.value || '' });
        // the type inherits the base's identity, labels and fields
        def.name = base.name;
        def.category = base.category;
        def.prefix = base.prefix;
        def.fields = base.fields;
        def.hideLabels = base.hideLabels;
        def.valueIsLabel = base.valueIsLabel;
        def.variantOf = base.id;
        def.variantName = variantName;
        const ref: VariantRef = { id: vid, name: variantName };
        const mergedBase: SymbolDef = { ...base, variants: [...(base.variants ?? []).filter((v) => v.id !== ref.id), ref] };
        saveUserSymbol(def);
        saveUserSymbol(mergedBase);
        // one document edit, so undo puts the whole addition back at once
        mutate((d) => {
          d.symbols[vid] = def;
          d.symbols[base.id] = mergedBase;
        });
        toast(`Added “${variantName}” as a type of ${base.name}`, 'success');
        closeEditor();
        return;
      }
      // ---- Save as a standalone symbol ----
      const id = !asNew && src.id ? src.id : `user-${slug(src.name)}-${uid('').slice(-5)}`;
      const def = compileSource({ ...src, id });
      saveUserSymbol(def);
      // made from a selection: one undoable step swaps those items for the new symbol
      if (seed) {
        let placed = '';
        mutate((d) => void (placed = replaceWithInstance(d as CircuitDoc, seed.ids, def, seed.origin)));
        set({ selection: placed ? [placed] : [] });
        toast(`Saved “${def.name}” and placed it in place of the selection`, 'success');
        closeEditor();
        return;
      }
      // keep the document copy in sync so placed parts update
      if (S().doc.symbols[id]) mutate((d) => void (d.symbols[id] = def));
      // when customising a built-in symbol for a selected part, swap it in
      if (original && !original.custom) {
        const targets = S().selection.filter((sid) => {
          const it = S().doc.items[sid];
          return it?.type === 'component' && it.symbol === original.id;
        });
        if (targets.length) {
          mutate((d) => {
            d.symbols[id] = def;
            for (const t of targets) {
              const c = d.items[t];
              if (c.type === 'component') c.symbol = id;
            }
          });
        }
      }
      toast(`Saved “${def.name}” to My symbols`, 'success');
      closeEditor();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Removes a type from a base symbol; parts using it fall back to the base drawing. */
  const removeType = (baseId: string, vid: string) => {
    const base = getSymbol(S().doc, baseId);
    const merged: SymbolDef = { ...base, variants: (base.variants ?? []).filter((v) => v.id !== vid) };
    saveUserSymbol(merged);
    deleteUserSymbol(vid);
    mutate((d) => {
      d.symbols[baseId] = merged;
      delete d.symbols[vid];
      for (const it of Object.values(d.items)) {
        if (it.type === 'component' && it.symbol === vid) it.symbol = baseId;
      }
    });
    toast(`Removed that type of ${base.name}`, 'success');
  };

  const bases = useMemo(() => baseSymbols({ symbols: S().doc.symbols }), []);
  const baseId = src.variantOf || (original?.variants?.length ? original.id : '');
  const manageBase = baseId ? getSymbol(S().doc, baseId) : null;
  const manageTypes = manageBase ? [manageBase, ...variantDefs({ symbols: S().doc.symbols }, manageBase)] : [];
  const variantName = (src.variantName ?? '').trim() || `Type ${(manageBase?.variants?.length ?? 0) + 1}`;

  return (
    <Modal title={original ? (original.custom ? `Edit symbol — ${original.name}` : `Customise “${original.name}”`) : seed ? 'Create a symbol from the selection' : 'Create a symbol'} onClose={requestClose} onEscape={onEscape} width={1080} className="symbol-editor">
      {draft && (
        <div className="se-banner">
          <History size={15} />
          <span>
            Unsaved changes from {new Date(draft.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} were kept.
          </span>
          <button className="primary-btn" onClick={() => restoreDraft(draft)}>
            Restore them
          </button>
          <button
            className="secondary-btn"
            onClick={() => {
              clearDraft();
              setDraft(null);
            }}
          >
            Discard
          </button>
        </div>
      )}
      {confirmClose && (
        <div className="se-confirm-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setConfirmClose(false)}>
          <div className="se-confirm" role="alertdialog" aria-label="Unsaved changes">
            <strong>Save your changes to this symbol?</strong>
            <span className="muted small">If you close without saving, your changes are lost.</span>
            <div className="btn-row">
              <button className="secondary-btn danger" onClick={closeEditor}>
                Don’t save
              </button>
              <span className="grow" />
              <button className="secondary-btn" autoFocus onClick={() => setConfirmClose(false)}>
                Keep editing
              </button>
              <button
                className="primary-btn"
                onClick={() => {
                  setConfirmClose(false);
                  save(false);
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="se-layout">
        <div className="se-main">
          <div className="tabs inline">
            <button className={tab === 'draw' ? 'active' : ''} onClick={() => setTab('draw')}>
              <PenLine size={13} /> Draw
            </button>
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
          {seed && !ports.length && (
            <p className="se-seed-hint">
              Drawn from your selection. Add pins where connections should go (on the outline), then save: the selection is replaced by the new symbol, and wires ending on a pin stay connected.
            </p>
          )}
          {tab === 'draw' && <SymbolDrawPane src={src} apply={apply} prims={prims} ports={ports} onUndo={undoEd} onRedo={redoEd} canUndo={hist.canUndo} canRedo={hist.canRedo} escRef={escRef} />}
          {tab === 'chip' && (
            <ChipBuilder
              onBuild={(b) => {
                apply((s) => {
                  s.src.w = b.w;
                  s.src.h = b.h;
                  if (!s.src.prefix) s.src.prefix = 'U';
                  s.prims = b.prims;
                  s.ports = b.ports;
                });
                setTab('draw');
              }}
            />
          )}
          {tab === 'svg' && (
            <SvgImport
              onImport={(p, w, h) => {
                apply((s) => {
                  s.src.w = w;
                  s.src.h = h;
                  s.prims = p;
                  s.ports = [];
                });
                setTab('draw');
                toast('Imported — now add pins with the Pin tool');
              }}
            />
          )}
          {tab === 'code' && (
            <CodePane
              src={src}
              onApply={(draw, portsText) => {
                try {
                  const p = parseDraw(draw);
                  const pt = parsePorts(portsText, src.w, src.h);
                  apply((s) => {
                    s.prims = p;
                    s.ports = pt;
                    s.src.draw = draw;
                    s.src.ports = portsText;
                  });
                  setError(null);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            />
          )}
        </div>
        <div className="se-side">
          <div className="se-preview">{preview ? <SymbolPreview def={preview} size={150} ports /> : <span className="muted">Invalid symbol</span>}</div>
          <Field label="Name">
            <TextInput value={src.name} onChange={(name) => apply((s) => void (s.src.name = name), 'name')} />
          </Field>
          <Field label="Category">
            <select className="input" value={src.category} onChange={(e) => apply((s) => void (s.src.category = e.target.value))}>
              {['My symbols', ...CATEGORY_ORDER].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Ref prefix" hint="R for resistors, U for ICs, Q for transistors…">
            <TextInput value={src.prefix} onChange={(prefix) => apply((s) => void (s.src.prefix = prefix), 'prefix')} />
          </Field>
          <Field label="Default value">
            <TextInput value={src.value} onChange={(value) => apply((s) => void (s.src.value = value), 'value')} placeholder="e.g. 10kΩ" />
          </Field>
          <Field label="Fields" hint="Comma separated, e.g. Package=0805, Voltage=50V">
            <TextInput value={src.fields} onChange={(fields) => apply((s) => void (s.src.fields = fields), 'fields')} placeholder="Package=0805, Tolerance=1%" />
          </Field>
          <Field label="Search words">
            <TextInput value={src.keywords} onChange={(keywords) => apply((s) => void (s.src.keywords = keywords), 'keywords')} />
          </Field>
          <div className="se-types">
            <Field label="Drawing type" hint="Offer this drawing as an extra “type” of an existing symbol">
              <select
                className="input"
                value={src.variantOf ?? ''}
                onChange={(e) =>
                  apply((s) => {
                    s.src.variantOf = e.target.value || undefined;
                    if (!e.target.value) s.src.variantName = '';
                  })
                }
              >
                <option value="">— standalone symbol —</option>
                {bases.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} · {b.category}
                  </option>
                ))}
              </select>
            </Field>
            {src.variantOf && (
              <Field label="Type name" hint="Shown in the type picker, e.g. “Type B · source arrow”">
                <input className="input" value={src.variantName ?? ''} onChange={(e) => apply((s) => void (s.src.variantName = e.target.value), 'vname')} placeholder="Type B" />
              </Field>
            )}
            {manageBase && (
              <div className="se-type-list">
                <div className="se-type-head">
                  <Layers size={12} /> {manageTypes.length} type{manageTypes.length === 1 ? '' : 's'} of {manageBase.name}
                </div>
                {manageTypes.map((t, i) => (
                  <div key={t.id} className={t.id === src.id ? 'se-type-row active' : 'se-type-row'}>
                    <span className="se-type-prev">
                      <SymbolPreview def={t} size={28} />
                    </span>
                    <span className="se-type-label">{i === 0 ? 'Type A · standard' : t.variantName || t.name}</span>
                    <button className="mini-btn" title="Edit this type" onClick={() => set({ editingSymbol: t.id })}>
                      <Pencil size={11} />
                    </button>
                    {t.id !== manageBase.id && (
                      <button className="mini-btn" title="Delete this type" onClick={() => removeType(manageBase.id, t.id)}>
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="se-pins">
            <b>{ports.length} pins</b>
            {ports.map((p, i) => (
              <span key={i} className="pin-chip">
                <input
                  value={p.id}
                  onChange={(e) => {
                    const id = e.target.value.replace(/[\s:,]/g, '_');
                    apply((s) => void (s.ports[i] = { ...s.ports[i], id, name: id }), `pin-${i}`);
                  }}
                />
                <button onClick={() => apply((s) => void s.ports.splice(i, 1))}>×</button>
              </span>
            ))}
          </div>
          {error && <div className="error-note">{error}</div>}
          <div className="btn-row">
            {src.id && !src.variantOf && (
              <button className="secondary-btn" onClick={() => save(true)}>
                Save as copy
              </button>
            )}
            <button className="primary-btn" onClick={() => save(false)}>
              {src.variantOf ? (src.id ? 'Save this type' : 'Add this type') : src.id ? 'Save changes' : 'Add to My symbols'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'symbol';
}

function safePrims(d: string): Prim[] {
  try {
    return parseDraw(d);
  } catch {
    return [];
  }
}
function safePorts(p: string, w: number, h: number): PortDef[] {
  try {
    return parsePorts(p, w, h);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Chip builder                                                        */
/* ------------------------------------------------------------------ */

function ChipBuilder({ onBuild }: { onBuild: (b: { w: number; h: number; prims: Prim[]; ports: PortDef[] }) => void }) {
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

function SvgImport({ onImport }: { onImport: (p: Prim[], w: number, h: number) => void }) {
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

function CodePane({ src, onApply }: { src: SymbolSource; onApply: (draw: string, ports: string) => void }) {
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
