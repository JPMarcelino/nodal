import type { Prim, SymbolDef } from '../types';

const r = (v: number) => Math.round(v * 1000) / 1000;

/** Scales the numbers of SVG path data; arc flags and rotations are left alone. */
export function scalePath(d: string, k: number): string {
  let out = '';
  let cmd = '';
  let i = 0; // index of the number within the current command's parameter group
  const re = /([a-zA-Z])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    if (m[1]) {
      cmd = m[1];
      i = 0;
      out += `${out ? ' ' : ''}${cmd}`;
      continue;
    }
    const v = +m[2];
    const arc = cmd === 'A' || cmd === 'a';
    // arc parameters: rx ry rotation large-arc sweep x y
    const keep = arc && i % 7 >= 2 && i % 7 <= 4;
    out += ` ${keep ? v : r(v * k)}`;
    i++;
  }
  return out;
}

function scalePrim(p: Prim, k: number): Prim {
  const s = (v: number) => r(v * k);
  switch (p.t) {
    case 'line':
    case 'poly':
      return { ...p, pts: p.pts.map(s) };
    case 'rect':
      return { ...p, x: s(p.x), y: s(p.y), w: s(p.w), h: s(p.h), rx: p.rx && s(p.rx) };
    case 'circle':
      return { ...p, cx: s(p.cx), cy: s(p.cy), r: s(p.r) };
    case 'ellipse':
      return { ...p, cx: s(p.cx), cy: s(p.cy), rx: s(p.rx), ry: s(p.ry) };
    case 'arc':
      return { ...p, cx: s(p.cx), cy: s(p.cy), r: s(p.r) };
    case 'path':
      return { ...p, d: scalePath(p.d, k) };
    case 'text':
      return { ...p, x: s(p.x), y: s(p.y), size: s(p.size) };
  }
}

const cache = new WeakMap<SymbolDef, Map<number, SymbolDef>>();

/**
 * The symbol drawn `k` times as large: geometry, pins and text scale, line
 * widths don't, so a resized part still matches the lines around it.
 */
export function scaleSymbol(def: SymbolDef, k: number): SymbolDef {
  if (!k || k === 1) return def;
  let byK = cache.get(def);
  if (!byK) cache.set(def, (byK = new Map()));
  let out = byK.get(k);
  if (!out) {
    out = {
      ...def,
      w: r(def.w * k),
      h: r(def.h * k),
      prims: def.prims.map((p) => scalePrim(p, k)),
      ports: def.ports.map((p) => ({ ...p, x: r(p.x * k), y: r(p.y * k) })),
    };
    byK.set(k, out);
  }
  return out;
}

/** The schematic grid symbols are drawn on; placed parts sit on it. */
export const PIN_GRID = 10;

const snapG = (v: number) => Math.round(v / PIN_GRID) * PIN_GRID;
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

/**
 * Anchor shift along one axis (pins sit at `offs` from the part's centre):
 * the shift within half a grid step that leaves the pins closest to the grid.
 */
function bestShift(offs: number[]): number {
  let best = 0;
  let bestErr = Infinity;
  for (const d of [0, ...offs.map((o) => snapG(o) - o)]) {
    const dd = d > PIN_GRID / 2 ? d - PIN_GRID : d <= -PIN_GRID / 2 ? d + PIN_GRID : d;
    const err = offs.reduce((s, o) => s + Math.abs(snapG(o + dd) - (o + dd)), 0);
    if (err < bestErr - 0.001 || (Math.abs(err - bestErr) < 0.001 && Math.abs(dd) < Math.abs(best))) {
      best = dd;
      bestErr = err;
    }
  }
  return best;
}

function shiftPrim(p: Prim, sx: number, sy: number): Prim {
  if (!sx && !sy) return p;
  switch (p.t) {
    case 'line':
    case 'poly':
      return { ...p, pts: p.pts.map((v, i) => r(v + (i % 2 ? sy : sx))) };
    case 'rect':
    case 'text':
      return { ...p, x: r(p.x + sx), y: r(p.y + sy) };
    case 'circle':
    case 'ellipse':
    case 'arc':
      return { ...p, cx: r(p.cx + sx), cy: r(p.cy + sy) };
    case 'path':
      return { ...p, d: shiftPath(p.d, sx, sy) };
  }
}

