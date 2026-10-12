import type { Point } from '../model/types';
import type { Fragment } from '../model/ops';
import { toast } from '../store/store';
import { pasteFragment } from '../store/actions';
import { importFileText, viewCentre } from './importFiles';
import { insertPictures, rasterToPicture, type Picture } from './imageImport';

export type ClipboardPasteKind = 'fragment' | 'image' | 'svg' | 'none';

export interface ClipboardPasteData {
  text?: string | null;
  imageBlob?: Blob | null;
  svgText?: string | null;
}

/** Test overrides (the image decoder needs a browser canvas). */
export interface ClipboardPasteDeps {
  rasterToPicture?: (blob: Blob) => Promise<Picture>;
  insertPictures?: (pictures: Picture[], at: Point) => string[];
  importSvg?: (name: string, text: string, at?: Point) => Promise<void>;
}

export const PASTE_IMAGE_RE = /^image\/(png|jpeg|gif|webp|bmp|avif)$/;

/** True when pasted text is an SVG document rather than prose or JSON. */
export function isSvgText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<') && /<svg[\s>]/i.test(t);
}

/**
 * Handles already-read clipboard data in priority order — Nodal fragment,
 * raster image, SVG document — and reports which path ran. The in-memory
 * fragment fallback stays in `paste()`, which owns that state; reading the
 * clipboard stays there too, so this function is pure logic plus insertion
 * and is easy to unit test.
 */
export async function pasteClipboardContent(
  { text, imageBlob, svgText }: ClipboardPasteData,
  at?: Point,
  deps: ClipboardPasteDeps = {},
): Promise<ClipboardPasteKind> {
  if (text && text.includes('"nodal-fragment"')) {
    try {
      const frag = JSON.parse(text) as Fragment;
      if (frag && Array.isArray(frag.items) && frag.items.length) {
        pasteFragment(frag, at);
        return 'fragment';
      }
    } catch {
      /* corrupt JSON: carry on to the image / in-memory paths */
    }
  }
  if (imageBlob) {
    try {
      const pic = await (deps.rasterToPicture ?? rasterToPicture)(imageBlob);
      (deps.insertPictures ?? insertPictures)([pic], at ?? viewCentre());
      toast('Pasted image', 'success');
    } catch (e) {
      toast(`Could not paste image: ${(e as Error).message}`, 'error');
    }
    return 'image';
  }
  const svg = svgText || (text && isSvgText(text) ? text : null);
  if (svg) {
    await (deps.importSvg ?? ((name: string, body: string, p?: Point) => importFileText(name, body, null, p)))('Pasted SVG.svg', svg, at);
    return 'svg';
  }
  return 'none';
}
