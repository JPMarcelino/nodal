import { memo, useMemo } from 'react';
import { componentBounds, measureText, segmentIntersectsRect, sideVector, toWorld } from '../model/geometry';
import { drawOrder } from '../model/doc';
import { touchingPins } from '../model/netlist';
import { isDnp } from '../model/partFields';
import { getSymbol } from '../model/registry';
import type { CircuitDoc, ComponentItem, Dash, DocSettings, HeadKind, Point, Rect, ShapeItem, SymbolDef, WireItem } from '../model/types';
import { buildWirePath, hopLayerMap, hopsFromCrossings, portPosition, wireCrossings, wirePolyline, wireStyle, type Crossing, type Hop } from '../model/wires';
import { SheetFrame } from './SheetFrame';
import { RichText } from './RichText';
import { hasMath } from '../model/latex';
import { layoutRich, measureRich } from '../model/richText';
import { SymbolBody } from './SymbolGraphic';

export interface Palette {
  sym: string;
  symBg: string;
  label: string;
  value: string;
  bg: string;
  selection: string;
  /** What pure black (the default wire / shape colour) is drawn as; stays readable on dark canvases. */
  ink: string;
}

export const EDITOR_PALETTE: Palette = {
  sym: 'var(--sym)',
  symBg: 'var(--canvas)',
  label: 'var(--label)',
  value: 'var(--label-dim)',
  bg: 'var(--canvas)',
  selection: 'var(--accent)',
  ink: 'var(--ink)',
};

/** Maps pure black to the palette's ink colour; every other colour is left as chosen. */
export const inkColor = (c: string, p: Palette) => (/^#(000|000000)$/i.test(c) ? p.ink : c);

export const dashArray = (d: Dash, w: number) => (d === 'dashed' ? `${w * 4} ${w * 3}` : d === 'dotted' ? `0.01 ${w * 2.5}` : undefined);

const LABEL_SYMBOLS = /^$/;

/* ------------------------------------------------------------------ */
/* Derived scene data                                                  */
/* ------------------------------------------------------------------ */

export interface SceneData {
  polys: Map<string, Point[]>;
  hops: Map<string, Hop[]>;
  /** Every point where two wires cross without being connected. */
  crossings: Crossing[];
  /** Wire stacking layers (hopLayer) of the wires that set one. */
  layers: Map<string, number>;
  /** Number of wire ends at each port key "comp:port". */
  portDegree: Map<string, number>;
  junctionDegree: Map<string, number>;
  /** Pins ("comp:port") resting on another part's pin, which connects them. */
  touching: Set<string>;
}

export function useSceneData(doc: CircuitDoc): SceneData {
  return useMemo(() => computeSceneData(doc), [doc]);
}

export function computeSceneData(doc: CircuitDoc): SceneData {
  const polys = new Map<string, Point[]>();
  const portDegree = new Map<string, number>();
  const junctionDegree = new Map<string, number>();
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire') continue;
    if (!it.hidden) polys.set(it.id, wirePolyline(doc, it));
    for (const ep of [it.a, it.b]) {
      if (ep.kind === 'port') portDegree.set(`${ep.comp}:${ep.port}`, (portDegree.get(`${ep.comp}:${ep.port}`) ?? 0) + 1);
      if (ep.kind === 'junction') junctionDegree.set(ep.id, (junctionDegree.get(ep.id) ?? 0) + 1);
    }
  }
  // crossings are always found (they offer a hover menu); arcs only when hops are drawn
  const crossings = wireCrossings(polys);
  const layers = hopLayerMap(Object.values(doc.items));
  const hops = doc.settings.hops === 'none' ? new Map<string, Hop[]>() : hopsFromCrossings(crossings, doc.settings.hopSize, layers);
  const touching = new Set(touchingPins(doc).flat());
  return { polys, hops, crossings, layers, portDegree, junctionDegree, touching };
}

/* ------------------------------------------------------------------ */
/* Components                                                          */
/* ------------------------------------------------------------------ */

/** Offset of each label: the reference uses labelDx/Dy, the value its own offset or else the reference's. */
export const labelOffsets = (c: ComponentItem) => ({
  ref: { x: c.labelDx ?? 0, y: c.labelDy ?? 0 },
  value: { x: c.valueDx ?? c.labelDx ?? 0, y: c.valueDy ?? c.labelDy ?? 0 },
});

