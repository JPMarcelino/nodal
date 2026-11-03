import type { FieldDef, Fill, PortDef, Prim, Side, SymbolDef, VariantRef } from '../model/types';

/*
 * KiCad symbol libraries (.kicad_sym, format 6 and later) as Nodal symbols.
 *
 * KiCad draws in millimetres with y pointing up, pins on a 100 mil (2.54 mm)
 * grid. Nodal draws in pixels with y down on a 10 px grid, so 50 mil becomes
 * 10 px and every KiCad pin lands on a Nodal grid point. A pin's connection
 * point is its outer end; its line runs from there towards the body.
 *
 * A symbol with several units (the gates of a 7400, the halves of a dual
 * op-amp, a power unit) becomes its first unit, with the other units as its
 * "types". Alternate body styles (De Morgan) are left out. Everything here is
 * pure, so the converter runs in the browser and in the library build script.
 */

/** Pixels per millimetre: 1.27 mm (50 mil) is one 10 px grid step. */
export const KICAD_PX = 10 / 1.27;

/* ------------------------------------------------------------------ */
/* S-expressions                                                       */
/* ------------------------------------------------------------------ */

export type SExpr = string | SExpr[];

/** Parses KiCad's S-expression text into nested arrays (strings unquoted). */
export function parseSExpr(text: string): SExpr[] {
  const root: SExpr[] = [];
  const stack: SExpr[][] = [root];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 40 /* ( */) {
      const list: SExpr[] = [];
      stack[stack.length - 1].push(list);
      stack.push(list);
      i++;
    } else if (c === 41 /* ) */) {
      if (stack.length > 1) stack.pop();
      i++;
    } else if (c === 34 /* " */) {
      let s = '';
      i++;
      while (i < n && text.charCodeAt(i) !== 34) {
        if (text.charCodeAt(i) === 92 /* \ */ && i + 1 < n) {
          const e = text[i + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else s += text[i++];
      }
      i++;
      stack[stack.length - 1].push(s);
    } else if (c <= 32) i++;
    else {
      let j = i;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d <= 32 || d === 40 || d === 41) break;
        j++;
      }
      stack[stack.length - 1].push(text.slice(i, j));
      i = j;
    }
  }
  return root;
}

const isList = (e: SExpr | undefined): e is SExpr[] => Array.isArray(e);
const head = (e: SExpr) => (isList(e) && typeof e[0] === 'string' ? e[0] : '');
const kids = (e: SExpr[], name: string) => e.filter((k): k is SExpr[] => isList(k) && k[0] === name);
const kid = (e: SExpr[] | undefined, name: string) => e?.find((k): k is SExpr[] => isList(k) && k[0] === name);
const num = (v: SExpr | undefined, d = 0) => (typeof v === 'string' && v !== '' && !Number.isNaN(+v) ? +v : d);
const str = (v: SExpr | undefined) => (typeof v === 'string' ? v : '');
/** `(hide yes)`, a bare `hide` token (format 6/7), or absent. */
const hidden = (e: SExpr[] | undefined) => !!e && e.some((k) => k === 'hide' || (isList(k) && k[0] === 'hide' && k[1] !== 'no'));

/* ------------------------------------------------------------------ */
/* Conversion                                                          */
/* ------------------------------------------------------------------ */

const R = (v: number) => Math.round(v * 10) / 10;
const X = (mm: number) => R(mm * KICAD_PX);
const Y = (mm: number) => R(-mm * KICAD_PX);
const xy = (e: SExpr[] | undefined) => (e ? { x: X(num(e[1])), y: Y(num(e[2])) } : { x: 0, y: 0 });

/** KiCad's text markup as plain text: ~{RST} gets an overbar, _{x} and ^{x} lose their braces. */
export function kicadText(s: string): string {
  return s
    .replace(/~\{([^}]*)\}/g, (_, t: string) => [...t].map((ch) => ch + '̅').join(''))
    .replace(/[_^]\{([^}]*)\}/g, '$1')
    .replace(/\{slash\}/g, '/')
    .replace(/\{dblquote\}/g, '"');
}

