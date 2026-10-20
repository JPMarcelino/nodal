import { closeLoop, type PathNode } from '../model/path';
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
const HTML_NS = 'http://www.w3.org/1999/xhtml';

/* ------------------------------------------------------------------ */
/* Sanitising untrusted SVG before it touches the live document        */
/* ------------------------------------------------------------------ */

/**
 * Elements that can never contribute drawable geometry (only SHAPES are
 * collected) but can run code or fetch remote resources once attached to
 * the app document. Removed with their whole subtree while still inert.
 *
 * `use` is deliberately kept: expandUses() only follows `#fragment` refs
 * and external refs are stripped below, so it cannot fetch either. `a`
 * is kept for the same reason (shapes inside links still import); its
 * href is stripped unless it is a fragment.
 */
const BLOCKED_SVG_TAGS = new Set([
  'script', 'foreignobject',
  'iframe', 'embed', 'object', 'frame', 'frameset',
  'image', 'video', 'audio', 'source', 'track', 'canvas',
  'link', 'meta', 'base',
  'form', 'input', 'button', 'select', 'textarea',
  'animate', 'animatemotion', 'animatetransform', 'set', 'mpath', 'discard',
  'handler', 'listener',
  'feimage', 'cursor',
]);

/** Internal `#fragment` refs (paint servers, use targets) are safe; anything else can load code or phone home. */
const safeSvgRef = (value: string) => value.trimStart().startsWith('#');

/**
 * CSS `\69` escapes decoded repeatedly, so `@\69 mport`, `@\5c 69mport`
 * (double-escaped) or `u\52 l(` can't smuggle tokens past the scrub below.
 * Bounded so a pathological run of backslashes can't hang the import.
 */
function decodeCssEscapes(css: string): string {
  return css.replace(/\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g, (_m, esc: string) => {
    if (/^[0-9a-fA-F]/.test(esc)) {
      const cp = parseInt(esc.trim(), 16);
      return cp > 0x10ffff ? '�' : String.fromCodePoint(cp);
    }
    // a backslash-newline is a line continuation, any other escape is literal
    if (esc === '\n' || esc === '\r' || esc === '\f') return '';
    return esc;
  });
}

/**
 * Decode until no escapes remain (the browser decodes again at
 * tokenisation, so a single pass leaves `@\\69 mport` → `@\69 mport`
 * looking innocent). Bounded so a pathological run of backslashes can't
 * hang the import; any escapes left over after the bound are removed by
 * normalizeCss below, so the bound is only a performance concern.
 */
function decodeCssEscapesFully(css: string): string {
  let out = css;
  for (let i = 0; i < 10; i++) {
    const next = decodeCssEscapes(out);
    if (next === out) return out;
    out = next;
  }
  return out;
}

/**
 * Fully decoded with no backslashes left: what the browser will
 * tokenise. Stripping here (rather than after the @import/url patterns)
 * matters: with N backslashes still present after the decode bound,
 * stripping afterwards would itself re-form `url(` / `@import` past the
 * patterns that already ran. Patterns below always run on this
 * backslash-free text, and cleanSvgAttr detects on it too.
 */
function normalizeCss(css: string): string {
  return decodeCssEscapesFully(css).replace(/\\/g, '');
}

/**
 * CSS with comments, @import rules and external url() targets removed;
 * internal url(#…) paint servers are kept. The url() pattern is
 * quote-aware so a ')' inside a quoted URL can't leave garbage behind.
 */
