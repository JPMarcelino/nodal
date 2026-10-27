import { flattenSegs, parsePathData, type SvgDrawing } from '../io/svgImport';
import { toWorld } from './geometry';
import { getUserLibrary, instanceSymbol } from './registry';
import { BUILTIN_SYMBOLS, MISSING_SYMBOL } from './symbols';
import { gridScale } from './symbols/scale';
import type { CircuitDoc, ComponentItem, Point, Prim, SymbolDef } from './types';

/*
 * Finds library symbols drawn in an imported SVG. A symbol counts as found
 * when some of the drawing's pieces lie entirely on the symbol's outline
 * (moved, rotated / mirrored and uniformly scaled) and together they trace
 * all of it. Line widths, colours and fills are ignored; text inside the
 * symbol is not needed to match.
 */

export interface RecognizedPart {
  symbol: string;
  x: number;
  y: number;
  rot: ComponentItem['rot'];
  flipX: boolean;
  scale?: number;
  /** Reference read from a nearby text (e.g. "R3"). */
  ref?: string;
}

type Poly = Point[];
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Distance (canvas units, at scale 1) the drawing may stray from a symbol's outline. */
const TOL = 0.75;
/** Spacing of the points checked along every outline. */
const STEP = 1.5;
const CELL = 8;
const ORIENTATIONS: { rot: ComponentItem['rot']; flipX: boolean }[] = [0, 90, 180, 270].flatMap((rot) => [false, true].map((flipX) => ({ rot: rot as ComponentItem['rot'], flipX })));

const bbox = (polys: Poly[]): Box => {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of polys)
    for (const q of p) {
      b.x0 = Math.min(b.x0, q.x);
      b.y0 = Math.min(b.y0, q.y);
      b.x1 = Math.max(b.x1, q.x);
      b.y1 = Math.max(b.y1, q.y);
    }
  return b;
};

/** Path data of an axis-aligned (rounded) rectangle or an ellipse. */
export function boxPath(kind: 'rect' | 'ellipse', x: number, y: number, w: number, h: number, rx = 0): string {
  if (kind === 'ellipse') {
    const [a, b, cx, cy] = [w / 2, h / 2, x + w / 2, y + h / 2];
    return `M${cx - a} ${cy}A${a} ${b} 0 1 0 ${cx + a} ${cy}A${a} ${b} 0 1 0 ${cx - a} ${cy}Z`;
  }
  const r = Math.min(rx, w / 2, h / 2);
  if (!(r > 0)) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

function arcD(cx: number, cy: number, r: number, a1: number, a2: number): string {
  const rad = (a: number) => (a * Math.PI) / 180;
  const sweep = a2 - a1;
  if (Math.abs(sweep) >= 359.99) return `M${cx - r} ${cy}a${r} ${r} 0 1 1 ${2 * r} 0a${r} ${r} 0 1 1 ${-2 * r} 0`;
  return `M${cx + r * Math.cos(rad(a1))} ${cy + r * Math.sin(rad(a1))}A${r} ${r} 0 ${Math.abs(sweep) > 180 ? 1 : 0} ${sweep > 0 ? 1 : 0} ${cx + r * Math.cos(rad(a2))} ${cy + r * Math.sin(rad(a2))}`;
}

/** Outline polylines of path data. */
export function pathPolys(d: string): Poly[] {
  try {
    return flattenSegs(parsePathData(d)).map((f) => {
      const out: Poly = [];
      for (let i = 0; i < f.pts.length; i += 2) out.push({ x: f.pts[i], y: f.pts[i + 1] });
      return out;
    });
  } catch {
    return [];
  }
}

export function primPolys(p: Prim): Poly[] {
  const pairs = (a: number[], close: boolean): Poly[] => {
    const out: Poly = [];
    for (let i = 0; i + 1 < a.length; i += 2) out.push({ x: a[i], y: a[i + 1] });
    if (close && out.length > 2) out.push(out[0]);
    return out.length >= 2 ? [out] : [];
  };
  switch (p.t) {
    case 'line':
      return pairs(p.pts, false);
    case 'poly':
      return pairs(p.pts, true);
    case 'rect':
      return pathPolys(boxPath('rect', p.x, p.y, p.w, p.h, p.rx));
    case 'circle':
      return pathPolys(boxPath('ellipse', p.cx - p.r, p.cy - p.r, 2 * p.r, 2 * p.r));
    case 'ellipse':
      return pathPolys(boxPath('ellipse', p.cx - p.rx, p.cy - p.ry, 2 * p.rx, 2 * p.ry));
    case 'arc':
      return pathPolys(arcD(p.cx, p.cy, p.r, p.a1, p.a2));
    case 'path':
      return pathPolys(p.d);
    case 'text':
      return [];
  }
}

/** Points every `STEP` along the polylines (vertices included). */
function samples(polys: Poly[], step = STEP): Point[] {
  const out: Point[] = [];
  for (const p of polys) {
    out.push(p[0]);
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step);
      for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
  }
  return out;
}