interface Style {
  w?: number;
  dash?: boolean;
  fill: Fill;
  fc?: string;
}

function styleOf(e: SExpr[]): Style {
  const stroke = kid(e, 'stroke');
  const width = num(kid(stroke, 'width')?.[1]);
  const type = str(kid(stroke, 'type')?.[1]);
  const fillType = str(kid(kid(e, 'fill'), 'type')?.[1]) || 'none';
  const out: Style = { fill: fillType === 'outline' ? 'solid' : fillType === 'background' ? 'bg' : fillType === 'color' ? 'solid' : 'none' };
  const px = width * KICAD_PX;
  // the default width (0.254 mm) is Nodal's default 2 px: leave it unset so it follows the theme
  if (width > 0 && Math.abs(px - 2) > 0.3) out.w = R(Math.max(0.5, px));
  if (type === 'dash' || type === 'dot' || type === 'dash_dot' || type === 'dash_dot_dot') out.dash = true;
  if (fillType === 'color') {
    const c = kid(kid(e, 'fill'), 'color');
    if (c) out.fc = `rgb(${num(c[1])},${num(c[2])},${num(c[3])})`;
  }
  return out;
}

const withStyle = <P extends Prim>(p: P, s: Style): P => {
  const o = p as P & { w?: number; dash?: boolean; fc?: string };
  if (s.w !== undefined && o.t !== 'text') {
    if (o.t === 'rect') (o as { sw?: number }).sw = s.w;
    else o.w = s.w;
  }
  if (s.dash) o.dash = true;
  if (s.fc && s.fill === 'solid') o.fc = s.fc;
  return o;
};

/** Points along the arc through start, mid and end (KiCad's three-point arc). */
function arcPoints(a: { x: number; y: number }, m: { x: number; y: number }, b: { x: number; y: number }): number[] {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-9) return [a.x, a.y, b.x, b.y];
  const sq = (p: { x: number; y: number }) => p.x * p.x + p.y * p.y;
  const cx = (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d;
  const cy = (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d;
  const r = Math.hypot(a.x - cx, a.y - cy);
  const ang = (p: { x: number; y: number }) => Math.atan2(p.y - cy, p.x - cx);
  const a0 = ang(a);
  const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let sweep = norm(ang(b) - a0);
  // go the way that passes through the middle point
  if (norm(ang(m) - a0) > sweep) sweep -= 2 * Math.PI;
  const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
  const pts: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = a0 + (sweep * i) / steps;
    pts.push(R(cx + r * Math.cos(t)), R(cy + r * Math.sin(t)));
  }
  return pts;
}

function fontSize(e: SExpr[] | undefined): number {
  const size = kid(kid(kid(e, 'effects'), 'font'), 'size');
  return R(num(size?.[1], 1.27) * KICAD_PX);
}

function textPrim(raw: string, at: SExpr[] | undefined, effects: SExpr[] | undefined): Prim | null {
  const text = kicadText(raw).trim();
  if (!text || text === '~') return null;
  const p = xy(at);
  const size = R(num(kid(kid(effects, 'font'), 'size')?.[1], 1.27) * KICAD_PX);
  const j = kid(effects, 'justify') ?? [];
  const rot = num(at?.[3]);
  const vertical = Math.round(rot / 90) % 2 !== 0;
  // text is drawn upright: justification of turned text is ignored and it stays centred
  const anchor = vertical ? 'middle' : j.includes('left') ? 'start' : j.includes('right') ? 'end' : 'middle';
  const dy = vertical ? size * 0.35 : j.includes('top') ? size * 0.8 : j.includes('bottom') ? 0 : size * 0.35;
  return { t: 'text', x: p.x, y: R(p.y + dy), size, anchor, text };
}

