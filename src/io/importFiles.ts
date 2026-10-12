import { uid } from '../model/doc';
import { snap } from '../model/geometry';
import { compileSource, primsToDsl } from '../model/symbols/dsl';
import type { Point } from '../model/types';
import { placeComponent } from '../store/actions';
import { S, saveUserSymbol, toast } from '../store/store';
import { openCircuitText } from './fileActions';
import { openAnyFile } from './files';
import { insertPictures, isPdf, isRaster, pdfToPictures, rasterToPicture } from './imageImport';
import { importLibraryText, importTemplateText } from './sharing';
import { svgToPrims } from './svgImport';

/** Everything "Import file…" and drag & drop understand. */
export const IMPORT_FILTER = [
  { name: 'Nodal files, SVG, PDF and images', extensions: ['nodal', 'json', 'svg', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'] },
];

const viewCentre = (): Point => {
  const { view, canvasSize } = S();
  return { x: (canvasSize.w / 2 - view.x) / view.zoom, y: (canvasSize.h / 2 - view.y) / view.zoom };
};

/**
 * Imports one file by sniffing its contents: a circuit opens, a symbol library
 * merges into "My symbols", a template / copied selection is inserted at `at`,
 * and an SVG becomes a new symbol placed at `at`.
 */
export async function importFileText(name: string, text: string, path: string | null = null, at?: Point): Promise<void> {
  try {
    const trimmed = text.trimStart();
    if (/\.svg$/i.test(name) || (trimmed.startsWith('<') && /<svg[\s>]/i.test(text))) {
      importSvgSymbol(name, text, at ?? viewCentre());
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

/** Turns an SVG drawing into a pin-less symbol in "My symbols" and places it. */
function importSvgSymbol(fileName: string, text: string, at: Point) {
  const { prims, w, h } = svgToPrims(text, 80);
  const name = fileName.replace(/\.svg$/i, '').trim() || 'Imported SVG';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'svg';
  const def = compileSource({
    id: `user-${slug}-${uid('').slice(-5)}`,
    name,
    category: 'My symbols',
    w,
    h,
    draw: primsToDsl(prims),
    ports: '',
    prefix: 'U',
    value: '',
    fields: '',
    keywords: 'svg import',
  });
  saveUserSymbol(def);
  const g = S().doc.settings.grid;
  placeComponent(def.id, snap(at.x, g), snap(at.y, g));
  toast(`Added “${name}” to My symbols — edit it to add pins`, 'success');
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
