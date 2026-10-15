import { normalizeDoc } from '../model/doc';
import { prepareMath } from '../model/latex';
import { toBomCsv, toKicadNetlist, toSpiceNetlist } from '../model/netlist';
import type { CircuitDoc, Rect } from '../model/types';
import { S, newDoc, replaceDoc, set, toast } from '../store/store';
import { fitView } from '../store/actions';
import { exportDxf, exportPng, exportSvg, printDoc, selectionDoc, type SvgOptions } from './export';
import { openTextFile, sanitizeName, saveFile } from './files';
import { ask } from '../ui/Ask';

export const NODAL_FILTER = [{ name: 'Nodal circuit', extensions: ['nodal', 'json'] }];

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
    const f = await openTextFile(NODAL_FILTER);
    if (!f) return;
    loadCircuit(f.name, normalizeDoc(JSON.parse(f.text)), f.path);
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

function loadCircuit(name: string, doc: CircuitDoc, path: string | null) {
  replaceDoc(doc, path);
  setTimeout(() => fitView(), 0);
  toast(`Opened ${name}`, 'success');
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

export type ExportKind = 'svg' | 'png' | 'dxf' | 'spice' | 'kicad' | 'bom' | 'json';

/** Exports the circuit, or with `opts.ids` only those items (and the wires between them), in any format. Images are transparent unless asked otherwise. */
export async function doExport(kind: ExportKind, opts: Partial<SvgOptions> & { scale?: number } = {}) {
  const full = S().doc;
  const part = !!opts.ids?.length;
  // images crop to the ids themselves; data formats get the reduced circuit
  const doc = part && kind !== 'svg' && kind !== 'png' ? selectionDoc(full, opts.ids!) : full;
  const base = sanitizeName(full.name) + (part ? '-selection' : '');
  const svgOpts: SvgOptions = { theme: 'light', background: false, padding: 20, ...opts };
  try {
    await prepareMath(doc);
    let res: string | null | false = null;
    switch (kind) {
      case 'svg':
        res = await saveFile(exportSvg(doc, svgOpts).svg, `${base}.svg`, [{ name: 'SVG image', extensions: ['svg'] }]);
        break;
      case 'png':
        res = await saveFile(await exportPng(doc, { ...svgOpts, scale: opts.scale ?? 3 }), `${base}.png`, [{ name: 'PNG image', extensions: ['png'] }]);
        break;
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

/** Exports an arbitrary world-space window; wires are cut at the boundary. */
export async function doClipExport(kind: 'png' | 'svg', rect: Rect, opts: Partial<SvgOptions> & { scale?: number }) {
  const base = `${sanitizeName(S().doc.name)}-area`;
  const svgOpts: SvgOptions = { theme: 'light', background: false, padding: 8, ...opts, clip: rect };
  try {
    await prepareMath(S().doc);
    const res =
      kind === 'svg'
        ? await saveFile(exportSvg(S().doc, svgOpts).svg, `${base}.svg`, [{ name: 'SVG image', extensions: ['svg'] }])
        : await saveFile(await exportPng(S().doc, { ...svgOpts, scale: opts.scale ?? 3 }), `${base}.png`, [{ name: 'PNG image', extensions: ['png'] }]);
    if (res !== false) toast(`Exported ${kind.toUpperCase()} of selected area`, 'success');
  } catch (e) {
    toast(`Export failed: ${(e as Error).message}`, 'error');
  }
}

/** Arms "export area" mode: the next rectangle drawn on the canvas is exported. */
export function startAreaExport(kind: 'png' | 'svg', opts: Partial<SvgOptions> & { scale?: number } = {}) {
  set({
    dialog: null,
    exportArea: {
      kind,
      theme: opts.theme ?? 'light',
      background: opts.background ?? false,
      scale: opts.scale ?? 3,
    },
  });
}

/** Finishes an armed area export; rectangles too small to be deliberate just cancel it. */
export function runAreaExport(rect: Rect) {
  const job = S().exportArea;
  set({ exportArea: null });
  if (!job || rect.w < 4 || rect.h < 4) return;
  void doClipExport(job.kind, rect, { theme: job.theme, background: job.background, scale: job.scale, padding: job.kind === 'png' ? 0 : 4 });
}

/** Exports only the currently selected items. */
export function exportSelection(kind: ExportKind = 'png') {
  const sel = S().selection;
  if (!sel.length) return toast('Select items to export first');
  void doExport(kind, { ids: sel });
}

export async function copyAsSvg() {
  const { doc, selection } = S();
  await prepareMath(doc).catch(() => undefined);
  const { svg } = exportSvg(doc, { theme: 'light', background: false, padding: 10, ids: selection.length ? selection : undefined });
  try {
    await navigator.clipboard.writeText(svg);
    toast('SVG copied to clipboard', 'success');
  } catch {
    toast('Clipboard is not available', 'error');
  }
}