const DIRS: Record<number, { x: number; y: number }> = { 0: { x: 1, y: 0 }, 90: { x: 0, y: -1 }, 180: { x: -1, y: 0 }, 270: { x: 0, y: 1 } };
const SIDES: Record<number, Side> = { 0: 'left', 90: 'bottom', 180: 'right', 270: 'top' };

interface PinOpts {
  namesHidden: boolean;
  nameOffset: number;
  numbersHidden: boolean;
}

interface Pin {
  id: string;
  name: string;
  x: number;
  y: number;
  side: Side;
}

/** Marks the name of a top or bottom pin, drawn upright (KiCad turns it), so it can be fitted between its neighbours. */
const UPRIGHT = { upright: true } as unknown as Record<string, never>;
const isUpright = (p: Prim) => (p as { upright?: boolean }).upright === true;

/** Shrinks the upright names of top and bottom pins that would run into a neighbour's. */
function fitUprightNames(prims: Prim[]) {
  const names = prims.filter((p): p is Extract<Prim, { t: 'text' }> => p.t === 'text' && isUpright(p));
  for (const p of names) {
    delete (p as { upright?: boolean }).upright;
    let gap = Infinity;
    for (const q of names) if (q !== p && Math.abs(q.y - p.y) < p.size) gap = Math.min(gap, Math.abs(q.x - p.x));
    if (gap === Infinity) continue;
    const chars = [...p.text.replace(/\u0305/g, '')].length;
    const fit = R((gap - 3) / (chars * 0.6));
    if (fit < p.size) p.size = Math.max(4, fit);
  }
}

function pinPrims(e: SExpr[], o: PinOpts, out: Prim[]): Pin | null {
  if (hidden(e)) return null;
  const style = str(e[2]);
  const at = kid(e, 'at');
  const p = xy(at);
  const angle = ((Math.round(num(at?.[3]) / 90) * 90) % 360 + 360) % 360;
  const dir = DIRS[angle] ?? DIRS[0];
  const len = X(num(kid(e, 'length')?.[1]));
  const end = { x: R(p.x + dir.x * len), y: R(p.y + dir.y * len) };
  const nameE = kid(e, 'name');
  const numE = kid(e, 'number');
  const number = str(numE?.[1]);
  const rawName = str(nameE?.[1]);
  const name = kicadText(rawName).trim();
  const bubble = style === 'inverted' || style === 'inverted_clock' || style === 'input_low' || style === 'output_low';
  const clock = style === 'clock' || style === 'inverted_clock' || style === 'clock_low' || style === 'falling_edge_clock';
  const br = 3;
  if (len > 0) {
    const stop = bubble ? Math.max(0, len - 2 * br) : len;
    out.push({ t: 'line', pts: [p.x, p.y, R(p.x + dir.x * stop), R(p.y + dir.y * stop)] });
    if (bubble) out.push({ t: 'circle', cx: R(p.x + dir.x * (len - br)), cy: R(p.y + dir.y * (len - br)), r: br, fill: 'none' });
  }
  if (clock) {
    const n = { x: -dir.y, y: dir.x };
    const c = 5;
    out.push({ t: 'line', pts: [R(end.x + n.x * c), R(end.y + n.y * c), R(end.x + dir.x * c), R(end.y + dir.y * c), R(end.x - n.x * c), R(end.y - n.y * c)] });
  }
  const horizontal = dir.y === 0;
  if (!o.namesHidden && name && name !== '~' && !hidden(kid(nameE, 'effects'))) {
    const size = fontSize(nameE);
    if (o.nameOffset > 0) {
      // inside the body, past the pin's inner end
      const off = o.nameOffset + (clock ? 6 : 0);
      if (horizontal) out.push({ t: 'text', x: R(end.x + dir.x * off), y: R(end.y + size * 0.35), size, anchor: dir.x > 0 ? 'start' : 'end', text: name });
      else out.push({ t: 'text', x: end.x, y: R(dir.y > 0 ? end.y + off + size * 0.8 : end.y - off), size, anchor: 'middle', text: name, ...UPRIGHT });
    } else if (horizontal) {
      out.push({ t: 'text', x: R((p.x + end.x) / 2), y: R(p.y - 2), size, anchor: 'middle', text: name });
    } else {
      out.push({ t: 'text', x: R(p.x + 2), y: R((p.y + end.y) / 2 + size * 0.35), size, anchor: 'start', text: name });
    }
  }
  if (!o.numbersHidden && number && !hidden(kid(numE, 'effects')) && len > 0) {
    const size = Math.min(fontSize(numE), 8);
    // the number sits beside the pin line, on the side away from the name
    // a name drawn outside the body (offset 0) is above the line: the number goes under it
    const below = o.nameOffset <= 0 && !o.namesHidden && !!name && name !== '~';
    if (horizontal) out.push({ t: 'text', x: R((p.x + end.x) / 2), y: R(below ? p.y + size + 1 : p.y - 2), size, anchor: 'middle', text: number });
    else out.push({ t: 'text', x: R(p.x - 2), y: R((p.y + end.y) / 2 + size * 0.35), size, anchor: 'end', text: number });
  }
  return { id: number || name || 'pin', name: name && name !== '~' ? name : number, x: p.x, y: p.y, side: SIDES[angle] ?? 'left' };
}

