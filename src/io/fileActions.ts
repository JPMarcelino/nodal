import { itemBounds, normalizeDoc, uid } from '../model/doc';
import { rectsIntersect } from '../model/geometry';
import { prepareMath } from '../model/latex';
import { sampleDoc } from '../model/sample';
import { toBomCsv, toKicadNetlist, toSpiceNetlist } from '../model/netlist';
import type { CircuitDoc, Rect } from '../model/types';
import { S, imageExportOptions, newDoc, replaceDoc, set, toast, vdoc, type ExportScope } from '../store/store';

export { imageExportOptions };
import { fitView } from '../store/actions';
import { exportDxf, exportPng, exportSvg, pageTitle, printDoc, selectionDoc, type SvgOptions } from './export';
import { writePictureClipboard } from './clipboardCopy';
import { extractFragment } from '../model/ops';
import { openAnyFile, sanitizeName, saveFile } from './files';
import { pngWithScene, sceneFromFile, sceneJson, svgWithScene } from './embeddedScene';
import { ask } from '../ui/Ask';
import { saveVersion } from './versionStore';

export const NODAL_FILTER = [{ name: 'Nodal circuit', extensions: ['nodal', 'json'] }];
/** What File → Open takes: circuits, and pictures exported with their circuit inside. */
const OPEN_FILTER = [{ name: 'Nodal circuit (or a PNG / SVG exported with it)', extensions: ['nodal', 'json', 'png', 'svg'] }];

/**
 * Before the open circuit is replaced: with unsaved changes, asks whether to
 * save them first. Resolves false when the user would rather keep editing.
 */
async function confirmDiscard(action: string): Promise<boolean> {
  if (!S().dirty || !Object.keys(S().doc.items).length) return true;
  const choice = await ask(
    `Save changes to “${S().doc.name}”?`,
    `You have unsaved changes. ${action} replaces this circuit; anything not saved is only kept in the History tab.`,
    [
      { label: 'Don’t save', value: 'discard', kind: 'danger' },
      { label: 'Keep editing', value: 'cancel' },
      { label: 'Save', value: 'save', kind: 'primary' },
    ],
    'cancel',
  );
  if (choice === 'cancel') return false;
  if (choice === 'save') return fileSave();
  return true;
}

export async function fileNew() {
  if (!(await confirmDiscard('A new circuit'))) return;
  newDoc();
  setTimeout(() => fitView(), 0);
}

export async function fileOpen() {
  if (!(await confirmDiscard('Opening a file'))) return;
  try {
    const f = await openAnyFile(OPEN_FILTER);
    if (!f) return;
    const { file, path } = f;
    if (/\.(png|svg)$/i.test(file.name) || /^image\//.test(file.type)) {
      const json = await sceneFromFile(file);
      if (!json) throw new Error('this picture does not carry a Nodal circuit (export it with “Include circuit” on)');
      // no path: saving must not write the circuit over the picture
      loadCircuit(file.name, normalizeDoc(JSON.parse(json)), null);
      return;
    }
    loadCircuit(file.name, normalizeDoc(JSON.parse(await file.text())), path);
  } catch (e) {
    toast(`Could not open file: ${(e as Error).message}`, 'error');
  }
}

/** Opens a circuit kept in version history (one that was closed or replaced). */
export async function openFromHistory(doc: CircuitDoc) {
  if (!(await confirmDiscard('Opening another circuit'))) return;
  replaceDoc(doc, null);
  // it only exists on this device until it is saved to a file
  set({ dirty: true });
  setTimeout(() => fitView(), 0);
  toast(`Opened ${doc.name}`, 'success');
}

/** Opens the built-in example circuit (the 555 LED flasher) as a new, unsaved circuit. */
export async function openExample() {
  if (!(await confirmDiscard('Opening the example'))) return;
  const doc = sampleDoc();
  replaceDoc(doc, null);
  setTimeout(() => fitView(), 0);
  toast(`Opened the example: ${doc.name}`, 'success');
}

