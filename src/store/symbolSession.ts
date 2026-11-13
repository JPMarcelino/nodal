import { groupChain, uid } from '../model/doc';
import { replaceWithInstance } from '../model/fromSelection';
import { getSymbol } from '../model/registry';
import { PIN_SYMBOL, pageOf, pageToSymbol, storedPage, symbolDoc, type SymbolPage } from '../model/symbolPage';
import { compileSource, primsToDsl, sourceOf, type SymbolSource } from '../model/symbols/dsl';
import { portPosition } from '../model/wires';
import type { CircuitDoc, Item, SymbolDef, VariantRef } from '../model/types';
import { S, symbolDraftHook, deleteUserSymbol, mutate, readOnly, readOnlyNotice, saveUserSymbol, set, toast, type SymbolSession } from './store';

/*
 * The symbol editor works on the canvas itself: the open circuit is set aside
 * and the symbol opens as a page of its own, with every tool, the library and
 * the side panels (see model/symbolPage). Saving turns the page back into the
 * symbol and brings the circuit back; Cancel just brings the circuit back.
 */

/** Unsaved work on a symbol page, kept so a reload (or a crash) loses nothing. */
const DRAFT_KEY = 'nodal.symbolPageDraft';
export interface SymbolDraft {
  /** Symbol being edited, or '' for a new one. */
  key: string;
  t: number;
  meta: SymbolSource;
  page: SymbolPage;
}

export function readSymbolDraft(): SymbolDraft | null {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as SymbolDraft | null;
    return d && typeof d === 'object' && d.page?.items ? d : null;
  } catch {
    return null;
  }
}
export const clearSymbolDraft = () => localStorage.removeItem(DRAFT_KEY);

let draftTimer: ReturnType<typeof setTimeout> | undefined;
/** Keeps the page's unsaved work (debounced). */
export function scheduleSymbolDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const s = S().symbolSession;
    if (!s || !symbolDirty() || s.seedIds) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ key: s.editing ?? '', t: Date.now(), meta: s.meta, page: pageOf(S().doc) } satisfies SymbolDraft));
    } catch {
      /* storage full: nothing to do */
    }
  }, 500);
}

symbolDraftHook.run = scheduleSymbolDraft;

const blankMeta = (): SymbolSource => ({
  id: '',
  name: 'New symbol',
  category: 'My symbols',
  w: 80,
  h: 40,
  draw: '',
  ports: '',
  prefix: 'U',
  value: '',
  fields: '',
  keywords: '',
  variantOf: '',
  variantName: '',
});

/** A blank symbol starts as a little two-pin part, so there is something to shape. */
const STARTER = 'L 0 20 20 20\nRB 20 10 40 20 3\nL 60 20 80 20';

export interface OpenSymbolOptions {
  /** Symbol to edit; unset = a new symbol. */
  editing?: string | null;
  /** Items of the open circuit to start from ("Create symbol from selection"); saving swaps them for the symbol. */
  fromSelection?: string[];
}

/** Opens the symbol editor page. Returns false when it can't open (read-only circuit, a drag running). */
export function openSymbolEditor(opts: OpenSymbolOptions = {}): boolean {
  const s = S();
  if (readOnly(s)) {
    readOnlyNotice();
    return false;
  }
  if (s.symbolSession) {
    // switching symbols (a type of the one open, say): only once this one is saved or dropped
    if (symbolDirty()) {
      toast('Save or cancel the symbol you are editing first', 'info');
      return false;
    }
    closeSymbolEditor();
  }
  const editing = opts.editing ?? null;
  const original: SymbolDef | null = editing ? getSymbol(S().doc, editing) : null;
  let meta: SymbolSource;
  let doc: CircuitDoc;
  if (original) {
    const src = sourceOf(original);
    const keep = original.custom || !!original.variantOf; // editing a type keeps its id/name
    meta = {
      ...src,
      id: keep ? original.id : '',
      name: keep ? original.name : `${original.name} (custom)`,
      category: keep ? original.category : 'My symbols',
    };
    doc = symbolDoc(meta.name, original.prims, original.ports, storedPage(src));
  } else if (opts.fromSelection?.length) {
    meta = blankMeta();
    doc = selectionDoc(S().doc, opts.fromSelection);
  } else {
    meta = blankMeta();
    const starter = compileSource({ ...meta, draw: STARTER, ports: '1:0,20 2:80,20' });
    doc = symbolDoc(meta.name, starter.prims, starter.ports);
  }
  delete meta.page;
  doc.settings = { ...doc.settings, grid: S().doc.settings.grid, snap: true, titleBlock: false };
  doc.name = meta.name;
  const draft = opts.fromSelection?.length ? null : readSymbolDraft();
  const session: SymbolSession = {
    editing,
    meta,
    seedIds: opts.fromSelection?.length ? [...opts.fromSelection] : null,
    customising: !!original && !original.custom && !original.variantOf,
    metaDirty: false,
    draft: draft && draft.key === (editing ?? '') ? draft : null,
    stash: { doc: s.doc, page: s.page, past: s.past, future: s.future, dirty: s.dirty, filePath: s.filePath, view: s.view, selection: s.selection, scope: s.scope },
  };
  set({
    symbolSession: session,
    doc,
    page: undefined,
    past: [],
    future: [],
    selection: [],
    scope: undefined,
    wirePart: null,
    highlight: null,
    placing: null,
    tool: 'select',
    contextMenu: null,
    dialog: null,
    editingSymbol: null,
    symbolSeed: null,
    rightPanel: true,
  });
  // frame the symbol once the canvas has the new page
  setTimeout(() => void import('./actions').then((A) => A.fitView()), 0);
  return true;
}

