import { BUILTIN } from '../model/symbols';
import type { Prim, SymbolDef } from '../model/types';

/*
 * "Add a symbol library by link": opening Nodal at
 *   https://…/nodal/#addLibrary=<url-encoded https URL of a .json library>
 * fetches that file and, once the user agrees, adds its symbols to My symbols
 * (the Excalidraw convention; a `&token=…` after it is accepted and ignored).
 * Everything here is pure or takes its fetch from outside, so it is testable.
 */

/** Largest library file fetched, in bytes. */
export const LIBRARY_MAX_BYTES = 5 * 1024 * 1024;
/** How long the download may take, ms. */
export const LIBRARY_TIMEOUT_MS = 15_000;
/** Most symbols one link may add. */
export const LIBRARY_MAX_SYMBOLS = 2000;

/** The library URL in a page hash (`#addLibrary=…`), still unchecked; null when there is none. */
export function parseAddLibraryHash(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!/^addLibrary=/i.test(h)) return null;
  // the URL is percent-encoded, so its own '&' and '#' can't end it early
  const raw = h.slice(h.indexOf('=') + 1).split('&')[0];
  try {
    const url = decodeURIComponent(raw).trim();
    return url || null;
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Checks a library URL: https only (plain http just for localhost, while
 * developing), no user name or password in it. Throws with a message for the user.
 */
export function checkLibraryUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The library link is not a valid web address.');
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Libraries can only be added from https:// addresses.');
  if (url.username || url.password) throw new Error('The library link must not carry a user name or password.');
  return url;
}

/** The link that opens Nodal (at `appUrl`) and offers to add the library at `fileUrl`. Throws if `fileUrl` isn't allowed. */
export function buildLibraryLink(fileUrl: string, appUrl: string): string {
  const url = checkLibraryUrl(fileUrl.trim());
  const base = appUrl.split('#')[0];
  return `${base}#addLibrary=${encodeURIComponent(url.href)}`;
}

/**
 * Downloads a library file as text: no cookies, no referrer, a timeout and a
 * size cap (checked against Content-Length and again while reading).
 */
