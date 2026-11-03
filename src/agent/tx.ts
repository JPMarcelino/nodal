import { produce, type Draft } from 'immer';
import { settleEdit } from '../model/settle';
import { editPage, resolvePage } from '../model/pages';
import type { CircuitDoc, Group, Item, Page, SymbolDef } from '../model/types';
import { applyExternal, S, sharedDoc } from '../store/store';

/**
 * Agent edits. Every call works on its own copy of the circuit (a
 * transaction), which is folded into the app in one go when the call (or a
 * whole batch) ends — through the store's applyExternal, the same door a live
 * session's remote edits use. So the agent's edits never touch the user's
 * selection, tool, page, view or running drag, and stay off the user's undo
 * stack (the agent has its own, below).
 */

export class AgentError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** One agent step as a change set: for each key, the value after (null = removed). */
export interface DocDiff {
  items: Record<string, Item | null>;
  groups: Record<string, Group | null>;
  symbols: Record<string, SymbolDef | null>;
  settings?: CircuitDoc['settings'];
  /** Page list after (null = no explicit pages). */
  pages?: Page[] | null;
  name?: string;
}

export interface AgentStep {
  label: string;
  /** What the step did, and what it replaced. */
  after: DocDiff;
  before: DocDiff;
}

const emptyDiff = (): DocDiff => ({ items: {}, groups: {}, symbols: {} });

function diffRecord<T>(a: Record<string, T> | undefined, b: Record<string, T> | undefined, out: Record<string, T | null>, back: Record<string, T | null>) {
  if (a === b) return;
  const A = a ?? {};
  const B = b ?? {};
  for (const k in B) if (A[k] !== B[k]) [out[k], back[k]] = [B[k], A[k] ?? null];
  for (const k in A) if (!(k in B)) [out[k], back[k]] = [null, A[k]];
}

/** The change from `a` to `b`, both ways. */
export function diffDocs(a: CircuitDoc, b: CircuitDoc): { after: DocDiff; before: DocDiff } {
  const after = emptyDiff();
  const before = emptyDiff();
  diffRecord(a.items, b.items, after.items, before.items);
  diffRecord(a.groups, b.groups, after.groups, before.groups);
  diffRecord(a.symbols, b.symbols, after.symbols, before.symbols);
  if (a.settings !== b.settings) [after.settings, before.settings] = [b.settings, a.settings];
  if (a.pages !== b.pages) [after.pages, before.pages] = [b.pages ?? null, a.pages ?? null];
  if (a.name !== b.name) [after.name, before.name] = [b.name, a.name];
  return { after, before };
}

export const diffEmpty = (d: DocDiff) =>
  !Object.keys(d.items).length && !Object.keys(d.groups).length && !Object.keys(d.symbols).length && d.settings === undefined && d.pages === undefined && d.name === undefined;