/** The selected items of `src`, copied into a page of their own (connections to anything left out come loose where they were). */
function selectionDoc(src: CircuitDoc, ids: string[]): CircuitDoc {
  const doc = symbolDoc('New symbol', [], []);
  const take = new Set(ids.filter((id) => src.items[id] && !src.items[id].hidden));
  for (const id of take) {
    const it = structuredClone(src.items[id]) as Item;
    delete it.page;
    if (it.type === 'wire') {
      for (const end of ['a', 'b'] as const) {
        const ep = it[end];
        if (ep.kind === 'port' && !take.has(ep.comp)) {
          const c = src.items[ep.comp];
          const pos = c?.type === 'component' ? portPosition(src, c, ep.port) : null;
          it[end] = pos ? { kind: 'free', x: pos.pt.x, y: pos.pt.y } : { kind: 'free', x: 0, y: 0 };
        } else if (ep.kind === 'junction' && !take.has(ep.id)) {
          const j = src.items[ep.id];
          it[end] = j?.type === 'junction' ? { kind: 'free', x: j.x, y: j.y } : { kind: 'free', x: 0, y: 0 };
        }
      }
    }
    if (it.type === 'shape') {
      if (it.from && !take.has(it.from.id)) delete it.from;
      if (it.to && !take.has(it.to.id)) delete it.to;
      if (it.anchor?.id && !take.has(it.anchor.id)) delete it.anchor.id;
    }
    if (it.type === 'component') {
      const def = src.symbols[it.symbol];
      if (def) doc.symbols[def.id] = def;
      if (def?.variantOf && src.symbols[def.variantOf]) doc.symbols[def.variantOf] = src.symbols[def.variantOf];
    }
    doc.items[id] = it;
  }
  for (const it of Object.values(doc.items)) {
    if (!it.group) continue;
    for (const g of groupChain(src, it.group)) if (src.groups[g]) doc.groups[g] = structuredClone(src.groups[g]);
  }
  return doc;
}

/** Whether the symbol page has changes that would be lost. */
export function symbolDirty(): boolean {
  const s = S();
  return !!s.symbolSession && (s.past.length > 0 || s.symbolSession.metaDirty);
}

/** Changes the symbol's own fields (name, prefix, …). */
export function setSymbolMeta(patch: Partial<SymbolSource>) {
  const s = S().symbolSession;
  if (!s) return;
  set({ symbolSession: { ...s, meta: { ...s.meta, ...patch }, metaDirty: true } });
  if (patch.name !== undefined) set((st) => ({ doc: { ...st.doc, name: patch.name! } }));
  scheduleSymbolDraft();
}

/** Puts the kept unsaved page back. */
export function restoreSymbolDraft() {
  const s = S().symbolSession;
  const d = s?.draft;
  if (!s || !d) return;
  const doc = symbolDoc(d.meta.name, [], [], d.page);
  doc.settings = S().doc.settings;
  set({ symbolSession: { ...s, meta: { ...d.meta }, metaDirty: true, draft: null }, past: [...S().past, S().doc], future: [], doc, selection: [] });
  setTimeout(() => void import('./actions').then((A) => A.fitView()), 0);
}

export function dismissSymbolDraft() {
  const s = S().symbolSession;
  if (!s) return;
  clearSymbolDraft();
  set({ symbolSession: { ...s, draft: null } });
}

