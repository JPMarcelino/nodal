import { docBounds, uid } from '../model/doc';
import { extractFragment, insertFragment, type Fragment } from '../model/ops';
import { snap } from '../model/geometry';
import type { CircuitDoc, Point, SymbolDef } from '../model/types';
import { S, mergeUserSymbols, mutate, set, toast } from '../store/store';
import { openTextFile, sanitizeName, saveFile } from './files';

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
 */
export function insertCircuit(src: CircuitDoc, at?: Point): string[] {
  const frag = extractFragment(src, new Set(Object.keys(src.items)));
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
  mutate((d) => {
    let scope = S().scope;
    if (groupName) {
      const g = uid('g');
      d.groups[g] = { id: g, name: groupName, group: scope };
      scope = g;
    }
    ids = insertFragment(d, frag, dx, dy, scope);
  });
  set({ selection: ids });
  return ids;
}

export async function exportLibraryFile() {
  const lib = buildLibraryFile();
  if (!lib.symbols || !Object.keys(lib.symbols).length) return toast('Your library is empty — nothing to share yet');
  const res = await saveFile(libraryToText(lib), `${sanitizeName(lib.name)}.nodal-lib.json`, [{ name: 'Nodal symbol library', extensions: ['json'] }]);
  if (res !== false) toast('Symbol library exported', 'success');
}

export async function exportTemplateFile(ids: string[]) {
  const tpl = buildTemplateFile(ids);
  if (!tpl) return toast('Select the items to share as a template first');
  const res = await saveFile(templateToText(tpl), `${sanitizeName(tpl.name)}.nodal-template.json`, [{ name: 'Nodal template', extensions: ['json'] }]);
  if (res !== false) toast('Template exported', 'success');
}

export async function importLibraryFile() {
  const f = await openTextFile([{ name: 'Nodal symbol library', extensions: ['json'] }]);
  if (!f) return;
  try {
    const n = importLibraryText(f.text, { overwrite: false });
    toast(n ? `Imported ${n} symbol${n > 1 ? 's' : ''}` : 'Every symbol was already in your library', n ? 'success' : 'info');
  } catch (e) {
    toast(`Could not import library: ${(e as Error).message}`, 'error');
  }
}

export async function importTemplateFile() {
  const f = await openTextFile([{ name: 'Nodal template', extensions: ['json'] }]);
  if (!f) return;
  try {
    const ids = importTemplateText(f.text);
    toast(`Inserted template (${ids.length} items)`, 'success');
  } catch (e) {
    toast(`Could not import template: ${(e as Error).message}`, 'error');
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
