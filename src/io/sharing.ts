import { docBounds, uid } from '../model/doc';
import { cleanup, extractFragment, insertFragment, type Fragment } from '../model/ops';
import { addPage, docPages, pageItemIds, resolvePage, viewDoc } from '../model/pages';
import { snap } from '../model/geometry';
import { BUILTIN } from '../model/symbols';
import type { CircuitDoc, Page, Point, SymbolDef } from '../model/types';
import { S, mergeUserSymbols, mutate, readOnly, readOnlyNotice, set, toast } from '../store/store';
import { isDesktop, parseJsonText, sanitizeName, saveFile } from './files';
import { checkLibraryUrl, fetchLibraryText, parseAddLibraryHash, parseRemoteLibrary } from './libraryUrl';
import { ask } from '../ui/Ask';

/* ------------------------------------------------------------------ */
/* Shareable payloads                                                  */
/* ------------------------------------------------------------------ */

export interface LibraryFile {
  format: 'nodal-library';
  version: 1;
  app: 'Nodal';
  name: string;
  symbols: Record<string, SymbolDef>;
}

export interface TemplateFile {
  format: 'nodal-template';
  version: 1;
  app: 'Nodal';
  name: string;
  fragment: Fragment;
}

export function buildLibraryFile(): LibraryFile {
  return {
    format: 'nodal-library',
    version: 1,
    app: 'Nodal',
    name: `${S().doc.name} — symbols`,
    symbols: { ...S().userLibrary },
  };
}

/** A reusable snippet of the current selection (a sub-circuit "template"). */
export function buildTemplateFile(ids: string[], name?: string): TemplateFile | null {
  const doc = S().doc;
  const frag = extractFragment(doc, new Set(ids));
  if (!frag.items.length) return null;
  return { format: 'nodal-template', version: 1, app: 'Nodal', name: name ?? `${doc.name} template`, fragment: frag };
}

export const libraryToText = (lib: LibraryFile) => JSON.stringify(lib, null, 2);
export const templateToText = (tpl: TemplateFile) => JSON.stringify(tpl, null, 2);

/* ------------------------------------------------------------------ */
/* Import / export actions                                             */
/* ------------------------------------------------------------------ */

/** Merges a library payload into "My symbols", keeping existing entries. */
export function importLibraryText(text: string, opts: { overwrite?: boolean } = {}): number {
  const data = parseLib(text);
  const incoming = data.symbols ?? {};
  const existing = S().userLibrary;
  const toAdd: Record<string, SymbolDef> = {};
  for (const [id, def] of Object.entries(incoming)) {
    // a library can't shadow a built-in drawing (the same rule the "add by link" path enforces)
    if (BUILTIN[id]) continue;
    if (!opts.overwrite && existing[id]) continue;
    toAdd[id] = def;
  }
  if (!Object.keys(toAdd).length) return 0;
  mergeUserSymbols(toAdd);
  return Object.keys(toAdd).length;
}

/**
 * Inserts a template's items into the current document, centred on `at`
 * (world) or the view. Throws while the circuit is read-only, so no caller
 * reports an insert that mutate quietly refused.
 */
export function importTemplateText(text: string, at?: Point): string[] {
  if (readOnly()) {
    readOnlyNotice();
    throw new Error('the circuit can’t be changed right now');
  }
  const data = parseTemplate(text);
  const frag = data.fragment;
  if (!frag?.items?.length) throw new Error('This template has no items.');
  return insertFragmentAt(frag, at);
}

/**
 * Adds a whole circuit to the open one (instead of replacing it), centred on
 * `at`, as one group named after it. Its symbols come along. One undo step.
 *
 * A `.nodal` file with several pages keeps them: the first drawing is added
 * where it was dropped, and the others each get their own page after the one
 * in view. (Before, every page was flattened onto the current page, so the
 * drawings landed on top of each other.)
 *
 * A picture carries one drawing: `opts.onePage` says which page the picture
 * shows (`opts.pageId` from the picture's geometry, else `opts.page` its name,
 * else the first page with something on it), so an older export of a whole
 * circuit — before scenes were scoped to their page — adds only that drawing,
 * not every page on top of each other.
 */
