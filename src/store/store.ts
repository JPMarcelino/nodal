import { produce, type Draft } from 'immer';
import { create } from 'zustand';
import { createDoc, groupMembers, normalizeDoc, topGroup } from '../model/doc';
import { setUserLibrary, usedSymbols } from '../model/registry';
import { sampleDoc } from '../model/sample';
import type { SelectionDrawing } from '../model/fromSelection';
import type { CircuitDoc, Point, SymbolDef, Tool, WireAngle } from '../model/types';
import { settleEdit } from '../model/settle';

export interface View {
  x: number;
  y: number;
  zoom: number;
}

/** Pending "draw a rectangle and export its contents" job. */
export interface ExportAreaJob {
  kind: 'png' | 'svg';
  theme: 'light' | 'dark';
  background: boolean;
  scale: number;
}

export interface Placing {
  symbol: string;
  rot: 0 | 90 | 180 | 270;
  flipX: boolean;
  /** Keep placing copies after each click. */
  repeat: boolean;
}

/** A node or segment of a wire, or a polygon corner (edit points tool), selected for deletion. */
export interface WirePartSel {
  /** Wire or polygon id. */
  wire: string;
  kind: 'node' | 'segment';
  index: number;
}

export interface ContextMenuState {
  x: number;
  y: number;
  world: Point;
  target: string | null;
}

export type Dialog = null | 'palette' | 'find' | 'shortcuts' | 'settings' | 'symbol-editor' | 'about' | 'export' | 'share' | 'video';

export interface Prefs {
  theme: 'dark' | 'light';
  keymap: Record<string, string[]>;
  /** Custom keys of the Cadence scheme. */
  keymapCadence: Record<string, string[]>;
  wheel: 'zoom' | 'pan';
  /** What one finger does on a touch screen: draw (use tools), pan, or pan once a stylus has been used. */
  touch: 'auto' | 'draw' | 'pan';
  autosave: boolean;
  showMinimap: boolean;
  showPortMarkers: boolean;
  uiScale: number;
  /** Shortcut scheme: Nodal's own, or Cadence Virtuoso schematic bindkeys. */
  shortcuts: 'nodal' | 'cadence';
  /** New wires route around instances and stay off unrelated terminals. */
  wireAvoid: boolean;
  /** Alignment guides (and snapping to them) while moving. */
  alignGuides: boolean;
  /** Widths of the library (left) and properties (right) panels, in px. */
  leftWidth: number;
  rightWidth: number;
  /** Angles new wires are drawn at. */
  wireAngle: WireAngle;
}


export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

export interface AppState {
  doc: CircuitDoc;
  selection: string[];
  /** A node or segment of the selected wire, for part-level deletion. */
  wirePart: WirePartSel | null;
  /** Group currently entered (double-click into a group). */
  scope?: string;
  tool: Tool;
  /** Alt move (Shift+M): moving leaves connections behind instead of dragging wires along. */
  altMove: boolean;
  view: View;
  past: CircuitDoc[];
  future: CircuitDoc[];
  dirty: boolean;
  filePath: string | null;
  placing: Placing | null;
  highlight: Set<string> | null;
  /** Items hovered in the layers panel (outlined on the canvas). */
  layerHover: string[];
  contextMenu: ContextMenuState | null;
  dialog: Dialog;
  editingSymbol: string | null;
  /** Drawing made from a selection, opened in the symbol editor; saving replaces those items with the new symbol. */
  symbolSeed: (SelectionDrawing & { ids: string[] }) | null;
  leftPanel: boolean;
  rightPanel: boolean;
  leftTab: 'library' | 'layers' | 'check' | 'history';
  prefs: Prefs;
  userLibrary: Record<string, SymbolDef>;
  favorites: string[];
  recent: string[];
  toasts: Toast[];
  cursor: Point;
  /** Whether the mouse is over the canvas (so paste can land under it). */
  pointerOnCanvas: boolean;
  canvasSize: { w: number; h: number };
  /** Wire style applied to newly drawn wires. */
  wireBrush: { color?: string; width?: number; radius?: number; dash?: 'solid' | 'dashed' | 'dotted' } | null;
  /** When set, the next drag on the canvas defines an export rectangle. */
  exportArea: ExportAreaJob | null;
  /** Viewing someone else's live session: the circuit can't be changed. */
  viewOnly: boolean;
}

