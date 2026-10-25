import { normalizeDoc } from '../model/doc';
import { snap } from '../model/geometry';
import { docPages, viewDoc } from '../model/pages';
import { insertSvgDrawing, type SvgImportOptions } from '../model/svgDrawing';
import type { CircuitDoc, Point, Rect } from '../model/types';
import { S, mutate, toast } from '../store/store';
import { askSvgImport } from '../ui/SvgImportDialog';
import { openAnyFile } from './files';
import { insertPictures, isPdf, isRaster, pdfToPictures, rasterToPicture } from './imageImport';
import { importLibraryText, importTemplateText, insertCircuit } from './sharing';
import { svgToDrawing } from './svgImport';
import { fragmentFromText } from './clipboardCopy';
import { sceneFromPicture, sceneFromSvgText, svgTitle } from './embeddedScene';
import { exportBox } from './export';

interface PictureSize {
  width?: number;
  height?: number;
}

/** The world rectangle an exported SVG covers, from its viewBox. */
function svgViewBox(text: string): Rect | null {
  const m = /<svg\b[^>]*\bviewBox\s*=\s*"([^"]+)"/i.exec(text);
  const n = m ? m[1].trim().split(/[\s,]+/).map(Number) : [];
  return n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0 ? { x: n[0], y: n[1], w: n[2], h: n[3] } : null;
}

const sameBox = (a: Rect, b: Rect) =>
  Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1;

/**
 * Which page an older picture shows, judged by what the picture covers: the
 * SVG viewBox (or a PNG's proportions) against each page's export window. An
 * export made before pictures were scoped to their page still carried the
 * whole circuit, and may be named after the circuit rather than the page, so
 * the picture's own geometry is the reliable clue.
 */
function picturePageId(doc: CircuitDoc, text: string, size?: PictureSize): string | undefined {
  const viewBox = text.trimStart().startsWith('<') ? svgViewBox(text) : null;
  const box: Rect | null =
    viewBox ?? (size?.width && size.height ? { x: 0, y: 0, w: size.width, h: size.height } : null);
  if (!box) return undefined;
  const pages = docPages(doc);
  const windows: { id: string; box: Rect }[] = [];
  for (const p of pages) {
    const view = viewDoc(doc, p.id);
    if (!Object.keys(view.items).length) continue;
    windows.push({ id: p.id, box: exportBox(view, { theme: 'light', background: false, padding: 20 }) });
  }
  if (!windows.length) return undefined;
  if (viewBox) {
    const exact = windows.filter((w) => sameBox(w.box, viewBox));
    if (exact.length === 1) return exact[0].id;
  }
  // the picture's shape: only a clear winner counts (pages often look alike)
  const aspect = box.w / box.h;
  const scored = windows
    .map((w) => ({ id: w.id, err: Math.abs(w.box.w / w.box.h - aspect) / aspect }))
    .sort((a, b) => a.err - b.err);
  const [best, next] = scored;
  return best && best.err <= 0.01 && (!next || next.err >= best.err + 0.01) ? best.id : undefined;
}

/** The page name an exported picture was of: its SVG title, else its file name. */
function scenePageHint(name: string, text: string): string | undefined {
  const title = text.trimStart().startsWith('<') ? svgTitle(text) : null;
  return title ?? (name.replace(/\.(nodal|json|png|svg)$/i, '').trim() || undefined);
}

