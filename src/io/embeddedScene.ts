import { normalizePages } from '../model/pages';
import type { CircuitDoc } from '../model/types';
import { extractPngText, insertPngText, isPng, pngSize } from './pngMeta';

/**
 * Exported PNG and SVG pictures can carry the circuit they show (the same JSON
 * as a .nodal file), so dropping, importing, pasting or opening the picture
 * gives the editable circuit back. In a PNG it is an iTXt chunk; in an SVG a
 * base64 <metadata> element. Reading it is data only: the text is JSON-parsed
 * and checked, never put into a DOM.
 */
export const SCENE_TYPE = 'application/vnd.nodal+json';

const SVG_RE = /<metadata id="nodal-scene"[^>]*>([A-Za-z0-9+/=\s]*)<\/metadata>/;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

/** The text of an exported SVG's <title>; the page name, on a multi-page circuit. */
export function svgTitle(text: string | null | undefined): string | null {
  const raw = text ? TITLE_RE.exec(text)?.[1] : null;
  if (!raw) return null;
  const decoded = raw
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
  return decoded || null;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** `json` when it is a Nodal circuit, else null. */
function circuitJson(json: string | null): string | null {
  if (!json) return null;
  try {
    const d = JSON.parse(json) as { format?: unknown; items?: unknown };
    return d && typeof d === 'object' && d.format === 'nodal' && !!d.items && typeof d.items === 'object' ? json : null;
  } catch {
    return null;
  }
}

/**
 * The circuit as stored in a picture: every page and every item's page, with
 * stale page ids repaired exactly as a `.nodal` file is written.
 */
export const sceneJson = (doc: CircuitDoc) => JSON.stringify(normalizePages(doc));

/** The SVG with the circuit stored in it. */
export function svgWithScene(svg: string, json: string): string {
  return svg.replace(/<svg\b[^>]*>/, (open) => `${open}\n<metadata id="nodal-scene" data-type="${SCENE_TYPE}">${toBase64(json)}</metadata>`);
}

/** The circuit stored in an SVG's text (null when it has none). */
export function sceneFromSvgText(text: string | null | undefined): string | null {
  const m = text ? SVG_RE.exec(text) : null;
  if (!m) return null;
  try {
    return circuitJson(fromBase64(m[1]));
  } catch {
    return null;
  }
}

/** The PNG with the circuit stored in it. */
export async function pngWithScene(png: Blob, json: string): Promise<Blob> {
  const bytes = insertPngText(new Uint8Array(await png.arrayBuffer()), SCENE_TYPE, json);
  return new Blob([bytes as BlobPart], { type: 'image/png' });
}

/** The circuit stored in a PNG's bytes (null when it has none or it is damaged). */
export function sceneFromPng(bytes: Uint8Array): string | null {
  return circuitJson(extractPngText(bytes, SCENE_TYPE));
}

/** The circuit stored in a PNG or SVG file or blob; null for anything else. */
export async function sceneFromFile(file: Blob & { name?: string }): Promise<string | null> {
  return (await sceneFromPicture(file))?.json ?? null;
}

/**
 * The circuit a picture carries, and a PNG's pixel size, so an older picture
 * of a page can be matched to that page.
 */
export async function sceneFromPicture(
  file: Blob & { name?: string },
): Promise<{ json: string; width?: number; height?: number } | null> {
  const name = file.name ?? '';
  if (file.type === 'image/png' || /\.png$/i.test(name)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const json = isPng(bytes) ? sceneFromPng(bytes) : null;
    const size = pngSize(bytes);
    return json ? { json, width: size?.w, height: size?.h } : null;
  }
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(name)) {
    const json = sceneFromSvgText(await file.text());
    return json ? { json } : null;
  }
  return null;
}
