import { produce, type Draft } from 'immer';
import { create } from 'zustand';
import { createDoc, groupMembers, normalizeDoc, topGroup } from '../model/doc';
import { setUserLibrary } from '../model/registry';
import { sampleDoc } from '../model/sample';
import type { SelectionDrawing } from '../model/fromSelection';
import type { CircuitDoc, Point, SymbolDef, Tool } from '../model/types';

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

/** A single vertex ("node") or one segment of a wire, selected for deletion. */
export interface WirePartSel {
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

export type Dialog = null | 'palette' | 'shortcuts' | 'settings' | 'symbol-editor' | 'about' | 'export' | 'share';

export interface Prefs {
  theme: 'dark' | 'light';
  keymap: Record<string, string[]>;
  wheel: 'zoom' | 'pan';
  autosave: boolean;
  showMinimap: boolean;
  showPortMarkers: boolean;
  uiScale: number;
  /** Finish click-to-click wiring as soon as the wire reaches an existing wire end, junction or bend. */
  autoFinishWire: boolean;
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
  leftTab: 'library' | 'layers';
  prefs: Prefs;
  userLibrary: Record<string, SymbolDef>;
  favorites: string[];
  recent: string[];
  toasts: Toast[];
  cursor: Point;
  canvasSize: { w: number; h: number };
  /** Wire style applied to newly drawn wires. */
  wireBrush: { color?: string; width?: number; radius?: number; dash?: 'solid' | 'dashed' | 'dotted' } | null;
  /** When set, the next drag on the canvas defines an export rectangle. */
  exportArea: ExportAreaJob | null;
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
  wheel: 'zoom',
  autosave: true,
  showMinimap: true,
  showPortMarkers: true,
  uiScale: 1,
  autoFinishWire: true,
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
  canvasSize: { w: 800, h: 600 },
  wireBrush: null,
  exportArea: null,
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
  // the recipe's return value is ignored on purpose: Immer would otherwise use it as the new
  // document (e.g. `(d) => (d.settings.hops = 'arc')` returns 'arc' when nothing changed)
  const next = produce(s.doc, (d) => {
    recipe(d);
  });
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
export function beginGesture() {
  gestureBase = S().doc;
}

/** Re-applies a recipe against the gesture's starting document. */
export function gestureUpdate(recipe: (d: Draft<CircuitDoc>, base: CircuitDoc) => void) {
  if (!gestureBase) return;
  const base = gestureBase;
  set({
    doc: produce(base, (d) => {
      recipe(d, base);
    }),
  });
}

export function endGesture(commit = true) {
  const base = gestureBase;
  gestureBase = null;
  if (!base) return;
  const s = S();
  if (!commit) {
    set({ doc: base });
    return;
  }
  if (s.doc !== base) set({ past: [...s.past.slice(-HISTORY_LIMIT), base], future: [], dirty: true });
}

export const inGesture = () => gestureBase !== null;

export function undo() {
  const s = S();
  if (!s.past.length) return;
  const prev = s.past[s.past.length - 1];
  set({ doc: prev, past: s.past.slice(0, -1), future: [s.doc, ...s.future], dirty: true, selection: s.selection.filter((id) => prev.items[id]) });
}

export function redo() {
  const s = S();
  if (!s.future.length) return;
  const next = s.future[0];
  set({ doc: next, future: s.future.slice(1), past: [...s.past, s.doc], dirty: true, selection: s.selection.filter((id) => next.items[id]) });
}

/**
 * Applies a change made by someone else in a live session. It is not undoable,
 * and it is written into the undo history too, so undo only ever reverts the
 * local user's own edits.
 */
export function applyExternal(patch: (doc: CircuitDoc) => CircuitDoc) {
  const s = S();
  if (gestureBase) gestureBase = patch(gestureBase);
  const doc = patch(s.doc);
  set({ doc, past: s.past.map(patch), future: s.future.map(patch), selection: s.selection.filter((id) => doc.items[id]) });
}

let autosavePaused = false;
/** Stops autosave from overwriting the local circuit (e.g. while a shared one is open). */
export function pauseAutosave(paused: boolean) {
  autosavePaused = paused;
}

export function replaceDoc(doc: CircuitDoc, filePath: string | null = null) {
  set({ doc, past: [], future: [], selection: [], scope: undefined, dirty: false, filePath, highlight: null });
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
  const uses = (sid: string) => Object.values(doc.items).filter((it) => it.type === 'component' && it.symbol === sid).length;
  for (const sid of ids) deleteUserSymbol(sid);
  const unused = ids.filter((sid) => doc.symbols[sid] && !uses(sid));
  if (unused.length) mutate((d) => unused.forEach((sid) => delete d.symbols[sid]));
  return { inUse: ids.reduce((n, sid) => n + uses(sid), 0) };
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
  saveTimer = setTimeout(() => {
    const doc = S().doc;
    // never overwrite the last good autosave with something that isn't a circuit
    if (!doc || typeof doc !== 'object' || doc.format !== 'nodal' || typeof doc.items !== 'object' || !doc.settings) return;
    try {
      localStorage.setItem(LS.doc, JSON.stringify(doc));
    } catch {
      /* quota exceeded — ignore */
    }
  }, 600);
});

if (import.meta.env.DEV) (window as unknown as { __nodal: unknown }).__nodal = { S, set };