/** Spatial hash of segments: "is this point within `tol` of any of them". */
const cellKey = (x: number, y: number) => x * 1e6 + y;

class SegIndex {
  private cells = new Map<number, [Point, Point][]>();
  constructor(polys: Poly[]) {
    for (const p of polys)
      for (let i = 1; i < p.length; i++) {
        const a = p[i - 1], b = p[i];
        for (let x = Math.floor(Math.min(a.x, b.x) / CELL) - 1; x <= Math.floor(Math.max(a.x, b.x) / CELL) + 1; x++)
          for (let y = Math.floor(Math.min(a.y, b.y) / CELL) - 1; y <= Math.floor(Math.max(a.y, b.y) / CELL) + 1; y++) {
            const k = cellKey(x, y);
            const list = this.cells.get(k);
            if (list) list.push([a, b]);
            else this.cells.set(k, [[a, b]]);
          }
      }
  }
  near(p: Point, tol: number): boolean {
    for (const [a, b] of this.cells.get(cellKey(Math.floor(p.x / CELL), Math.floor(p.y / CELL))) ?? []) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
      if (Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) <= tol) return true;
    }
    return false;
  }
}

/** One drawing piece the symbols are matched against. */
interface Piece {
  kind: 'line' | 'box' | 'dot';
  index: number;
  polys: Poly[];
  b: Box;
  pts: Point[];
}

function drawingPieces(d: SvgDrawing): Piece[] {
  const out: Piece[] = [];
  const add = (kind: Piece['kind'], index: number, polys: Poly[]) => {
    if (!polys.length) return;
    out.push({ kind, index, polys, b: bbox(polys), pts: samples(polys) });
  };
  d.lines.forEach((l, i) => add('line', i, [l.closed && l.pts.length > 2 ? [...l.pts, l.pts[0]] : l.pts]));
  d.boxes.forEach((b, i) => add('box', i, pathPolys(boxPath(b.kind, b.x, b.y, b.w, b.h, b.rx))));
  d.dots.forEach((p, i) => {
    const r = p.r ?? 0;
    add('dot', i, r > 0 ? pathPolys(boxPath('ellipse', p.x - r, p.y - r, 2 * r, 2 * r)) : [[p, p]]);
  });
  return out;
}

/** A symbol's outline (its `local` polylines) in one orientation, centred on the part's anchor. */
function orientedPolys(def: SymbolDef, local: Poly[], o: { rot: ComponentItem['rot']; flipX: boolean }): Poly[] {
  const c = { x: 0, y: 0, ...o };
  return local.map((p) => p.map((q) => toWorld(c, def, q.x, q.y)));
}

/** Whether every point lies on one straight line (a bare line can't be told from a wire). */
function collinear(polys: Poly[]): boolean {
  const pts = polys.flat();
  const a = pts[0];
  const b = pts.reduce((best, p) => (Math.hypot(p.x - a.x, p.y - a.y) > Math.hypot(best.x - a.x, best.y - a.y) ? p : best), a);
  const l = Math.hypot(b.x - a.x, b.y - a.y);
  if (l < 1) return true;
  return pts.every((p) => Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / l < 0.5);
}

/** Every symbol that could be placed: user, document and built-in ones (types included). */
function candidateSymbols(doc: Pick<CircuitDoc, 'symbols'>): SymbolDef[] {
  const byId = new Map<string, SymbolDef>();
  for (const d of [...Object.values(getUserLibrary()), ...Object.values(doc.symbols), ...BUILTIN_SYMBOLS]) if (!byId.has(d.id) && d.id !== MISSING_SYMBOL.id) byId.set(d.id, d);
  return [...byId.values()];
}

/**
 * Looks for library symbols in an imported drawing. Returns the parts found
 * and the drawing without the pieces (and texts) they replace.
 */