function scrubSvgCss(css: string): string {
  return normalizeCss(css)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(?!(["']?)\s*#)("([^"]*)"|'([^']*)'|[^)]*)\)/gi, 'none');
}

/**
 * What to do with one attribute on an untrusted SVG element: null removes
 * it, a string replaces its value. Pure (no DOM) so it can be unit-tested.
 */
export function cleanSvgAttr(local: string, value: string): string | null {
  const name = local.toLowerCase();
  // localName may be 'href'/'base'/'src' while name is 'xlink:href'/'xml:base';
  // normalise so prefixed variants can't smuggle past the checks below.
  const base = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
  if (name.startsWith('on') || base.startsWith('on')) return null; // event handlers (onload, onerror, onbegin, …)
  // xml:base re-bases otherwise-safe url(#…) and href="#…" to the attacker
  // origin, so internal refs would fetch/paint remotely once attached.
  if (base === 'base') return null;
  if (base === 'href') return safeSvgRef(value) ? value : null; // javascript:/data:/remote refs
  if (base === 'src' || base === 'srcdoc' || base === 'srcset' || base === 'imagesrcset') return null;
  if (name === 'style' || base === 'style') return scrubSvgCss(value);
  // presentation attributes (fill, stroke, filter, clip-path, mask,
  // marker-*, cursor, …) can all carry url(https://…) payloads, escapes included
  if (/url\(/i.test(normalizeCss(value))) return scrubSvgCss(value);
  if (base === 'formaction' || base === 'action' || base === 'poster' || base === 'background' || base === 'cite' || base === 'data' || base === 'codebase' || base === 'classid' || base === 'usemap' || base === 'profile' || base === 'longdesc' || base === 'archive' || base === 'code' || base === 'lowsrc' || base === 'dynsrc') return null;
  return value;
}

/** True for element tags dropped with their whole subtree (case-insensitive). */
export function blockedSvgTag(tag: string): boolean {
  return BLOCKED_SVG_TAGS.has(tag.toLowerCase());
}

/**
 * Strips everything that could run or fetch once attached to the app
 * document: blocked elements (script, foreignObject, image, …),
 * non-SVG-namespaced elements, event-handler attributes, external
 * references and embedded stylesheets' imports. Runs on the inert parsed
 * document, before importNode into the live DOM.
 */
export function sanitizeSvg(svg: Element): void {
  const els = [svg, ...Array.from(svg.querySelectorAll('*'))];
  for (const el of els) {
    const tag = (el.localName ?? el.tagName).toLowerCase();
    if (el !== svg && (blockedSvgTag(tag) || el.namespaceURI === HTML_NS)) {
      el.remove();
      continue;
    }
    for (const a of Array.from(el.attributes)) {
      const v = cleanSvgAttr(a.localName ?? a.name, a.value);
      if (v === null) el.removeAttribute(a.name);
      else if (v !== a.value) el.setAttribute(a.name, v);
    }
    if (tag === 'style' && el.textContent) {
      const clean = scrubSvgCss(el.textContent);
      if (clean !== el.textContent) el.textContent = clean;
    }
  }
}

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
  /** Computed colours, as #rrggbb ('' = none). */
  stroke: string;
  fillColor: string;
  fillOpacity: number;
  dashed: boolean;
  /** Set for <rect>/<circle>/<ellipse> drawn without rotation or skew (source units). */
  box?: { kind: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; rx: number };
}
interface RawText {
  x: number;
  y: number;
  size: number;
  anchor: 'start' | 'middle' | 'end';
  text: string;
  color: string;
}

/** 'rgb(r, g, b)' → '#rrggbb' ('' for none / unparsable). */
function hexOf(paint: string): string {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(paint);
  if (!m) return '';
  return '#' + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, '0')).join('');
}

function axisBox(el: Element, m: DOMMatrix): RawShape['box'] {
  if (Math.abs(m.b) > 1e-6 || Math.abs(m.c) > 1e-6) return undefined;
  const tag = el.tagName.toLowerCase();
  let x: number, y: number, w: number, h: number, rx = 0;
  if (tag === 'rect') {
    const r = el as SVGRectElement;
    [x, y, w, h] = [len(r.x), len(r.y), len(r.width), len(r.height)];
    rx = len(r.rx) || len(r.ry);
  } else if (tag === 'circle' || tag === 'ellipse') {
    const e = el as SVGCircleElement & SVGEllipseElement;
    const ex = tag === 'circle' ? len(e.r) : len(e.rx);
    const ey = tag === 'circle' ? len(e.r) : len(e.ry);
    [x, y, w, h] = [len(e.cx) - ex, len(e.cy) - ey, 2 * ex, 2 * ey];
  } else return undefined;
  const x0 = m.a * x + m.e, y0 = m.d * y + m.f;
  const x1 = m.a * (x + w) + m.e, y1 = m.d * (y + h) + m.f;
  return { kind: tag === 'rect' ? 'rect' : 'ellipse', x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), rx: rx * Math.abs(m.a) };
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
      texts.push({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f, size: (parseFloat(cs.fontSize) || 16) * scale, anchor, text: text.replace(/;/g, ','), color: hexOf(cs.fill) });
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
    shapes.push({
      segs: segs.map((s) => ({ c: s.c, p: T(s.p) })),
      fill: filled ? fillKind(cs.fill) : null,
      sw,
      stroke: sw ? hexOf(cs.stroke) : '',
      fillColor: filled ? hexOf(cs.fill) : '',
      fillOpacity: filled ? +cs.fillOpacity : 0,
      dashed: !!cs.strokeDasharray && cs.strokeDasharray !== 'none',
      box: axisBox(el, m),
    });
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
  const { shapes, texts, b } = readSvg(text);
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
}

