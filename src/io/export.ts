import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { Scene, computeSceneData, type Palette } from '../canvas/Scene';
import { docBounds, drawOrder, itemBounds, uid } from '../model/doc';
import { clipPolylineToRect, rectsIntersect, toWorld } from '../model/geometry';
import { fromShapeFrame, normDeg, shapeRot } from '../model/rotation';
import { instanceSymbol } from '../model/registry';
import { shapeText } from '../model/shapeText';
import { PX_PER_MM, sheetRect } from '../model/sheet';
import { stripMath } from '../model/latex';
import type { CircuitDoc, Endpoint, Item, Point, Prim, Rect, WireItem } from '../model/types';
import { endpointInfo, wirePolyline, wireStyle } from '../model/wires';
import { withoutFrames } from '../model/presentation';
import { polyPoints } from '../model/polygon';

export const EXPORT_THEMES: Record<'light' | 'dark', Palette & { grid: string }> = {
  light: { sym: '#1f2433', symBg: '#ffffff', label: '#1f2433', value: '#5a6275', bg: '#ffffff', selection: '#3b82f6', ink: '#000000', grid: '#e6e8ee' },
  dark: { sym: '#e6dfcf', symBg: '#0f0e0c', label: '#ece6d8', value: '#a69f8f', bg: '#0f0e0c', selection: '#d4af6a', ink: '#e6dfcf', grid: '#2a2722' },
};

export interface SvgOptions {
  theme: 'light' | 'dark';
  background: boolean;
  padding: number;
  ids?: string[];
  /** World-space rectangle to export (wires are cut at the boundary). */
  clip?: Rect;
}

/** Builds a document reduced to a rectangular window; wires running out of it are split and cut. */
export function clipAreaDoc(doc: CircuitDoc, rect: Rect): CircuitDoc {
  const items: Record<string, Item> = {};
  for (const it of Object.values(doc.items)) {
    if (it.hidden) continue;
    const b = itemBounds(doc, it);
    if (!b || !rectsIntersect(rect, b)) continue;
    if (it.type !== 'wire') {
      items[it.id] = it;
      continue;
    }
    const pieces = clipPolylineToRect(wirePolyline(doc, it), rect);
    for (const run of pieces) {
      if (run.length < 2) continue;
      const id = uid('w');
      items[id] = {
        id,
        type: 'wire',
        a: { kind: 'free', x: run[0].x, y: run[0].y },
        b: { kind: 'free', x: run[run.length - 1].x, y: run[run.length - 1].y },
        pts: run.slice(1, -1).map((p) => ({ x: p.x, y: p.y })),
        routing: 'straight',
        ...(it.style ? { style: { ...it.style } } : {}),
        ...(it.label ? { label: it.label } : {}),
        ...(it.hopLayer ? { hopLayer: it.hopLayer } : {}),
      } as WireItem;
    }
  }
  return { ...doc, items };
}

function endpointOwnerId(ep: Endpoint): string | null {
  return ep.kind === 'port' ? ep.comp : ep.kind === 'junction' ? ep.id : null;
}

/**
 * Builds a document reduced to the given item ids. Wires that connect two kept
 * items are included even when not selected themselves (mirroring
 * extractFragment in ops.ts), and kept wires whose endpoint owner is outside
 * the selection are re-anchored as free ends at their current position so the
 * wire still renders instead of vanishing (wirePolyline returns [] when an
 * endpoint owner is missing).
 */
export function selectionDoc(doc: CircuitDoc, ids: string[]): CircuitDoc {
  const keep = new Set(ids);
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire' || keep.has(it.id)) continue;
    const oa = endpointOwnerId(it.a);
    const ob = endpointOwnerId(it.b);
    if ((!oa || keep.has(oa)) && (!ob || keep.has(ob)) && (oa || ob) && (keep.has(oa ?? '') || keep.has(ob ?? ''))) keep.add(it.id);
  }
  const items: Record<string, Item> = {};
  for (const [id, it] of Object.entries(doc.items)) {
    if (!keep.has(id)) continue;
    if (it.type !== 'wire') {
      items[id] = it;
      continue;
    }
    const c: WireItem = { ...it, pts: it.pts.map((p) => ({ ...p })) };
    let frozen: Point[] | null = null;
    for (const end of ['a', 'b'] as const) {
      const o = endpointOwnerId(c[end]);
      if (o && !keep.has(o)) {
        const info = endpointInfo(doc, c[end]);
        if (info) {
          if (!frozen) frozen = wirePolyline(doc, it).slice(1, -1);
          c[end] = { kind: 'free', x: info.pt.x, y: info.pt.y };
        }
      }
    }
    if (frozen) c.pts = frozen;
    items[id] = c;
  }
  return { ...doc, items };
}

