/** Geometry of symbol drawing primitives: bounds, moving and scaling (paths included, without a transform attribute). */

import type { Prim } from '../types';

const r2 = (v: number) => +v.toFixed(2);

/* ------------------------------------------------------------------ */
/* Path data                                                           */
/* ------------------------------------------------------------------ */

/** Coordinates each command takes, in order. */
const ARGS: Record<string, number> = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0 };

type Cmd = { c: string; a: number[] };

function parse(d: string): Cmd[] {
  const out: Cmd[] = [];
  const toks = d.match(/[MLHVCSQTAZ]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0;
  let c = '';
  while (i < toks.length) {
    if (/[a-z]/i.test(toks[i])) c = toks[i++];
    if (!c) return [];
    const n = ARGS[c.toUpperCase()];
    if (n === 0) {
      out.push({ c, a: [] });
      continue;
    }
    const a = toks.slice(i, i + n).map(Number);
    if (a.length < n || a.some((v) => !Number.isFinite(v))) break;
    out.push({ c, a });
    i += n;
    // extra pairs after a move are line-tos
    if (c === 'M') c = 'L';
    else if (c === 'm') c = 'l';
  }
  return out;
}

const n2 = (v: number) => String(r2(v));

/**
 * Path data under x' = x·sx + tx, y' = y·sy + ty (relative commands only scale).
 * Arc radii scale too; a flip on one axis reverses the arc's sweep.
 */
export function transformPath(d: string, sx: number, sy: number, tx: number, ty: number): string {
  const cmds = parse(d);
  if (!cmds.length) return d;
  const flip = sx * sy < 0;
  return cmds
    .map(({ c, a }) => {
      const rel = c === c.toLowerCase();
      const X = (v: number) => (rel ? v * sx : v * sx + tx);
      const Y = (v: number) => (rel ? v * sy : v * sy + ty);
      const C = c.toUpperCase();
      let b: number[];
      if (C === 'H') b = [X(a[0])];
      else if (C === 'V') b = [Y(a[0])];
      else if (C === 'A') b = [Math.abs(a[0] * sx), Math.abs(a[1] * sy), a[2], a[3], flip ? 1 - a[4] : a[4], X(a[5]), Y(a[6])];
      else b = a.map((v, k) => (k % 2 ? Y(v) : X(v)));
      return c + b.map(n2).join(' ');
    })
    .join(' ');
}

/** A box around every point the path passes through or is pulled towards (control points included). */
export function pathBounds(d: string): { x: number; y: number; w: number; h: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  for (const { c, a } of parse(d)) {
    const rel = c === c.toLowerCase();
    const C = c.toUpperCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    if (C === 'Z') {
      cx = sx;
      cy = sy;
      continue;
    }
    if (C === 'H') cx = a[0] + ox;
    else if (C === 'V') cy = a[0] + oy;
    else if (C === 'A') {
      cx = a[5] + ox;
      cy = a[6] + oy;
    } else {
      for (let k = 0; k + 1 < a.length; k += 2) {
        xs.push(a[k] + ox);
        ys.push(a[k + 1] + oy);
      }
      cx = a[a.length - 2] + ox;
      cy = a[a.length - 1] + oy;
    }
    xs.push(cx);
    ys.push(cy);
    if (C === 'M') {
      sx = cx;
      sy = cy;
    }
  }
  if (!xs.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */


export function primBounds(p: Prim): { x: number; y: number; w: number; h: number } {
  const pts: number[] = [];
  switch (p.t) {
    case 'line':
    case 'poly':
      pts.push(...p.pts);
      break;
    case 'rect':
      pts.push(p.x, p.y, p.x + p.w, p.y + p.h);
      break;
    case 'circle':
    case 'arc':
      pts.push(p.cx - p.r, p.cy - p.r, p.cx + p.r, p.cy + p.r);
      break;
    case 'ellipse':
      pts.push(p.cx - p.rx, p.cy - p.ry, p.cx + p.rx, p.cy + p.ry);
      break;
    case 'text': {
      const w = p.text.length * p.size * 0.6;
      const x0 = p.anchor === 'start' ? p.x : p.anchor === 'end' ? p.x - w : p.x - w / 2;
      pts.push(x0, p.y - p.size, x0 + w, p.y + p.size * 0.2);
      break;
    }
    case 'path':
      return pathBounds(p.d);
  }
  const xs = pts.filter((_, i) => i % 2 === 0);
  const ys = pts.filter((_, i) => i % 2 === 1);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function movePrim(p: Prim, dx: number, dy: number): Prim {
  switch (p.t) {
    case 'line':
    case 'poly':
      return { ...p, pts: p.pts.map((v, i) => v + (i % 2 ? dy : dx)) };
    case 'rect':
    case 'text':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'circle':
    case 'ellipse':
    case 'arc':
      return { ...p, cx: p.cx + dx, cy: p.cy + dy };
    case 'path':
      return { ...p, d: transformPath(p.d, 1, 1, dx, dy) };
  }
}

/** A primitive scaled by kx, ky about (ox, oy); a circle stretched unevenly becomes an ellipse. */
export function scalePrim(p: Prim, ox: number, oy: number, kx: number, ky: number): Prim {
  const X = (v: number) => r2(ox + (v - ox) * kx);
  const Y = (v: number) => r2(oy + (v - oy) * ky);
  const k = Math.sqrt(Math.abs(kx * ky));
  switch (p.t) {
    case 'line':
    case 'poly':
      return { ...p, pts: p.pts.map((v, i) => (i % 2 ? Y(v) : X(v))) };
    case 'rect':
      return { ...p, x: X(p.x), y: Y(p.y), w: r2(p.w * kx), h: r2(p.h * ky) };
    case 'circle': {
      if (Math.abs(kx - ky) < 1e-6) return { ...p, cx: X(p.cx), cy: Y(p.cy), r: r2(p.r * kx) };
      const { r, ...rest } = p;
      return { ...rest, t: 'ellipse', cx: X(p.cx), cy: Y(p.cy), rx: r2(r * kx), ry: r2(r * ky) };
    }
    case 'ellipse':
      return { ...p, cx: X(p.cx), cy: Y(p.cy), rx: r2(p.rx * kx), ry: r2(p.ry * ky) };
    case 'arc':
      return { ...p, cx: X(p.cx), cy: Y(p.cy), r: r2(p.r * k) };
    case 'text':
      return { ...p, x: X(p.x), y: Y(p.y), size: Math.max(2, r2(p.size * k)) };
    case 'path':
      return { ...p, d: transformPath(p.d, kx, ky, ox - ox * kx, oy - oy * ky) };
  }
}
