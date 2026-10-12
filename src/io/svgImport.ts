import type { Fill, Prim } from '../model/types';

/*
 * SVG → symbol primitives. Geometry is converted exactly (no sampling): paths
 * are normalised to absolute M/L/C/Q/Z, transforms are applied, and stroke
 * widths, fills and text follow the file. Everything is scaled by one factor,
 * so proportions and relative line weights match the original.
 */

export type Seg = { c: 'M' | 'L' | 'C' | 'Q' | 'Z'; p: number[] };

const r20 = (v: number) => Math.max(20, Math.round(v / 20) * 20);
const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

/** Parses SVG path data into absolute M/L/C/Q/Z segments (H/V/S/T/A are converted). */
export function parsePathData(d: string): Seg[] {
  const out: Seg[] = [];
  const n = d.length;
  let i = 0;
  const skip = () => {
    while (i < n && /[\s,]/.test(d[i])) i++;
  };
  const num = (): number => {
    skip();
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) throw new Error('Bad SVG path data');
    i = NUM.lastIndex;
    return +m[0];
  };
  const flag = (): boolean => {
    skip();
    const ch = d[i++];
    if (ch !== '0' && ch !== '1') throw new Error('Bad SVG arc flag');
    return ch === '1';
  };
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastC: number[] | null = null;
  let lastQ: number[] | null = null;
  let cmd = '';
  for (;;) {
    skip();
    if (i >= n) break;
    if (/[a-zA-Z]/.test(d[i])) cmd = d[i++];
    else if (!cmd) throw new Error('Bad SVG path data');
    const rel = cmd !== cmd.toUpperCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    const C = cmd.toUpperCase();
    let nextC: number[] | null = null;
    let nextQ: number[] | null = null;
    switch (C) {
      case 'M':
        x = num() + ox;
        y = num() + oy;
        sx = x;
        sy = y;
        out.push({ c: 'M', p: [x, y] });
        cmd = rel ? 'l' : 'L'; // further pairs are line-tos
        break;
      case 'L':
        x = num() + ox;
        y = num() + oy;
        out.push({ c: 'L', p: [x, y] });
        break;
      case 'H':
        x = num() + ox;
        out.push({ c: 'L', p: [x, y] });
        break;
      case 'V':
        y = num() + oy;
        out.push({ c: 'L', p: [x, y] });
        break;
      case 'C': {
        const p = [num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy];
        out.push({ c: 'C', p });
        nextC = [p[2], p[3]];
        [x, y] = [p[4], p[5]];
        break;
      }
      case 'S': {
        const c1: number[] = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y];
        const p: number[] = [c1[0], c1[1], num() + ox, num() + oy, num() + ox, num() + oy];
        out.push({ c: 'C', p });
        nextC = [p[2], p[3]];
        [x, y] = [p[4], p[5]];
        break;
      }
      case 'Q': {
        const p = [num() + ox, num() + oy, num() + ox, num() + oy];
        out.push({ c: 'Q', p });
        nextQ = [p[0], p[1]];
        [x, y] = [p[2], p[3]];
        break;
      }
      case 'T': {
        const c1: number[] = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y];
        const p: number[] = [c1[0], c1[1], num() + ox, num() + oy];
        out.push({ c: 'Q', p });
        nextQ = c1;
        [x, y] = [p[2], p[3]];
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num();
        const large = flag(), sweep = flag();
        const ex = num() + ox, ey = num() + oy;
        const curves = arcToCubics(x, y, rx, ry, rot, large, sweep, ex, ey);
        if (curves) for (const p of curves) out.push({ c: 'C', p });
        else if (ex !== x || ey !== y) out.push({ c: 'L', p: [ex, ey] });
        [x, y] = [ex, ey];
        break;
      }
      case 'Z':
        out.push({ c: 'Z', p: [] });
        x = sx;
        y = sy;
        cmd = ''; // numbers may not follow Z
        break;
      default:
        throw new Error(`Unsupported SVG path command "${cmd}"`);
    }
    lastC = nextC;
    lastQ = nextQ;
  }
  return out;
}

