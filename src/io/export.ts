import { renderToStaticMarkup } from 'react-dom/server';
import { resolveConnector } from '../model/connectors';
import { createElement } from 'react';
import { Scene, computeSceneData, pagePalette, type Palette } from '../canvas/Scene';
import { docBounds, drawOrder, itemBounds, labelsShown, uid } from '../model/doc';
import { clipPolylineToRect, rectsIntersect, toWorld } from '../model/geometry';
import { fromShapeFrame, normDeg, shapeRot } from '../model/rotation';
import { instanceSymbol } from '../model/registry';
import { shapeText } from '../model/shapeText';
import { labelLayout } from '../model/labels';
import { PX_PER_MM, sheetRect } from '../model/sheet';
import { stripMath } from '../model/latex';
import { docPages, viewDoc, viewPage, viewSource } from '../model/pages';
import { pageCrossRefs } from '../model/pageRefs';
import type { CircuitDoc, Endpoint, Item, Point, Prim, Rect, ShapeItem, WireItem } from '../model/types';
import { endpointInfo, wirePolyline, wireStyle } from '../model/wires';
import { withoutFrames } from '../model/presentation';
import { shapeOutline } from '../model/path';

/** The editor's colours (styles/app.css) as plain values, so an export looks like the canvas in that theme; the light page is pure white rather than the canvas's warm off-white, since exports land on white pages. */
export const EXPORT_THEMES: Record<'light' | 'dark', Palette & { grid: string; danger: string }> = {
  light: { sym: '#1f1c16', symBg: '#ffffff', label: '#1f1c16', value: '#6b6355', bg: '#ffffff', selection: '#9a7429', ink: '#000000', grid: '#e6e8ee', danger: '#c4483c' },
  dark: { sym: '#e6dfcf', symBg: '#0f0e0c', label: '#ece6d8', value: '#9c9483', bg: '#0f0e0c', selection: '#d4af6a', ink: '#e6dfcf', grid: '#2a2722', danger: '#e5786d' },
};