export function labelLayout(c: ComponentItem, def: SymbolDef) {
  const L = baseLabelLayout(c, def);
  const o = labelOffsets(c);
  const shift = <T extends { x: number; y: number } | null>(p: T, d: { x: number; y: number }): T => (p ? { ...p, x: p.x + d.x, y: p.y + d.y } : p);
  return { ...L, ref: shift(L.ref, o.ref), value: shift(L.value, o.value) };
}

/** Default label spots, before any dragging. */
function baseLabelLayout(c: ComponentItem, def: SymbolDef) {
  const b = componentBounds(c, def);
  const dx = 0;
  const dy = 0;
  if (def.valueIsLabel) {
    if (LABEL_SYMBOLS.test(def.id)) {
      // text sits inside the flag body, away from the connection point
      return { value: { x: b.x + b.w / 2 + dx, y: b.y + b.h / 2 + 4 + dy, anchor: 'middle' as const }, ref: null, inside: true };
    }
    const port = def.ports[0];
    const pd = port ? sideVector(c, port.side) : null;
    const dir = pd ? { x: -pd.x, y: -pd.y } : { x: 0, y: -1 };
    if (dir.y < 0) return { value: { x: c.x + dx, y: b.y - 4 + dy, anchor: 'middle' as const }, ref: null };
    if (dir.y > 0) return { value: { x: c.x + dx, y: b.y + b.h + 13 + dy, anchor: 'middle' as const }, ref: null };
    if (dir.x > 0) return { value: { x: b.x + b.w + 4 + dx, y: c.y + 4 + dy, anchor: 'start' as const }, ref: null };
    return { value: { x: b.x - 4 + dx, y: c.y + 4 + dy, anchor: 'end' as const }, ref: null };
  }
  const spots = labelCandidates(b, c);
  // dragged labels are offsets from this fixed spot (see frozenLabelOffsets)
  if (hasLabelOffsets(c)) return b.w >= b.h ? spots.split : spots.right;
  // otherwise use the first spot that keeps both labels off the wires leaving the pins
  const leads = def.ports.map((p) => {
    const at = toWorld(c, def, p.x, p.y);
    const v = sideVector(c, p.side);
    return [at, { x: at.x + v.x * LEAD_CLEARANCE, y: at.y + v.y * LEAD_CLEARANCE }] as const;
  });
  const hits = (spot: LabelSpot) =>
    labelRects(spot, c).reduce((n, r) => n + leads.filter(([a, z]) => segmentIntersectsRect(a, z, r)).length, 0);
  const sides = new Set(leads.map(([a, z]) => `${Math.sign(z.x - a.x)},${Math.sign(z.y - a.y)}`));
  const order: (keyof typeof spots)[] =
    sides.size === 4
      ? // chips with pins all round: keep the labels off the body, at a corner
        ['topRight', 'topLeft', 'bottomRight', 'split', 'right', 'left', 'above', 'below']
      : b.w >= b.h
      ? ['split', 'right', 'topRight', 'above', 'below', 'left', 'bottomRight', 'topLeft']
      : ['right', 'left', 'split', 'topRight', 'bottomRight', 'above', 'below', 'topLeft'];
  let best = spots[order[0]];
  let bestHits = Infinity;
  for (const k of order) {
    const n = hits(spots[k]);
    if (n < bestHits) [best, bestHits] = [spots[k], n];
    if (!n) break;
  }
  return best;
}

const hasLabelOffsets = (c: ComponentItem) => c.labelDx != null || c.labelDy != null || c.valueDx != null || c.valueDy != null;

/** Offsets that keep both labels exactly where they are drawn now; written when a label is first dragged. */
export function frozenLabelOffsets(c: ComponentItem, def: SymbolDef) {
  const o = labelOffsets(c);
  if (hasLabelOffsets(c) || def.valueIsLabel) return { labelDx: o.ref.x, labelDy: o.ref.y, valueDx: o.value.x, valueDy: o.value.y };
  const auto = baseLabelLayout(c, def);
  const b = componentBounds(c, def);
  const spots = labelCandidates(b, c);
  const fixed = b.w >= b.h ? spots.split : spots.right;
  const d = (p: { x: number; y: number } | null, q: LabelPos) => (p ? { x: p.x - q.x, y: p.y - q.y } : { x: 0, y: 0 });
  const r = d(auto.ref, fixed.ref);
  const v = d(auto.value, fixed.value);
  return { labelDx: r.x, labelDy: r.y, valueDx: v.x, valueDy: v.y };
}

