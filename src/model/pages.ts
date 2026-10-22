import { produce, type Draft } from 'immer';
import { groupChain, uid } from './doc';
import type { CircuitDoc, Group, Item, Page } from './types';

/**
 * Pages (sheets): every item sits on one page (`item.page`, unset = the first
 * one). The canvas only ever sees the active page through `viewDoc`, a
 * document-shaped copy holding just that page's items, and edits made there
 * are folded back into the whole document with `mergeView`. Netlist, rule
 * check and exports read the whole document, so nets join across pages by
 * label name, as in multi-sheet schematics.
 */

/** Id of the one page of a document that has never had pages added. */
export const FIRST_PAGE = 'page1';

/** The one page of a document without a page list (shared, so it is stable between calls). */
const IMPLICIT: readonly Page[] = Object.freeze([Object.freeze({ id: FIRST_PAGE, name: 'Page 1' })]);

export function docPages(doc: Pick<CircuitDoc, 'pages'>): readonly Page[] {
  return doc.pages?.length ? doc.pages : IMPLICIT;
}

export const firstPage = (doc: Pick<CircuitDoc, 'pages'>) => docPages(doc)[0].id;

/** A page id that exists in the document (unknown or unset = the first page). */
export function resolvePage(doc: Pick<CircuitDoc, 'pages'>, page?: string | null): string {
  const pages = docPages(doc);
  return (page && pages.find((p) => p.id === page)?.id) || pages[0].id;
}

/** Whether two page ids (either may be unset or stale) name the same page. */
export const samePage = (doc: Pick<CircuitDoc, 'pages'>, a?: string | null, b?: string | null) => resolvePage(doc, a) === resolvePage(doc, b);

export const itemPage = (doc: Pick<CircuitDoc, 'pages'>, it: Pick<Item, 'page'>) => resolvePage(doc, it.page);

export const pageIndex = (doc: Pick<CircuitDoc, 'pages'>, page?: string | null) => docPages(doc).findIndex((p) => p.id === resolvePage(doc, page));

export const multiPage = (doc: Pick<CircuitDoc, 'pages'>) => (doc.pages?.length ?? 0) > 1;

/** Ids of the items on a page. */
export function pageItemIds(doc: CircuitDoc, page?: string | null): string[] {
  const p = resolvePage(doc, page);
  return Object.values(doc.items).filter((it) => itemPage(doc, it) === p).map((it) => it.id);
}

const views = new WeakMap<CircuitDoc, Map<string, CircuitDoc>>();
const pageOfView = new WeakMap<CircuitDoc, string>();
const viewSources = new WeakMap<CircuitDoc, CircuitDoc>();

/** The page a view shows (a whole document: its first page). */
export const viewPage = (doc: CircuitDoc) => pageOfView.get(doc) ?? firstPage(doc);

/** The whole document a page view was made from (undefined for a document that is its own view). */
export const viewSource = (view: CircuitDoc): CircuitDoc | undefined => viewSources.get(view);

/** "Sheet n / m" text of the page a view shows; null for a one-page document (the sheet field is then typed in). */
export function sheetNumber(doc: CircuitDoc): string | null {
  if (!multiPage(doc)) return null;
  return `${pageIndex(doc, viewPage(doc)) + 1} / ${docPages(doc).length}`;
}

/**
 * The document as seen on one page: same settings, symbols and pages, but
 * only that page's items (and the groups they use). Memoised per document, so
 * it is cheap to call on every render; a one-page document is its own view.
 */
export function viewDoc(doc: CircuitDoc, page?: string | null): CircuitDoc {
  if (!multiPage(doc)) return doc;
  const p = resolvePage(doc, page);
  let byPage = views.get(doc);
  const hit = byPage?.get(p);
  if (hit) return hit;
  const items: Record<string, Item> = {};
  const here = new Set<string>();
  const elsewhere = new Set<string>();
  for (const it of Object.values(doc.items)) {
    const on = itemPage(doc, it) === p;
    if (on) items[it.id] = it;
    for (const g of groupChain(doc, it.group)) (on ? here : elsewhere).add(g);
  }
  // a page keeps its own groups, plus any group no item uses yet
  const groups: Record<string, Group> = {};
  for (const g of Object.values(doc.groups)) if (here.has(g.id) || !elsewhere.has(g.id)) groups[g.id] = g;
  const view: CircuitDoc = { ...doc, items, groups };
  pageOfView.set(view, p);
  viewSources.set(view, doc);
  if (!byPage) views.set(doc, (byPage = new Map()));
  byPage.set(p, view);
  return view;
}

/**
 * Folds an edited page view back into the whole document: items of other
 * pages are kept as they are (in their original order), the page's items are
 * replaced, deleted or added, and anything added lands on `page`.
 */