export async function fetchLibraryText(
  url: URL,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? LIBRARY_MAX_BYTES;
  const tooBig = () => new Error(`The library is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, opts.timeoutMs ?? LIBRARY_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url.href, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow' });
    } catch {
      throw new Error(timedOut ? 'The library took too long to download.' : `Could not reach ${url.host} (offline, or the server doesn’t allow downloads from other sites).`);
    }
    if (!res.ok) throw new Error(`The server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`);
    // a redirect must not leave https either
    if (res.url) checkLibraryUrl(res.url);
    const declared = Number(res.headers?.get('content-length'));
    if (declared > maxBytes) throw tooBig();
    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      if (new TextEncoder().encode(text).length > maxBytes) throw tooBig();
      return text;
    }
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel();
        throw tooBig();
      }
      parts.push(value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.byteLength;
    }
    return new TextDecoder().decode(all);
  } catch (e) {
    if (timedOut) throw new Error('The library took too long to download.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Validation: a library from the web is data, checked field by field  */
/* ------------------------------------------------------------------ */

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, max = 500): v is string => typeof v === 'string' && v.length <= max;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nums = (v: unknown): v is number[] => Array.isArray(v) && v.length <= 4000 && v.every(isNum);
/** Plain colours only (hex, names, rgb/hsl): never url(…) or anything else CSS could fetch. */
const COLOUR = /^(#[0-9a-f]{3,8}|[a-z]{3,30}|(rgb|hsl)a?\([\d\s.,%a-z/+-]{1,60}\))$/i;
/** SVG path data: commands, numbers and separators, nothing else. */
const PATH_D = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$/;
const FILLS = new Set(['none', 'solid', 'bg']);
const SIDES = new Set(['left', 'right', 'top', 'bottom']);
const ANCHORS = new Set(['start', 'middle', 'end']);

function cleanPrim(p: unknown): Prim | null {
  if (!isObj(p)) return null;
  const style: { color?: string; fc?: string; dash?: boolean } = {};
  if (p.color !== undefined) {
    if (!isStr(p.color, 80) || !COLOUR.test(p.color)) return null;
    style.color = p.color;
  }
  if (p.fc !== undefined) {
    if (!isStr(p.fc, 80) || !COLOUR.test(p.fc)) return null;
    style.fc = p.fc;
  }
  if (p.dash !== undefined) style.dash = !!p.dash;
  const fill = () => (FILLS.has(p.fill as string) ? (p.fill as 'none' | 'solid' | 'bg') : 'none');
  const w = isNum(p.w) ? { w: p.w } : {};
  switch (p.t) {
    case 'line':
      return nums(p.pts) ? { ...style, t: 'line', pts: p.pts, ...w } : null;
    case 'poly':
      return nums(p.pts) ? { ...style, t: 'poly', pts: p.pts, fill: fill(), ...w } : null;
    case 'rect':
      if (![p.x, p.y, p.w, p.h].every(isNum)) return null;
      return { ...style, t: 'rect', x: p.x as number, y: p.y as number, w: p.w as number, h: p.h as number, fill: fill(), ...(isNum(p.rx) ? { rx: p.rx } : {}), ...(isNum(p.sw) ? { sw: p.sw } : {}) };
    case 'circle':
      return [p.cx, p.cy, p.r].every(isNum) ? { ...style, t: 'circle', cx: p.cx as number, cy: p.cy as number, r: p.r as number, fill: fill(), ...w } : null;
    case 'ellipse':
      return [p.cx, p.cy, p.rx, p.ry].every(isNum) ? { ...style, t: 'ellipse', cx: p.cx as number, cy: p.cy as number, rx: p.rx as number, ry: p.ry as number, fill: fill(), ...w } : null;
    case 'arc':
      return [p.cx, p.cy, p.r, p.a1, p.a2].every(isNum) ? { ...style, t: 'arc', cx: p.cx as number, cy: p.cy as number, r: p.r as number, a1: p.a1 as number, a2: p.a2 as number, ...w } : null;
    case 'path':
      return isStr(p.d, 20000) && PATH_D.test(p.d) ? { ...style, t: 'path', d: p.d, fill: fill(), ...w } : null;
    case 'text':
      if (![p.x, p.y, p.size].every(isNum) || !isStr(p.text, 500)) return null;
      return { ...style, t: 'text', x: p.x as number, y: p.y as number, size: p.size as number, anchor: ANCHORS.has(p.anchor as string) ? (p.anchor as 'start' | 'middle' | 'end') : 'start', text: p.text };
  }
  return null;
}

function cleanPrims(v: unknown): Prim[] | null {
  if (!Array.isArray(v) || v.length > 2000) return null;
  const out: Prim[] = [];
  for (const p of v) {
    const c = cleanPrim(p);
    if (!c) return null;
    out.push(c);
  }
  return out;
}

/** A symbol from an untrusted library, rebuilt from known fields only; null when anything is off. */
export function cleanSymbol(id: string, raw: unknown): SymbolDef | null {
  if (!isObj(raw) || !isStr(id, 120) || !/^[\w.:-]+$/.test(id)) return null;
  const prims = cleanPrims(raw.prims);
  if (!prims || !isNum(raw.w) || !isNum(raw.h) || !isStr(raw.name, 200) || !raw.name.trim()) return null;
  if (!Array.isArray(raw.ports) || raw.ports.length > 1000) return null;
  const ports = [];
  for (const p of raw.ports) {
    if (!isObj(p) || !isStr(p.id, 60) || !isStr(p.name ?? '', 120) || !isNum(p.x) || !isNum(p.y)) return null;
    ports.push({ id: p.id, name: (p.name as string | undefined) ?? p.id, x: p.x, y: p.y, side: (SIDES.has(p.side as string) ? p.side : 'left') as SymbolDef['ports'][number]['side'] });
  }
  const def: SymbolDef = {
    id,
    name: raw.name,
    category: isStr(raw.category, 120) && raw.category.trim() ? raw.category : 'My symbols',
    w: raw.w,
    h: raw.h,
    prims,
    ports,
    prefix: isStr(raw.prefix, 20) ? raw.prefix : 'U',
  };
  if (isStr(raw.keywords, 500)) def.keywords = raw.keywords;
  if (isStr(raw.value, 200)) def.value = raw.value;
  if (isStr(raw.source, 50000)) def.source = raw.source;
  if (raw.custom === true) def.custom = true;
  if (raw.hideLabels === true) def.hideLabels = true;
  if (raw.valueIsLabel === true) def.valueIsLabel = true;
  if (isStr(raw.variantOf, 120)) def.variantOf = raw.variantOf;
  if (isStr(raw.variantName, 200)) def.variantName = raw.variantName;
  if (Array.isArray(raw.fields)) {
    const fields = raw.fields.filter((f): f is { key: string; label: string; default?: string } => isObj(f) && isStr(f.key, 60) && isStr(f.label, 120) && (f.default === undefined || isStr(f.default, 500)));
    if (fields.length) def.fields = fields.map((f) => ({ key: f.key, label: f.label, ...(f.default !== undefined ? { default: f.default } : {}) }));
  }
  if (Array.isArray(raw.variants)) {
    const v = raw.variants.filter((r): r is { id: string; name: string } => isObj(r) && isStr(r.id, 120) && isStr(r.name, 200));
    if (v.length) def.variants = v.map((r) => ({ id: r.id, name: r.name }));
  }
  if (raw.closedPrims !== undefined) {
    const closed = cleanPrims(raw.closedPrims);
    if (closed) def.closedPrims = closed;
  }
  return def;
}

export interface RemoteLibrary {
  name: string;
  symbols: Record<string, SymbolDef>;
  /** Symbols left out: malformed, or named like a built-in symbol (a library can't replace those). */
  skipped: number;
}

/** Reads a downloaded file as a Nodal symbol library (the "Share whole symbol library" format). Throws when it isn't one. */
export function parseRemoteLibrary(text: string): RemoteLibrary {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('The link doesn’t point to a Nodal symbol library (not JSON).');
  }
  if (!isObj(raw) || raw.format !== 'nodal-library' || !isObj(raw.symbols)) throw new Error('The link doesn’t point to a Nodal symbol library.');
  const entries = Object.entries(raw.symbols);
  if (entries.length > LIBRARY_MAX_SYMBOLS) throw new Error(`The library has more than ${LIBRARY_MAX_SYMBOLS} symbols.`);
  const symbols: Record<string, SymbolDef> = {};
  let skipped = 0;
  for (const [id, def] of entries) {
    const clean = BUILTIN[id] ? null : cleanSymbol(id, def);
    if (clean) symbols[id] = clean;
    else skipped++;
  }
  const name = isStr(raw.name, 200) && raw.name.trim() ? raw.name.trim() : 'Symbol library';
  return { name, symbols, skipped };
}
