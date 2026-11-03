import { flattenSegs, parsePathData, subpathNodes } from '../io/svgImport';
import { createDoc, makeComponent, makeShape } from './doc';
import { selectionToDrawing } from './fromSelection';
import { measureText, toWorld } from './geometry';
import { instanceSymbol } from './registry';
import { arcNodes, closeLoop, packPath, type PathNode } from './path';
import { packPoly } from './polygon';
import { PIN_SYMBOL } from './symbols';
import { inferSide, type SymbolSource } from './symbols/dsl';
import type { CircuitDoc, ComponentItem, Fill, Group, Item, Point, PortDef, Prim, ShapeItem, SymbolDef } from './types';

/*
 * The symbol editor is a page of its own: a symbol's drawing opens as ordinary
 * shapes (and any parts, wires or ink drawn there) plus one "pin" marker per
 * connection point. Saving flattens the page back into the symbol's drawing.
 * The page itself is kept in the symbol's source, so it reopens exactly as it
 * was left (parts stay parts, text stays text).
 */

export { PIN_DEF, PIN_SYMBOL } from './symbols';

/** The editable page a symbol was drawn on (stored in its source). */
export interface SymbolPage {
  items: Record<string, Item>;
  groups: Record<string, Group>;
  /** Symbols of parts placed on the page (so they reopen even when no longer in the library). */
  symbols: Record<string, SymbolDef>;
}

export const isPin = (it: Item | undefined): it is ComponentItem => it?.type === 'component' && it.symbol === PIN_SYMBOL;

/** Every pin marker on the page, in pin order. */
export const pagePins = (doc: Pick<CircuitDoc, 'items'>): ComponentItem[] => Object.values(doc.items).filter(isPin);

/** A pin name usable in the pin list (no spaces, colons or commas). */
export const pinId = (name: string) => name.trim().replace(/[\s:,]/g, '_') || 'pin';

/** Lowest pin number not used yet ("1", "2", …). */
export function nextPinName(doc: Pick<CircuitDoc, 'items'>): string {
  const used = new Set(pagePins(doc).map((p) => p.ref));
  let n = 1;
  while (used.has(String(n))) n++;
  return String(n);
}

/** A pin marker at `p` (world coordinates). */
export function makePin(doc: CircuitDoc, p: Point, name = nextPinName(doc)): ComponentItem {
  const c = makeComponent(doc, PIN_SYMBOL, p.x, p.y);
  c.ref = name;
  c.showRef = true;
  c.showValue = false;
  return c;
}

/* ------------------------------------------------------------------ */
/* Symbol → page                                                       */
/* ------------------------------------------------------------------ */

const INK = '#000000';
/** Page colour: a shape filled with it follows the canvas, as a background-filled symbol interior does. */
const PAGE = '#fffdf9';

/** The page saved with a symbol, if it has one. */
export function storedPage(src: Pick<SymbolSource, 'page'> | null | undefined): SymbolPage | null {
  const p = src?.page;
  if (!p || typeof p !== 'object' || typeof p.items !== 'object') return null;
  return { items: p.items, groups: p.groups ?? {}, symbols: p.symbols ?? {} };
}

/**
 * A document holding the symbol as editable items: its saved page, or else
 * its drawing turned into shapes and its ports into pins (symbol coordinates
 * are world coordinates, so (0, 0) is the drawing's top-left corner).
 */
export function symbolDoc(name: string, prims: Prim[], ports: PortDef[], page?: SymbolPage | null): CircuitDoc {
  const doc = createDoc(name);
  if (page) {
    doc.items = structuredClone(page.items);
    doc.groups = structuredClone(page.groups);
    doc.symbols = structuredClone(page.symbols);
    return doc;
  }
  for (const s of primsToShapes(doc, prims)) doc.items[s.id] = s;
  for (const p of ports) {
    const c = makePin(doc, p, p.id);
    doc.items[c.id] = c;
  }
  return doc;
}

