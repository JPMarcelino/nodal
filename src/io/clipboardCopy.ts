import { prepareMath } from '../model/latex';
import type { Fragment } from '../model/ops';
import type { CircuitDoc } from '../model/types';
import { exportPng, exportSvg } from './export';

/**
 * Copied items travel as an SVG picture that carries the items themselves in a
 * <metadata> element: other apps paste the picture, Nodal pastes editable parts.
 */
const META_RE = /<metadata id="nodal-fragment">([\s\S]*?)<\/metadata>/;

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The SVG with the copied items stored in it. */
export function svgWithFragment(svg: string, frag: Fragment): string {
  return svg.replace(/<svg\b[^>]*>/, (open) => `${open}\n<metadata id="nodal-fragment">${escapeXml(JSON.stringify(frag))}</metadata>`);
}

/** The copied items in clipboard text: a fragment's JSON, or an SVG Nodal copied (null for anything else). */
export function fragmentFromText(text: string | null | undefined): Fragment | null {
  if (!text) return null;
  const meta = META_RE.exec(text);
  if (!meta && !text.includes('"nodal-fragment"')) return null;
  try {
    const frag = JSON.parse(meta ? unescapeXml(meta[1]) : text) as Fragment;
    return frag && Array.isArray(frag.items) && frag.items.length ? frag : null;
  } catch {
    return null;
  }
}

/**
 * Puts the selection on the system clipboard as a PNG, as an SVG image where
 * the browser allows it, and as SVG text (with the items inside, see above).
 * Falls back to the SVG text alone. `look` is the export theme and background.
 * Must be called from the key or click that copies: the write starts before
 * anything is awaited.
 */
export async function writeSelectionClipboard(doc: CircuitDoc, ids: string[], frag: Fragment, look: { theme: 'light' | 'dark'; background: boolean }): Promise<boolean> {
  const { theme, background } = look;
  const svg = (async () => {
    await prepareMath(doc).catch(() => undefined);
    return svgWithFragment(exportSvg(doc, { theme, background, padding: 10, ids }).svg, frag);
  })();
  const cb = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  const Item = globalThis.ClipboardItem as (typeof ClipboardItem & { supports?: (type: string) => boolean }) | undefined;
  if (Item && typeof cb?.write === 'function') {
    const data: Record<string, Promise<Blob>> = {
      'text/plain': svg.then((s) => new Blob([s], { type: 'text/plain' })),
      // pasted pictures get the canvas behind them: most apps show transparency as white or black
      'image/png': svg.then(() => exportPng(doc, { theme, background: true, padding: 10, ids, scale: 2 })),
    };
    if (Item.supports?.('image/svg+xml')) data['image/svg+xml'] = svg.then((s) => new Blob([s], { type: 'image/svg+xml' }));
    try {
      await cb.write([new Item(data)]);
      return true;
    } catch {
      /* unsupported types or no permission (Firefox, WebKitGTK): text only */
    }
  }
  try {
    await cb?.writeText(await svg);
    return true;
  } catch {
    return false;
  }
}