export interface SvgOptions {
  theme: 'light' | 'dark';
  background: boolean;
  padding: number;
  ids?: string[];
  /** World-space rectangle to export (wires are cut at the boundary). */
  clip?: Rect;
  /** Keep symbol interiors filled with the theme's page colour even without a background (the picture lands on that colour anyway: paper, video frames). */
  opaqueSymbols?: boolean;
  /** Name in the file's <title>; the page's own name by default. */
  title?: string;
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
    const poly = wirePolyline(doc, it);
    const pieces = clipPolylineToRect(poly, rect);
    // a piece that still reaches the wire's own end keeps that end's pin or junction, so its dots are drawn
    const same = (p: Point, q: Point | undefined) => !!q && Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
    for (const run of pieces) {
      if (run.length < 2) continue;
      const id = uid('w');
      const first = run[0];
      const last = run[run.length - 1];
      items[id] = {
        id,
        type: 'wire',
        a: same(first, poly[0]) ? it.a : { kind: 'free', x: first.x, y: first.y },
        b: same(last, poly[poly.length - 1]) ? it.b : { kind: 'free', x: last.x, y: last.y },
        pts: run.slice(1, -1).map((p) => ({ x: p.x, y: p.y })),
        routing: 'straight',
        // a cut piece keeps the wire's place in the stack (without it, every cut wire would jump in front)
        ...(it.z !== undefined ? { z: it.z } : {}),
        ...(it.style ? { style: { ...it.style } } : {}),
        ...(it.label ? { label: it.label, ...(it.labelStyle ? { labelStyle: it.labelStyle } : {}) } : {}),
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

/** A page view's own name; the circuit's when it is a whole document (one page, or no page view). */
export function pageTitle(doc: CircuitDoc): string {
  const pages = docPages(doc);
  if (pages.length < 2 || !viewSource(doc)) return doc.name;
  return pages.find((p) => p.id === viewPage(doc))?.name.trim() || doc.name;
}

/** The world-space window an export covers: the drawing frame when it is on, else the items plus a margin (a selection crops to its items, an area to its rectangle). */
export function exportBox(doc: CircuitDoc, opts: SvgOptions): Rect {
  const p = opts.padding;
  if (opts.clip) return { x: opts.clip.x - p, y: opts.clip.y - p, w: opts.clip.w + 2 * p, h: opts.clip.h + 2 * p };
  const sheet = opts.ids?.length ? null : sheetRect(doc.settings);
  if (sheet) return { x: sheet.x, y: sheet.y, w: sheet.w, h: sheet.h };
  // extra margin so labels that overhang the item bounds are not cut off
  const b = docBounds(doc) ?? { x: 0, y: 0, w: 100, h: 100 };
  return { x: b.x - p - 30, y: b.y - p - 20, w: b.w + 2 * p + 60, h: b.h + 2 * p + 40 };
}

export function exportSvg(doc: CircuitDoc, opts: SvgOptions): { svg: string; bounds: Rect } {
  const palette = EXPORT_THEMES[opts.theme];
  const title = opts.title ?? pageTitle(doc);
  // cross-page references come from the whole document, before any clip or selection narrowing
  const xrefs = pageCrossRefs(viewSource(doc) ?? doc, viewPage(doc));
  // presentation frames are editor-only
  let d = withoutFrames(doc);
  if (opts.ids?.length) {
    d = selectionDoc(doc, opts.ids);
    // a selection is exported on its own, without the drawing frame
    d = { ...d, settings: { ...d.settings, titleBlock: false } };
  }
  if (opts.clip) d = clipAreaDoc(d, opts.clip);
  const box = exportBox(d, opts);
  const data = computeSceneData(d);
  // a document's own page colour wins over the theme for part interiors, labels and ink
  const page = pagePalette(d.settings, palette);
  // without a background, symbol interiors stay see-through: filled with the canvas colour they'd be dark (or white) blobs on whatever page they land on. Where such an interior sits over another item, a mask still erases that item behind it, so the picture is not more transparent than the canvas.
  const scenePalette = opts.background || opts.opaqueSymbols ? page : { ...page, symBg: 'none' };
  const knockout = !opts.background && !opts.opaqueSymbols;
  // DNP tags follow the page the parts sit on, not the theme: a light page exported in the dark theme keeps the light-page red
  const danger = page.ink === EXPORT_THEMES.light.ink ? EXPORT_THEMES.light.danger : page.ink === EXPORT_THEMES.dark.ink ? EXPORT_THEMES.dark.danger : palette.danger;
  const inner = renderToStaticMarkup(createElement(Scene, { doc: d, data, palette: scenePalette, xrefs, knockout, knockoutBox: box }));
  // the label rules of styles/app.css, which a standalone file doesn't have
  const css = `text{font-family:${FONT}}.sym-text{font-weight:500;stroke:none}.ref-label{font-size:11px;font-weight:650}.value-label{font-size:10.5px}.net-label{font-size:11px;font-weight:700}.wire-label{font-size:10px;font-weight:600}.dnp-tag{font-weight:700;fill:${danger}}.page-ref{font-weight:400;font-size:0.85em;opacity:.7}.comp.dnp>g:first-child{opacity:.45}`;
  // The page colour also becomes an attribute value (part interiors); a document's
  // own background is untrusted file data, so escape it like the page rect above.
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.ceil(box.w)}" height="${Math.ceil(box.h)}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}">
<title>${escapeXml(title)}</title>
<style>${css}</style>
${opts.background ? `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${escapeXml(d.settings.background || palette.bg)}"/>` : ''}
<g>${plainColours(inner.replace(/var\(--sym-bg\)/g, () => escapeXml(scenePalette.symBg)), page.ink)}</g>
</svg>`;
  return { svg, bounds: box };
}

/**
 * Resolves `currentColor` to the colour it stands for and drops CSS custom
 * properties, so the file looks the same outside a browser: many SVG tools
 * (Inkscape, Figma, image viewers) ignore a style holding `--sym-bg:…` or don't
 * support currentColor, and draw the parts black — invisible on a dark export.
 */
export function plainColours(markup: string, root: string): string {
  const stack: string[] = [root];
  return markup.replace(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g, (tag, close: string, name: string, attrs: string, self: string) => {
    if (close) {
      if (stack.length > 1) stack.pop();
      return tag;
    }
    const own = /style="(?:[^"]*?[;\s])?color:\s*([^;"]+)/.exec(attrs)?.[1] ?? /\scolor="([^"]+)"/.exec(attrs)?.[1];
    const colour = own && !/currentColor/i.test(own) ? own.trim() : stack[stack.length - 1];
    let a = attrs
      .replace(/currentColor/gi, colour)
      .replace(/style="([^"]*)"/, (_, css: string) => {
        // drop custom properties and the `color` declaration the text already inherits;
        // match declarations rather than splitting on `;`, since an escaped font name
        // (`&quot;Times New Roman&quot;`) contains semicolons of its own
        const kept = css
          .replace(/(^|;)\s*--[\w-]+\s*:[^;]*/g, '')
          .replace(/(^|;)\s*color\s*:[^;]*/g, '')
          // a leading separator is left when the first declaration goes; keep every other
          // semicolon, since `&quot;` and friends end in one
          .replace(/^;+/, '')
          .trim();
        return kept ? `style="${kept}"` : '';
      })
      .replace(/\s+color="[^"]*"/, '');
    if (a.trim() === '') a = '';
    if (!self) stack.push(colour);
    return `<${name}${a}${self}>`;
  });
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
  // black (the default ink) is ACI 7, which CAD shows as black or white to suit its background, not grey 8
  if (r < 48 && g < 48 && b < 48) return 7;
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
  const text = (layer: string, x: number, y: number, h: number, s: string, align: 'start' | 'middle' | 'end' = 'start', rot = 0, color?: number) => {
    g(0, 'TEXT');
    g(8, layer);
    // an explicit colour overrides the layer's (shape text keeps the colour chosen for it)
    if (color) g(62, color);
    g(10, x);
    g(20, Y(y));
    g(40, h);
    // a line break inside a group value would shift every code/value pair after it
    g(1, stripMath(s).replace(/\r?\n/g, ' '));
    if (rot) g(50, normDeg(-rot));
    if (align !== 'start') {
      g(72, align === 'middle' ? 1 : 2);
      g(11, x);
      g(21, Y(y));
    }
  };
  /** A shape's outline colour; a fill-only shape keeps its fill instead of turning white. */
  const shapeColour = (it: ShapeItem) => aciColor(it.stroke && it.stroke !== 'none' ? it.stroke : it.fill && it.fill !== 'none' ? it.fill : '#000000');
  const titleColour = (it: ShapeItem) => (it.textColor ? aciColor(it.textColor) : undefined);
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
          // placed and anchored as the canvas draws it (ComponentView): upright text, its anchor swapped when the part is turned round
          const w = toWorld(it, def, p.x, p.y - p.size * 0.35);
          let anchor = p.anchor;
          if (anchor !== 'middle' && (it.flipX ? it.rot !== 180 : it.rot === 180)) anchor = anchor === 'start' ? 'end' : 'start';
          if (it.rot === 90 || it.rot === 270) anchor = 'middle';
          text('COMPONENTS', w.x, w.y + p.size * 0.35, p.size * 0.8, p.text, anchor);
          continue;
        }
        for (const run of primPolylines(p)) {
          const pts: Point[] = [];
          for (let i = 0; i < run.pts.length; i += 2) pts.push(toWorld(it, def, run.pts[i], run.pts[i + 1]));
          poly('COMPONENTS', pts, run.closed, p.color ? aciColor(p.color) : undefined);
        }
      }
      // the labels' spots as drawn: around the turned/flipped bounds, at the chosen or dragged spot
      const shown = labelsShown(doc.settings, it, def);
      const at = labelLayout(it, def);
      if (shown.ref && it.ref && at.ref) text('LABELS', at.ref.x, at.ref.y, 9, it.ref, at.ref.anchor);
      if (shown.value && it.value && at.value) text('LABELS', at.value.x, at.value.y, 8, it.value, at.value.anchor);
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
        poly(layer, [{ x: it.x, y: it.y }, { x: it.x + it.w, y: it.y }, { x: it.x + it.w, y: it.y + it.h }, { x: it.x, y: it.y + it.h }].map(W), true, shapeColour(it));
        if (it.text) {
          it.text.split(/\r?\n/).forEach((l, i) => {
            const at = W({ x: it.x + 10, y: it.y + 18 + i * 13 });
            text(layer, at.x, at.y, 10, l, 'start', rot, titleColour(it));
          });
        }
      } else if (it.kind === 'ellipse') {
        const pts: Point[] = [];
        for (let i = 0; i < 48; i++) {
          const a = (i / 48) * Math.PI * 2;
          pts.push({ x: it.x + it.w / 2 + (it.w / 2) * Math.cos(a), y: it.y + it.h / 2 + (it.h / 2) * Math.sin(a) });
        }
        poly(layer, pts.map(W), true, shapeColour(it));
      } else if (it.kind === 'polygon') {
        // curves flattened; an open path stays open
        poly(layer, shapeOutline(it), !it.open, shapeColour(it));
      } else if (it.kind === 'line' || it.kind === 'arrow') {
        // the drawn path: bends, elbows and glued ends in, curves flattened
        poly(layer, resolveConnector(doc, it).flat, false, shapeColour(it));
      } else if (it.kind === 'text' && it.text) {
        shapeText(it).split(/\r?\n/).forEach((l, i) => {
          const at = W({ x: it.x, y: it.y + (it.fontSize ?? 16) * (i + 1) * 1.3 });
          text(layer, at.x, at.y, (it.fontSize ?? 16) * 0.75, l, 'start', rot, titleColour(it));
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

/**
 * One page drawn for paper. The page's own colour is ignored: paper is white whatever the
 * page is, and a dark page colour would turn the ink (see pagePalette) near-white on it.
 */
export function printPageSvg(view: CircuitDoc): string {
  const paper = { ...view, settings: { ...view.settings, background: '' } };
  return exportSvg(paper, { theme: 'light', background: false, padding: 20, opaqueSymbols: true }).svg;
}

/** Prints every page, one per sheet of paper (empty pages are skipped unless all are empty). */
export function printDoc(doc: CircuitDoc) {
  const views = docPages(doc).map((p) => viewDoc(doc, p.id));
  const pages = views.filter((v) => Object.keys(v.items).length);
  const host = document.createElement('div');
  host.id = 'print-host';
  host.innerHTML = (pages.length ? pages : views.slice(0, 1))
    .map((v) => printPageSvg(v).replace(/^<\?xml[^>]*>/, ''))
    .join('');
  for (const el of host.querySelectorAll('svg')) {
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