const FONT = `'Inter', 'Segoe UI', system-ui, -apple-system, 'Noto Sans', sans-serif`;

export function exportSvg(doc: CircuitDoc, opts: SvgOptions): { svg: string; bounds: Rect } {
  const palette = EXPORT_THEMES[opts.theme];
  // presentation frames are editor-only
  let d = withoutFrames(doc);
  if (opts.ids?.length) {
    d = selectionDoc(doc, opts.ids);
    // a selection is exported on its own, without the drawing frame
    d = { ...d, settings: { ...d.settings, titleBlock: false } };
  }
  const p = opts.padding;
  let box: Rect;
  if (opts.clip) {
    const c = opts.clip;
    d = clipAreaDoc(d, c);
    box = { x: c.x - p, y: c.y - p, w: c.w + 2 * p, h: c.h + 2 * p };
  } else {
    const sheet = opts.ids?.length ? null : sheetRect(d.settings);
    if (sheet) {
      // with a drawing frame the page is exactly the sheet
      box = { x: sheet.x, y: sheet.y, w: sheet.w, h: sheet.h };
    } else {
      // extra margin so labels that overhang the item bounds are not cut off
      const b = docBounds(d) ?? { x: 0, y: 0, w: 100, h: 100 };
      box = { x: b.x - p - 30, y: b.y - p - 20, w: b.w + 2 * p + 60, h: b.h + 2 * p + 40 };
    }
  }
  const data = computeSceneData(d);
  const inner = renderToStaticMarkup(createElement(Scene, { doc: d, data, palette }));
  const css = `text{font-family:${FONT}}.ref-label{font-size:11px;font-weight:600}.value-label{font-size:10.5px}.net-label{font-size:11px;font-weight:700}.wire-label{font-size:10px;font-weight:600}.dnp-tag{font-weight:700;fill:#c4483c}.comp.dnp>g:first-child{opacity:.45}`;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(box.w)}" height="${Math.ceil(box.h)}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}">
