import { prepareMath } from '../model/latex';
import type { Fragment } from '../model/ops';
import type { CircuitDoc } from '../model/types';
import { exportPng, exportSvg, type SvgOptions } from './export';

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
    const ok = (x: unknown) => !!x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string' && typeof (x as { type?: unknown }).type === 'string';
    // pasted text can be anything: only take fragments whose items look like items
    return frag && Array.isArray(frag.items) && frag.items.length && frag.items.every(ok) && (!frag.groups || Array.isArray(frag.groups)) ? frag : null;
  } catch {
    return null;
  }
}

/**
 * Puts a picture on the system clipboard: a PNG, an SVG image where the
 * browser allows it, and SVG text (carrying `frag`, the copied items, when
 * given). Falls back to the SVG text alone. Both pictures use `opts`, exactly
 * as an export would. Must be called from the key or click that copies: the
 * write starts before anything is awaited.
 */
export async function writePictureClipboard(doc: CircuitDoc, opts: SvgOptions & { scale: number }, frag?: Fragment): Promise<boolean> {
  const svg = (async () => {
    await prepareMath(doc).catch(() => undefined);
    const out = exportSvg(doc, opts).svg;
    return frag ? svgWithFragment(out, frag) : out;
  })();
  const cb = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  const Item = globalThis.ClipboardItem as (typeof ClipboardItem & { supports?: (type: string) => boolean }) | undefined;
  if (Item && typeof cb?.write === 'function') {
    const data: Record<string, Promise<Blob>> = {
      'text/plain': svg.then((s) => new Blob([s], { type: 'text/plain' })),
      'image/png': svg.then(() => exportPng(doc, opts)),
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