/** How far out from a pin its wire is kept clear of labels. */
const LEAD_CLEARANCE = 30;

interface LabelPos {
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
}
interface LabelSpot {
  ref: LabelPos;
  value: LabelPos;
}

/** Spots the reference and value can take around a part's bounds. */
function labelCandidates(b: Rect, c: ComponentItem): Record<'split' | 'right' | 'left' | 'above' | 'below' | 'topRight' | 'bottomRight' | 'topLeft', LabelSpot> {
  const r = b.x + b.w + 6;
  const l = b.x - 6;
  const both = (x: number, y1: number, y2: number, anchor: LabelPos['anchor']): LabelSpot => ({ ref: { x, y: y1, anchor }, value: { x, y: y2, anchor } });
  return {
    split: { ref: { x: c.x, y: b.y - 5, anchor: 'middle' }, value: { x: c.x, y: b.y + b.h + 14, anchor: 'middle' } },
    right: both(r, c.y - 2, c.y + 12, 'start'),
    left: both(l, c.y - 2, c.y + 12, 'end'),
    above: both(c.x, b.y - 18, b.y - 5, 'middle'),
    below: both(c.x, b.y + b.h + 14, b.y + b.h + 27, 'middle'),
    topRight: both(b.x + b.w + 2, b.y - 18, b.y - 5, 'start'),
    bottomRight: both(b.x + b.w + 2, b.y + b.h + 14, b.y + b.h + 27, 'start'),
    topLeft: both(b.x - 2, b.y - 18, b.y - 5, 'end'),
  };
}

/** Approximate boxes of the visible labels at a spot. */
function labelRects(spot: LabelSpot, c: ComponentItem): Rect[] {
  const out: Rect[] = [];
  const box = (at: LabelPos, text: string, size: number) => {
    const m = measureRich(text, size, 600);
    const x = at.anchor === 'start' ? at.x : at.anchor === 'middle' ? at.x - m.w / 2 : at.x - m.w;
    out.push({ x, y: at.y - size, w: m.w, h: size * 1.25 });
  };
  if (c.showRef && c.ref) box(spot.ref, c.ref, 11);
  if (c.showValue && c.value) box(spot.value, c.value, 10.5);
  return out;
}

export const ComponentView = memo(function ComponentView({
  c,
  def,
  settings,
  palette,
  ghost,
}: {
  c: ComponentItem;
  def: SymbolDef;
  settings: DocSettings;
  palette: Palette;
  ghost?: boolean;
}) {
  const color = c.color || settings.componentColor || palette.sym;
  const tf = `translate(${c.x} ${c.y}) rotate(${c.rot}) scale(${c.flipX ? -1 : 1} 1) translate(${-def.w / 2} ${-def.h / 2})`;
  const labels = labelLayout(c, def);
  const labelColor = settings.labelColor || palette.label;
  const dnp = isDnp(c);
  return (
    <g className={`comp${ghost ? ' ghost' : ''}${dnp ? ' dnp' : ''}`} data-id={c.id} style={{ color, ['--sym-bg' as string]: palette.symBg }}>
      <g transform={tf}>
        <SymbolBody def={def} />
      </g>
      {def.prims.map((p, i) => {
        if (p.t !== 'text') return null;
        const w = toWorld(c, def, p.x, p.y - p.size * 0.35);
        let anchor = p.anchor;
        if (anchor !== 'middle' && (c.flipX ? c.rot !== 180 : c.rot === 180)) anchor = anchor === 'start' ? 'end' : 'start';
        if (c.rot === 90 || c.rot === 270) anchor = 'middle';
        return (
          <text key={i} x={w.x} y={w.y + p.size * 0.35} fontSize={p.size} textAnchor={anchor} fill="currentColor" className="sym-text">
            {p.text}
          </text>
        );
      })}
      {c.showRef && labels.ref && (
        <RichText text={c.ref} x={labels.ref.x} y={labels.ref.y} anchor={labels.ref.anchor} fontSize={11} className="ref-label" fill={labelColor} />
      )}
      {c.showValue && c.value && labels.value && (
        <RichText
          text={c.value}
          x={labels.value.x}
          y={labels.value.y}
          anchor={labels.value.anchor}
          fontSize={def.valueIsLabel ? 11 : 10.5}
          className={def.valueIsLabel ? 'net-label' : 'value-label'}
          fill={def.valueIsLabel ? color : settings.labelColor || palette.value}
        >
          {dnp && <tspan className="dnp-tag"> DNP</tspan>}
        </RichText>
      )}
    </g>
  );
});