/** Parses SVG markup in a live (off-screen) DOM and collects its shapes, text and bounds. */
function readSvg(text: string): { shapes: RawShape[]; texts: RawText[]; b: { minX: number; minY: number; maxX: number; maxY: number } } {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) throw new Error('The SVG could not be parsed');
  const svg = parsed.querySelector('svg');
  if (!svg) throw new Error('No <svg> element found');
  // untrusted markup: strip scripts, foreign content, handlers and remote
  // refs while still inert, before it is attached to the app document
  sanitizeSvg(svg);
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
    return { shapes, texts, b };
  } finally {
    host.remove();
  }
}

/* ------------------------------------------------------------------ */
/* SVG → editable drawing (wires, shapes, text)                        */
/* ------------------------------------------------------------------ */

export interface SvgPolyline {
  pts: { x: number; y: number }[];
  closed: boolean;
  width: number;
  color: string;
  dashed: boolean;
  /** Fill of the outline it came from (#rrggbb or 'none'; unset = none). */
  fill?: string;
  fillOpacity?: number;
  /** False when the source drew only a fill (no outline). */
  stroked?: boolean;
  /** Curved outlines: the nodes with their Bézier handles (same coordinates as `pts`, which is the flattened curve). */
  nodes?: PathNode[];
}
export interface SvgBox {
  kind: 'rect' | 'ellipse';
  x: number;
  y: number;
  w: number;
  h: number;
  rx: number;
  stroke: string;
  strokeWidth: number;
  fill: string;
  fillOpacity: number;
  dashed: boolean;
}
export interface SvgDrawing {
  lines: SvgPolyline[];
  boxes: SvgBox[];
  /** Small filled dots — connection points in a schematic. */
  dots: { x: number; y: number; r?: number }[];
  texts: { x: number; y: number; size: number; anchor: 'start' | 'middle' | 'end'; text: string; color: string }[];
}

/** Largest dot (canvas units) treated as a junction rather than a filled shape. */
const DOT_MAX = 10;

