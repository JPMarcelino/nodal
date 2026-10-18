import type { SvgDrawing, SvgPolyline } from '../io/svgImport';
import { makeComponent, makeShape, uid } from './doc';
import { measureText, projectOnSegment } from './geometry';
import { groupItems } from './ops';
import { mapNodes, packPath } from './path';
import { packPoly } from './polygon';
import { boxPath, pathPolys, recognizeSymbols } from './svgSymbols';
import type { CircuitDoc, Endpoint, JunctionItem, Point, WireItem } from './types';
import { instanceSymbol } from './registry';
import { portPosition } from './wires';

/** How an imported SVG is turned into items. */
export interface SvgImportOptions {
  /** Open strokes: connected wires, or plain drawn lines. */
  strokes: 'wires' | 'lines';
  /** Closed outlines: polygon shapes (keeping their fill), or treated like the strokes. */
  closed: 'polygons' | 'strokes';
  /** Rectangles, circles and ellipses: rectangle / ellipse shapes, or treated like closed outlines. */
  boxes: 'shapes' | 'outlines';
  /** Replace drawings that exactly match a library symbol with that part. */
  symbols: boolean;
}

export const DEFAULT_SVG_IMPORT: SvgImportOptions = { strokes: 'wires', closed: 'strokes', boxes: 'shapes', symbols: false };

/** How close (canvas units) two points must be to count as connected. */
const EPS = 0.75;
const CELL = 16;

const key = (p: Point) => `${Math.round(p.x * 2) / 2},${Math.round(p.y * 2) / 2}`;
/** Near-black colours follow the theme's ink instead of staying literally black. */
const ink = (c: string) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  return !m || [m[1], m[2], m[3]].every((h) => parseInt(h, 16) < 48) ? '#000000' : c.toLowerCase();
};

/** Spatial hash of junction points, for fast "which junctions lie on this segment". */
class PointGrid {
  private cells = new Map<string, Point[]>();
  add(p: Point) {
    const k = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
    const list = this.cells.get(k);
    if (list) list.push(p);
    else this.cells.set(k, [p]);
  }
  near(a: Point, b: Point): Point[] {
    const out: Point[] = [];
    const x0 = Math.floor((Math.min(a.x, b.x) - EPS) / CELL), x1 = Math.floor((Math.max(a.x, b.x) + EPS) / CELL);
    const y0 = Math.floor((Math.min(a.y, b.y) - EPS) / CELL), y1 = Math.floor((Math.max(a.y, b.y) + EPS) / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) {
      for (const list of this.cells.values()) out.push(...list);
      return out;
    }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(...(this.cells.get(`${x},${y}`) ?? []));
    return out;
  }
}

/**
 * Adds an imported SVG drawing to the document as editable items: by default
 * strokes become straight-routed wires (split and joined by junctions wherever
 * they meet), plain rectangles / ellipses become shapes and text becomes text;
 * `opts` can make them lines and polygons instead, and turn drawings of
 * library symbols into parts (wired up at their pins). Everything is grouped
 * (when there is more than one item) and offset by `at`.
 */