function loadCircuit(name: string, doc: CircuitDoc, path: string | null) {
  replaceDoc(doc, path);
  setTimeout(() => fitView(), 0);
  toast(`Opened ${name}`, 'success');
}

/**
 * Opens a live session's shared circuit as the guest's own new, unsaved
 * circuit. The session already put the guest's own circuit back, so the copy
 * replaces that (asking first with unsaved changes). Resolves true when the
 * copy was opened.
 */
export async function openSessionCopy(doc: CircuitDoc): Promise<boolean> {
  const copy = { ...doc, id: uid('d'), name: `${doc.name} (copy)` };
  if (!(await confirmDiscard('Keeping the shared circuit'))) {
    // an empty shared circuit, or a history failure, saves nothing: only then say so
    let saved = false;
    try {
      saved = (await saveVersion(copy, '', true)) !== null;
    } catch {
      saved = false;
    }
    toast(
      saved
        ? 'Kept your circuit. The shared copy is under History → Other circuits on this device.'
        : 'Kept your circuit. The shared circuit was not saved.',
      'info',
    );
    return false;
  }
  replaceDoc(copy, null);
  set({ dirty: true });
  setTimeout(() => fitView(), 0);
  return true;
}

/** Saves the circuit to a file; resolves true once it is saved. */
export async function fileSave(saveAs = false): Promise<boolean> {
  const { doc, filePath } = S();
  try {
    const res = await saveFile(JSON.stringify(doc, null, 1), `${sanitizeName(doc.name)}.nodal`, NODAL_FILTER, saveAs ? null : filePath);
    if (res === false) return false;
    // edits made while the save dialog was open are still unsaved
    set({ dirty: S().doc !== doc, filePath: res || filePath });
    toast('Saved', 'success');
    return true;
  } catch (e) {
    toast(`Save failed: ${(e as Error).message}`, 'error');
    return false;
  }
}


/** Opens the Export dialog, which previews what will be exported: the page, `scope.ids`, or the area `scope.clip`. */
export function openExport(scope: ExportScope = {}) {
  set({ dialog: 'export', exportScope: scope, exportArea: null });
}

/**
 * File name (without extension) for an export: the current page's own name
 * when the circuit has pages, the circuit's name when it has only one, and a
 * suffix that says what part of the page it is.
 */
export function exportBaseName(scope: ExportScope = {}): string {
  let base = sanitizeName(pageTitle(vdoc()));
  if (scope.ids?.length) base += ' (selection)';
  if (scope.clip) base += ` (area ${Math.round(scope.clip.x)},${Math.round(scope.clip.y)})`;
  return base;
}

/** SVG options for exporting (and previewing) a scope as `kind`; areas are cropped tight, the page and selections get a margin. */
export function scopeSvgOptions(scope: ExportScope, kind: 'png' | 'svg', look: { theme: 'light' | 'dark'; background: boolean }): SvgOptions {
  if (scope.clip) return { ...look, padding: kind === 'png' ? 0 : 4, clip: scope.clip };
  return { ...look, padding: 20, ids: scope.ids?.length ? scope.ids : undefined };
}

/**
 * Copies what the Export dialog shows as a picture (PNG + SVG). The page and
 * selections carry their items along, so pasting back into Nodal gives them
 * editable; an area is a picture only (its wires are cut).
 */
export async function copyScope(scope: ExportScope, look: { theme: 'light' | 'dark'; background: boolean; scale: number }) {
  const doc = vdoc();
  const ids = scope.clip ? [] : scope.ids?.length ? scope.ids : Object.keys(doc.items);
  const frag = ids.length ? extractFragment(doc, new Set(ids)) : undefined;
  const ok = await writePictureClipboard(doc, { ...scopeSvgOptions(scope, 'png', look), scale: look.scale }, frag);
  if (ok) toast('Copied as a picture: paste it into any app, or back into Nodal', 'success');
  else toast('Clipboard is not available here: export a PNG or SVG instead', 'error');
}

