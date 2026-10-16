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

/**
 * Snaps coordinates to grid lines through `c`, keeping distinct coordinates
 * distinct and in order (so tiny parts never merge two pins into one point).
 */
function snapAxis(vals: number[], c: number): (v: number) => number {
  const uniq = [...new Set(vals)].sort((a, b) => a - b);
  const snapped = uniq.map((v) => c + snapG(v - c));
  // spread from the middle outwards so a symmetric part stays symmetric
  const mid = uniq.findIndex((v) => v >= c);
  const m = mid < 0 ? uniq.length - 1 : mid;
  for (let i = m + 1; i < uniq.length; i++) if (snapped[i] <= snapped[i - 1] + 0.01) snapped[i] = snapped[i - 1] + PIN_GRID;
  for (let i = m - 1; i >= 0; i--) if (snapped[i] >= snapped[i + 1] - 0.01) snapped[i] = snapped[i + 1] - PIN_GRID;
  return (v) => r(snapped[uniq.indexOf(v)]);
}

const aligned = new WeakMap<SymbolDef, SymbolDef>();

/**
 * The symbol with every pin on the grid relative to the part's anchor (its
 * centre), so pins of a placed part always land on grid points. The anchor
 * moves by under half a grid step (padding the outline on one side) and any
 * pin still off the grid is snapped, its lead stretched to meet it. Symbols
 * already on the grid come back unchanged.
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
    const cx = ax.size / 2;
    const cy = ay.size / 2;
    let prims = def.prims.map((p) => shiftPrim(p, ax.shift, ay.shift));
    const from = def.ports.map((p) => ({ x: r(p.x + ax.shift), y: r(p.y + ay.shift) }));
    const sx = snapAxis(from.map((p) => p.x), cx);
    const sy = snapAxis(from.map((p) => p.y), cy);
    const to = from.map((p) => ({ x: sx(p.x), y: sy(p.y) }));
    from.forEach((f, i) => {
      const t = to[i];
      if (near(f.x, t.x) && near(f.y, t.y)) return;
      let stretched = false;
      prims = prims.map((p) => {
        if (p.t !== 'line' && p.t !== 'poly') return p;
        const n = p.pts.length;
        const at = [0, n - 2].find((k) => near(p.pts[k], f.x) && near(p.pts[k + 1], f.y));
        if (at === undefined) return p;
        stretched = true;
        const pts = p.pts.slice();
        pts[at] = t.x;
        pts[at + 1] = t.y;
        return { ...p, pts };
      });
      if (!stretched) prims.push({ t: 'line', pts: [f.x, f.y, t.x, t.y] });
    });
    // pins pushed past the outline: grow it by whole grid steps on both sides
    const grow = (lo: number, hi: number, size: number) => Math.ceil(Math.max(0, -lo, hi - size) / PIN_GRID - 0.001) * PIN_GRID;
    const gx = grow(Math.min(...to.map((t) => t.x)), Math.max(...to.map((t) => t.x)), ax.size);
    const gy = grow(Math.min(...to.map((t) => t.y)), Math.max(...to.map((t) => t.y)), ay.size);
    out = {
      ...def,
      w: ax.size + 2 * gx,
      h: ay.size + 2 * gy,
      prims: prims.map((p) => shiftPrim(p, gx, gy)),
      ports: def.ports.map((p, i) => ({ ...p, x: r(to[i].x + gx), y: r(to[i].y + gy) })),
    };
  }
  aligned.set(def, out);
  return out;
}