/** Leaves the symbol page without saving; the circuit comes back as it was. */
export function closeSymbolEditor() {
  const s = S().symbolSession;
  if (!s) return;
  clearTimeout(draftTimer);
  clearSymbolDraft();
  const st = s.stash;
  set({
    symbolSession: null,
    doc: st.doc,
    page: st.page,
    past: st.past,
    future: st.future,
    dirty: st.dirty,
    filePath: st.filePath,
    view: st.view,
    selection: st.selection.filter((id) => st.doc.items[id]),
    scope: st.scope,
    wirePart: null,
    highlight: null,
    placing: null,
    tool: 'select',
    contextMenu: null,
  });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'symbol';

/**
 * Saves the page as the symbol (a copy with `asNew`) and goes back to the
 * circuit. Returns an error message instead when the page can't become a symbol.
 */
export function saveSymbolEditor(asNew = false): string | null {
  const s = S().symbolSession;
  if (!s) return null;
  let built;
  try {
    built = pageToSymbol(S().doc);
  } catch (e) {
    return (e as Error).message;
  }
  if (!built || (!built.prims.length && !built.ports.length)) return 'Draw something first: the symbol is empty';
  const page = pageOf(S().doc);
  const src: SymbolSource = {
    ...s.meta,
    w: built.w,
    h: built.h,
    draw: primsToDsl(built.prims),
    ports: built.ports.map((p) => `${p.id}:${p.x},${p.y}`).join(' '),
    page,
  };
  const { meta, seedIds, customising } = s;
  const originalId = s.editing;
  const origin = built.origin;
  // back to the circuit first: the saves below are edits of it (one undo step each)
  closeSymbolEditor();

  // ---- an extra "type" of an existing symbol ----
  if (meta.variantOf) {
    const base = getSymbol(S().doc, meta.variantOf);
    const variantName = (meta.variantName ?? '').trim() || `Type ${(base.variants?.length ?? 0) + 2}`;
    const vid = !asNew && meta.id ? meta.id : `user-type-${slug(variantName)}-${uid('').slice(-5)}`;
    const def = compileSource({ ...src, id: vid, name: base.name, category: base.category, prefix: base.prefix, value: meta.value || base.value || '', variants: undefined });
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
    mutate((d) => {
      d.symbols[vid] = def;
      d.symbols[base.id] = mergedBase;
    }, undefined, { allPages: true });
    toast(`Added “${variantName}” as a type of ${base.name}`, 'success');
    return null;
  }

  // ---- a standalone symbol ----
  const id = !asNew && meta.id ? meta.id : `user-${slug(meta.name)}-${uid('').slice(-5)}`;
  // keep the current type list only when overwriting the same symbol; a copy starts without its types
  const existing = !asNew && meta.id ? getSymbol(S().doc, id) : null;
  const def = compileSource({ ...src, id, variants: existing?.id === id ? existing.variants : undefined });
  saveUserSymbol(def);
  // made from a selection: one undoable step swaps those items for the new symbol, where they were
  if (seedIds) {
    let placed = '';
    mutate((d) => void (placed = replaceWithInstance(d as CircuitDoc, seedIds, def, origin)));
    set({ selection: placed ? [placed] : [] });
    toast(`Saved “${def.name}” and placed it in place of the selection`, 'success');
    return null;
  }
  // keep the document copy in sync so placed parts update
  if (S().doc.symbols[id]) mutate((d) => void (d.symbols[id] = def), undefined, { allPages: true });
  // customising a built-in symbol for selected parts swaps it in for them
  if (customising && originalId) {
    const targets = S().selection.filter((sid) => {
      const it = S().doc.items[sid];
      return it?.type === 'component' && it.symbol === originalId;
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
  return null;
}

/** Removes a type from a base symbol; parts using it fall back to the base drawing. */
export function removeSymbolType(baseId: string, vid: string) {
  const s = S().symbolSession;
  const docOf = () => s?.stash.doc ?? S().doc;
  const base = getSymbol(docOf(), baseId);
  const merged: SymbolDef = { ...base, variants: (base.variants ?? []).filter((v) => v.id !== vid) };
  saveUserSymbol(merged);
  deleteUserSymbol(vid);
  const strip = (d: CircuitDoc) => {
    d.symbols[baseId] = merged;
    delete d.symbols[vid];
    for (const it of Object.values(d.items)) if (it.type === 'component' && it.symbol === vid) it.symbol = baseId;
  };
  if (s) {
    // the circuit is set aside while the page is open: change it there (an undo step of its own)
    const next = structuredClone(s.stash.doc);
    strip(next);
    set({ symbolSession: { ...s, stash: { ...s.stash, doc: next, past: [...s.stash.past, s.stash.doc], future: [], dirty: true } } });
  } else mutate((d) => strip(d as CircuitDoc), undefined, { allPages: true });
  toast(`Removed that type of ${base.name}`, 'success');
}

export { PIN_SYMBOL };

/** Replaces everything on the symbol page with a drawing and its pins (chip builder, SVG import, code). One undo step. */
export function replaceSymbolPage(prims: import('../model/types').Prim[], ports: import('../model/types').PortDef[]) {
  if (!S().symbolSession) return;
  mutate(
    (d) => {
      for (const id of Object.keys(d.items)) delete d.items[id];
      d.groups = {};
      const fresh = symbolDoc('', prims, ports);
      // ids are fresh: copy them over as they are
      for (const [id, it] of Object.entries(fresh.items)) d.items[id] = it;
    },
    [],
    { allPages: true },
  );
  setTimeout(() => void import('./actions').then((A) => A.fitView()), 0);
}

/** The page as symbol code (drawing and pin list), for the Code tab. */
export function symbolCode(): { draw: string; ports: string } {
  try {
    const s = pageToSymbol(S().doc);
    if (!s) return { draw: '', ports: '' };
    return { draw: primsToDsl(s.prims), ports: s.ports.map((p) => `${p.id}:${p.x},${p.y}`).join(' ') };
  } catch {
    return { draw: '', ports: '' };
  }
}
