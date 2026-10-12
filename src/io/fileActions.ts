import { normalizeDoc } from '../model/doc';
import { toBomCsv, toSpiceNetlist } from '../model/netlist';
import type { CircuitDoc, Rect } from '../model/types';
import { S, newDoc, replaceDoc, set, toast } from '../store/store';
import { fitView } from '../store/actions';
import { exportDxf, exportPng, exportSvg, printDoc, type SvgOptions } from './export';
import { openTextFile, sanitizeName, saveFile } from './files';

const NODAL_FILTER = [{ name: 'Nodal circuit', extensions: ['nodal', 'json'] }];

async function confirmDiscard(): Promise<boolean> {
  if (!S().dirty || !Object.keys(S().doc.items).length) return true;
  return window.confirm('Discard unsaved changes to the current circuit?');
}

export async function fileNew() {
  if (!(await confirmDiscard())) return;
  newDoc();
  setTimeout(() => fitView(), 0);
}

export async function fileOpen() {
  if (!(await confirmDiscard())) return;
  try {
    const f = await openTextFile(NODAL_FILTER);
    if (!f) return;
    loadCircuit(f.name, normalizeDoc(JSON.parse(f.text)), f.path);
  } catch (e) {
    toast(`Could not open file: ${(e as Error).message}`, 'error');
  }
}

/** Opens circuit text that arrived some other way (drag & drop, Import…). Throws if it isn't a circuit. */
export async function openCircuitText(name: string, text: string, path: string | null) {
  const doc = normalizeDoc(JSON.parse(text));
  if (await confirmDiscard()) loadCircuit(name, doc, path);
}

function loadCircuit(name: string, doc: CircuitDoc, path: string | null) {
  replaceDoc(doc, path);
  setTimeout(() => fitView(), 0);
  toast(`Opened ${name}`, 'success');
}

export async function fileSave(saveAs = false) {
  const { doc, filePath } = S();
  try {
    const res = await saveFile(JSON.stringify(doc, null, 1), `${sanitizeName(doc.name)}.nodal`, NODAL_FILTER, saveAs ? null : filePath);
    if (res === false) return;
    set({ dirty: false, filePath: res || filePath });
    toast('Saved', 'success');
  } catch (e) {
    toast(`Save failed: ${(e as Error).message}`, 'error');
  }
}

export type ExportKind = 'svg' | 'png' | 'dxf' | 'spice' | 'bom' | 'json';

export async function doExport(kind: ExportKind, opts: Partial<SvgOptions> & { scale?: number } = {}) {
  const { doc } = S();
  const base = sanitizeName(doc.name);
  const svgOpts: SvgOptions = { theme: 'light', background: true, padding: 20, ...opts };
  try {
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
    if (res !== false) toast(`Exported ${kind.toUpperCase()}`, 'success');
  } catch (e) {
    toast(`Export failed: ${(e as Error).message}`, 'error');
  }
}

export function filePrint() {
  printDoc(S().doc);
}

/** Exports an arbitrary world-space window; wires are cut at the boundary. */
export async function doClipExport(kind: 'png' | 'svg', rect: Rect, opts: Partial<SvgOptions> & { scale?: number }) {
  const base = `${sanitizeName(S().doc.name)}-area`;
  const svgOpts: SvgOptions = { theme: 'light', background: true, padding: 8, ...opts, clip: rect };
  try {
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
      background: opts.background ?? true,
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
export function exportSelection(kind: 'png' | 'svg' = 'png') {
  const sel = S().selection;
  if (!sel.length) return toast('Select items to export first');
  void doExport(kind, { ids: sel });
}

export async function copyAsSvg() {
  const { doc, selection } = S();
  const { svg } = exportSvg(doc, { theme: 'light', background: false, padding: 10, ids: selection.length ? selection : undefined });
  try {
    await navigator.clipboard.writeText(svg);
    toast('SVG copied to clipboard', 'success');
  } catch {
    toast('Clipboard is not available', 'error');
  }
}