function graphicPrims(e: SExpr[], out: Prim[]) {
  const s = styleOf(e);
  switch (head(e)) {
    case 'polyline': {
      const pts = kids(kid(e, 'pts') ?? [], 'xy').flatMap((p) => [X(num(p[1])), Y(num(p[2]))]);
      if (pts.length < 4) return;
      if (s.fill !== 'none' && pts.length >= 6) out.push(withStyle({ t: 'poly', pts, fill: s.fill }, s));
      else out.push(withStyle({ t: 'line', pts }, s));
      return;
    }
    case 'rectangle': {
      const a = xy(kid(e, 'start'));
      const b = xy(kid(e, 'end'));
      out.push(withStyle({ t: 'rect', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: R(Math.abs(b.x - a.x)), h: R(Math.abs(b.y - a.y)), fill: s.fill }, s));
      return;
    }
    case 'circle': {
      const c = xy(kid(e, 'center'));
      out.push(withStyle({ t: 'circle', cx: c.x, cy: c.y, r: X(num(kid(e, 'radius')?.[1])), fill: s.fill }, s));
      return;
    }
    case 'arc': {
      const pts = arcPoints(xy(kid(e, 'start')), xy(kid(e, 'mid')), xy(kid(e, 'end')));
      if (s.fill !== 'none' && pts.length >= 6) out.push(withStyle({ t: 'poly', pts, fill: s.fill }, s));
      else out.push(withStyle({ t: 'line', pts }, s));
      return;
    }
    case 'bezier': {
      const p = kids(kid(e, 'pts') ?? [], 'xy').map((q) => `${X(num(q[1]))} ${Y(num(q[2]))}`);
      if (p.length < 4) return;
      const d = `M ${p[0]} C ${p.slice(1, 4).join(' ')}${s.fill !== 'none' ? ' Z' : ''}`;
      out.push(withStyle({ t: 'path', d, fill: s.fill }, s));
      return;
    }
    case 'text': {
      if (hidden(kid(e, 'effects'))) return;
      const t = textPrim(str(e[1]), kid(e, 'at'), kid(e, 'effects'));
      if (t) out.push(t);
      return;
    }
    case 'text_box': {
      const a = xy(kid(e, 'start') ?? kid(e, 'at'));
      const size = kid(e, 'size');
      const w = X(num(size?.[1]));
      const h = X(num(size?.[2]));
      const t = textPrim(str(e[1]), ['at', String(((a.x + w / 2) / KICAD_PX).toFixed(3)), String((-(a.y + h / 2) / KICAD_PX).toFixed(3))], kid(e, 'effects'));
      if (t) out.push(t);
      return;
    }
  }
}