<title>${escapeXml(doc.name)}</title>
<style>${css}</style>
${opts.background ? `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${palette.bg}"/>` : ''}
<g style="--sym-bg:${palette.symBg}">${inner.replace(/var\(--sym-bg\)/g, palette.symBg)}</g>
</svg>`;
  return { svg, bounds: box };
}

export async function exportPng(doc: CircuitDoc, opts: SvgOptions & { scale: number }): Promise<Blob> {
  const { svg, bounds } = exportSvg(doc, opts);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('Could not render image'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(bounds.w * opts.scale);
    canvas.height = Math.ceil(bounds.h * opts.scale);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(opts.scale, opts.scale);
    ctx.drawImage(img, 0, 0, bounds.w, bounds.h);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/* ------------------------------------------------------------------ */
/* DXF                                                                 */
/* ------------------------------------------------------------------ */

const ACI: [number, number, number, number][] = [
  [1, 255, 0, 0],
  [2, 255, 255, 0],
  [3, 0, 255, 0],
  [4, 0, 255, 255],
  [5, 0, 0, 255],
  [6, 255, 0, 255],
  [7, 255, 255, 255],
  [8, 128, 128, 128],
  [30, 255, 127, 0],
];

function aciColor(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 7;
  const n = parseInt(m[1], 16);
  const r = n >> 16,
    g = (n >> 8) & 255,
    b = n & 255;
  let best = 7,
    bd = Infinity;
  for (const [i, cr, cg, cb] of ACI) {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

function sampleArc(cx: number, cy: number, r: number, a1: number, a2: number, steps = 24): number[] {
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a1 + ((a2 - a1) * i) / steps) * Math.PI) / 180;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

function samplePath(d: string): number[][] {
  // Uses the browser's SVG engine to flatten arbitrary path data.
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  svg.style.position = 'absolute';
  svg.style.visibility = 'hidden';
  document.body.appendChild(svg);
  const runs: number[][] = [];
  try {
    for (const sub of d.split(/(?=[Mm])/)) {
      if (!sub.trim()) continue;
      path.setAttribute('d', sub);
      const len = path.getTotalLength();
      const steps = Math.max(2, Math.ceil(len / 2));
      const pts: number[] = [];
      for (let i = 0; i <= steps; i++) {
        const p = path.getPointAtLength((len * i) / steps);
        pts.push(p.x, p.y);
      }
      runs.push(pts);
    }
  } finally {
    svg.remove();
  }
  return runs;
}

function primPolylines(p: Prim): { pts: number[]; closed: boolean }[] {
  switch (p.t) {
    case 'line':
      return [{ pts: p.pts, closed: false }];
    case 'poly':
      return [{ pts: p.pts, closed: true }];
    case 'rect':
      return [{ pts: [p.x, p.y, p.x + p.w, p.y, p.x + p.w, p.y + p.h, p.x, p.y + p.h], closed: true }];
    case 'circle':
      return [{ pts: sampleArc(p.cx, p.cy, p.r, 0, 360, 36), closed: true }];
    case 'ellipse': {
      const pts: number[] = [];
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2;
        pts.push(p.cx + p.rx * Math.cos(a), p.cy + p.ry * Math.sin(a));
      }
      return [{ pts, closed: true }];
    }
    case 'arc':
      return [{ pts: sampleArc(p.cx, p.cy, p.r, p.a1, p.a2), closed: false }];
    case 'path':
      return samplePath(p.d).map((pts) => ({ pts, closed: false }));
    case 'text':
      return [];
  }
}

export function exportDxf(doc: CircuitDoc): string {
  const out: string[] = [];
  const g = (code: number, v: string | number) => out.push(String(code), typeof v === 'number' ? (+v.toFixed(4)).toString() : v);
  const Y = (y: number) => -y;
  const poly = (layer: string, pts: Point[], closed: boolean, color?: number) => {
    if (pts.length < 2) return;
    g(0, 'LWPOLYLINE');
    g(8, layer);
    if (color) g(62, color);
    g(90, pts.length);
    g(70, closed ? 1 : 0);
    for (const p of pts) {
      g(10, p.x);
      g(20, Y(p.y));
    }
  };
  /** `rot`: degrees clockwise on screen (DXF angles run counter-clockwise, with y flipped). */
  const text = (layer: string, x: number, y: number, h: number, s: string, align: 'start' | 'middle' | 'end' = 'start', rot = 0) => {
    g(0, 'TEXT');
    g(8, layer);
    g(10, x);
    g(20, Y(y));
    g(40, h);
    g(1, stripMath(s));
    if (rot) g(50, normDeg(-rot));
    if (align !== 'start') {
      g(72, align === 'middle' ? 1 : 2);
      g(11, x);
      g(21, Y(y));
    }
  };
  const layers = ['WIRES', 'COMPONENTS', 'LABELS', 'JUNCTIONS', 'ZONES', 'ANNOTATIONS'];
  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$INSUNITS');
  g(70, 4);
  g(0, 'ENDSEC');
  g(0, 'SECTION');
  g(2, 'TABLES');
  g(0, 'TABLE');
  g(2, 'LAYER');
  g(70, layers.length);
  layers.forEach((l, i) => {
    g(0, 'LAYER');
    g(2, l);
    g(70, 0);
    g(62, [3, 7, 2, 3, 5, 6][i]);
    g(6, 'CONTINUOUS');
  });
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION');
  g(2, 'ENTITIES');

  const data = computeSceneData(doc);
  // entities in the drawing's stacking order (back first), like the SVG export
  const rank = drawOrder(doc);
  for (const it of Object.values(doc.items).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)) {
    if (it.hidden || (it.type === 'shape' && it.kind === 'frame')) continue;
    if (it.type === 'wire') {
      poly('WIRES', data.polys.get(it.id) ?? [], false, aciColor(wireStyle(doc, it).color));
    } else if (it.type === 'component') {
      const def = instanceSymbol(doc, it);
      for (const p of def.prims) {
        if (p.t === 'text') {
          const w = toWorld(it, def, p.x, p.y);
          text('COMPONENTS', w.x, w.y, p.size * 0.8, p.text, p.anchor);
          continue;
        }
        for (const run of primPolylines(p)) {
          const pts: Point[] = [];
          for (let i = 0; i < run.pts.length; i += 2) pts.push(toWorld(it, def, run.pts[i], run.pts[i + 1]));
          poly('COMPONENTS', pts, run.closed, p.color ? aciColor(p.color) : undefined);
        }
      }
      const b = { x: it.x, y: it.y };
      if (it.showRef && !def.valueIsLabel) text('LABELS', b.x + def.w / 2 + 6, b.y - 4, 9, it.ref);
      if (it.showValue && it.value) text('LABELS', b.x + def.w / 2 + 6, b.y + 10, 8, it.value);
    } else if (it.type === 'junction') {
      if ((data.junctionDegree.get(it.id) ?? 0) >= 3) {
        g(0, 'CIRCLE');
        g(8, 'JUNCTIONS');
        g(10, it.x);
        g(20, Y(it.y));
        g(40, doc.settings.junctionSize);
      }
    } else if (it.type === 'shape') {
      const layer = it.kind === 'zone' || it.kind === 'rect' ? 'ZONES' : 'ANNOTATIONS';
      // turned shapes: points of their own frame are turned into the world
      const rot = shapeRot(it);
      const W = (p: Point) => fromShapeFrame(it, p);
      if (it.kind === 'rect' || it.kind === 'zone') {
        poly(layer, [{ x: it.x, y: it.y }, { x: it.x + it.w, y: it.y }, { x: it.x + it.w, y: it.y + it.h }, { x: it.x, y: it.y + it.h }].map(W), true, aciColor(it.stroke));
        if (it.text) {
          const at = W({ x: it.x + 10, y: it.y + 18 });
          text(layer, at.x, at.y, 10, it.text, 'start', rot);
        }
      } else if (it.kind === 'ellipse') {
        const pts: Point[] = [];
        for (let i = 0; i < 48; i++) {
          const a = (i / 48) * Math.PI * 2;
          pts.push({ x: it.x + it.w / 2 + (it.w / 2) * Math.cos(a), y: it.y + it.h / 2 + (it.h / 2) * Math.sin(a) });
        }
        poly(layer, pts.map(W), true, aciColor(it.stroke));
      } else if (it.kind === 'polygon') {
        poly(layer, polyPoints(it), true, aciColor(it.stroke));
      } else if (it.kind === 'line' || it.kind === 'arrow') {
        poly(layer, [{ x: it.x, y: it.y }, { x: it.x + it.w, y: it.y + it.h }], false, aciColor(it.stroke));
      } else if (it.kind === 'text' && it.text) {
        shapeText(it).split('\n').forEach((l, i) => {
          const at = W({ x: it.x, y: it.y + (it.fontSize ?? 16) * (i + 1) * 1.3 });
          text(layer, at.x, at.y, (it.fontSize ?? 16) * 0.75, l, 'start', rot);
        });
      }
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* Print                                                               */
/* ------------------------------------------------------------------ */

export function printDoc(doc: CircuitDoc) {
  const { svg } = exportSvg(doc, { theme: 'light', background: false, padding: 20 });
  const host = document.createElement('div');
  host.id = 'print-host';
  host.innerHTML = svg.replace(/^<\?xml[^>]*>/, '');
  const el = host.querySelector('svg');
  if (el) {
    el.removeAttribute('width');
    el.removeAttribute('height');
  }
  // with a drawing frame, print on that paper size and orientation, edge to edge
  const sheet = sheetRect(doc.settings);
  if (sheet) {
    const mm = (px: number) => (px / PX_PER_MM).toFixed(1);
    const page = document.createElement('style');
    page.textContent = `@page { size: ${mm(sheet.w)}mm ${mm(sheet.h)}mm; margin: 0 }`;
    host.appendChild(page);
  }
  document.body.appendChild(host);
  document.body.classList.add('printing');
  const done = () => {
    document.body.classList.remove('printing');
    host.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  setTimeout(() => {
    window.print();
    setTimeout(done, 1000);
  }, 50);
}