export function insertCircuit(
  src: CircuitDoc,
  at?: Point,
  opts: { onePage?: boolean; page?: string | null; pageId?: string | null } = {},
): string[] {
  const name = (opts.page ?? '').trim();
  const pages = docPages(src);
  const withItems = (p: string) => pageItemIds(src, p).length;
  // a dropped circuit with several pages keeps each drawing on its own page
  if (!opts.onePage && !name && !opts.pageId) {
    const drawn = pages.filter((p) => withItems(p.id));
    if (drawn.length > 1) return insertCircuitPages(src, drawn, at);
  }
  let ids: string[];
  if (opts.onePage || name || opts.pageId) {
    // file names carry the page name with characters a file system refuses
    // (and Windows ignores case), so match that form too
    const norm = (s: string) => sanitizeName(s).toLowerCase();
    const wanted = name
      ? pages.find((p) => p.name.trim().toLowerCase() === name.toLowerCase()) ?? pages.find((p) => norm(p.name) === norm(name))
      : undefined;
    // an older picture's own geometry says which page it shows; then its name;
    // then the first page with a drawing, so nothing lands on top of anything
    const shown = opts.pageId ? pages.find((p) => p.id === opts.pageId && withItems(p.id)) : undefined;
    const page = shown ?? (wanted && withItems(wanted.id) ? wanted : pages.find((p) => withItems(p.id)));
    ids = page ? pageItemIds(src, page.id) : Object.keys(src.items);
  } else {
    ids = Object.keys(src.items);
  }
  const frag = extractFragment(src, new Set(ids));
  if (!frag.items.length) throw new Error('This circuit is empty.');
  return insertFragmentAt(frag, at, src.name);
}

