import { docBounds, uid } from '../model/doc';
import { cleanup, extractFragment, insertFragment, type Fragment } from '../model/ops';
import { docPages, pageItemIds } from '../model/pages';
import { snap } from '../model/geometry';
import type { CircuitDoc, Point, SymbolDef } from '../model/types';
import { S, mergeUserSymbols, mutate, set, toast } from '../store/store';
import { isDesktop, sanitizeName, saveFile } from './files';
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
    if (!opts.overwrite && existing[id]) continue;
    toAdd[id] = def;
  }
  if (!Object.keys(toAdd).length) return 0;
  mergeUserSymbols(toAdd);
  return Object.keys(toAdd).length;
}

/** Inserts a template's items into the current document, centred on `at` (world) or the view. */
export function importTemplateText(text: string, at?: Point): string[] {
  const data = parseTemplate(text);
  const frag = data.fragment;
  if (!frag?.items?.length) throw new Error('This template has no items.');
  return insertFragmentAt(frag, at);
}

/**
 * Adds a whole circuit to the open one (instead of replacing it), centred on
 * `at`, as one group named after it. Its symbols come along. One undo step.
 *
 * A picture carries one drawing: `opts.onePage` says which page the picture
 * shows (`opts.pageId` from the picture's geometry, else `opts.page` its name,
 * else the first page with something on it), so an older export of a whole
 * circuit — before scenes were scoped to their page — adds only that drawing,
 * not every page on top of each other. Without it (a `.nodal` file) every page
 * is added, as before.
 */
export function insertCircuit(
  src: CircuitDoc,
  at?: Point,
  opts: { onePage?: boolean; page?: string | null; pageId?: string | null } = {},
): string[] {
  const name = (opts.page ?? '').trim();
  let ids: string[];
  if (opts.onePage || name || opts.pageId) {
    const pages = docPages(src);
    const withItems = (p: string) => pageItemIds(src, p).length;
    // file names carry the page name with characters a file system refuses
    // replaced (and Windows ignores case), so match that form too
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
  try {
    const text = await navigator.clipboard.readText();
    const n = importLibraryText(text, { overwrite: false });
    toast(n ? `Imported ${n} symbol${n > 1 ? 's' : ''}` : 'Nothing new to import', n ? 'success' : 'info');
  } catch {
    toast('Could not read the clipboard', 'error');
  }
}

export async function pasteTemplateFromClipboard() {
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
  const raw = JSON.parse(text) as Partial<LibraryFile>;
  if (raw.format !== 'nodal-library' || !raw.symbols || typeof raw.symbols !== 'object') {
    throw new Error('Not a Nodal symbol library file.');
  }
  return raw as LibraryFile;
}

function parseTemplate(text: string): TemplateFile {
  const raw = JSON.parse(text) as Partial<TemplateFile> & { symbols?: CircuitDoc['symbols'] };
  // accept a plain copied fragment too (Edit → Copy puts one on the clipboard as JSON)
  if (raw.format === 'nodal-template' && raw.fragment) return raw as TemplateFile;
  const frag = raw as unknown as Fragment;
  if (frag.format === 'nodal-fragment' && Array.isArray(frag.items)) {
    return { format: 'nodal-template', version: 1, app: 'Nodal', name: 'Pasted selection', fragment: frag };
  }
  throw new Error('Not a Nodal template file.');
}
