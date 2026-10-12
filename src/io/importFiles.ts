import { snap } from '../model/geometry';
import { insertSvgDrawing } from '../model/svgDrawing';
import type { CircuitDoc, Point } from '../model/types';
import { S, mutate, toast } from '../store/store';
import { openCircuitText } from './fileActions';
import { openAnyFile } from './files';
import { insertPictures, isPdf, isRaster, pdfToPictures, rasterToPicture } from './imageImport';
import { importLibraryText, importTemplateText } from './sharing';
import { svgToDrawing } from './svgImport';

/** Everything "Import file…" and drag & drop understand. */
export const IMPORT_FILTER = [
  { name: 'Nodal files, SVG, PDF and images', extensions: ['nodal', 'json', 'svg', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'] },
];

export const viewCentre = (): Point => {
  const { view, canvasSize } = S();
  return { x: (canvasSize.w / 2 - view.x) / view.zoom, y: (canvasSize.h / 2 - view.y) / view.zoom };
};

/**
 * Imports one file by sniffing its contents: a circuit opens, a symbol library
 * merges into "My symbols", a template / copied selection is inserted at `at`,
 * and an SVG becomes editable wires and shapes placed at `at`.
 */
export async function importFileText(name: string, text: string, path: string | null = null, at?: Point): Promise<void> {
  try {
    const trimmed = text.trimStart();
    if (/\.svg$/i.test(name) || (trimmed.startsWith('<') && /<svg[\s>]/i.test(text))) {
      importSvgDrawing(name, text, at ?? viewCentre());
      return;
    }
    let data: { format?: unknown };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Nodal can import circuits (.nodal), symbol libraries, templates, SVG, PDF and images');
    }
    switch (data?.format) {
      case 'nodal':
        await openCircuitText(name, text, path);
        return;
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

/** Adds an SVG as editable wires, shapes and text (grouped), centred on `at`, in one undo step. */
function importSvgDrawing(fileName: string, text: string, at: Point) {
  const drawing = svgToDrawing(text);
  const name = fileName.replace(/\.svg$/i, '').trim() || 'Imported SVG';
  const g = S().doc.settings.grid;
  const ids: string[] = [];
  mutate((d) => {
    ids.push(...insertSvgDrawing(d as CircuitDoc, drawing, { x: snap(at.x, g), y: snap(at.y, g) }, S().scope, name));
  }, ids);
  const wires = ids.filter((id) => S().doc.items[id]?.type === 'wire').length;
  toast(`Imported “${name}” — ${wires} wire${wires === 1 ? '' : 's'}${ids.length > wires ? ` and ${ids.length - wires} other item${ids.length - wires === 1 ? '' : 's'}` : ''} (grouped; double-click to edit inside)`, 'success');
}

/** Imports one file of any supported kind; text formats go through `importFileText`. */
async function importOneFile(file: File, path: string | null, at?: Point) {
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
  await importFileText(file.name, await file.text(), path, at);
}

/** Imports files dropped onto the app, in order. */
export async function importDroppedFiles(files: FileList | File[], at?: Point) {
  for (const f of [...files]) await importOneFile(f, null, at);
}

/** File → Import…: picks any supported file. */
export async function importFile() {
  const picked = await openAnyFile(IMPORT_FILTER);
  if (picked) await importOneFile(picked.file, picked.path);
}