/** Converts an SVG elliptical arc into cubic Béziers (null when it is really a line). */
export function arcToCubics(x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): number[][] | null {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry) return null;
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const delta = dt / segs;
  const k = (4 / 3) * Math.tan(delta / 4);
  const pt = (a: number) => [cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin, cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos];
  const der = (a: number) => [-rx * Math.sin(a) * cos - ry * Math.cos(a) * sin, -rx * Math.sin(a) * sin + ry * Math.cos(a) * cos];
  const out: number[][] = [];
  for (let s = 0; s < segs; s++) {
    const a1 = t1 + s * delta;
    const a2 = a1 + delta;
    const [p0x, p0y] = pt(a1), [d1x, d1y] = der(a1);
    const [p3x, p3y] = pt(a2), [d2x, d2y] = der(a2);
    out.push([p0x + k * d1x, p0y + k * d1y, p3x - k * d2x, p3y - k * d2y, p3x, p3y]);
  }
  // land exactly on the requested end point
  out[out.length - 1][4] = x2;
  out[out.length - 1][5] = y2;
  return out;
}

/* ------------------------------------------------------------------ */
/* DOM → segments                                                      */
/* ------------------------------------------------------------------ */

const SHAPES = 'path,line,polyline,polygon,rect,circle,ellipse,text';
const HIDDEN_CONTAINERS = 'defs,clipPath,mask,symbol,marker,pattern,title,desc,metadata';
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

const len = (v: SVGAnimatedLength) => v.baseVal.value;