export function recognizeSymbols(doc: Pick<CircuitDoc, 'symbols'>, drawing: SvgDrawing, opts: { symbols?: SymbolDef[] } = {}): { parts: RecognizedPart[]; rest: SvgDrawing } {
  const pieces = drawingPieces(drawing);
  const used = new Set<Piece>();
  const usedText = new Set<number>();
  const parts: RecognizedPart[] = [];
  if (!pieces.length) return { parts, rest: drawing };

  // the most detailed symbols first, so a symbol isn't claimed by a simpler one it contains
  const cands = (opts.symbols ?? candidateSymbols(doc))
    .map((def) => ({ def, polys: def.prims.flatMap(primPolys) }))
    .filter((c) => c.polys.length && !collinear(c.polys))
    .map((c) => ({ ...c, weight: samples(c.polys).length }))
    .sort((a, b) => b.weight - a.weight);
  const all = new SegIndex(pieces.flatMap((p) => p.polys));
  // pieces by the angle of their box diagonal (a uniform scale keeps it), and the flat ones
  const BINS = 64;
  const binOf = (a: number) => Math.max(0, Math.min(BINS - 1, Math.floor((a / (Math.PI / 2)) * BINS)));
  const byAngle: Piece[][] = Array.from({ length: BINS }, () => []);
  for (const pc of pieces) byAngle[binOf(Math.atan2(pc.b.y1 - pc.b.y0, pc.b.x1 - pc.b.x0))].push(pc);
  const flatH = pieces.filter((pc) => pc.b.y1 - pc.b.y0 <= 0.5 + TOL);
  const flatW = pieces.filter((pc) => pc.b.x1 - pc.b.x0 <= 0.5 + TOL);
  const near = (sw: number, sh: number): Piece[] => {
    if (sh < 0.5) return flatH;
    if (sw < 0.5) return flatW;
    const a = Math.atan2(sh, sw);
    const eps = 0.03 + TOL / Math.min(sw, sh);
    const out: Piece[] = [];
    for (let i = binOf(a - eps); i <= binOf(a + eps); i++) out.push(...byAngle[i]);
    return out;
  };
  const size = (b: Box) => (b.x1 - b.x0) * (b.y1 - b.y0) + (b.x1 - b.x0) + (b.y1 - b.y0);

  for (const { def } of cands) {
    const locals = new Map<number, { inst: SymbolDef; polys: Poly[] }>();
    const shapes = new Map<string, Poly[]>();
    const outline = (scale: number | undefined, o: (typeof ORIENTATIONS)[number]) => {
      const key = `${scale ?? 1}|${o.rot}|${o.flipX}`;
      let polys = shapes.get(key);
      if (!polys) {
        let l = locals.get(scale ?? 1);
        if (!l) {
          const inst = instanceSymbol(doc, { symbol: def.id, scale });
          locals.set(scale ?? 1, (l = { inst, polys: inst.prims.flatMap(primPolys) }));
        }
        shapes.set(key, (polys = orientedPolys(l.inst, l.polys, o)));
      }
      return polys;
    };
    for (const o of ORIENTATIONS) {
      const unit = outline(undefined, o);
      // a spread of the outline's points, for rejecting a placement cheaply
      const all1 = samples(unit);
      const probe = all1.filter((_, i) => i % Math.max(1, Math.floor(all1.length / 16)) === 0);
      // seeds: the two largest outlines, matched against single pieces by their boxes
      const seeds = unit
        .map((p, i) => ({ i, b: bbox([p]) }))
        .sort((a, b) => size(b.b) - size(a.b))
        .slice(0, 2);
      for (const seed of seeds) {
        const sw = seed.b.x1 - seed.b.x0, sh = seed.b.y1 - seed.b.y0;
        if (sw < 0.5 && sh < 0.5) continue;
        for (const pc of near(sw, sh)) {
          if (used.has(pc)) continue;
          const pw = pc.b.x1 - pc.b.x0, ph = pc.b.y1 - pc.b.y0;
          // uniform scale from the boxes; a flat seed only fixes it along its long side
          const kx = sw >= 0.5 ? pw / sw : NaN;
          const ky = sh >= 0.5 ? ph / sh : NaN;
          let k: number;
          if (Number.isNaN(kx)) {
            if (pw > 0.5 + TOL) continue;
            k = ky;
          } else if (Number.isNaN(ky)) {
            if (ph > 0.5 + TOL) continue;
            k = kx;
          } else {
            if (Math.abs(kx - ky) > 0.02 * Math.max(kx, ky) + TOL / Math.min(sw, sh)) continue;
            k = (kx + ky) / 2;
          }
          if (!(k >= 0.25 && k <= 8)) continue;
          const scale = Math.abs(k - 1) < 0.01 ? undefined : gridScale(def, k);
          if (scale !== undefined && Math.abs(scale - k) > 0.02 * k) continue;
          // relative to its seed the scaled outline is just the unit one grown k times
          const kk = scale ?? 1;
          const tol = TOL * Math.max(1, kk);
          if (!probe.every((q) => all.near({ x: pc.b.x0 + (q.x - seed.b.x0) * kk, y: pc.b.y0 + (q.y - seed.b.y0) * kk }, tol))) continue;
          const hit = tryPlace(outline(scale, o), scale, seed.i, pc, pieces, used);
          if (!hit) continue;
          for (const p of hit.pieces) used.add(p);
          const part: RecognizedPart = { symbol: def.id, x: hit.x, y: hit.y, rot: o.rot, flipX: o.flipX, ...(scale !== undefined ? { scale } : {}) };
          claimTexts(drawing, def, hit.b, hit.x, hit.y, scale ?? 1, usedText, part);
          parts.push(part);
        }
      }
    }
  }

  const gone = (kind: Piece['kind']) => new Set([...used].filter((p) => p.kind === kind).map((p) => p.index));
  const [lines, boxes, dots] = [gone('line'), gone('box'), gone('dot')];
  return {
    parts,
    rest: {
      lines: drawing.lines.filter((_, i) => !lines.has(i)),
      boxes: drawing.boxes.filter((_, i) => !boxes.has(i)),
      dots: drawing.dots.filter((_, i) => !dots.has(i)),
      texts: drawing.texts.filter((_, i) => !usedText.has(i)),
    },
  };
}