/* ------------------------------------------------------------------ */
/* Wires                                                               */
/* ------------------------------------------------------------------ */

export const WireView = memo(function WireView({
  w,
  pts,
  hops,
  settings,
  palette,
  dim,
}: {
  w: WireItem;
  pts: Point[];
  hops: Hop[] | undefined;
  settings: DocSettings;
  palette: Palette;
  dim?: boolean;
}) {
  const st = { ...settings.wire, ...w.style };
  const color = inkColor(st.color, palette);
  const d = buildWirePath(pts, st.radius, hops, settings.hops, settings.hopSize);
  const mid = pts.length >= 2 ? midpoint(pts) : null;
  return (
    <g className="wire" data-id={w.id} opacity={dim ? 0.25 : 1}>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={st.width}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={dashArray(st.dash, st.width)}
      />
      {w.label && mid && (
        <RichText text={w.label} x={mid.x} y={mid.y - st.width - 3} anchor="middle" fontSize={10} className="wire-label" fill={color} />
      )}
    </g>
  );
});

function midpoint(pts: Point[]): Point {
  // midpoint of the longest segment reads best for labels
  let best = 0;
  let bi = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    if (l > best) {
      best = l;
      bi = i;
    }
  }
  return { x: (pts[bi].x + pts[bi + 1].x) / 2, y: (pts[bi].y + pts[bi + 1].y) / 2 };
}

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

/** Automatic arrowhead length for a stroke width. */
export const defaultHeadSize = (sw: number) => Math.max(10, Math.round(sw * 4));

/** Arrowhead half-width as a fraction of its length (~48° opening). */
const HEAD_SPREAD = 0.45;

/** How far a line should stop short of the tip so it doesn't show through the head. */
export function headInset(kind: HeadKind, size: number): number {
  return kind === 'filled' ? size * 0.6 : 0;
}

/** Renders one arrowhead at `tip`; (x, y) is the unit vector pointing into the tip. */
export function ArrowHeadEl({ tip, x, y, size, kind, color, sw }: { tip: Point; x: number; y: number; size: number; kind: HeadKind; color: string; sw: number }) {
  if (kind === 'none') return null;
  if (kind === 'circle') return <circle cx={tip.x} cy={tip.y} r={Math.max(1.5, size * 0.3)} fill={color} />;
  // perpendicular to the direction of travel
  const px = -y;
  const py = x;
  if (kind === 'bar') {
    const h = size * 0.5;
    return <path d={`M${tip.x + px * h},${tip.y + py * h}L${tip.x - px * h},${tip.y - py * h}`} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" />;
  }
  const w = size * HEAD_SPREAD;
  const bx = tip.x - x * size;
  const by = tip.y - y * size;
  const left = `${bx + px * w},${by + py * w}`;
  const right = `${bx - px * w},${by - py * w}`;
  if (kind === 'filled') {
    return <path d={`M${left}L${tip.x},${tip.y}L${right}Z`} fill={color} stroke={color} strokeWidth={Math.min(sw, 2)} strokeLinejoin="round" />;
  }
  return <path d={`M${left}L${tip.x},${tip.y}L${right}`} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />;
}

function shapeHeads(s: ShapeItem) {
  const len = Math.hypot(s.w, s.h);
  const ux = len ? s.w / len : 1;
  const uy = len ? s.h / len : 0;
  const size = s.headSize ?? defaultHeadSize(s.strokeWidth);
  return { ux, uy, size, endTip: { x: s.x + s.w, y: s.y + s.h }, startTip: { x: s.x, y: s.y } };
}

/** Shapes whose title can be dragged around. */
export const hasMovableTitle = (s: ShapeItem) => !!s.text && (s.kind === 'rect' || s.kind === 'zone' || s.kind === 'ellipse');