export function mergeView(full: CircuitDoc, view: CircuitDoc, next: CircuitDoc, page?: string | null): CircuitDoc {
  if (next === view) return full;
  if (view === full) return next;
  const p = resolvePage(full, page);
  const onPage = (it: Item) => (itemPage(full, it) === p ? it : { ...it, page: p });
  let items = full.items;
  if (next.items !== view.items) {
    items = {};
    for (const [id, it] of Object.entries(full.items)) {
      if (!(id in view.items)) items[id] = it;
      else if (next.items[id]) items[id] = onPage(next.items[id]);
    }
    for (const [id, it] of Object.entries(next.items)) if (!(id in view.items)) items[id] = onPage(it);
  }
  let groups = full.groups;
  if (next.groups !== view.groups) {
    groups = {};
    for (const [id, g] of Object.entries(full.groups)) if (!(id in view.groups) || next.groups[id]) groups[id] = next.groups[id] ?? g;
    Object.assign(groups, next.groups);
  }
  return { ...next, items, groups };
}

/**
 * Applies an edit to one page of the document only (what the canvas does): it
 * cannot see or touch the other pages. `after` post-processes the edited page
 * (e.g. settling connections) before it is folded back.
 */
export function editPage(
  doc: CircuitDoc,
  page: string | null | undefined,
  recipe: (d: Draft<CircuitDoc>, view: CircuitDoc) => void,
  after?: (view: CircuitDoc, next: CircuitDoc) => CircuitDoc,
): CircuitDoc {
  const view = viewDoc(doc, page);
  const edit = () => {
    const next = produce(view, (d) => void recipe(d, view));
    return after ? after(view, next) : next;
  };
  // each page names its parts on its own, so an edit only ever sees its page
  if (view === doc) return edit();
  return mergeView(doc, view, edit(), page);
}

/* ------------------------------------------------------------------ */
/* Page list (draft edits; callers record them as one undo step)        */
/* ------------------------------------------------------------------ */

/** Gives every item an explicit page, so reordering or deleting the first page can't move "unset" items. */
export function pinPages(d: CircuitDoc) {
  if (!d.pages?.length) d.pages = docPages(d).map((p) => ({ ...p }));
  for (const it of Object.values(d.items)) {
    const p = itemPage(d, it);
    if (it.page !== p) it.page = p;
  }
}

/** A page name not yet taken: "Page 2", "Page 3"… */
export function nextPageName(doc: Pick<CircuitDoc, 'pages'>): string {
  const names = new Set(docPages(doc).map((p) => p.name));
  let n = docPages(doc).length + 1;
  while (names.has(`Page ${n}`)) n++;
  return `Page ${n}`;
}

/** Adds an empty page after `after` (default: at the end); returns its id. */
export function addPage(d: CircuitDoc, name?: string, after?: string): string {
  const label = name?.trim() || nextPageName(d);
  if (!d.pages?.length) d.pages = docPages(d).map((p) => ({ ...p }));
  const id = uid('pg');
  const at = after ? d.pages.findIndex((p) => p.id === after) : -1;
  d.pages.splice(at < 0 ? d.pages.length : at + 1, 0, { id, name: label });
  return id;
}

export function renamePage(d: CircuitDoc, id: string, name: string) {
  const v = name.trim();
  if (!v) return;
  if (!d.pages?.length) d.pages = docPages(d).map((p) => ({ ...p }));
  const p = d.pages.find((pg) => pg.id === id);
  if (p) p.name = v;
}

/** Moves a page to position `to` of the tab row. */
export function movePage(d: CircuitDoc, id: string, to: number) {
  if (!d.pages?.length) return;
  const pages = d.pages;
  const from = pages.findIndex((p) => p.id === id);
  if (from < 0) return;
  const at = Math.max(0, Math.min(pages.length - 1, to));
  if (at === from) return;
  // untagged items belong to the first page: tag them before it changes
  if (from === 0 || at === 0) pinPages(d);
  const [p] = pages.splice(from, 1);
  pages.splice(at, 0, p);
}

/** Normalises the page list of a loaded document: ids are unique and named, item pages point at a real page (unknown → the first one). */
export function normalizePages(doc: CircuitDoc): CircuitDoc {
  const raw = Array.isArray(doc.pages) ? doc.pages : [];
  const seen = new Set<string>();
  const pages: Page[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    pages.push({ id: p.id, name: typeof p.name === 'string' && p.name.trim() ? p.name : `Page ${pages.length + 1}` });
  }
  const first = pages[0]?.id;
  // the first page's items need no tag; anything pointing nowhere goes there too
  const stray = (it: Item) => it.page !== undefined && (typeof it.page !== 'string' || !seen.has(it.page) || it.page === first);
  let items = doc.items;
  if (Object.values(items).some(stray)) {
    items = {};
    for (const [id, it] of Object.entries(doc.items)) {
      if (!stray(it)) items[id] = it;
      else {
        const rest = { ...it };
        delete rest.page;
        items[id] = rest;
      }
    }
  }
  const out: CircuitDoc = { ...doc, items };
  if (pages.length) out.pages = pages;
  else delete out.pages;
  return out;
}