/** Flattens segments into polylines (one per subpath); curves are subdivided finely enough to look smooth. */
export function flattenSegs(segs: Seg[], k = 1): { pts: number[]; closed: boolean }[] {
  const out: { pts: number[]; closed: boolean }[] = [];
  let cur: number[] = [];
  let closed = false;
  const flush = () => {
    if (cur.length >= 4) out.push({ pts: cur, closed });
    cur = [];
    closed = false;
  };
  for (const g of segs) {
    const px = cur[cur.length - 2], py = cur[cur.length - 1];
    if (g.c === 'M') {
      flush();
      cur = [g.p[0], g.p[1]];
    } else if (g.c === 'L') cur.push(g.p[0], g.p[1]);
    else if (g.c === 'Z') {
      if (cur.length >= 2 && (cur[0] !== px || cur[1] !== py)) cur.push(cur[0], cur[1]);
      closed = true;
      const start = [cur[0], cur[1]];
      flush();
      cur = start; // a following command continues from the subpath start
    } else {
      const ctrl = g.p;
      let lenEst = Math.hypot(ctrl[0] - px, ctrl[1] - py);
      for (let i = 2; i < ctrl.length; i += 2) lenEst += Math.hypot(ctrl[i] - ctrl[i - 2], ctrl[i + 1] - ctrl[i - 1]);
      const n = Math.min(64, Math.max(4, Math.ceil((lenEst * k) / 4)));
      for (let s = 1; s <= n; s++) {
        const t = s / n, u = 1 - t;
        if (g.c === 'C') cur.push(u * u * u * px + 3 * u * u * t * ctrl[0] + 3 * u * t * t * ctrl[2] + t * t * t * ctrl[4], u * u * u * py + 3 * u * u * t * ctrl[1] + 3 * u * t * t * ctrl[3] + t * t * t * ctrl[5]);
        else cur.push(u * u * px + 2 * u * t * ctrl[0] + t * t * ctrl[2], u * u * py + 2 * u * t * ctrl[1] + t * t * ctrl[3]);
      }
    }
  }
  flush();
  return out;
}

/**
 * The subpaths of `segs` as nodes with Bézier handles (quadratics raised to
 * cubics), one entry per polyline flattenSegs returns, in the same order;
 * null for subpaths without curves.
 */
export function subpathNodes(segs: Seg[]): ({ nodes: PathNode[]; closed: boolean } | null)[] {
  const out: ({ nodes: PathNode[]; closed: boolean } | null)[] = [];
  let cur: PathNode[] = [];
  // points flattenSegs would hold for this subpath (it drops those with fewer than two)
  let count = 0;
  let curved = false;
  let closed = false;
  const flush = () => {
    if (count >= 2) out.push(curved ? { nodes: closed ? closeLoop(cur) : cur, closed } : null);
    cur = [];
    count = 0;
    curved = false;
    closed = false;
  };
  for (const g of segs) {
    const last = cur[cur.length - 1];
    if (g.c === 'M') {
      flush();
      cur = [{ x: g.p[0], y: g.p[1] }];
      count = 1;
    } else if (g.c === 'L') {
      cur.push({ x: g.p[0], y: g.p[1] });
      count++;
    } else if (g.c === 'Z') {
      if (cur.length && (cur[0].x !== last.x || cur[0].y !== last.y)) {
        cur.push({ x: cur[0].x, y: cur[0].y });
        count++;
      }
      closed = true;
      const start = cur[0];
      flush();
      if (start) {
        cur = [{ x: start.x, y: start.y }];
        count = 1;
      }
    } else if (last) {
      const q = g.p;
      const end = { x: q[q.length - 2], y: q[q.length - 1] };
      if (g.c === 'C') last.out = { x: q[0], y: q[1] };
      else last.out = { x: last.x + ((q[0] - last.x) * 2) / 3, y: last.y + ((q[1] - last.y) * 2) / 3 };
      const c2 = g.c === 'C' ? { x: q[2], y: q[3] } : { x: end.x + ((q[0] - end.x) * 2) / 3, y: end.y + ((q[1] - end.y) * 2) / 3 };
      cur.push({ ...end, in: c2 });
      curved = true;
      // flattenSegs adds at least four points per curve
      count += 4;
    }
  }
  flush();
  return out;
}

/**
 * Converts SVG markup into an editable drawing at its own size (capped at
 * 2000 px), centred on (0, 0): strokes become polylines (for wires), plain
 * rectangles / circles / ellipses become boxes, small dots become junctions.
 */