/** One KiCad symbol definition (its own sub-symbols merged with the parent's when it extends one). */
interface Raw {
  name: string;
  node: SExpr[];
  /** Sub-symbol bodies: `Name_unit_style`. */
  bodies: SExpr[][];
  /** Where pin options come from (the parent's, for a derived symbol). */
  base: SExpr[];
}

function props(node: SExpr[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of kids(node, 'property')) out[str(p[1])] = str(p[2]);
  return out;
}

const unitOf = (body: SExpr[]) => {
  const m = /_(\d+)_(\d+)$/.exec(str(body[1]));
  return m ? { unit: +m[1], style: +m[2] } : { unit: 0, style: 0 };
};

function primExtent(prims: Prim[], pins: Pin[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const pt = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  for (const p of prims) {
    switch (p.t) {
      case 'line':
      case 'poly':
        for (let i = 0; i + 1 < p.pts.length; i += 2) pt(p.pts[i], p.pts[i + 1]);
        break;
      case 'rect':
        pt(p.x, p.y);
        pt(p.x + p.w, p.y + p.h);
        break;
      case 'circle':
        pt(p.cx - p.r, p.cy - p.r);
        pt(p.cx + p.r, p.cy + p.r);
        break;
      case 'path': {
        const n = p.d.match(/-?[\d.]+/g)?.map(Number) ?? [];
        for (let i = 0; i + 1 < n.length; i += 2) pt(n[i], n[i + 1]);
        break;
      }
      case 'text': {
        const w = [...p.text.replace(/̅/g, '')].length * p.size * 0.6;
        const x = p.anchor === 'middle' ? p.x - w / 2 : p.anchor === 'end' ? p.x - w : p.x;
        pt(x, p.y - p.size * 0.8);
        pt(x + w, p.y + p.size * 0.2);
        break;
      }
      default:
        break;
    }
  }
  for (const p of pins) pt(p.x, p.y);
  return x0 === Infinity ? { x0: 0, y0: 0, x1: 20, y1: 20 } : { x0, y0, x1, y1 };
}

function movePrim(p: Prim, dx: number, dy: number): Prim {
  switch (p.t) {
    case 'line':
    case 'poly':
      return { ...p, pts: p.pts.map((v, i) => R(v + (i % 2 ? dy : dx))) };
    case 'rect':
    case 'text':
      return { ...p, x: R(p.x + dx), y: R(p.y + dy) };
    case 'circle':
    case 'ellipse':
    case 'arc':
      return { ...p, cx: R(p.cx + dx), cy: R(p.cy + dy) };
    case 'path': {
      let i = 0;
      return { ...p, d: p.d.replace(/[A-Za-z]|-?[\d.]+/g, (tok) => (/[A-Za-z]/.test(tok) ? ((i = 0), tok) : String(R(+tok + (i++ % 2 ? dy : dx))))) };
    }
  }
}

/** The drawing and pins of one unit, moved so the outline starts at (0, 0) on the grid with an even size. */
function drawUnit(raw: Raw, unit: number): { prims: Prim[]; ports: PortDef[]; w: number; h: number } {
  const pinNames = kid(raw.base, 'pin_names');
  const opts: PinOpts = {
    namesHidden: hidden(pinNames),
    nameOffset: X(num(kid(pinNames, 'offset')?.[1], 0.508)),
    numbersHidden: hidden(kid(raw.base, 'pin_numbers')),
  };
  const prims: Prim[] = [];
  const pinPrimsOut: Prim[] = [];
  const pins: Pin[] = [];
  for (const body of raw.bodies) {
    const u = unitOf(body);
    if ((u.unit !== 0 && u.unit !== unit) || (u.style !== 0 && u.style !== 1)) continue;
    for (const g of body) {
      if (!isList(g)) continue;
      if (g[0] === 'pin') {
        const pin = pinPrims(g, opts, pinPrimsOut);
        // stacked pins (one spot, several numbers) are one connection
        if (pin && !pins.some((q) => q.x === pin.x && q.y === pin.y)) pins.push(pin);
      } else graphicPrims(g, prims);
    }
  }
  fitUprightNames(pinPrimsOut);
  // pin lines under the body, as KiCad draws them; pin names and numbers over it
  prims.unshift(...pinPrimsOut.filter((p) => p.t !== 'text'));
  prims.push(...pinPrimsOut.filter((p) => p.t === 'text'));
  const b = primExtent(prims, pins);
  const ox = Math.floor(b.x0 / 10) * 10;
  const oy = Math.floor(b.y0 / 10) * 10;
  const even = (v: number) => Math.max(20, Math.ceil(v / 20) * 20);
  const w = even(b.x1 - ox);
  const h = even(b.y1 - oy);
  const seen = new Set<string>();
  const ports: PortDef[] = [];
  for (const p of pins) {
    let id = p.id.replace(/[\s:,]/g, '_');
    while (seen.has(id)) id += "'";
    seen.add(id);
    ports.push({ id, name: p.name, x: R(p.x - ox), y: R(p.y - oy), side: p.side });
  }
  return { prims: prims.map((p) => movePrim(p, -ox, -oy)), ports, w, h };
}

/** Id of a KiCad symbol in Nodal (`kicad:Library:Name`, units after a `#`). */
export const kicadId = (lib: string, name: string, unit = 1) => `kicad:${lib}:${name}${unit > 1 ? `#${String.fromCharCode(64 + unit)}` : ''}`;

export interface KicadSymbol extends SymbolDef {
  /** KiCad's one-line description of the part. */
  description?: string;
}

/** The drawing of one unit (origin top-left, pins on the grid). */
export interface UnitDrawing {
  prims: Prim[];
  ports: PortDef[];
  w: number;
  h: number;
  /** KiCad's own name for the unit ("NMOS", "PWR"…), when it has one. */
  name?: string;
}

/** A part of a KiCad library, without its drawing (which it shares with every part derived from the same root). */
export interface KicadPart {
  name: string;
  /** The symbol whose drawing this part uses (itself, or the one it extends). */
  root: string;
  ref: string;
  value: string;
  description?: string;
  datasheet?: string;
  footprint?: string;
  keywords?: string;
  power?: boolean;
}

export interface KicadLibrary {
  parts: KicadPart[];
  /** Unit drawings by root symbol name, unit A first. */
  drawings: Map<string, UnitDrawing[]>;
}

/**
 * Reads a .kicad_sym file (or several, joined) into parts and their drawings.
 * Symbols that extend one missing from the text are skipped.
 */
export function readKicadLibrary(text: string): KicadLibrary {
  const top = parseSExpr(text).filter(isList);
  const nodes = new Map<string, SExpr[]>();
  for (const libNode of top) {
    if (libNode[0] !== 'kicad_symbol_lib') continue;
    for (const s of kids(libNode, 'symbol')) nodes.set(str(s[1]), s);
  }
  const resolve = (name: string, depth = 0): (Raw & { root: string }) | null => {
    const node = nodes.get(name);
    if (!node || depth > 8) return null;
    const parent = str(kid(node, 'extends')?.[1]);
    if (parent) {
      const base = resolve(parent, depth + 1);
      return base && { name, node, bodies: base.bodies, base: base.base, root: base.root };
    }
    return { name, node, bodies: kids(node, 'symbol'), base: node, root: name };
  };
  const parts: KicadPart[] = [];
  const drawings = new Map<string, UnitDrawing[]>();
  for (const name of nodes.keys()) {
    const raw = resolve(name);
    if (!raw) continue;
    // a derived symbol overrides its parent's properties
    const pr = { ...(raw.base !== raw.node ? props(raw.base) : {}), ...props(raw.node) };
    const power = !!kid(raw.base, 'power') || !!kid(raw.node, 'power');
    if (!drawings.has(raw.root)) {
      const units = Math.max(1, ...raw.bodies.map((b) => unitOf(b).unit));
      const unitNames = new Map<number, string>();
      for (const b of raw.bodies) {
        const un = str(kid(b, 'unit_name')?.[1]);
        if (un) unitNames.set(unitOf(b).unit, un);
      }
      const list: UnitDrawing[] = [];
      for (let u = 1; u <= units; u++) {
        const d: UnitDrawing = drawUnit(raw, u);
        if (u > 1 && !d.prims.length && !d.ports.length) continue;
        const un = unitNames.get(u);
        if (un) d.name = un;
        list.push(d);
      }
      drawings.set(raw.root, list);
    }
    const part: KicadPart = { name, root: raw.root, ref: pr.Reference || 'U', value: pr.Value ?? name };
    if (pr.Description) part.description = pr.Description;
    if (pr.Datasheet && pr.Datasheet !== '~') part.datasheet = pr.Datasheet;
    if (pr.Footprint) part.footprint = pr.Footprint;
    if (pr.ki_keywords) part.keywords = pr.ki_keywords;
    if (power) part.power = true;
    parts.push(part);
  }
  return { parts, drawings };
}

/** A part as Nodal symbols: its first unit, then each other unit as a type of it. */
export function partSymbols(lib: string, part: KicadPart, units: UnitDrawing[], category = `KiCad: ${lib}`): KicadSymbol[] {
  const fields: FieldDef[] = [];
  if (part.description) fields.push({ key: 'description', label: 'Description', default: part.description });
  if (part.datasheet) fields.push({ key: 'datasheet', label: 'Datasheet', default: part.datasheet });
  if (part.footprint) fields.push({ key: 'footprint', label: 'Footprint', default: part.footprint });
  const base: Omit<KicadSymbol, 'id' | 'prims' | 'ports' | 'w' | 'h'> = {
    name: part.name,
    category,
    keywords: [part.keywords, part.description, lib.replace(/_/g, ' ')].filter(Boolean).join(' '),
    prefix: part.power ? '#PWR' : part.ref,
    value: part.value,
    ...(fields.length ? { fields } : {}),
    ...(part.description ? { description: part.description } : {}),
    ...(part.power ? { hideLabels: true, valueIsLabel: true } : {}),
  };
  const draw = (d: UnitDrawing) => ({ prims: d.prims, ports: d.ports, w: d.w, h: d.h });
  const unitLabel = (i: number, d: UnitDrawing) => `Unit ${String.fromCharCode(65 + i)}${d.name ? ` (${d.name})` : ''}`;
  const first: KicadSymbol = { ...base, id: kicadId(lib, part.name), ...draw(units[0] ?? { prims: [], ports: [], w: 20, h: 20 }) };
  const out = [first];
  if (units.length > 1) {
    const variants: VariantRef[] = [];
    units.slice(1).forEach((d, k) => {
      const id = kicadId(lib, part.name, k + 2);
      const variantName = unitLabel(k + 1, d);
      variants.push({ id, name: variantName });
      out.push({ ...base, id, ...draw(d), variantOf: first.id, variantName });
    });
    first.variants = variants;
    first.variantName = unitLabel(0, units[0]);
  }
  return out;
}

/** Every symbol of a .kicad_sym file (or of several, joined), as Nodal symbols. */
export function kicadToSymbols(text: string, lib: string, category = `KiCad: ${lib}`): KicadSymbol[] {
  const { parts, drawings } = readKicadLibrary(text);
  return parts.flatMap((p) => partSymbols(lib, p, drawings.get(p.root) ?? [], category));
}
