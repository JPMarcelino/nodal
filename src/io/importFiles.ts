import { normalizeDoc } from '../model/doc';
import { snap } from '../model/geometry';
import { insertSvgDrawing, type SvgImportOptions } from '../model/svgDrawing';
import type { CircuitDoc, Point } from '../model/types';
import { S, mutate, toast } from '../store/store';
import { askSvgImport } from '../ui/SvgImportDialog';
import { openAnyFile } from './files';
import { insertPictures, isPdf, isRaster, pdfToPictures, rasterToPicture } from './imageImport';
import { importLibraryText, importTemplateText, insertCircuit } from './sharing';
import { svgToDrawing } from './svgImport';
import { fragmentFromText } from './clipboardCopy';
import { sceneFromFile, sceneFromSvgText } from './embeddedScene';

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
export async function importFileText(name: string, text: string, at?: Point, svg?: SvgImportOptions): Promise<void> {
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
    let data: { format?: unknown };
    try {
      data = JSON.parse(embedded ?? text);
    } catch {
      throw new Error('Nodal can import circuits (.nodal), symbol libraries, templates, SVG, PDF and images');
    }
    switch (data?.format) {
      case 'nodal': {
        // dropped or imported circuits are added to this one; File → Open replaces it
        const ids = insertCircuit(normalizeDoc(data), at);
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
  const embedded = /\.png$/i.test(file.name) || file.type === 'image/png' ? await sceneFromFile(file).catch(() => null) : null;
  if (embedded) return importFileText(file.name, embedded, at);
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