/** Where a shape's title text sits: anchor point (baseline) and its box. */
export function shapeTitle(s: ShapeItem): { x: number; y: number; anchor: 'start' | 'middle'; box: { x: number; y: number; w: number; h: number } } {
  const fs = s.fontSize ?? 13;
  const dx = s.textDx ?? 0;
  const dy = s.textDy ?? 0;
  const m = measureRich(s.text ?? '', fs, s.kind !== 'ellipse' && s.bold === false ? 400 : 600);
  if (s.kind === 'ellipse') {
    const x = s.x + s.w / 2 + dx;
    const y = s.y + s.h / 2 + 5 + dy;
    return { x, y, anchor: 'middle', box: { x: x - m.w / 2, y: y - fs, w: m.w, h: fs * 1.3 } };
  }
  const x = s.x + 10 + dx;
  const y = s.y + fs + 6 + dy;
  return { x, y, anchor: 'start', box: { x, y: y - fs, w: m.w, h: fs * 1.3 } };
}

/**
 * Clamps a title offset so the text stays inside the shape or just outside
 * it, near the edge (its centre at most ~2 font sizes beyond the outline).
 */
export function clampTitleOffset(s: ShapeItem, dx: number, dy: number): { dx: number; dy: number } {
  const t = shapeTitle({ ...s, textDx: dx, textDy: dy });
  const margin = Math.max(24, (s.fontSize ?? 13) * 2);
  const cx = t.box.x + t.box.w / 2;
  const cy = t.box.y + t.box.h / 2;
  const x0 = Math.min(s.x, s.x + s.w) - margin;
  const x1 = Math.max(s.x, s.x + s.w) + margin;
  const y0 = Math.min(s.y, s.y + s.h) - margin;
  const y1 = Math.max(s.y, s.y + s.h) + margin;
  return { dx: dx + Math.min(Math.max(cx, x0), x1) - cx, dy: dy + Math.min(Math.max(cy, y0), y1) - cy };
}

export const ShapeView = memo(function ShapeView({ s, palette }: { s: ShapeItem; palette: Palette }) {
  const da = dashArray(s.dash, s.strokeWidth || 1);
  const ink = inkColor(s.stroke, palette);
  const stroke = s.strokeWidth > 0 ? ink : 'none';
  const fill = s.fillOpacity > 0 ? inkColor(s.fill, palette) : 'none';
  const textColor = s.textColor ? inkColor(s.textColor, palette) : s.kind === 'text' ? palette.label : ink;
  switch (s.kind) {
    case 'rect':
    case 'zone':
      return (
        <g className="shape" data-id={s.id}>
          <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={s.radius} fill={fill} fillOpacity={s.fillOpacity} stroke={stroke} strokeWidth={s.strokeWidth} strokeDasharray={da} />
          {s.text && (
            <RichText text={s.text} x={shapeTitle(s).x} y={shapeTitle(s).y} fontSize={s.fontSize ?? 13} fill={textColor} fontWeight={s.bold === false ? 400 : 600} className="shape-title" />
          )}
        </g>
      );
    case 'ellipse':
      return (
        <g className="shape" data-id={s.id}>
          <ellipse cx={s.x + s.w / 2} cy={s.y + s.h / 2} rx={Math.abs(s.w / 2)} ry={Math.abs(s.h / 2)} fill={fill} fillOpacity={s.fillOpacity} stroke={stroke} strokeWidth={s.strokeWidth} strokeDasharray={da} />
          {s.text && (
            <RichText text={s.text} x={shapeTitle(s).x} y={shapeTitle(s).y} anchor="middle" fontSize={s.fontSize ?? 13} fill={textColor} fontWeight={600} />
          )}
        </g>
      );
    case 'image':
      return (
        <g className="shape" data-id={s.id}>
          <image href={s.src} x={Math.min(s.x, s.x + s.w)} y={Math.min(s.y, s.y + s.h)} width={Math.abs(s.w)} height={Math.abs(s.h)} preserveAspectRatio="none" />
          {s.strokeWidth > 0 && <rect x={s.x} y={s.y} width={s.w} height={s.h} fill="none" stroke={stroke} strokeWidth={s.strokeWidth} strokeDasharray={da} />}
        </g>
      );
    case 'line':
    case 'arrow': {
      const { ux, uy, size, endTip, startTip } = shapeHeads(s);
      const endKind: HeadKind = s.headEnd ?? (s.kind === 'arrow' ? 'open' : 'none');
      const startKind: HeadKind = s.headStart ?? 'none';
      const e = headInset(endKind, size);
      const st = headInset(startKind, size);
      return (
        <g className="shape" data-id={s.id}>
          <line x1={startTip.x + ux * st} y1={startTip.y + uy * st} x2={endTip.x - ux * e} y2={endTip.y - uy * e} stroke={ink} strokeWidth={s.strokeWidth} strokeDasharray={da} strokeLinecap="round" />
          <ArrowHeadEl tip={endTip} x={ux} y={uy} size={size} kind={endKind} color={ink} sw={s.strokeWidth} />
          <ArrowHeadEl tip={startTip} x={-ux} y={-uy} size={size} kind={startKind} color={ink} sw={s.strokeWidth} />
          {s.text && (
            <RichText text={s.text} x={s.x + s.w / 2} y={s.y + s.h / 2 - 6} anchor="middle" fontSize={s.fontSize ?? 13} fill={textColor} />
          )}
        </g>
      );
    }
    case 'text': {
      const fs = s.fontSize ?? 16;
      const lines = (s.text ?? '').split('\n');
      const m = measureRich(s.text ?? '', fs, s.bold ? 700 : 400);
      const first = hasMath(lines[0]) ? layoutRich(lines[0], fs, s.bold ? 700 : 400)[0].ascent : fs;
      return (
        <g className="shape" data-id={s.id}>
          {s.fillOpacity > 0 && <rect x={s.x - 6} y={s.y - 4} width={m.w + 12} height={m.h + 8} rx={4} fill={fill} fillOpacity={s.fillOpacity} />}
          <RichText text={s.text ?? ''} x={s.x} y={s.y + Math.max(fs, first)} fontSize={fs} fill={textColor} fontWeight={s.bold ? 700 : 400} className="free-text" />
        </g>
      );
    }
  }
});