/** A page name not already taken (an imported file's names may clash). */
function freePageName(doc: CircuitDoc, name: string): string {
  const base = name.trim() || 'Page';
  const names = new Set(docPages(doc).map((p) => p.name.trim()));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

/**
 * Adds a circuit with several drawings: the first page lands on the page in
 * view (where it was dropped), every other page becomes its own page right
 * after it, with the file's page names. One undo step and one group.
 */
function insertCircuitPages(src: CircuitDoc, pages: Page[], at?: Point): string[] {
  const { doc, page: wantedPage, view, canvasSize, scope } = S();
  const empty = Object.keys(doc.items).length === 0;
  const grid = doc.settings.grid;
  const ids: string[] = [];
  let onFirstPage: string[] = [];
  const ok = mutate((d) => {
    const gid = uid('g');
    d.groups[gid] = { id: gid, name: src.name, group: scope };
    const current = resolvePage(d, wantedPage);
    // an empty circuit with a default page name takes the imported first
    // page's name instead of keeping a blank "Page 1" beside the new pages
    if (empty) {
      const implicit = !d.pages?.length;
      if (implicit) d.pages = docPages(d).map((p) => ({ ...p }));
      const list = d.pages ?? [];
      const target = list.find((p) => p.id === current) ?? list[0];
      if (target && (implicit || /^Page \d+$/.test(target.name.trim()))) target.name = pages[0].name;
    }
    let after = current;
    pages.forEach((source, i) => {
      const frag = extractFragment(viewDoc(src, source.id), new Set(pageItemIds(src, source.id)));
      let dest = current;
      let dx = 0;
      let dy = 0;
      if (i === 0) {
        // the first drawing lands where it was dropped, as a one-page import does
        const tmp = { ...d, symbols: { ...d.symbols, ...frag.symbols }, items: Object.fromEntries(frag.items.map((it) => [it.id, it])) } as CircuitDoc;
        const b = docBounds(tmp);
        const targetX = at ? at.x : (canvasSize.w / 2 - view.x) / view.zoom;
        const targetY = at ? at.y : (canvasSize.h / 2 - view.y) / view.zoom;
        dx = b ? snap(targetX - (b.x + b.w / 2), grid) : 0;
        dy = b ? snap(targetY - (b.y + b.h / 2), grid) : 0;
      } else {
        dest = addPage(d, freePageName(d, source.name), after);
        after = dest;
      }
      // a new page is empty, so its parts keep the names the file gave them;
      // the page in view may already use some of them
      const taken: string[] = [];
      for (const id of pageItemIds(d, dest)) {
        const it = d.items[id];
        if (it.type === 'component') taken.push(it.ref);
      }
      const added = insertFragment(d, frag, dx, dy, gid, taken);
      const first = docPages(d)[0].id === dest;
      for (const id of added) {
        if (first) delete d.items[id].page;
        else d.items[id].page = dest;
      }
      ids.push(...added);
      if (i === 0) onFirstPage = added;
    });
  }, [], { allPages: true });
  if (!ok) return [];
  // the drawing in view is selected, so a drop is visible straight away
  set({ selection: onFirstPage });
  return ids;
}

/** Inserts a fragment centred on `at` (or the view); with `groupName`, inside a new group of that name. */
function insertFragmentAt(frag: Fragment, at?: Point, groupName?: string): string[] {
  const { view, canvasSize, doc } = S();
  const g = doc.settings.grid;
  const tmp = { ...doc, items: Object.fromEntries(frag.items.map((i) => [i.id, i])) } as CircuitDoc;
  const b = docBounds(tmp);
  const targetX = at ? at.x : (canvasSize.w / 2 - view.x) / view.zoom;
  const targetY = at ? at.y : (canvasSize.h / 2 - view.y) / view.zoom;
  const dx = b ? snap(targetX - (b.x + b.w / 2), g) : 0;
  const dy = b ? snap(targetY - (b.y + b.h / 2), g) : 0;
  let ids: string[] = [];
  const ok = mutate((d) => {
    let scope = S().scope;
    if (groupName) {
      const g = uid('g');
      d.groups[g] = { id: g, name: groupName, group: scope };
      scope = g;
    }
    ids = insertFragment(d, frag, dx, dy, scope);
    // junctions that came without all their wires are dropped or merged
    cleanup(d);
    ids = ids.filter((id) => d.items[id]);
  });
  if (!ok) return [];
  set({ selection: ids });
  return ids;
}

export async function exportLibraryFile() {
  const lib = buildLibraryFile();
  if (!lib.symbols || !Object.keys(lib.symbols).length) return toast('Your library is empty — nothing to share yet');
  try {
    const res = await saveFile(libraryToText(lib), `${sanitizeName(lib.name)}.nodal-lib.json`, [{ name: 'Nodal symbol library', extensions: ['json'] }]);
    if (res !== false) toast('Symbol library exported', 'success');
  } catch (e) {
    toast(`Library export failed: ${(e as Error).message}`, 'error');
  }
}

export async function exportTemplateFile(ids: string[]) {
  const tpl = buildTemplateFile(ids);
  if (!tpl) return toast('Select the items to share as a template first');
  try {
    const res = await saveFile(templateToText(tpl), `${sanitizeName(tpl.name)}.nodal-template.json`, [{ name: 'Nodal template', extensions: ['json'] }]);
    if (res !== false) toast('Template exported', 'success');
  } catch (e) {
    toast(`Template export failed: ${(e as Error).message}`, 'error');
  }
}

export async function copyToClipboard(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied to clipboard`, 'success');
  } catch {
    toast('Clipboard is not available here — download the file instead', 'error');
  }
}

export async function pasteLibraryFromClipboard() {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    toast('Could not read the clipboard', 'error');
    return;
  }
  try {
    const n = importLibraryText(text, { overwrite: false });
    toast(n ? `Imported ${n} symbol${n > 1 ? 's' : ''}` : 'Nothing new to import', n ? 'success' : 'info');
  } catch (e) {
    const why = (e as Error).message;
    toast(/not a nodal symbol library/i.test(why) ? 'The clipboard text is not a Nodal symbol library.' : `Could not import the library: ${why}`, 'error');
  }
}

export async function pasteTemplateFromClipboard() {
  if (readOnly()) return readOnlyNotice();
  try {
    const text = await navigator.clipboard.readText();
    const ids = importTemplateText(text);
    toast(`Inserted template (${ids.length} items)`, 'success');
  } catch (e) {
    toast(`Could not paste template: ${(e as Error).message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Adding a library from a link (#addLibrary=…)                        */
/* ------------------------------------------------------------------ */

let adding = false;

/**
 * Downloads the library at `raw`, asks before adding it, then merges its new
 * symbols into My symbols (never replacing one already there). Returns how
 * many were added.
 */
export async function addLibraryFromUrl(raw: string): Promise<number> {
  if (adding) return 0;
  adding = true;
  try {
    const url = checkLibraryUrl(raw);
    toast(`Fetching the symbol library from ${url.host}…`, 'info');
    const lib = parseRemoteLibrary(await fetchLibraryText(url));
    const existing = S().userLibrary;
    const fresh = Object.keys(lib.symbols).filter((id) => !existing[id]);
    const total = Object.keys(lib.symbols).length;
    if (!total) {
      toast(`“${lib.name}” from ${url.host} has no symbols that can be added`, 'error');
      return 0;
    }
    if (!fresh.length) {
      toast(`Every symbol of “${lib.name}” is already in My symbols`, 'info');
      return 0;
    }
    const plural = (n: number) => `${n} symbol${n === 1 ? '' : 's'}`;
    const notes = [
      total > fresh.length ? `${plural(total - fresh.length)} you already have stay as they are.` : '',
      lib.skipped ? `${plural(lib.skipped)} that couldn’t be read (or would replace a built-in one) are left out.` : '',
    ].filter(Boolean);
    const ok = await ask(
      `Add ${plural(fresh.length)} from ${url.host}?`,
      [`“${lib.name}” will be added to My symbols.`, ...notes, 'Only add libraries from people you trust.'].join(' '),
      [
        { label: 'Cancel', value: false },
        { label: 'Add symbols', value: true, kind: 'primary' },
      ],
      false,
    );
    if (!ok) return 0;
    mergeUserSymbols(Object.fromEntries(fresh.map((id) => [id, lib.symbols[id]])));
    toast(`Added ${plural(fresh.length)} to My symbols`, 'success');
    return fresh.length;
  } catch (e) {
    toast(`Could not add the library: ${(e as Error).message}`, 'error');
    return 0;
  } finally {
    adding = false;
  }
}

/** Handles `#addLibrary=<url>` in the page address (web), now and whenever the hash changes; the hash is removed so a reload doesn't ask again. */
export function addLibraryFromLocation() {
  if (isDesktop()) return;
  const check = () => {
    const raw = parseAddLibraryHash(location.hash);
    if (raw === null) return;
    history.replaceState(null, '', location.pathname + location.search);
    void addLibraryFromUrl(raw);
  };
  check();
  window.addEventListener('hashchange', check);
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function parseLib(text: string): LibraryFile {
  const raw = parseJsonText<Partial<LibraryFile> | null>(text);
  if (!raw || raw.format !== 'nodal-library' || !raw.symbols || typeof raw.symbols !== 'object') {
    throw new Error('Not a Nodal symbol library file.');
  }
  return raw as LibraryFile;
}

function parseTemplate(text: string): TemplateFile {
  const raw = parseJsonText<(Partial<TemplateFile> & { symbols?: CircuitDoc['symbols'] }) | null>(text);
  if (!raw || typeof raw !== 'object') throw new Error('Not a Nodal template file.');
  // accept a plain copied fragment too (Edit → Copy puts one on the clipboard as JSON)
  if (raw.format === 'nodal-template' && raw.fragment) return raw as TemplateFile;
  const frag = raw as unknown as Fragment;
  if (frag.format === 'nodal-fragment' && Array.isArray(frag.items)) {
    return { format: 'nodal-template', version: 1, app: 'Nodal', name: 'Pasted selection', fragment: frag };
  }
  throw new Error('Not a Nodal template file.');
}