export function insertSvgDrawing(doc: CircuitDoc, drawing: SvgDrawing, at: Point, scope?: string, name?: string, opts: SvgImportOptions = DEFAULT_SVG_IMPORT): string[] {
  const move = (p: Point): Point => ({ x: Math.round((p.x + at.x) * 100) / 100, y: Math.round((p.y + at.y) * 100) / 100 });
  const ids: string[] = [];
  const z0 = Math.max(0, ...Object.values(doc.items).map((i) => i.z ?? 0));

  // 0. parts: symbols found in the drawing replace the pieces that drew them
  const portAt = new Map<string, Endpoint>();
  if (opts.symbols) {
    const found = recognizeSymbols(doc, drawing);
    drawing = found.rest;
    const refs = new Set(Object.values(doc.items).flatMap((i) => (i.type === 'component' ? [i.ref] : [])));
    for (const p of found.parts) {
      const pos = move(p);
      const c = makeComponent(doc, p.symbol, pos.x, pos.y, p.rot, p.flipX);
      if (p.scale) c.scale = p.scale;
      // keep the drawing's reference unless the circuit already uses it
      if (p.ref && !refs.has(p.ref)) c.ref = p.ref;
      refs.add(c.ref);
      doc.items[c.id] = c;
      ids.push(c.id);
      for (const port of instanceSymbol(doc, c).ports) {
        const pos = portPosition(doc, c, port.id);
        if (pos && !portAt.has(key(pos.pt))) portAt.set(key(pos.pt), { kind: 'port', comp: c.id, port: port.id });
      }
    }
  }

  // closed outlines (and boxes treated as outlines) become polygons when asked
  const polygons: SvgPolyline[] = [];
  const asStrokes: SvgPolyline[] = [];
  const outlineOf = (b: SvgDrawing['boxes'][number]): SvgPolyline[] =>
    pathPolys(boxPath(b.kind, b.x, b.y, b.w, b.h, b.rx)).map((pts) => ({
      pts: pts.slice(0, -1),
      closed: true,
      width: b.strokeWidth || 1,
      color: b.stroke,
      dashed: b.dashed,
      fill: b.fill,
      fillOpacity: b.fillOpacity,
      stroked: b.strokeWidth > 0,
    }));
  const boxes = opts.boxes === 'shapes' ? drawing.boxes : [];
  for (const l of [...drawing.lines, ...(opts.boxes === 'outlines' ? drawing.boxes.flatMap(outlineOf) : [])]) {
    if (l.closed && l.pts.length >= 3 && opts.closed === 'polygons') polygons.push(l);
    else asStrokes.push(l);
  }
  const strokes = asStrokes.map((l) => ({ ...l, pts: l.pts.map(move) }));
  const lines = opts.strokes === 'wires' ? strokes : [];

  // 1. connection points: dots, shared line ends, and line ends landing on another line
  const junctionAt = new Map<string, Point>();
  const addJ = (p: Point) => {
    // a pin is a connection point already
    if (!junctionAt.has(key(p)) && !portAt.has(key(p))) junctionAt.set(key(p), p);
  };
  const dots = opts.strokes === 'wires' ? drawing.dots : [];
  for (const d of dots) addJ(move(d));
  const endCount = new Map<string, number>();
  for (const l of lines) {
    if (l.closed) continue;
    for (const p of [l.pts[0], l.pts[l.pts.length - 1]]) endCount.set(key(p), (endCount.get(key(p)) ?? 0) + 1);
  }
  for (const l of lines) {
    if (l.closed) continue;
    for (const p of [l.pts[0], l.pts[l.pts.length - 1]]) if ((endCount.get(key(p)) ?? 0) >= 2) addJ(p);
  }
  const ends = new PointGrid();
  for (const l of lines) if (!l.closed) [l.pts[0], l.pts[l.pts.length - 1]].forEach((p) => ends.add(p));
  for (const l of lines) {
    for (let i = 1; i < l.pts.length; i++) {
      for (const e of ends.near(l.pts[i - 1], l.pts[i])) {
        const pr = projectOnSegment(e, l.pts[i - 1], l.pts[i]);
        const atLineEnd = (i === 1 && pr.t === 0) || (i === l.pts.length - 1 && pr.t === 1);
        if (pr.d < EPS && !atLineEnd && !(l.pts[0] === e || l.pts[l.pts.length - 1] === e)) addJ(e);
      }
    }
  }
  const jGrid = new PointGrid();
  for (const p of junctionAt.values()) jGrid.add(p);

  // 2. split every line at the connection points it passes through
  const pieces: { pts: Point[]; style: (typeof lines)[number] }[] = [];
  for (const l of lines) {
    const seq: Point[] = [junctionAt.get(key(l.pts[0])) ?? l.pts[0]];
    for (let i = 1; i < l.pts.length; i++) {
      const a = l.pts[i - 1], b = l.pts[i];
      const hits = jGrid
        .near(a, b)
        .map((j) => ({ j, pr: projectOnSegment(j, a, b) }))
        .filter((h) => h.pr.d < EPS && h.pr.t > 0.001 && h.pr.t < 0.999)
        .sort((h1, h2) => h1.pr.t - h2.pr.t);
      for (const h of hits) seq.push(h.j);
      seq.push(junctionAt.get(key(b)) ?? b);
    }
    let cur: Point[] = [seq[0]];
    for (let i = 1; i < seq.length; i++) {
      const p = seq[i];
      const last = cur[cur.length - 1];
      if (Math.abs(p.x - last.x) < 0.01 && Math.abs(p.y - last.y) < 0.01) continue;
      cur.push(p);
      if (i < seq.length - 1 && junctionAt.has(key(p))) {
        pieces.push({ pts: cur, style: l });
        cur = [p];
      }
    }
    if (cur.length >= 2) pieces.push({ pts: cur, style: l });
  }

  // 3. build the items
  const junctionId = new Map<string, string>();
  const endpoint = (p: Point): Endpoint => {
    const k = key(p);
    const pin = portAt.get(k);
    if (pin) return pin;
    const j = junctionAt.get(k);
    if (!j) return { kind: 'free', x: p.x, y: p.y };
    let id = junctionId.get(k);
    if (!id) {
      const item: JunctionItem = { id: uid('j'), type: 'junction', x: j.x, y: j.y };
      doc.items[item.id] = item;
      ids.push(item.id);
      id = item.id;
      junctionId.set(k, id);
    }
    return { kind: 'junction', id };
  };
  for (const d of dots) endpoint(move(d));
  const defaults = doc.settings.wire;
  for (const { pts, style } of pieces) {
    const color = ink(style.color);
    const w: WireItem = {
      id: uid('w'),
      type: 'wire',
      a: endpoint(pts[0]),
      b: endpoint(pts[pts.length - 1]),
      pts: pts.slice(1, -1),
      routing: 'straight',
      style: {
        width: style.width,
        ...(color !== ink(defaults.color) ? { color } : {}),
        ...(style.dashed ? { dash: 'dashed' as const } : {}),
      },
    };
    doc.items[w.id] = w;
    ids.push(w.id);
  }
  const addShape = (s: ReturnType<typeof makeShape>) => {
    s.z = z0 + ids.length + 1;
    doc.items[s.id] = s;
    ids.push(s.id);
  };
  if (opts.strokes === 'lines') {
    // one line shape per segment (shapes are single segments)
    for (const l of strokes) {
      const pts = l.closed && l.pts.length > 2 ? [...l.pts, l.pts[0]] : l.pts;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const s = makeShape(doc, 'line', a.x, a.y, Math.round((b.x - a.x) * 100) / 100, Math.round((b.y - a.y) * 100) / 100);
        Object.assign(s, { stroke: ink(l.color), strokeWidth: l.width, dash: l.dashed ? 'dashed' : 'solid' });
        addShape(s);
      }
    }
    for (const d of drawing.dots) {
      const r = d.r ?? 2;
      const p = move(d);
      const s = makeShape(doc, 'ellipse', p.x - r, p.y - r, 2 * r, 2 * r);
      Object.assign(s, { strokeWidth: 0, fill: '#000000', fillOpacity: 1 });
      addShape(s);
    }
  }
  for (const l of polygons) {
    const s = makeShape(doc, 'polygon', 0, 0, 1, 1);
    const fill = l.fill && l.fill !== 'none' ? ink(l.fill) : 'none';
    // curved outlines keep their Béziers; straight ones their corners
    Object.assign(s, l.nodes ? packPath(mapNodes(l.nodes, move)) : packPoly(l.pts.map(move)), {
      stroke: ink(l.color),
      strokeWidth: l.stroked === false ? 0 : l.width,
      fill: fill === 'none' ? ink(l.color) : fill,
      fillOpacity: fill === 'none' ? 0 : (l.fillOpacity ?? 1),
      dash: l.dashed ? 'dashed' : 'solid',
    });
    addShape(s);
  }
  for (const b of boxes) {
    const p = move(b);
    const s = makeShape(doc, b.kind, p.x, p.y, b.w, b.h);
    Object.assign(s, {
      stroke: b.strokeWidth ? ink(b.stroke) : '#000000',
      strokeWidth: b.strokeWidth,
      fill: b.fill === 'none' ? 'none' : ink(b.fill),
      fillOpacity: b.fillOpacity,
      dash: b.dashed ? 'dashed' : 'solid',
      radius: b.kind === 'rect' ? b.rx : 0,
      z: z0 + ids.length + 1,
    });
    doc.items[s.id] = s;
    ids.push(s.id);
  }
  for (const t of drawing.texts) {
    const p = move(t);
    const m = measureText(t.text, t.size);
    const x = t.anchor === 'middle' ? p.x - m.w / 2 : t.anchor === 'end' ? p.x - m.w : p.x;
    const s = makeShape(doc, 'text', x, p.y - t.size, m.w, m.h);
    s.text = t.text;
    s.fontSize = t.size;
    if (ink(t.color) !== '#000000') s.textColor = ink(t.color);
    s.z = z0 + ids.length + 1;
    doc.items[s.id] = s;
    ids.push(s.id);
  }
  for (const id of ids) doc.items[id].group = scope;
  if (ids.length > 1) groupItems(doc, ids, scope, name);
  return ids;
}
