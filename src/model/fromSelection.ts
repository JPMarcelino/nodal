import { deleteItems } from './ops';
import { docBounds, makeComponent } from './doc';
import { toWorld } from './geometry';
import { getSymbol } from './registry';
import type { CircuitDoc, ComponentItem, Point, Prim, ShapeItem, SymbolDef } from './types';
import { wirePolyline } from './wires';

/*
 * "Create symbol from selection": turns selected parts, wires, junctions and
 * shapes into one symbol drawing, and later swaps the selection for a single
 * instance of the new symbol.
 */

export interface SelectionDrawing {
  prims: Prim[];
  w: number;
  h: number;
  /** World position of the drawing's (0, 0). */
  origin: Point;
}

const r = (v: number) => Math.round(v * 2) / 2;
const floor10 = (v: number) => Math.floor(v / 10) * 10;
const ceil20 = (v: number) => Math.max(20, Math.ceil(v / 20) * 20);

export function selectionToDrawing(doc: CircuitDoc, ids: string[]): SelectionDrawing | null {
  const items = ids.map((id) => doc.items[id]).filter((it) => it && !it.hidden);
  const b = docBounds(doc, items.map((it) => it.id));
  if (!items.length || !b) return null;
  const origin = { x: floor10(b.x), y: floor10(b.y) };
  const at = (p: Point) => ({ x: r(p.x - origin.x), y: r(p.y - origin.y) });
  const flat = (pts: Point[]) => pts.flatMap((p) => [p.x, p.y]);
  const prims: Prim[] = [];
  for (const it of items) {
    if (it.type === 'component') prims.push(...componentPrims(doc, it, at));
    else if (it.type === 'wire') {
      const style = { ...doc.settings.wire, ...it.style };
      const pts = wirePolyline(doc, it).map(at);
      if (pts.length > 1) prims.push({ t: 'line', pts: flat(pts), w: style.width, ...(style.dash !== 'solid' ? { dash: true } : {}) });
    } else if (it.type === 'junction') {
      const c = at(it);
      prims.push({ t: 'circle', cx: c.x, cy: c.y, r: doc.settings.junctionSize, fill: 'solid' });
    } else prims.push(...shapePrims(it, at));
  }
  return {
    prims,
    origin,
    w: ceil20(b.x + b.w - origin.x),
    h: ceil20(b.y + b.h - origin.y),
  };
}

function componentPrims(doc: CircuitDoc, c: ComponentItem, at: (p: Point) => Point): Prim[] {
  const def = getSymbol(doc, c.symbol);
  const T = (x: number, y: number) => at(toWorld(c, def, x, y));
  const mapPts = (pts: number[]) => {
    const out: number[] = [];
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const p = T(pts[i], pts[i + 1]);
      out.push(p.x, p.y);
    }
    return out;
  };
  const vertical = c.rot === 90 || c.rot === 270;
  const out: Prim[] = [];
  for (const p of def.prims) {
    switch (p.t) {
      case 'line':
      case 'poly':
        out.push({ ...p, pts: mapPts(p.pts) });
        break;
      case 'rect': {
        const a = T(p.x, p.y);
        const z = T(p.x + p.w, p.y + p.h);
        out.push({ ...p, x: Math.min(a.x, z.x), y: Math.min(a.y, z.y), w: Math.abs(z.x - a.x), h: Math.abs(z.y - a.y) });
        break;
      }
      case 'circle': {
        const m = T(p.cx, p.cy);
        out.push({ ...p, cx: m.x, cy: m.y });
        break;
      }
      case 'ellipse': {
        const m = T(p.cx, p.cy);
        out.push({ ...p, cx: m.x, cy: m.y, rx: vertical ? p.ry : p.rx, ry: vertical ? p.rx : p.ry });
        break;
      }
      case 'arc': {
        // drawn as a polyline so rotation and mirroring stay exact
        const steps = Math.max(8, Math.ceil(Math.abs(p.a2 - p.a1) / 10));
        const pts: number[] = [];
        for (let i = 0; i <= steps; i++) {
          const a = ((p.a1 + ((p.a2 - p.a1) * i) / steps) * Math.PI) / 180;
          pts.push(p.cx + p.r * Math.cos(a), p.cy + p.r * Math.sin(a));
        }
        out.push({ t: 'line', pts: mapPts(pts), w: p.w });
        break;
      }
      case 'path': {
        const d = mapPath(p.d, T);
        if (d) out.push({ ...p, d });
        break;
      }
      case 'text': {
        const m = T(p.x, p.y);
        out.push({ ...p, x: m.x, y: m.y });
        break;
      }
    }
  }
  return out;
}

