import type { Point } from '../model/types';
import { toast } from '../store/store';
import { pasteFragment } from '../store/actions';
import { importFileText, viewCentre } from './importFiles';
import { insertPictures, rasterToPicture, type Picture } from './imageImport';
import { fragmentFromText } from './clipboardCopy';
import { sceneFromPicture } from './embeddedScene';

export type ClipboardPasteKind = 'fragment' | 'circuit' | 'image' | 'svg' | 'none';

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
 * picture exported with its circuit, raster image, SVG document — and reports which path ran. The in-memory
 * fragment fallback stays in `paste()`, which owns that state; reading the
 * clipboard stays there too, so this function is pure logic plus insertion
 * and is easy to unit test.
 */
export async function pasteClipboardContent(
  { text, imageBlob, svgText }: ClipboardPasteData,
  at?: Point,
  deps: ClipboardPasteDeps = {},
): Promise<ClipboardPasteKind> {
  // our own copy (JSON, or an SVG with the items inside) pastes as editable items, not as a picture
  const frag = fragmentFromText(text) ?? fragmentFromText(svgText);
  if (frag) {
    pasteFragment(frag, at);
    return 'fragment';
  }
  // an exported PNG that carries its circuit (most apps drop the chunk when copying, but not all)
  const scene = imageBlob ? await sceneFromPicture(imageBlob).catch(() => null) : null;
  if (scene) {
    await importFileText('Pasted circuit.png', scene.json, at, undefined, { width: scene.width, height: scene.height });
    return 'circuit';
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
    await (deps.importSvg ?? ((name: string, body: string, p?: Point) => importFileText(name, body, p)))('Pasted SVG.svg', svg, at);
    return 'svg';
  }
  return 'none';
}