/** Checks a placement suggested by matching seed outline `seedIndex` (of `local`) to piece `seed`. */
function tryPlace(local: Poly[], scale: number | undefined, seedIndex: number, seed: Piece, pieces: Piece[], used: Set<Piece>) {
  const sb = bbox([local[seedIndex]]);
  const dx = seed.b.x0 - sb.x0, dy = seed.b.y0 - sb.y0;
  const polys = local.map((p) => p.map((q) => ({ x: q.x + dx, y: q.y + dy })));
  const tol = TOL * Math.max(1, scale ?? 1);
  const pts = samples(polys);
  const b = bbox(polys);
  const onSymbol = new SegIndex(polys);
  // the pieces lying wholly on the symbol…
  const mine = pieces.filter(
    (pc) => !used.has(pc) && pc.b.x0 >= b.x0 - tol && pc.b.y0 >= b.y0 - tol && pc.b.x1 <= b.x1 + tol && pc.b.y1 <= b.y1 + tol && pc.pts.every((p) => onSymbol.near(p, tol)),
  );
  if (!mine.includes(seed)) return null;
  // …must trace all of it
  const traced = new SegIndex(mine.flatMap((pc) => pc.polys));
  if (!pts.every((p) => traced.near(p, tol))) return null;
  const r = (v: number) => Math.round(v * 100) / 100;
  return { x: r(dx), y: r(dy), b, pieces: mine };
}

/** Removes texts the symbol draws itself, and adopts a nearby reference ("R3") for the part. */
function claimTexts(drawing: SvgDrawing, def: SymbolDef, b: Box, cx: number, cy: number, k: number, usedText: Set<number>, part: RecognizedPart) {
  const own = new Set(def.prims.flatMap((p) => (p.t === 'text' ? [p.text.trim()] : [])));
  const pad = 4 * k;
  drawing.texts.forEach((t, i) => {
    if (!usedText.has(i) && own.has(t.text) && t.x >= b.x0 - pad - t.size * t.text.length && t.x <= b.x1 + pad + t.size * t.text.length && t.y >= b.y0 - pad && t.y <= b.y1 + pad + t.size) usedText.add(i);
  });
  if (!def.prefix) return;
  const refRe = new RegExp(`^${def.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+[A-Za-z]?$`);
  const reach = Math.max(60, Math.max(b.x1 - b.x0, b.y1 - b.y0) * 1.5);
  let best = -1, bestD = Infinity;
  drawing.texts.forEach((t, i) => {
    if (usedText.has(i) || !refRe.test(t.text)) return;
    const d = Math.hypot(t.x - cx, t.y - t.size / 2 - cy);
    if (d < reach && d < bestD) [best, bestD] = [i, d];
  });
  if (best >= 0) {
    usedText.add(best);
    part.ref = drawing.texts[best].text;
  }
}