const fillOf = (p: { fill: Fill; fc?: string; color?: string }): { fill: string; fillOpacity: number } =>
  p.fill === 'solid'
    ? { fill: !p.fc || p.fc === 'currentColor' ? (p.color ?? INK) : p.fc, fillOpacity: 1 }
    : p.fill === 'bg'
      ? { fill: PAGE, fillOpacity: 1 }
      : { fill: p.color ?? INK, fillOpacity: 0 };

/** Symbol primitives as editable shapes (their colours, fills, widths and dashes kept). */
export function primsToShapes(doc: CircuitDoc, prims: Prim[]): ShapeItem[] {
  const out: ShapeItem[] = [];
  const add = (kind: ShapeItem['kind'], p: Prim, fields: Partial<ShapeItem>) => {
    const s = makeShape(doc, kind, 0, 0, 1, 1);
    const width = p.t === 'rect' ? p.sw : 'w' in p ? p.w : undefined;
    Object.assign(s, {
      stroke: p.color ?? INK,
      strokeWidth: width ?? 2,
      dash: p.dash ? 'dashed' : 'solid',
      radius: 0,
      ...('fill' in p ? fillOf(p) : { fill: 'none', fillOpacity: 0 }),
      ...fields,
    });
    if (s.strokeWidth === 0) s.stroke = 'none';
    // each shape stacks above the one before, in drawing order
    s.z = out.length + 1;
    out.push(s);
  };
  const nodesOf = (pts: number[]): PathNode[] => {
    const ns: PathNode[] = [];
    for (let i = 0; i + 1 < pts.length; i += 2) ns.push({ x: pts[i], y: pts[i + 1] });
    return ns;
  };
  for (const p of prims) {
    switch (p.t) {
      case 'line': {
        const ns = nodesOf(p.pts);
        if (ns.length < 2) break;
        const a = ns[0];
        const z = ns[ns.length - 1];
        add('line', p, { x: a.x, y: a.y, w: z.x - a.x, h: z.y - a.y, pts: ns.slice(1, -1), headStart: 'none', headEnd: 'none', fill: 'none', fillOpacity: 0 });
        break;
      }
      case 'poly':
        if (p.pts.length >= 6) add('polygon', p, packPoly(nodesOf(p.pts)));
        break;
      case 'rect':
        add('rect', p, { x: p.x, y: p.y, w: p.w, h: p.h, radius: p.rx ?? 0 });
        break;
      case 'circle':
        add('ellipse', p, { x: p.cx - p.r, y: p.cy - p.r, w: 2 * p.r, h: 2 * p.r });
        break;
      case 'ellipse':
        add('ellipse', p, { x: p.cx - p.rx, y: p.cy - p.ry, w: 2 * p.rx, h: 2 * p.ry });
        break;
      case 'arc':
        add('polygon', p, { ...packPath(arcNodes(p.cx, p.cy, p.r, p.r, p.a1, p.a2), true), fill: 'none', fillOpacity: 0 });
        break;
      case 'path': {
        const segs = parsePathData(p.d);
        const flat = flattenSegs(segs);
        const curved = subpathNodes(segs);
        flat.forEach((f, i) => {
          const c = curved[i];
          const closed = c ? c.closed : f.closed;
          const nodes = c ? c.nodes : closed ? closeLoop(nodesOf(f.pts)) : nodesOf(f.pts);
          // a closed outline needs three corners, or two curved stretches (a lens closed on itself)
          const fewest = closed && !nodes.some((n) => n.in || n.out) ? 3 : 2;
          if (nodes.length < fewest) return;
          add('polygon', p, closed ? packPath(nodes) : { ...packPath(nodes, true), fill: 'none', fillOpacity: 0 });
        });
        break;
      }
      case 'text': {
        const m = measureText(p.text, p.size);
        const dx = p.anchor === 'middle' ? m.w / 2 : p.anchor === 'end' ? m.w : 0;
        add('text', p, {
          x: p.x - dx,
          y: p.y - p.size,
          w: m.w,
          h: m.h,
          text: p.text,
          fontSize: p.size,
          align: p.anchor,
          stroke: 'none',
          strokeWidth: 0,
          fill: 'none',
          fillOpacity: 0,
          ...(p.color && p.color !== INK ? { textColor: p.color } : {}),
        });
        break;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Page → symbol                                                       */
/* ------------------------------------------------------------------ */

export interface PageSymbol {
  prims: Prim[];
  ports: PortDef[];
  w: number;
  h: number;
  /** World position of the symbol's (0, 0). */
  origin: Point;
}

const floor10 = (v: number) => Math.floor(v / 10) * 10;
const ceil10 = (v: number) => Math.max(10, Math.ceil(v / 10) * 10);

/** The symbol's outline on the page: the drawing and every pin, out to the 10 px grid (null when the page is empty). */
export function symbolBox(doc: CircuitDoc): { x: number; y: number; w: number; h: number } | null {
  const s = pageToSymbol(doc);
  return s && { x: s.origin.x, y: s.origin.y, w: s.w, h: s.h };
}

/**
 * Flattens the page into a symbol drawing: every visible item but the pins
 * becomes primitives (parts are drawn in place, wires as lines), and each pin
 * becomes a port on its side of the outline. Throws when two pins share a name.
 */
export function pageToSymbol(doc: CircuitDoc): PageSymbol | null {
  const items = Object.values(doc.items).filter((it) => !it.hidden);
  const pins = items.filter(isPin);
  const drawn = items.filter((it) => !isPin(it)).map((it) => it.id);
  const drawing = drawn.length ? selectionToDrawing(doc, drawn) : null;
  if (!drawing && !pins.length) return null;
  const xs = pins.map((p) => p.x);
  const ys = pins.map((p) => p.y);
  if (drawing) {
    xs.push(drawing.origin.x, drawing.origin.x + drawing.w);
    ys.push(drawing.origin.y, drawing.origin.y + drawing.h);
  }
  // selectionToDrawing rounds its size up generously: tighten to the real extent of the drawing
  if (drawing) {
    const b = primExtent(drawing.prims);
    if (b) {
      xs.splice(-2, 2, drawing.origin.x + b.x0, drawing.origin.x + b.x1);
      ys.splice(-2, 2, drawing.origin.y + b.y0, drawing.origin.y + b.y1);
    }
  }
  const origin = { x: floor10(Math.min(...xs)), y: floor10(Math.min(...ys)) };
  const w = ceil10(Math.max(...xs) - origin.x);
  const h = ceil10(Math.max(...ys) - origin.y);
  const shift = drawing ? { x: drawing.origin.x - origin.x, y: drawing.origin.y - origin.y } : { x: 0, y: 0 };
  const prims = drawing ? drawing.prims.map((p) => movePrimBy(p, shift.x, shift.y)) : [];
  const seen = new Set<string>();
  const ports: PortDef[] = [];
  for (const pin of pins) {
    const id = pinId(pin.ref);
    if (seen.has(id)) throw new Error(`Two pins are named “${pin.ref}”: give each pin its own name`);
    seen.add(id);
    const x = r2(pin.x - origin.x);
    const y = r2(pin.y - origin.y);
    ports.push({ id, name: id.replace(/_/g, ' '), x, y, side: inferSide(x, y, w, h) });
  }
  return { prims, ports, w, h, origin };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** The page saved alongside the symbol: its items (pins included) and what they need to reopen. */
export function pageOf(doc: CircuitDoc): SymbolPage {
  const used = new Set(Object.values(doc.items).flatMap((it) => (it.type === 'component' && it.symbol !== PIN_SYMBOL ? [it.symbol] : [])));
  const symbols: Record<string, SymbolDef> = {};
  for (const id of used) {
    const def = doc.symbols[id];
    if (!def) continue;
    // a symbol's own stored page is not needed to draw it here
    symbols[id] = def;
    if (def.variantOf && doc.symbols[def.variantOf]) symbols[def.variantOf] = doc.symbols[def.variantOf];
  }
  return { items: structuredClone(doc.items), groups: structuredClone(doc.groups), symbols: structuredClone(symbols) };
}

/** Bounds of primitives (strokes not included). */
function primExtent(prims: Prim[]): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const pt = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
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
      case 'arc':
        pt(p.cx - p.r, p.cy - p.r);
        pt(p.cx + p.r, p.cy + p.r);
        break;
      case 'ellipse':
        pt(p.cx - p.rx, p.cy - p.ry);
        pt(p.cx + p.rx, p.cy + p.ry);
        break;
      case 'path': {
        for (const f of flattenSegs(parsePathData(p.d))) for (let i = 0; i + 1 < f.pts.length; i += 2) pt(f.pts[i], f.pts[i + 1]);
        break;
      }
      case 'text': {
        const m = measureText(p.text, p.size);
        const x = p.anchor === 'middle' ? p.x - m.w / 2 : p.anchor === 'end' ? p.x - m.w : p.x;
        pt(x, p.y - p.size);
        pt(x + m.w, p.y + p.size * 0.25);
        break;
      }
    }
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

function movePrimBy(p: Prim, dx: number, dy: number): Prim {
  if (!dx && !dy) return p;
  const r = (v: number) => Math.round(v * 100) / 100;
  const pts = (a: number[]) => a.map((v, i) => r(v + (i % 2 ? dy : dx)));
  switch (p.t) {
    case 'line':
    case 'poly':
      return { ...p, pts: pts(p.pts) };
    case 'rect':
    case 'text':
      return { ...p, x: r(p.x + dx), y: r(p.y + dy) };
    case 'circle':
    case 'arc':
    case 'ellipse':
      return { ...p, cx: r(p.cx + dx), cy: r(p.cy + dy) };
    case 'path': {
      // absolute M/L/C/Q/Z data (as the converters write it): every pair moves
      let i = 0;
      const d = p.d.replace(/[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g, (tok) => {
        if (/[A-Za-z]/.test(tok)) {
          i = 0;
          return tok;
        }
        const v = +tok + (i++ % 2 ? dy : dx);
        return String(r(v));
      });
      return { ...p, d };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Pin placement                                                       */
/* ------------------------------------------------------------------ */

/** Spots a new pin likes to land on: the free ends of lines, open paths and wires, and pins of parts on the page. */
export function pinTargets(doc: CircuitDoc): Point[] {
  const out: Point[] = [];
  for (const it of Object.values(doc.items)) {
    if (it.hidden) continue;
    if (it.type === 'shape') {
      if (it.kind === 'line' || it.kind === 'arrow') out.push({ x: it.x, y: it.y }, { x: it.x + it.w, y: it.y + it.h });
      else if (it.kind === 'polygon' && it.open && it.poly && it.poly.length >= 4) {
        const n = it.poly.length;
        out.push({ x: it.x + it.poly[0] * it.w, y: it.y + it.poly[1] * it.h }, { x: it.x + it.poly[n - 2] * it.w, y: it.y + it.poly[n - 1] * it.h });
      }
    } else if (it.type === 'wire') {
      for (const ep of [it.a, it.b]) if (ep.kind === 'free') out.push({ x: ep.x, y: ep.y });
    } else if (it.type === 'component' && !isPin(it)) {
      for (const port of getSymbolPorts(doc, it)) out.push(port);
    }
  }
  return out;
}

function getSymbolPorts(doc: CircuitDoc, c: ComponentItem): Point[] {
  const def = instanceSymbol(doc, c);
  return def.ports.map((p) => toWorld(c, def, p.x, p.y));
}

/**
 * Where a pin dropped at `raw` goes: onto a lead end within `tol` (so pins
 * land exactly on the ends of the drawing), else the grid-snapped `snapped`.
 * Spots that already hold a pin are skipped.
 */
export function snapPin(doc: CircuitDoc, raw: Point, snapped: Point, tol: number): Point {
  const taken = pagePins(doc).map((p) => ({ x: p.x, y: p.y }));
  let best: Point | null = null;
  let bd = tol;
  for (const t of pinTargets(doc)) {
    if (taken.some((p) => Math.abs(p.x - t.x) < 0.5 && Math.abs(p.y - t.y) < 0.5)) continue;
    const d = Math.hypot(t.x - raw.x, t.y - raw.y);
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  return best ? { x: r2(best.x), y: r2(best.y) } : snapped;
}
