import type { CircuitDoc } from '../model/types';
import { extractPngText, insertPngText, isPng } from './pngMeta';

/**
 * Exported PNG and SVG pictures can carry the circuit they show (the same JSON
 * as a .nodal file), so dropping, importing, pasting or opening the picture
 * gives the editable circuit back. In a PNG it is an iTXt chunk; in an SVG a
 * base64 <metadata> element. Reading it is data only: the text is JSON-parsed
 * and checked, never put into a DOM.
 */
export const SCENE_TYPE = 'application/vnd.nodal+json';

const SVG_RE = /<metadata id="nodal-scene"[^>]*>([A-Za-z0-9+/=\s]*)<\/metadata>/;

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

/** The circuit as stored in a picture. */
export const sceneJson = (doc: CircuitDoc) => JSON.stringify(doc);

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
  const name = file.name ?? '';
  if (file.type === 'image/png' || /\.png$/i.test(name)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return isPng(bytes) ? sceneFromPng(bytes) : null;
  }
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(name)) return sceneFromSvgText(await file.text());
  return null;
}