function elementPathData(el: Element): string | null {
  switch (el.tagName.toLowerCase()) {
    case 'path':
      return el.getAttribute('d');
    case 'line': {
      const l = el as SVGLineElement;
      return `M${len(l.x1)} ${len(l.y1)}L${len(l.x2)} ${len(l.y2)}`;
    }
    case 'polyline':
    case 'polygon': {
      const nums = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).filter(Boolean);
      if (nums.length < 4) return null;
      return `M${nums.slice(0, 2).join(' ')}L${nums.slice(2).join(' ')}${el.tagName.toLowerCase() === 'polygon' ? 'Z' : ''}`;
    }
    case 'rect': {
      const r = el as SVGRectElement;
      const x = len(r.x), y = len(r.y), w = len(r.width), h = len(r.height);
      if (w <= 0 || h <= 0) return null;
      let rx = len(r.rx), ry = len(r.ry);
      // a single radius applies to both axes
      if (!r.hasAttribute('rx') && r.hasAttribute('ry')) rx = ry;
      if (!r.hasAttribute('ry') && r.hasAttribute('rx')) ry = rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    case 'circle':
    case 'ellipse': {
      const e = el as SVGCircleElement & SVGEllipseElement;
      const cx = len(e.cx), cy = len(e.cy);
      const rx = el.tagName.toLowerCase() === 'circle' ? len(e.r) : len(e.rx);
      const ry = el.tagName.toLowerCase() === 'circle' ? len(e.r) : len(e.ry);
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
  }
  return null;
}

/** Replaces <use> references with copies of what they point at, so their shapes are found. */
function expandUses(root: SVGSVGElement) {
  for (let pass = 0; pass < 4; pass++) {
    const uses = [...root.querySelectorAll('use')];
    if (!uses.length) return;
    for (const u of uses) {
      const ref = u.getAttribute('href') ?? u.getAttributeNS(XLINK_NS, 'href') ?? '';
      const target = ref.startsWith('#') ? root.querySelector(`[id="${CSS.escape(ref.slice(1))}"]`) : null;
      const g = document.createElementNS(SVG_NS, 'g');
      for (const a of ['class', 'style', 'fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity']) {
        const v = u.getAttribute(a);
        if (v !== null) g.setAttribute(a, v);
      }
      const tx = u.getAttribute('x') ?? '0';
      const ty = u.getAttribute('y') ?? '0';
      g.setAttribute('transform', `${u.getAttribute('transform') ?? ''} translate(${parseFloat(tx) || 0} ${parseFloat(ty) || 0})`);
      if (target) {
        if (target.tagName.toLowerCase() === 'symbol') for (const ch of target.childNodes) g.appendChild(ch.cloneNode(true));
        else {
          const copy = target.cloneNode(true) as Element;
          copy.removeAttribute('id');
          g.appendChild(copy);
        }
      }
      u.replaceWith(g);
    }
  }
}

const isNone = (paint: string) => !paint || paint === 'none' || /rgba\(.*,\s*0\)$/.test(paint) || paint === 'transparent';

function fillKind(paint: string): Fill {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(paint);
  // white / near-white fills become the symbol background, so they follow the theme
  if (m && +m[1] > 235 && +m[2] > 235 && +m[3] > 235) return 'bg';
  return 'solid';
}

interface RawShape {
  segs: Seg[];
  fill: Fill | null;
  /** Stroke width in source units (0 = no stroke). */
  sw: number;
}
interface RawText {
  x: number;
  y: number;
  size: number;
  anchor: 'start' | 'middle' | 'end';
  text: string;
}

function collect(live: SVGSVGElement): { shapes: RawShape[]; texts: RawText[] } {
  const shapes: RawShape[] = [];
  const texts: RawText[] = [];
  for (const el of live.querySelectorAll(SHAPES) as NodeListOf<SVGGraphicsElement>) {
    if (el.closest(HIDDEN_CONTAINERS) || el.parentElement?.closest('text')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || +cs.opacity === 0) continue;
    const m = el.getCTM();
    if (!m) continue;
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
    if (el.tagName.toLowerCase() === 'text') {
      const t = el as SVGTextElement;
      const text = (t.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const x = t.x.baseVal.numberOfItems ? t.x.baseVal.getItem(0).value : 0;
      const y = t.y.baseVal.numberOfItems ? t.y.baseVal.getItem(0).value : 0;
      const anchor = cs.textAnchor === 'middle' ? 'middle' : cs.textAnchor === 'end' ? 'end' : 'start';
      texts.push({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f, size: (parseFloat(cs.fontSize) || 16) * scale, anchor, text: text.replace(/;/g, ',') });
      continue;
    }
    const d = elementPathData(el);
    if (!d) continue;
    let segs: Seg[];
    try {
      segs = parsePathData(d);
    } catch {
      continue; // skip a malformed element rather than failing the whole file
    }
    if (segs.length < 2) continue;
    const tag = el.tagName.toLowerCase();
    const filled = tag !== 'line' && !isNone(cs.fill) && +cs.fillOpacity > 0;
    const sw = !isNone(cs.stroke) && +cs.strokeOpacity > 0 ? (parseFloat(cs.strokeWidth) || 0) * scale : 0;
    if (!filled && !sw) continue;
    const T = (p: number[]) => {
      const o: number[] = [];
      for (let i = 0; i < p.length; i += 2) o.push(m.a * p[i] + m.c * p[i + 1] + m.e, m.b * p[i] + m.d * p[i + 1] + m.f);
      return o;
    };
    shapes.push({ segs: segs.map((s) => ({ c: s.c, p: T(s.p) })), fill: filled ? fillKind(cs.fill) : null, sw });
  }
  return { shapes, texts };
}

/** Bounds of the drawn geometry (curves evaluated, not just their control points). */
function segBounds(shapes: RawShape[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number, pad = 0) => {
    minX = Math.min(minX, x - pad);
    minY = Math.min(minY, y - pad);
    maxX = Math.max(maxX, x + pad);
    maxY = Math.max(maxY, y + pad);
  };
  for (const s of shapes) {
    const pad = s.sw / 2;
    let px = 0, py = 0;
    for (const g of s.segs) {
      if (g.c === 'C' || g.c === 'Q') {
        for (let k = 1; k <= 8; k++) {
          const t = k / 8, u = 1 - t;
          const [x, y] =
            g.c === 'C'
              ? [u * u * u * px + 3 * u * u * t * g.p[0] + 3 * u * t * t * g.p[2] + t * t * t * g.p[4], u * u * u * py + 3 * u * u * t * g.p[1] + 3 * u * t * t * g.p[3] + t * t * t * g.p[5]]
              : [u * u * px + 2 * u * t * g.p[0] + t * t * g.p[2], u * u * py + 2 * u * t * g.p[1] + t * t * g.p[3]];
          add(x, y, pad);
        }
      } else if (g.p.length) add(g.p[g.p.length - 2], g.p[g.p.length - 1], pad);
      if (g.p.length) [px, py] = [g.p[g.p.length - 2], g.p[g.p.length - 1]];
    }
  }
  return { minX, minY, maxX, maxY };
}

const r2 = (v: number) => +v.toFixed(2);

/** Simplest primitive that draws the segments exactly. */
function toPrim(segs: Seg[], fill: Fill | null, w: number): Prim | null {
  const moves = segs.filter((s) => s.c === 'M').length;
  const straight = segs.every((s) => s.c === 'M' || s.c === 'L' || s.c === 'Z');
  const closed = segs[segs.length - 1].c === 'Z';
  if (straight && moves === 1 && segs[0].c === 'M') {
    const pts = segs.filter((s) => s.c !== 'Z').flatMap((s) => s.p.map(r2));
    // an open, filled and stroked outline must not stroke its closing edge: leave that to a path
    const openFilledStroke = !!fill && !closed && w > 0;
    if (pts.length >= 6 && (closed || fill) && !openFilledStroke) return { t: 'poly', pts, fill: fill ?? 'none', w };
    if (pts.length < 6 || !fill) return pts.length >= 4 && w > 0 ? { t: 'line', pts, w } : null;
  }
  const d = segs.map((s) => (s.c === 'Z' ? 'Z' : `${s.c}${s.p.map(r2).join(' ')}`)).join(' ');
  return { t: 'path', d, fill: fill ?? 'none', w };
}

/**
 * Converts SVG markup into symbol primitives. With `size` the drawing is
 * scaled to fit that many px (grid-aligned); without it, it keeps its own
 * size (capped at 1000 px). Needs a live DOM to resolve CSS and transforms.
 */
export function svgToPrims(text: string, size?: number): { prims: Prim[]; w: number; h: number } {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) throw new Error('The SVG could not be parsed');
  const svg = parsed.querySelector('svg');
  if (!svg) throw new Error('No <svg> element found');
  const host = document.createElement('div');
  // off-screen but not visibility:hidden, which every shape would inherit (and be skipped)
  host.style.cssText = 'position:absolute;left:-99999px;top:0;opacity:0;pointer-events:none';
  host.appendChild(document.importNode(svg, true));
  document.body.appendChild(host);
  try {
    const live = host.querySelector('svg')!;
    expandUses(live);
    const { shapes, texts } = collect(live);
    if (!shapes.length && !texts.length) throw new Error('The SVG has no drawable shapes');
    const b = segBounds(shapes);
    for (const t of texts) {
      b.minX = Math.min(b.minX, t.x);
      b.maxX = Math.max(b.maxX, t.x);
      b.minY = Math.min(b.minY, t.y - t.size);
      b.maxY = Math.max(b.maxY, t.y);
    }
    const bw = b.maxX - b.minX || 1;
    const bh = b.maxY - b.minY || 1;
    const k = size ? (size - 20) / Math.max(bw, bh) : Math.min(1, 1000 / Math.max(bw, bh));
    const w = r20(bw * k + 20);
    const h = r20(bh * k + 20);
    const ox = (w - bw * k) / 2 - b.minX * k;
    const oy = (h - bh * k) / 2 - b.minY * k;
    const map = (p: number[]) => p.map((v, i) => v * k + (i % 2 === 0 ? ox : oy));
    const prims: Prim[] = [];
    for (const s of shapes) {
      // keep hairlines visible, otherwise line weights scale with the drawing
      const sw = s.sw ? Math.max(0.25, r2(s.sw * k)) : 0;
      const prim = toPrim(
        s.segs.map((g) => ({ c: g.c, p: map(g.p) })),
        s.fill,
        sw,
      );
      if (prim) prims.push(prim);
    }
    for (const t of texts) {
      const [x, y] = map([t.x, t.y]);
      prims.push({ t: 'text', x: r2(x), y: r2(y), size: Math.max(4, r2(t.size * k)), anchor: t.anchor, text: t.text });
    }
    return { prims, w, h };
  } finally {
    host.remove();
  }
}