/** Everything "Import file…" and drag & drop understand. */
export const IMPORT_FILTER = [
  { name: 'Nodal files, SVG, PDF and images', extensions: ['nodal', 'json', 'svg', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'] },
];

export const viewCentre = (): Point => {
  const { view, canvasSize } = S();
  return { x: (canvasSize.w / 2 - view.x) / view.zoom, y: (canvasSize.h / 2 - view.y) / view.zoom };
};

/**
 * Imports one file by sniffing its contents: a circuit is added to the open one, a symbol library
 * merges into "My symbols", a template / copied selection is inserted at `at`,
 * and an SVG becomes editable wires and shapes placed at `at` (asking how, unless `svg` says).
 */
export async function importFileText(name: string, text: string, at?: Point, svg?: SvgImportOptions, picture?: PictureSize): Promise<void> {
  try {
    const trimmed = text.trimStart();
    // a picture copied from Nodal (Ctrl+C, Export → Copy) carries its items: bring them back editable
    const copied = fragmentFromText(text);
    if (copied) {
      const ids = importTemplateText(JSON.stringify(copied), at);
      toast(`Inserted ${ids.length} item${ids.length === 1 ? '' : 's'} copied from Nodal`, 'success');
      return;
    }
    // an SVG exported with its circuit inside is that circuit, not a drawing
    const embedded = sceneFromSvgText(text);
    if (!embedded && (/\.svg$/i.test(name) || (trimmed.startsWith('<') && /<svg[\s>]/i.test(text)))) {
      await importSvgDrawing(name, text, at ?? viewCentre(), svg);
      return;
    }
    // a picture carries one page; an older one may still carry the whole circuit
    const fromPicture = !!embedded || /\.png$/i.test(name);
    const page = fromPicture ? scenePageHint(name, text) : undefined;
    let data: { format?: unknown };
    try {
      data = JSON.parse(embedded ?? text);
    } catch {
      throw new Error('Nodal can import circuits (.nodal), symbol libraries, templates, SVG, PDF and images');
    }
    switch (data?.format) {
      case 'nodal': {
        // dropped or imported circuits are added to this one; File → Open replaces it
        const src = normalizeDoc(data);
        const pageId = fromPicture ? picturePageId(src, text, picture) : undefined;
        const ids = insertCircuit(src, at, { onePage: fromPicture, page, pageId });
        toast(`Added “${name.replace(/\.(nodal|json|png|svg)$/i, '')}” (${ids.length} items, grouped; double-click to edit inside)`, 'success');
        return;
      }
      case 'nodal-library': {
        const n = importLibraryText(text, { overwrite: false });
        toast(n ? `Imported ${n} symbol${n > 1 ? 's' : ''}` : 'Every symbol was already in your library', n ? 'success' : 'info');
        return;
      }
      case 'nodal-template':
      case 'nodal-fragment': {
        const ids = importTemplateText(text, at);
        toast(`Inserted template (${ids.length} items)`, 'success');
        return;
      }
      default:
        throw new Error('This JSON is not a Nodal circuit, library or template');
    }
  } catch (e) {
    toast(`Could not import ${name}: ${(e as Error).message}`, 'error');
  }
}

/** Adds an SVG as editable items (grouped), centred on `at`, in one undo step; asks how unless `opts` is given. */
async function importSvgDrawing(fileName: string, text: string, at: Point, opts?: SvgImportOptions) {
  const drawing = svgToDrawing(text);
  const name = fileName.replace(/\.svg$/i, '').trim() || 'Imported SVG';
  const how = opts ?? (await askSvgImport(name, drawing));
  if (!how) return;
  const g = S().doc.settings.grid;
  const ids: string[] = [];
  const ok = mutate((d) => {
    ids.push(...insertSvgDrawing(d as CircuitDoc, drawing, { x: snap(at.x, g), y: snap(at.y, g) }, S().scope, name, how));
  }, ids);
  if (!ok) return;
  const count = (type: string) => ids.filter((id) => S().doc.items[id]?.type === type).length;
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;
  const [parts, wires] = [count('component'), count('wire')];
  const rest = ids.length - parts - wires;
  const what = [parts && n(parts, 'part'), wires && n(wires, 'wire'), rest && n(rest, wires || parts ? 'other item' : 'item')].filter(Boolean).join(', ');
  toast(`Imported “${name}” — ${what || 'nothing'} (grouped; double-click to edit inside)`, 'success');
}

/** Imports one file of any supported kind; text formats go through `importFileText`. */
async function importOneFile(file: File, at?: Point) {
  // a PNG exported with its circuit inside is that circuit, not a picture
  const embedded =
    /\.png$/i.test(file.name) || file.type === 'image/png' ? await sceneFromPicture(file).catch(() => null) : null;
  if (embedded) return importFileText(file.name, embedded.json, at, undefined, { width: embedded.width, height: embedded.height });
  if (isRaster(file) || isPdf(file)) {
    try {
      let pictures;
      let note = '';
      if (isPdf(file)) {
        const { pages, total } = await pdfToPictures(file);
        if (!pages.length) throw new Error('The PDF has no pages');
        pictures = pages;
        note = total > pages.length ? ` (first ${pages.length} of ${total} pages)` : pages.length > 1 ? ` (${pages.length} pages)` : '';
      } else {
        pictures = [await rasterToPicture(file)];
      }
      insertPictures(pictures, at ?? viewCentre());
      toast(`Inserted ${file.name}${note}`, 'success');
    } catch (e) {
      toast(`Could not import ${file.name}: ${(e as Error).message}`, 'error');
    }
    return;
  }
  await importFileText(file.name, await file.text(), at);
}

/** Imports files dropped onto the app, in order. */
export async function importDroppedFiles(files: FileList | File[], at?: Point) {
  for (const f of [...files]) await importOneFile(f, at);
}

/** File → Import…: picks any supported file. */
export async function importFile() {
  const picked = await openAnyFile(IMPORT_FILTER);
  if (picked) await importOneFile(picked.file);
}
