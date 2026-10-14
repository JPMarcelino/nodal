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