function patchRecord<T>(rec: Record<string, T> | undefined, ch: Record<string, T | null>): Record<string, T> {
  const out = { ...(rec ?? {}) };
  for (const k in ch) {
    const v = ch[k];
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** Writes a change set into a document (any document: the current one, or one in the user's undo history). */
export function applyDiff(doc: CircuitDoc, d: DocDiff): CircuitDoc {
  const next: CircuitDoc = { ...doc };
  if (Object.keys(d.items).length) next.items = patchRecord(doc.items, d.items);
  if (Object.keys(d.groups).length) next.groups = patchRecord(doc.groups, d.groups);
  if (Object.keys(d.symbols).length) next.symbols = patchRecord(doc.symbols, d.symbols);
  if (d.settings !== undefined) next.settings = d.settings;
  if (d.pages !== undefined) {
    if (d.pages === null) delete next.pages;
    else next.pages = d.pages;
  }
  if (d.name !== undefined) next.name = d.name;
  return next;
}

/* ------------------------------------------------------------------ */
/* Transactions                                                        */
/* ------------------------------------------------------------------ */

export interface EditOpts {
  /** Edit the whole document instead of one page (page list, settings, cross-page moves). */
  allPages?: boolean;
  /** Tidy connections afterwards (parts landing on wires join them…); default true for page edits. */
  settle?: boolean;
}

export class Tx {
  readonly base: CircuitDoc;
  doc: CircuitDoc;
  /** Items the calls explicitly worked on (for the cursor and flash), in addition to everything the diff shows. */
  focus = new Set<string>();
  /** Page the work happened on (for the cursor and follow). */
  page?: string;

  constructor(
    public agentPage: () => string | undefined,
    base: CircuitDoc = sharedDoc(),
  ) {
    this.base = base;
    this.doc = base;
  }

  /** The page a call means: an id, a name (any case), or (unset) the agent's working page. */
  resolvePage(page?: string | null): string {
    const doc = this.doc;
    if (page) {
      const pages = doc.pages ?? [];
      const hit = pages.find((p) => p.id === page) ?? pages.find((p) => p.name.toLowerCase() === String(page).toLowerCase());
      if (hit) return hit.id;
      if (resolvePage(doc, page) === page) return page;
      throw new AgentError('bad_page', `No page "${page}" (pages.list shows them)`);
    }
    return resolvePage(doc, this.agentPage());
  }

  /** Applies an edit to one page (default the agent's) or, with allPages, to the whole document. */
  edit(page: string | null | undefined, recipe: (d: Draft<CircuitDoc>, view: CircuitDoc) => void, opts: EditOpts = {}): CircuitDoc {
    assertWritable();
    if (opts.allPages) {
      this.doc = produce(this.doc, (d) => void recipe(d, this.doc));
      return this.doc;
    }
    const p = this.resolvePage(page);
    this.page = p;
    this.doc = editPage(this.doc, p, recipe, opts.settle === false ? undefined : settleEdit);
    return this.doc;
  }

  touch(ids: Iterable<string>, page?: string) {
    for (const id of ids) this.focus.add(id);
    if (page) this.page = page;
  }
}

/** Throws when the circuit can't be changed (a view-only live session, or the user's View mode). */
export function assertWritable() {
  const s = S();
  if (s.viewOnly) throw new AgentError('read_only', 'The app is a guest in a view-only live session: the circuit cannot be changed.');
  if (s.viewMode) throw new AgentError('read_only', 'The user has View mode on: the circuit cannot be changed until they turn it off.');
}

/** Set while the agent's own change is being folded in (the guard lets it through). */
export let agentApplying = false;

/** Folds a change set into the app; not undoable by the user, like a collaborator's edit. */
export function commitDiff(d: DocDiff) {
  agentApplying = true;
  try {
    applyExternal((doc) => applyDiff(doc, d));
  } finally {
    agentApplying = false;
  }
}

/** Runs `fn` with the guard letting store writes through (the agent replacing the whole document). */
export function asAgent<T>(fn: () => T): T {
  agentApplying = true;
  try {
    return fn();
  } finally {
    agentApplying = false;
  }
}

/* ------------------------------------------------------------------ */
/* The agent's own undo                                                */
/* ------------------------------------------------------------------ */

const STEP_LIMIT = 200;
export const agentPast: AgentStep[] = [];
export const agentFuture: AgentStep[] = [];

export function recordStep(step: AgentStep) {
  agentPast.push(step);
  if (agentPast.length > STEP_LIMIT) agentPast.shift();
  agentFuture.length = 0;
}

export function clearSteps() {
  agentPast.length = 0;
  agentFuture.length = 0;
}

/** Keys of a change set whose current value is no longer what the step left (someone changed them since). */
export function conflicts(doc: CircuitDoc, d: DocDiff): string[] {
  const out: string[] = [];
  for (const k in d.items) if ((doc.items[k] ?? null) !== d.items[k]) out.push(k);
  for (const k in d.groups) if ((doc.groups?.[k] ?? null) !== d.groups[k]) out.push(`group:${k}`);
  for (const k in d.symbols) if ((doc.symbols?.[k] ?? null) !== d.symbols[k]) out.push(`symbol:${k}`);
  if (d.settings !== undefined && doc.settings !== d.settings) out.push('settings');
  if (d.pages !== undefined && (doc.pages ?? null) !== d.pages) out.push('pages');
  return out;
}