export type ExportKind = 'svg' | 'png' | 'dxf' | 'spice' | 'kicad' | 'bom' | 'json';

/**
 * The circuit an exported picture carries: the whole circuit (every page) for
 * a page export, the selected items (and the wires between them) for a
 * selection, and the items an area touches, whole and uncut, for an area.
 */
export function sceneForScope(scope: ExportScope): string {
  if (!scope.clip && !scope.ids?.length) return sceneJson(S().doc);
  const doc = vdoc();
  const c = scope.clip;
  const ids = c
    ? Object.values(doc.items)
        .filter((it) => {
          const b = !it.hidden && itemBounds(doc, it);
          return !!b && rectsIntersect(c, b);
        })
        .map((it) => it.id)
    : scope.ids!;
  return sceneJson(selectionDoc(doc, ids));
}

/** The picture, with the circuit inside when `scene`. */
async function imageFile(kind: 'png' | 'svg', doc: CircuitDoc, opts: SvgOptions & { scale: number }, scene: string | null): Promise<string | Blob> {
  if (kind === 'svg') {
    const { svg } = exportSvg(doc, opts);
    return scene ? svgWithScene(svg, scene) : svg;
  }
  const png = await exportPng(doc, opts);
  return scene ? pngWithScene(png, scene) : png;
}

/** Exports the circuit, or with `opts.ids` only those items (and the wires between them), in any format. Images use imageExportOptions unless told otherwise. */
export async function doExport(kind: ExportKind, opts: Partial<SvgOptions> & { scale?: number; scene?: boolean } = {}) {
  const full = S().doc;
  const part = !!opts.ids?.length;
  // drawings show the page on screen; netlists, BOM and JSON cover every page
  const drawing = kind === 'svg' || kind === 'png' || kind === 'dxf';
  const src = drawing ? vdoc() : full;
  // images crop to the ids themselves; data formats get the reduced circuit
  const doc = part && kind !== 'svg' && kind !== 'png' ? selectionDoc(src, opts.ids!) : src;
  const base = drawing ? exportBaseName({ ids: opts.ids }) : sanitizeName(full.name) + (part ? ' (selection)' : '');
  const img = imageExportOptions();
  const svgOpts: SvgOptions = { theme: img.theme, background: img.background, padding: 20, ...opts };
  try {
    await prepareMath(doc);
    let res: string | null | false = null;
    switch (kind) {
      case 'svg':
      case 'png': {
        const scene = (opts.scene ?? img.scene) ? sceneForScope({ ids: opts.ids }) : null;
        const data = await imageFile(kind, doc, { ...svgOpts, scale: opts.scale ?? img.scale }, scene);
        res = await saveFile(data, `${base}.${kind}`, [kind === 'svg' ? { name: 'SVG image', extensions: ['svg'] } : { name: 'PNG image', extensions: ['png'] }]);
        break;
      }
      case 'dxf':
        res = await saveFile(exportDxf(doc), `${base}.dxf`, [{ name: 'AutoCAD DXF', extensions: ['dxf'] }]);
        break;
      case 'kicad':
        res = await saveFile(toKicadNetlist(doc), `${base}.net`, [{ name: 'KiCad netlist', extensions: ['net'] }]);
        break;
      case 'spice':
        res = await saveFile(toSpiceNetlist(doc), `${base}.cir`, [{ name: 'SPICE netlist', extensions: ['cir', 'net', 'sp'] }]);
        break;
      case 'bom':
        res = await saveFile(toBomCsv(doc), `${base}-bom.csv`, [{ name: 'CSV', extensions: ['csv'] }]);
        break;
      case 'json':
        res = await saveFile(JSON.stringify(doc, null, 2), `${base}.json`, [{ name: 'JSON', extensions: ['json'] }]);
        break;
    }
    if (res !== false) toast(`Exported ${part ? 'selection as ' : ''}${kind === 'bom' ? 'BOM' : kind.toUpperCase()}`, 'success');
  } catch (e) {
    toast(`Export failed: ${(e as Error).message}`, 'error');
  }
}