/** Transforms an absolute SVG path made of M/L/Q/C/S/T/Z; anything else is dropped. */
function mapPath(d: string, T: (x: number, y: number) => Point): string | null {
  const parts = d.match(/[A-Za-z][^A-Za-z]*/g) ?? [];
  const out: string[] = [];
  for (const part of parts) {
    const cmd = part[0];
    if (!'MLQCSTZ'.includes(cmd)) return null;
    const n = part.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number);
    const mapped: number[] = [];
    for (let i = 0; i + 1 < n.length; i += 2) {
      const p = T(n[i], n[i + 1]);
      mapped.push(p.x, p.y);
    }
    out.push(`${cmd} ${mapped.join(' ')}`.trim());
  }
  return out.join(' ');
}

function shapePrims(s: ShapeItem, at: (p: Point) => Point): Prim[] {
  const a = at({ x: s.x, y: s.y });
  const z = at({ x: s.x + s.w, y: s.y + s.h });
  const x = Math.min(a.x, z.x);
  const y = Math.min(a.y, z.y);
  const w = Math.abs(z.x - a.x);
  const h = Math.abs(z.y - a.y);
  const fs = s.fontSize ?? 16;
  const textLines = (tx: number, ty: number, size: number) =>
    (s.text ?? '')
      .split('\n')
      .map((line, i): Prim => ({ t: 'text', x: tx, y: r(ty + size + i * size * 1.3), size, anchor: 'start', text: line }))
      .filter((p) => p.t === 'text' && p.text.trim());
  switch (s.kind) {
    case 'rect':
    case 'zone':
      return [{ t: 'rect', x, y, w, h, rx: s.radius || undefined, fill: 'none', sw: s.strokeWidth }, ...textLines(x + 8, y + 2, Math.min(fs, 14))];
    case 'ellipse':
      return [{ t: 'ellipse', cx: r(x + w / 2), cy: r(y + h / 2), rx: r(w / 2), ry: r(h / 2), fill: 'none', w: s.strokeWidth }];
    case 'line':
    case 'arrow': {
      const out: Prim[] = [{ t: 'line', pts: [a.x, a.y, z.x, z.y], w: s.strokeWidth, ...(s.dash !== 'solid' ? { dash: true } : {}) }];
      const head = (from: Point, to: Point) => {
        const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
        const ux = (to.x - from.x) / len;
        const uy = (to.y - from.y) / len;
        const size = s.headSize ?? 4 + s.strokeWidth * 3;
        const bx = to.x - ux * size;
        const by = to.y - uy * size;
        out.push({ t: 'poly', pts: [to.x, to.y, r(bx - uy * size * 0.45), r(by + ux * size * 0.45), r(bx + uy * size * 0.45), r(by - ux * size * 0.45)], fill: 'solid' });
      };
      const end = s.headEnd ?? (s.kind === 'arrow' ? 'filled' : 'none');
      if (end !== 'none') head(a, z);
      if ((s.headStart ?? 'none') !== 'none') head(z, a);
      return out;
    }
    case 'text':
      return textLines(a.x, a.y, fs);
  }
}

/**
 * Replaces the items with one instance of `def`, placed so the drawing sits
 * exactly where the selection was. Wires from outside that ended on the
 * selection and now end on one of the new pins are connected to it.
 */
export function replaceWithInstance(doc: CircuitDoc, ids: string[], def: SymbolDef, origin: Point): string {
  deleteItems(doc, ids.filter((id) => doc.items[id]));
  doc.symbols[def.id] = def;
  const comp = makeComponent(doc, def.id, origin.x + def.w / 2, origin.y + def.h / 2);
  doc.items[comp.id] = comp;
  const pins = def.ports.map((p) => ({ id: p.id, x: origin.x + p.x, y: origin.y + p.y }));
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire') continue;
    for (const end of ['a', 'b'] as const) {
      const ep = it[end];
      if (ep.kind !== 'free') continue;
      const pin = pins.find((p) => Math.abs(p.x - ep.x) < 0.5 && Math.abs(p.y - ep.y) < 0.5);
      if (pin) it[end] = { kind: 'port', comp: comp.id, port: pin.id };
    }
  }
  return comp.id;
}