/** Moves absolute SVG path coordinates; relative commands need no change. */
function shiftPath(d: string, sx: number, sy: number): string {
  let out = '';
  let cmd = '';
  let i = 0;
  let first = true;
  const re = /([a-zA-Z])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    if (m[1]) {
      cmd = m[1];
      i = 0;
      out += `${out ? ' ' : ''}${cmd}`;
      continue;
    }
    const v = +m[2];
    let add = 0;
    // a path's opening moveto is absolute even when written lower-case
    if (first && cmd === 'm' && i < 2) add = i ? sy : sx;
    else if (cmd === 'H') add = sx;
    else if (cmd === 'V') add = sy;
    else if (cmd === 'A') add = i % 7 === 5 ? sx : i % 7 === 6 ? sy : 0;
    else if (cmd === cmd.toUpperCase() && cmd !== 'Z') add = i % 2 ? sy : sx;
    out += ` ${add ? r(v + add) : v}`;
    if (++i >= 2 && cmd === 'm') first = false;
    else if (cmd !== 'm') first = false;
  }
  return out;
}

const aligned = new WeakMap<SymbolDef, SymbolDef>();

/**
 * The symbol with its pins on the grid relative to the part's anchor (its
 * centre), so the pins of a placed part land on grid points. Only the anchor
 * moves, by under half a grid step (padding the outline on one side): the
 * drawing itself is never changed. Symbols already on the grid come back as is.
 */
export function gridAlignSymbol(def: SymbolDef): SymbolDef {
  const hit = aligned.get(def);
  if (hit) return hit;
  let out = def;
  const ok = (v: number, size: number) => near(snapG(v - size / 2), v - size / 2);
  if (def.ports.length && !def.ports.every((p) => ok(p.x, def.w) && ok(p.y, def.h))) {
    const axis = (size: number, coords: number[]) => {
      const d = bestShift(coords.map((v) => v - size / 2));
      // positive d moves the anchor left/up: pad that side and shift the drawing
      return d > 0 ? { size: r(size + 2 * d), shift: r(2 * d) } : { size: r(size - 2 * d), shift: 0 };
    };
    const ax = axis(def.w, def.ports.map((p) => p.x));
    const ay = axis(def.h, def.ports.map((p) => p.y));
    // clear the rounding dust off pins that are now on the grid
    const pin = (v: number, c: number) => (near(c + snapG(v - c), v) ? r(c + snapG(v - c)) : v);
    out = {
      ...def,
      w: ax.size,
      h: ay.size,
      prims: def.prims.map((p) => shiftPrim(p, ax.shift, ay.shift)),
      ports: def.ports.map((p) => ({ ...p, x: pin(p.x + ax.shift, ax.size / 2), y: pin(p.y + ay.shift, ay.size / 2) })),
    };
  }
  aligned.set(def, out);
  return out;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const steps = new WeakMap<SymbolDef, number>();

/**
 * The smallest size step that keeps a symbol's pins on the grid: every
 * distance between two pins must stay a whole number of grid steps. 0 when
 * the pins put no limit on the size (a single pin).
 */
export function scaleStep(def: SymbolDef): number {
  let step = steps.get(def);
  if (step === undefined) {
    let g = 0;
    for (const key of ['x', 'y'] as const) {
      const vs = def.ports.map((p) => Math.round(p[key]));
      for (const v of vs) g = gcd(g, Math.abs(v - vs[0]));
    }
    step = g ? PIN_GRID / g : 0;
    steps.set(def, step);
  }
  return step;
}

/** The size nearest `k` at which the part's pins stay on the grid. */
export function gridScale(def: SymbolDef, k: number): number {
  const step = scaleStep(def);
  if (!step) return k;
  const m = Math.max(1, Math.round(k / step));
  return Math.round(m * step * 1e6) / 1e6;
}