const LS = {
  doc: 'nodal.doc',
  prefs: 'nodal.prefs',
  lib: 'nodal.library',
  fav: 'nodal.favorites',
  recent: 'nodal.recent',
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

const DEFAULT_PREFS: Prefs = {
  theme: 'dark',
  keymap: {},
  keymapCadence: {},
  wheel: 'zoom',
  touch: 'auto',
  autosave: true,
  showMinimap: true,
  showPortMarkers: true,
  uiScale: 1,
  shortcuts: 'nodal',
  wireAvoid: true,
  alignGuides: true,
  leftWidth: 280,
  rightWidth: 290,
  wireAngle: 'ortho',
};

function initialDoc(): CircuitDoc {
  try {
    const raw = localStorage.getItem(LS.doc);
    if (raw) return normalizeDoc(JSON.parse(raw));
  } catch {
    /* ignore corrupt autosave */
  }
  return sampleDoc();
}

const userLibrary = load<Record<string, SymbolDef>>(LS.lib, {});
setUserLibrary(userLibrary);

export const useStore = create<AppState>(() => ({
  doc: initialDoc(),
  selection: [],
  wirePart: null,
  scope: undefined,
  tool: 'select',
  altMove: false,
  view: { x: 0, y: 0, zoom: 1 },
  past: [],
  future: [],
  dirty: false,
  filePath: null,
  placing: null,
  highlight: null,
  layerHover: [],
  contextMenu: null,
  dialog: null,
  editingSymbol: null,
  symbolSeed: null,
  leftPanel: true,
  rightPanel: true,
  leftTab: 'library',
  prefs: { ...DEFAULT_PREFS, ...load<Partial<Prefs>>(LS.prefs, {}) },
  userLibrary,
  favorites: load<string[]>(LS.fav, []),
  recent: load<string[]>(LS.recent, []),
  toasts: [],
  cursor: { x: 0, y: 0 },
  pointerOnCanvas: false,
  canvasSize: { w: 800, h: 600 },
  wireBrush: null,
  exportArea: null,
  viewOnly: false,
}));

export const S = () => useStore.getState();
export const set = (p: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => useStore.setState(p);

/* ------------------------------------------------------------------ */
/* History-aware mutation                                              */
/* ------------------------------------------------------------------ */

const HISTORY_LIMIT = 300;
let gestureBase: CircuitDoc | null = null;

export function mutate(recipe: (d: Draft<CircuitDoc>) => void, selection?: string[]) {
  const s = S();
  if (s.viewOnly) {
    if (selection) set({ selection });
    return;
  }
  // the recipe's return value is ignored on purpose: Immer would otherwise use it as the new
  // document (e.g. `(d) => (d.settings.hops = 'arc')` returns 'arc' when nothing changed)
  const changed = produce(s.doc, (d) => {
    recipe(d);
  });
  // parts placed or moved onto wires connect to them (not mid-drag: only when the edit is committed)
  const next = gestureBase ? changed : settleEdit(s.doc, changed);
  if (next === s.doc) {
    if (selection) set({ selection });
    return;
  }
  set({
    doc: next,
    past: gestureBase ? s.past : [...s.past.slice(-HISTORY_LIMIT), s.doc],
    future: gestureBase ? s.future : [],
    dirty: true,
    ...(selection ? { selection } : {}),
  });
}

/** Starts a continuous edit (drag); intermediate states are not recorded. */
/** Document to restore on cancel / record for undo; differs from gestureBase when the gesture started from a staged change (a copy being placed). */
let gestureUndo: CircuitDoc | null = null;

export function beginGesture(undoBase?: CircuitDoc) {
  gestureBase = S().doc;
  gestureUndo = undoBase ?? gestureBase;
}

/** Makes the current document the base later gestureUpdate calls apply to (undo still returns to where the gesture began). */
export function rebaseGesture() {
  if (gestureBase) gestureBase = S().doc;
}

/** Re-applies a recipe against the gesture's starting document. */
export function gestureUpdate(recipe: (d: Draft<CircuitDoc>, base: CircuitDoc) => void) {
  if (!gestureBase || S().viewOnly) return;
  const base = gestureBase;
  set({
    doc: produce(base, (d) => {
      recipe(d, base);
    }),
  });
}

export function endGesture(commit = true) {
  const base = gestureUndo;
  gestureBase = null;
  gestureUndo = null;
  if (!base) return;
  const s = S();
  if (!commit || s.viewOnly) {
    set({ doc: base });
    return;
  }
  if (s.doc !== base) set({ doc: settleEdit(base, s.doc), past: [...s.past.slice(-HISTORY_LIMIT), base], future: [], dirty: true });
}

export const inGesture = () => gestureBase !== null;

/** Document the running gesture applies its updates to. */
export const gestureBaseDoc = () => gestureBase;

export function undo() {
  const s = S();
  if (!s.past.length || s.viewOnly) return;
  const prev = s.past[s.past.length - 1];
  set({ doc: prev, past: s.past.slice(0, -1), future: [s.doc, ...s.future], dirty: true, selection: s.selection.filter((id) => prev.items[id]), wirePart: null });
}

export function redo() {
  const s = S();
  if (!s.future.length || s.viewOnly) return;
  const next = s.future[0];
  set({ doc: next, future: s.future.slice(1), past: [...s.past, s.doc], dirty: true, selection: s.selection.filter((id) => next.items[id]), wirePart: null });
}

/**
 * Applies a change made by someone else in a live session. It is not undoable,
 * and it is written into the undo history too, so undo only ever reverts the
 * local user's own edits.
 */
export function applyExternal(patch: (doc: CircuitDoc) => CircuitDoc) {
  const s = S();
  if (gestureBase) {
    const same = gestureUndo === gestureBase;
    gestureBase = patch(gestureBase);
    gestureUndo = same ? gestureBase : gestureUndo && patch(gestureUndo);
  }
  const doc = patch(s.doc);
  // a node/segment sub-selection only survives if its wire was left untouched
  const wirePart = s.wirePart && doc.items[s.wirePart.wire] === s.doc.items[s.wirePart.wire] ? s.wirePart : null;
  set({ doc, past: s.past.map(patch), future: s.future.map(patch), selection: s.selection.filter((id) => doc.items[id]), wirePart });
}

let autosavePaused = false;
/** Stops autosave from overwriting the local circuit (e.g. while a shared one is open). */
export function pauseAutosave(paused: boolean) {
  autosavePaused = paused;
}

export function replaceDoc(doc: CircuitDoc, filePath: string | null = null) {
  set({ doc, past: [], future: [], selection: [], scope: undefined, dirty: false, filePath, highlight: null, wirePart: null });
}

export function newDoc() {
  replaceDoc(createDoc());
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

/** Expands ids to whole groups relative to the current scope. */
export function expandToGroups(ids: string[]): string[] {
  const { doc, scope } = S();
  const out = new Set<string>();
  for (const id of ids) {
    const it = doc.items[id];
    if (!it) continue;
    const g = topGroup(doc, it, scope);
    if (g) groupMembers(doc, g).forEach((m) => out.add(m));
    else out.add(id);
  }
  return [...out];
}

export function select(ids: string[], mode: 'replace' | 'add' | 'toggle' = 'replace') {
  const expanded = expandToGroups(ids);
  const cur = new Set(S().selection);
  // selecting items always drops any node/segment sub-selection
  if (mode === 'replace') return set({ selection: expanded, wirePart: null });
  if (mode === 'add') {
    expanded.forEach((id) => cur.add(id));
    return set({ selection: [...cur], wirePart: null });
  }
  const allIn = expanded.every((id) => cur.has(id));
  expanded.forEach((id) => (allIn ? cur.delete(id) : cur.add(id)));
  set({ selection: [...cur], wirePart: null });
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = ++toastId;
  set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 2600);
}

/* ------------------------------------------------------------------ */
/* Preferences & persistence                                           */
/* ------------------------------------------------------------------ */

export function setPrefs(p: Partial<Prefs>) {
  set((s) => ({ prefs: { ...s.prefs, ...p } }));
  localStorage.setItem(LS.prefs, JSON.stringify(S().prefs));
}

export function saveUserSymbol(def: SymbolDef) {
  const lib = { ...S().userLibrary, [def.id]: def };
  setUserLibrary(lib);
  set({ userLibrary: lib });
  localStorage.setItem(LS.lib, JSON.stringify(lib));
}

/** Merges a set of symbols into "My symbols" (used by share / import). */
export function mergeUserSymbols(incoming: Record<string, SymbolDef>): void {
  const lib = { ...S().userLibrary, ...incoming };
  setUserLibrary(lib);
  set({ userLibrary: lib });
  localStorage.setItem(LS.lib, JSON.stringify(lib));
}

export function deleteUserSymbol(id: string) {
  const lib = { ...S().userLibrary };
  delete lib[id];
  setUserLibrary(lib);
  set({ userLibrary: lib });
  localStorage.setItem(LS.lib, JSON.stringify(lib));
}

/**
 * Deletes a symbol (and its extra types) from "My symbols". The open circuit
 * keeps its copy only while parts still use it; otherwise that copy goes too,
 * or the library tile would stay (the library also lists circuit symbols).
 */
export function removeSymbolFromLibrary(id: string): { inUse: number } {
  const { doc, userLibrary } = S();
  const ids = [id, ...Object.values({ ...doc.symbols, ...userLibrary }).filter((d) => d.variantOf === id).map((d) => d.id)];
  // same fold as registry.usedSymbols: a base counts as used while any of its types is placed
  const used = usedSymbols(doc);
  for (const sid of ids) deleteUserSymbol(sid);
  const unused = ids.filter((sid) => doc.symbols[sid] && !used.has(sid));
  if (unused.length) mutate((d) => unused.forEach((sid) => delete d.symbols[sid]));
  // distinct parts using the family (a part placed as a type counts once, not twice)
  const family = new Set(ids);
  const inUse = Object.values(doc.items).filter((it) => {
    if (it.type !== 'component') return false;
    if (family.has(it.symbol)) return true;
    const base = doc.symbols[it.symbol]?.variantOf;
    return !!base && family.has(base);
  }).length;
  return { inUse };
}

export function toggleFavorite(id: string) {
  const fav = S().favorites.includes(id) ? S().favorites.filter((f) => f !== id) : [...S().favorites, id];
  set({ favorites: fav });
  localStorage.setItem(LS.fav, JSON.stringify(fav));
}

export function pushRecent(id: string) {
  const recent = [id, ...S().recent.filter((r) => r !== id)].slice(0, 8);
  set({ recent });
  localStorage.setItem(LS.recent, JSON.stringify(recent));
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((s, prev) => {
  if (s.doc === prev.doc || !s.prefs.autosave || autosavePaused) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(autosaveNow, 600);
});

function autosaveNow() {
  saveTimer = undefined;
  const doc = S().doc;
  // never overwrite the last good autosave with something that isn't a circuit
  if (!doc || typeof doc !== 'object' || doc.format !== 'nodal' || typeof doc.items !== 'object' || !doc.settings) return;
  try {
    localStorage.setItem(LS.doc, JSON.stringify(doc));
  } catch {
    /* quota exceeded — ignore */
  }
}

if (typeof window !== 'undefined') {
  // an edit made just before the page goes away is still written
  window.addEventListener('pagehide', () => saveTimer !== undefined && (clearTimeout(saveTimer), autosaveNow()));
  // leaving with changes that exist nowhere else (autosave off, or not yet saved to the open file)
  window.addEventListener('beforeunload', (e) => {
    const s = S();
    if (!s.dirty || !Object.keys(s.doc.items).length || (s.prefs.autosave && !s.filePath)) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

if (import.meta.env.DEV) (window as unknown as { __nodal: unknown }).__nodal = { S, set };