export function svgToDrawing(text: string): SvgDrawing {
  const { shapes, texts, b } = readSvg(text);
  const bw = b.maxX - b.minX || 1;
  const bh = b.maxY - b.minY || 1;
  const k = Math.min(1, 2000 / Math.max(bw, bh));
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const X = (v: number) => r2((v - cx) * k);
  const Y = (v: number) => r2((v - cy) * k);
  const out: SvgDrawing = { lines: [], boxes: [], dots: [], texts: [] };
  for (const s of shapes) {
    const width = s.sw ? Math.max(0.25, r2(s.sw * k)) : 0;
    if (s.box) {
      const bx = { x: X(s.box.x), y: Y(s.box.y), w: r2(s.box.w * k), h: r2(s.box.h * k) };
      if (s.box.kind === 'ellipse' && s.fill && bx.w <= DOT_MAX && bx.h <= DOT_MAX) {
        out.dots.push({ x: r2(bx.x + bx.w / 2), y: r2(bx.y + bx.h / 2), r: r2(Math.max(bx.w, bx.h) / 2) });
        continue;
      }
      out.boxes.push({ kind: s.box.kind, ...bx, rx: r2(s.box.rx * k), stroke: s.stroke || '#000000', strokeWidth: width, fill: s.fillColor || 'none', fillOpacity: s.fill ? s.fillOpacity : 0, dashed: s.dashed });
      continue;
    }
    const polys = flattenSegs(s.segs, k);
    // a small, round, filled blob (a path-drawn dot) is a connection point too; arrowheads etc. are not
    if (s.fill && polys.length && s.segs.some((g) => g.c === 'C' || g.c === 'Q')) {
      const xs = polys.flatMap((p) => p.pts.filter((_, i) => i % 2 === 0));
      const ys = polys.flatMap((p) => p.pts.filter((_, i) => i % 2 === 1));
      const w = (Math.max(...xs) - Math.min(...xs)) * k;
      const h = (Math.max(...ys) - Math.min(...ys)) * k;
      if (w <= DOT_MAX && h <= DOT_MAX && w > 0 && Math.abs(w - h) < Math.max(w, h) * 0.3) {
        out.dots.push({ x: X((Math.max(...xs) + Math.min(...xs)) / 2), y: Y((Math.max(...ys) + Math.min(...ys)) / 2), r: r2(Math.max(w, h) / 2) });
        continue;
      }
    }
    const color = s.stroke || s.fillColor || '#000000';
    const curves = subpathNodes(s.segs);
    const N = (q: { x: number; y: number }) => ({ x: X(q.x), y: Y(q.y) });
    for (const [pi, p] of polys.entries()) {
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < p.pts.length; i += 2) {
        const q = { x: X(p.pts[i]), y: Y(p.pts[i + 1]) };
        const last = pts[pts.length - 1];
        if (!last || last.x !== q.x || last.y !== q.y) pts.push(q);
      }
      // curves are kept as Béziers for outlines that become polygons
      const c = curves.length === polys.length ? curves[pi] : null;
      const nodes = c ? c.nodes.map((n) => ({ ...N(n), ...(n.in ? { in: N(n.in) } : {}), ...(n.out ? { out: N(n.out) } : {}) })) : undefined;
      if (pts.length >= 2)
        out.lines.push({ pts, closed: p.closed, width: width || Math.max(0.5, r2((s.sw || 1) * k)), color, dashed: s.dashed, fill: s.fill ? s.fillColor || '#000000' : 'none', fillOpacity: s.fill ? s.fillOpacity : 0, stroked: !!s.sw, ...(nodes ? { nodes } : {}) });
    }
  }
  for (const t of texts) out.texts.push({ x: X(t.x), y: Y(t.y), size: Math.max(4, r2(t.size * k)), anchor: t.anchor, text: t.text, color: t.color || '#000000' });
  return out;
}