export { measureText };

/* ------------------------------------------------------------------ */
/* Whole scene                                                         */
/* ------------------------------------------------------------------ */

export function Scene({ doc, data, palette, highlight }: { doc: CircuitDoc; data: SceneData; palette: Palette; highlight?: Set<string> | null }) {
  const items = Object.values(doc.items).filter((i) => !i.hidden);
  const shapes = items.filter((i): i is ShapeItem => i.type === 'shape').sort((a, b) => a.z - b.z);
  const below = shapes.filter((s) => s.layer === 'below');
  const above = shapes.filter((s) => s.layer === 'above');
  // front-to-back order from the layers panel (z, else creation order)
  const order = drawOrder(doc);
  const byOrder = (a: { id: string }, b: { id: string }) => order.get(a.id)! - order.get(b.id)!;
  const wires = items.filter((i): i is WireItem => i.type === 'wire').sort(byOrder);
  const comps = items.filter((i): i is ComponentItem => i.type === 'component').sort(byOrder);
  const dots: { x: number; y: number; color: string; key: string }[] = [];
  const js = doc.settings.junctionSize;
  for (const it of items) {
    if (it.type === 'junction' && (data.junctionDegree.get(it.id) ?? 0) >= 3) {
      const w = wires.find((w) => (w.a.kind === 'junction' && w.a.id === it.id) || (w.b.kind === 'junction' && w.b.id === it.id));
      dots.push({ x: it.x, y: it.y, color: w ? wireStyle(doc, w).color : doc.settings.wire.color, key: it.id });
    }
  }
  for (const [k, n] of data.portDegree) {
    if (n < 2) continue;
    const [comp, port] = k.split(':');
    const c = doc.items[comp];
    if (!c || c.type !== 'component') continue;
    const p = portPosition(doc, c, port);
    if (p) dots.push({ x: p.pt.x, y: p.pt.y, color: doc.settings.wire.color, key: k });
  }
  return (
    <>
      <SheetFrame doc={doc} ink={palette.sym} dim={palette.value} />
      <g className="layer-below">{below.map((s) => <ShapeView key={s.id} s={s} palette={palette} />)}</g>
      <g className="layer-wires">
        {wires.map((w) => (
          <WireView key={w.id} w={w} pts={data.polys.get(w.id) ?? []} hops={data.hops.get(w.id)} settings={doc.settings} palette={palette} dim={!!highlight && !highlight.has(w.id)} />
        ))}
      </g>
      <g className="layer-components">
        {comps.map((c) => (
          <ComponentView key={c.id} c={c} def={getSymbol(doc, c.symbol)} settings={doc.settings} palette={palette} />
        ))}
      </g>
      <g className="layer-dots">
        {dots.map((d) => (
          <circle key={d.key} cx={d.x} cy={d.y} r={js} fill={inkColor(d.color, palette)} />
        ))}
      </g>
      <g className="layer-above">{above.map((s) => <ShapeView key={s.id} s={s} palette={palette} />)}</g>
    </>
  );
}