export async function filePrint() {
  await prepareMath(S().doc).catch(() => undefined);
  printDoc(S().doc);
}

/**
 * Exports an arbitrary world-space window; wires are cut at the boundary.
 */
export async function doClipExport(kind: 'png' | 'svg', rect: Rect, opts: Partial<SvgOptions> & { scale?: number; scene?: boolean }) {
  const base = exportBaseName({ clip: rect });
  const img = imageExportOptions();
  const svgOpts: SvgOptions = { theme: img.theme, background: img.background, padding: 8, ...opts, clip: rect };
  const doc = vdoc();
  try {
    await prepareMath(doc);
    const scene = (opts.scene ?? img.scene) ? sceneForScope({ clip: rect }) : null;
    const data = await imageFile(kind, doc, { ...svgOpts, scale: opts.scale ?? img.scale }, scene);
    const res = await saveFile(data, `${base}.${kind}`, [kind === 'svg' ? { name: 'SVG image', extensions: ['svg'] } : { name: 'PNG image', extensions: ['png'] }]);
    if (res !== false) toast(`Exported ${kind.toUpperCase()} of selected area`, 'success');
  } catch (e) {
    toast(`Export failed: ${(e as Error).message}`, 'error');
  }
}

/** Arms "export area" mode: the next rectangle drawn on the canvas opens the Export dialog on it. */
export function startAreaExport(kind: 'png' | 'svg' = 'png') {
  set({ dialog: null, exportArea: { kind } });
}

/** Finishes an armed area export by previewing it; rectangles too small to be deliberate just cancel it. */
export function runAreaExport(rect: Rect) {
  const job = S().exportArea;
  set({ exportArea: null });
  if (!job || rect.w < 4 || rect.h < 4) return;
  openExport({ clip: rect });
}

/** Opens the Export dialog on just the selected items. */
export function exportSelection() {
  const sel = S().selection;
  if (!sel.length) return toast('Select items to export first');
  openExport({ ids: sel });
}

export async function copyAsSvg() {
  const { selection } = S();
  const doc = vdoc();
  await prepareMath(doc).catch(() => undefined);
  const { theme, background } = imageExportOptions();
  const { svg } = exportSvg(doc, { theme, background, padding: 10, ids: selection.length ? selection : undefined });
  try {
    await navigator.clipboard.writeText(svg);
    toast('SVG copied to clipboard', 'success');
  } catch {
    toast('Clipboard is not available', 'error');
  }
}

export async function copyAsPng() {
  const { selection } = S();
  const doc = vdoc();
  const ids = selection.length ? selection : undefined;
  try {
    const Ctor = globalThis.ClipboardItem as unknown as typeof ClipboardItem | undefined;
    const canWrite = typeof navigator !== 'undefined' && typeof navigator.clipboard?.write === 'function';
    if (typeof Ctor === 'undefined' || !canWrite) throw new Error('unsupported');
    // Pass the promise (not an awaited blob) so Safari keeps the user activation.
    const blobPromise = (async () => {
      await prepareMath(doc).catch(() => undefined);
      // pasted images get the canvas behind them: most apps show transparency as white or black
      return exportPng(doc, { theme: imageExportOptions().theme, background: true, padding: 10, ids, scale: 2 });
    })();
    const item = new Ctor({ 'image/png': blobPromise } as unknown as Record<string, Promise<Blob>>);
    await navigator.clipboard.write([item]);
    toast('Image copied to clipboard', 'success');
  } catch {
    toast("Copying images isn't supported here — use Export as PNG", 'error');
  }
}
