import { Fragment, memo, useMemo, useRef, type ReactNode } from 'react';
import { componentBounds, measureText, polylineBounds, segmentIntersectsRect, sideVector, toWorld } from '../model/geometry';
import { drawOrderCached, labelsShown } from '../model/doc';
import { refreshTouching, touchingCells, touchingFromCells } from '../model/netlist';
import { isDnp } from '../model/partFields';
import { instanceSymbol } from '../model/registry';
import type { CircuitDoc, ComponentItem, DocSettings, HeadKind, Item, LabelSpotName, LabelStyle, Point, Prim, Rect, ShapeItem, SymbolDef, WireItem } from '../model/types';
import { buildWirePath, wireLabelSpot, endpointInfo, hopLayerMap, hopsFromCrossings, portPosition, wireCrossings, wireCrossingsChanged, wirePolyline, wireStyle, wireStyleFor, type Crossing, type Hop } from '../model/wires';
import { SheetFrame } from './SheetFrame';
import { RichText } from './RichText';
import { hasMath } from '../model/latex';
import { layoutRich, measureRich, upperText } from '../model/richText';
import { dashArray } from '../model/dash';
import { FONT_STACKS } from '../model/fonts';
import { defaultAlign, defaultValign, hasHeader, headerHeight, lineCap, lineJoin, measureTextShape, shapeText, textFaceStyle, textSize, textWeight, titleWidth } from '../model/shapeText';
import { SymbolBody, PrimEl } from './SymbolGraphic';
import { calloutAnchor, calloutLayout, leaderPath } from '../model/callout';
import { inkCenterPath, inkOutline, inkPoints } from '../model/ink';
import { polyPath } from '../model/path';
import { connectorD, isConnector, resolveConnector, type ConnectorPath } from '../model/connectors';
import { rotateDeg, shapeBox, shapeTransform } from '../model/rotation';
import { gradientLine } from '../model/style';

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

/** Shape fills in either theme's page colour (preset shapes start that way) follow the page, like symbol interiors do. */
const pageFill = (c: string, p: Palette) => (/^#(0f0e0c|fffdf9)$/i.test(c) ? p.symBg : inkColor(c, p));

export { dashArray };

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
  /** Pin positions by cell, backing incremental touching updates. */
  touchCells: Map<string, string[]>;
}

export function useSceneData(doc: CircuitDoc): SceneData {
  const ref = useRef<{ doc: CircuitDoc; data: SceneData } | null>(null);
  const prev = ref.current;
  if (prev && prev.doc === doc) return prev.data;
  const data = prev ? updateSceneData(prev.doc, prev.data, doc) : computeSceneData(doc);
  ref.current = { doc, data };
  return data;
}

export function updateSceneData(prevDoc: CircuitDoc, prev: SceneData, doc: CircuitDoc): SceneData {
  if (prevDoc === doc) return prev;
  if (prevDoc.settings !== doc.settings || prevDoc.symbols !== doc.symbols) return computeSceneData(doc);
  const before = prevDoc.items;
  const items = doc.items;
  let wiresSame = true;
  let polysSame = true;
  const polys = new Map<string, Point[]>();
  const changed = new Set<string>();
  const moved = new Set<string>();
  for (const id of Object.keys(items)) {
    const it = items[id];
    const was = before[id];
    if (was !== it) {
      if (it.type === 'wire' || was?.type === 'wire') {
        wiresSame = false;
        changed.add(id);
      }
      if (it.type === 'component' || was?.type === 'component') moved.add(id);
    }
    if (it.type !== 'wire' || it.hidden) continue;
    let pts: Point[] | undefined;
    if (was === it) {
      let stable = true;
      for (const ep of [it.a, it.b]) {
        if (ep.kind !== 'port' && ep.kind !== 'junction') continue;
        if (before[ep.kind === 'port' ? ep.comp : ep.id] === items[ep.kind === 'port' ? ep.comp : ep.id]) continue;
        const p0 = endpointInfo(prevDoc, ep);
        const p1 = endpointInfo(doc, ep);
        if (!p0 || !p1 || p0.pt.x !== p1.pt.x || p0.pt.y !== p1.pt.y || p0.dir.x !== p1.dir.x || p0.dir.y !== p1.dir.y) {
          stable = false;
          break;
        }
      }
      if (stable) pts = prev.polys.get(id);
    }
    if (!pts) {
      pts = wirePolyline(doc, it);
      polysSame = false;
      changed.add(id);
    }
    polys.set(id, pts);
  }
  if (!wiresSame || moved.size > 0 || Object.keys(items).length !== Object.keys(before).length) {
    for (const id of Object.keys(before)) {
      if (items[id] !== undefined) continue;
      const gone = before[id];
      if (gone.type === 'wire') {
        wiresSame = false;
        changed.add(id);
      } else if (gone.type === 'component') moved.add(id);
    }
  }
  if (polys.size !== prev.polys.size) polysSame = false;
  let portDegree = prev.portDegree;
  let junctionDegree = prev.junctionDegree;
  if (!wiresSame) {
    portDegree = new Map<string, number>();
    junctionDegree = new Map<string, number>();
    for (const it of Object.values(items)) {
      if (it.type !== 'wire') continue;
      for (const ep of [it.a, it.b]) {
        if (ep.kind === 'port') portDegree.set(`${ep.comp}:${ep.port}`, (portDegree.get(`${ep.comp}:${ep.port}`) ?? 0) + 1);
        if (ep.kind === 'junction') junctionDegree.set(ep.id, (junctionDegree.get(ep.id) ?? 0) + 1);
      }
    }
  }
  const layers = wiresSame ? prev.layers : hopLayerMap(Object.values(items));
  const crossings = polysSame
    ? prev.crossings
    : [...prev.crossings.filter((c) => !changed.has(c.a.wire) && !changed.has(c.b.wire)), ...wireCrossingsChanged(polys, changed)];
  const hops = polysSame ? prev.hops : doc.settings.hops === 'none' ? new Map<string, Hop[]>() : hopsFromCrossings(crossings, doc.settings.hopSize, layers);
  const touch = refreshTouching(prevDoc, prev.touchCells, prev.touching, doc, moved);
  if (wiresSame && polysSame && touch.same) return prev;
  return { polys, hops, crossings, layers, portDegree, junctionDegree, touching: touch.touching, touchCells: touch.cells };
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
  const touchCells = touchingCells(doc);
  const touching = touchingFromCells(touchCells);
  return { polys, hops, crossings, layers, portDegree, junctionDegree, touching, touchCells };
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
  if (c.labelSpot && spots[c.labelSpot]) return spots[c.labelSpot];
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
  if (hasLabelOffsets(c) || def.valueIsLabel || c.labelSpot) return { labelDx: o.ref.x, labelDy: o.ref.y, valueDx: o.value.x, valueDy: o.value.y };
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
function labelCandidates(b: Rect, c: ComponentItem): Record<LabelSpotName, LabelSpot> {
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
    bottomLeft: both(b.x - 2, b.y + b.h + 14, b.y + b.h + 27, 'end'),
  };
}

/** Approximate boxes of the visible labels at a spot. */
function labelRects(spot: LabelSpot, c: ComponentItem): Rect[] {
  const out: Rect[] = [];
  for (const which of ['ref', 'value'] as const) {
    if (!(which === 'ref' ? c.showRef && c.ref : c.showValue && c.value)) continue;
    const look = labelLook(c, which);
    out.push(labelBox(spot[which], look));
  }
  return out;
}

/** Text, size, weight and style a part label is drawn with. */
export function labelLook(c: ComponentItem, which: 'ref' | 'value', def?: Pick<SymbolDef, 'valueIsLabel'>) {
  const st: LabelStyle = (which === 'ref' ? c.refStyle : c.valueStyle) ?? {};
  const raw = which === 'ref' ? c.ref : c.value;
  let text = raw ? `${st.prefix ?? ''}${raw}${st.suffix ?? ''}` : raw;
  if (st.allCaps) text = upperText(text);
  const netName = which === 'value' && !!def?.valueIsLabel;
  const size = st.size ?? (which === 'ref' || netName ? 11 : 10.5);
  const normal = which === 'ref' ? 650 : netName ? 700 : 400;
  const weight = st.bold === undefined ? normal : st.bold ? 700 : 400;
  return { st, text, size, weight };
}
export type LabelLook = ReturnType<typeof labelLook>;

/** Inline text style of a label (the label classes' CSS would otherwise override size and weight). */
const labelFace = (st: LabelStyle, size: number, weight: number) => ({
  fontSize: size,
  fontWeight: weight,
  fontStyle: st.italic ? ('italic' as const) : undefined,
  textDecoration: st.underline ? 'underline' : undefined,
  fontFamily: st.font ? FONT_STACKS[st.font] : undefined,
});

/** Text, size, weight and style a wire's net label is drawn with. */
export function wireLabelLook(w: Pick<WireItem, 'label' | 'labelStyle'>) {
  const st: LabelStyle = w.labelStyle ?? {};
  const raw = w.label ?? '';
  const text = st.allCaps ? upperText(raw) : raw;
  const size = st.size ?? 10;
  const weight = st.bold === undefined ? 600 : st.bold ? 700 : 400;
  return { st, text, size, weight };
}

/** Where a wire label is drawn: its spot, moved off the wire to make room for a larger size. */
export function wireLabelAt(w: WireItem, pts: Point[], width: number) {
  const spot = wireLabelSpot(w, pts, width);
  const grow = (w.labelStyle?.size ?? 10) - 10;
  if (!spot || !grow) return spot;
  if (spot.side === 'below') return { ...spot, y: spot.y + grow };
  if (spot.side === 'left' || spot.side === 'right') return { ...spot, y: spot.y + grow * 0.35 };
  return spot;
}

/** Approximate unrotated box of a label's text at its anchor. */
export function labelBox(at: LabelPos, look: LabelLook): Rect {
  const m = measureRich(look.text, look.size, look.weight);
  const anchor = look.st.align ?? at.anchor;
  const x = anchor === 'start' ? at.x : anchor === 'middle' ? at.x - m.w / 2 : at.x - m.w;
  return { x, y: at.y - look.size, w: m.w, h: Math.max(look.size * 1.3, m.h) };
}


/** World boxes of a part's shown name and value text (turned text: the box around it), e.g. for alignment guides. */
export function partLabelRects(doc: CircuitDoc, c: ComponentItem): { which: 'ref' | 'value'; rect: Rect }[] {
  const def = instanceSymbol(doc, c);
  const L = labelLayout(c, def);
  const shown = labelsShown(doc.settings, c, def);
  const out: { which: 'ref' | 'value'; rect: Rect }[] = [];
  for (const which of ['ref', 'value'] as const) {
    const at = L[which];
    if (!at || !shown[which] || !c[which]) continue;
    const look = labelLook(c, which, def);
    const b = labelBox(at, look);
    const deg = look.st.rotate ?? 0;
    if (!deg) {
      out.push({ which, rect: b });
      continue;
    }
    // text turns about its anchor
    const pts = [
      { x: b.x, y: b.y },
      { x: b.x + b.w, y: b.y },
      { x: b.x + b.w, y: b.y + b.h },
      { x: b.x, y: b.y + b.h },
    ].map((p) => rotateDeg(p, deg, at));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    out.push({ which, rect: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } });
  }
  return out;
}

function PartLabel({ at, look, fill, bg, className, children }: { at: LabelPos; look: LabelLook; fill: string; bg: string; className: string; children?: ReactNode }) {
  const { st, text, size, weight } = look;
  const box = st.backdrop ? labelBox(at, look) : null;
  return (
    <g transform={st.rotate ? `rotate(${st.rotate} ${at.x} ${at.y})` : undefined} opacity={st.opacity}>
      {box && <rect x={box.x - 2} y={box.y - 1} width={box.w + 4} height={box.h + 1} rx={2} fill={bg} />}
      <RichText
        text={text}
        x={at.x}
        y={at.y}
        anchor={st.align ?? at.anchor}
        fontSize={size}
        fontWeight={weight}
        className={className}
        fill={fill}
        style={labelFace(st, size, weight)}
      >
        {children}
      </RichText>
    </g>
  );
}

export const ComponentView = memo(function ComponentView({
  c,
  def,
  settings,
  palette,
  ghost,
  xref,
  knockout,
}: {
  c: ComponentItem;
  def: SymbolDef;
  settings: DocSettings;
  palette: Palette;
  ghost?: boolean;
  /** Cross-page reference ("[2, 3]"), shown after the value when it is drawn. */
  xref?: string;
  /** See-through export: label backdrops erase what is behind them with a mask instead of painting the page colour. */
  knockout?: boolean;
}) {
  const shown = labelsShown(settings, c, def);
  if (shown.ref !== c.showRef || shown.value !== c.showValue) c = { ...c, showRef: shown.ref, showValue: shown.value };
  const color = c.color || settings.componentColor || palette.sym;
  const tf = `translate(${c.x} ${c.y}) rotate(${c.rot}) scale(${c.flipX ? -1 : 1} 1) translate(${-def.w / 2} ${-def.h / 2})`;
  const labels = labelLayout(c, def);
  const labelColor = c.labelColor || settings.labelColor || palette.label;
  const lw = c.lineWidth ?? 2;
  const look = useMemo(() => ({ sw: lw, k: lw / 2, fill: c.fill, fillOpacity: c.fillOpacity }), [lw, c.fill, c.fillOpacity]);
  const dnp = isDnp(c);
  return (
    <g className={`comp${ghost ? ' ghost' : ''}${dnp ? ' dnp' : ''}`} data-id={c.id} style={{ color, ['--sym-bg' as string]: palette.symBg }}>
      <g transform={tf} strokeDasharray={dashArray(c.dash, lw, true)}>
        <SymbolBody def={def} look={look} />
      </g>
      {def.prims.map((p, i) => {
        if (p.t !== 'text') return null;
        const w = toWorld(c, def, p.x, p.y - p.size * 0.35);
        let anchor = p.anchor;
        if (anchor !== 'middle' && (c.flipX ? c.rot !== 180 : c.rot === 180)) anchor = anchor === 'start' ? 'end' : 'start';
        if (c.rot === 90 || c.rot === 270) anchor = 'middle';
        return (
          <text key={i} x={w.x} y={w.y + p.size * 0.35} fontSize={p.size} textAnchor={anchor} fill={p.color ?? 'currentColor'} className="sym-text">
            {p.text}
          </text>
        );
      })}
      {c.showRef && labels.ref && (
        <PartLabel at={labels.ref} look={labelLook(c, 'ref', def)} className="ref-label" fill={c.refStyle?.color || labelColor} bg={knockout ? 'none' : palette.bg} />
      )}
      {c.showValue && c.value && labels.value && (
        <PartLabel
          at={labels.value}
          look={labelLook(c, 'value', def)}
          className={def.valueIsLabel ? 'net-label' : 'value-label'}
          fill={c.valueStyle?.color || (def.valueIsLabel ? color : settings.labelColor || palette.value)}
          bg={knockout ? 'none' : palette.bg}
        >
          {dnp && <tspan className="dnp-tag"> DNP</tspan>}
          {xref && <tspan className="page-ref"> {xref}</tspan>}
        </PartLabel>
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
  const st = wireStyleFor(settings, w);
  const color = inkColor(st.color, palette);
  const d = buildWirePath(pts, st.radius, hops, settings.hops, settings.hopSize);
  const spot = w.label && !w.labelHidden && !settings.hideWireLabels ? wireLabelAt(w, pts, st.width) : null;
  const look = spot ? wireLabelLook(w) : null;
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
      {spot && look && (
        <RichText text={look.text} x={spot.x} y={spot.y} anchor={spot.anchor} fontSize={look.size} fontWeight={look.weight} className="wire-label" fill={look.st.color || color} style={labelFace(look.st, look.size, look.weight)} />
      )}
    </g>
  );
});

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


/** Shapes whose title can be dragged around. */
export const hasMovableTitle = (s: ShapeItem) => !!s.text && (s.kind === 'rect' || s.kind === 'zone' || s.kind === 'ellipse' || s.kind === 'polygon');

/** Where a shape's title text sits: anchor point (baseline of the first line), its alignment and its box. */
export function shapeTitle(s: ShapeItem): { x: number; y: number; anchor: 'start' | 'middle' | 'end'; box: { x: number; y: number; w: number; h: number } } {
  const fs = s.fontSize ?? 13;
  const m = measureRich(shapeText(s), fs, textWeight(s), s.font);
  const round = s.kind === 'ellipse' || s.kind === 'polygon';
  const anchor = s.align ?? defaultAlign(s);
  const valign = hasHeader(s) ? 'top' : (s.valign ?? defaultValign(s));
  const bx = Math.min(s.x, s.x + s.w);
  const by = Math.min(s.y, s.y + s.h);
  const bw = Math.abs(s.w);
  const bh = Math.abs(s.h);
  // the room for the text: the padded box, or the part of a round shape that fits inside
  const left = round ? bx + bw / 2 - titleWidth(s) / 2 : bx + 10;
  const right = round ? bx + bw / 2 + titleWidth(s) / 2 : bx + bw - 10;
  const h = Math.max(fs * 1.3, m.h);
  // in a header band the title is centred vertically in the band
  const top = hasHeader(s) ? by + (headerHeight(s) - h) / 2 : valign === 'top' ? by + 6 : valign === 'bottom' ? by + bh - 6 - h : by + bh / 2 - h / 2;
  const x = (anchor === 'start' ? left : anchor === 'end' ? right : (left + right) / 2) + (s.textDx ?? 0);
  const y = top + fs + (s.textDy ?? 0);
  return { x, y, anchor, box: { x: anchor === 'start' ? x : anchor === 'end' ? x - m.w : x - m.w / 2, y: y - fs, w: m.w, h } };
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

/** Name tag of a presentation frame, sitting on its top-left corner. */
export function frameTag(s: ShapeItem): { x: number; y: number; w: number; h: number; label: string; fs: number } {
  const fs = s.fontSize ?? 13;
  const label = `${s.step ?? ''}${s.text ? `  ${s.text.split('\n')[0]}` : '  Frame'}`.trim();
  const m = measureRich(label, fs, 600);
  const h = fs + 10;
  return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h) - h - 4, w: m.w + 16, h, label, fs };
}

/** Kinds the shadow applies to (it needs an area or a stroke to cast from). */
export const SHADOW_KINDS: ReadonlySet<ShapeItem['kind']> = new Set(['rect', 'zone', 'ellipse', 'polygon', 'line', 'arrow', 'text', 'image']);

const SHADOW_ID = 'nodal-shadow';
const gradId = (id: string) => `nodal-grad-${id.replace(/[^\w-]/g, '_')}`;
const hasGradient = (s: ShapeItem) => !!s.gradient && s.fill !== 'none' && s.fillOpacity > 0 && (s.kind === 'rect' || s.kind === 'zone' || s.kind === 'ellipse' || s.kind === 'polygon');
const hasShadow = (s: ShapeItem) => !!s.shadow && SHADOW_KINDS.has(s.kind);

/** `<defs>` for the gradients and the shadow filter the shapes use (ids derive from the shape's id). */
function ShapeDefs({ shapes, palette }: { shapes: ShapeItem[]; palette: Palette }) {
  const grads = shapes.filter(hasGradient);
  const shadow = shapes.some(hasShadow);
  if (!grads.length && !shadow) return null;
  return (
    <defs>
      {shadow && (
        <filter id={SHADOW_ID} x="-30%" y="-30%" width="170%" height="180%">
          <feDropShadow dx={2} dy={3} stdDeviation={3} floodColor="#000000" floodOpacity={0.35} />
        </filter>
      )}
      {grads.map((s) => {
        // user-space endpoints (in the shape's own, unturned frame): the angle stays true on a box that is not square
        const g = gradientLine(shapeBox(s), s.gradient!.angle);
        return (
          <linearGradient key={s.id} id={gradId(s.id)} gradientUnits="userSpaceOnUse" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}>
            <stop offset="0" stopColor={inkColor(s.fill, palette)} />
            <stop offset="1" stopColor={inkColor(s.gradient!.to, palette)} />
          </linearGradient>
        );
      })}
    </defs>
  );
}

/**
 * One shape. Lines and arrows take their resolved `path` (glued ends where
 * their targets are now; see model/connectors.ts); without it they are drawn
 * from their own stored points.
 */
export const ShapeView = memo(function ShapeView({ s, palette, ax, ay, path }: { s: ShapeItem; palette: Palette; ax?: number; ay?: number; path?: ConnectorPath }) {
  // a turned shape is drawn in its own frame, title and all
  const tf = shapeTransform(s);
  const conn = isConnector(s) ? path ?? resolveConnector(null, s) : null;
  const body = shapeBody(s, palette, ax, ay, conn);
  const turned = tf ? <g transform={tf}>{body}</g> : body;
  const shadow = hasShadow(s);
  if (!shadow && (s.opacity === undefined || s.opacity >= 1)) return turned;
  // opacity and shadow act on the finished shape, outside its turn (so the shadow keeps falling the same way)
  const flat = shadow && conn ? polylineBounds(conn.flat) : null;
  return (
    <g opacity={s.opacity} filter={shadow ? `url(#${SHADOW_ID})` : undefined}>
      {/* a straight line has no area to size the filter by */}
      {flat && <rect x={flat.x - 10} y={flat.y - 10} width={flat.w + 20} height={flat.h + 20} fill="none" stroke="none" />}
      {turned}
    </g>
  );
});

/** A container's header strip: the line colour at low opacity under the title, with a rule below it. */
function HeaderBand({ s, ink }: { s: ShapeItem; ink: string }) {
  const hh = Math.min(headerHeight(s), s.h);
  const r = Math.max(0, Math.min(s.radius, hh, s.w / 2));
  const d = `M${s.x} ${s.y + hh}V${s.y + r}${r ? `A${r} ${r} 0 0 1 ${s.x + r} ${s.y}` : ''}H${s.x + s.w - r}${r ? `A${r} ${r} 0 0 1 ${s.x + s.w} ${s.y + r}` : ''}V${s.y + hh}Z`;
  return (
    <>
      <path d={d} fill={ink} fillOpacity={0.16} stroke="none" />
      <line x1={s.x} y1={s.y + hh} x2={s.x + s.w} y2={s.y + hh} stroke={ink} strokeWidth={Math.min(s.strokeWidth, 1.5) || 1} strokeOpacity={s.strokeOpacity} />
    </>
  );
}

function shapeBody(s: ShapeItem, palette: Palette, ax?: number, ay?: number, conn?: ConnectorPath | null) {
  const da = dashArray(s.dash, s.strokeWidth || 1);
  const ink = inkColor(s.stroke, palette);
  const stroke = s.strokeWidth > 0 ? ink : 'none';
  const fill = s.fillOpacity > 0 ? (hasGradient(s) ? `url(#${gradId(s.id)})` : pageFill(s.fill, palette)) : 'none';
  // outline details; unset keeps each kind's own default
  const line = { strokeOpacity: s.strokeOpacity, strokeLinecap: lineCap(s), strokeLinejoin: lineJoin(s) };
  const face = textFaceStyle(s);
  const textColor = s.textColor ? inkColor(s.textColor, palette) : s.kind === 'text' ? palette.label : ink;
  switch (s.kind) {
    case 'rect':
    case 'zone':
      return (
        <g className="shape" data-id={s.id}>
          <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={s.radius} fill={fill} fillOpacity={s.fillOpacity} stroke={stroke} strokeWidth={s.strokeWidth} strokeDasharray={da} {...line} />
          {hasHeader(s) && <HeaderBand s={s} ink={ink} />}
          {s.text && (
            <RichText text={shapeText(s)} x={shapeTitle(s).x} y={shapeTitle(s).y} anchor={shapeTitle(s).anchor} fontSize={s.fontSize ?? 13} fill={textColor} fontWeight={textWeight(s)} style={face} className="shape-title" />
          )}
        </g>
      );
    case 'frame': {
      const t = frameTag(s);
      return (
        <g className="shape frame" data-id={s.id}>
          <rect x={s.x} y={s.y} width={s.w} height={s.h} fill="none" stroke={stroke} strokeWidth={s.strokeWidth} strokeDasharray={da} vectorEffect="non-scaling-stroke" />
          <rect x={t.x} y={t.y} width={t.w} height={t.h} rx={t.h / 2} fill={ink} />
          <text x={t.x + 8} y={t.y + t.h / 2 + t.fs * 0.35} fontSize={t.fs} fontWeight={600} fill="#fff">
            {t.label}
          </text>
        </g>
      );
    }
    case 'ellipse':
      return (
        <g className="shape" data-id={s.id}>
          <ellipse cx={s.x + s.w / 2} cy={s.y + s.h / 2} rx={Math.abs(s.w / 2)} ry={Math.abs(s.h / 2)} fill={fill} fillOpacity={s.fillOpacity} stroke={stroke} strokeWidth={s.strokeWidth} strokeDasharray={da} {...line} />
          {s.text && (
            <RichText text={shapeText(s)} x={shapeTitle(s).x} y={shapeTitle(s).y} anchor={shapeTitle(s).anchor} fontSize={s.fontSize ?? 13} fill={textColor} fontWeight={textWeight(s)} style={face} />
          )}
        </g>
      );
    case 'polygon':
      return (
        <g className="shape" data-id={s.id}>
          <path d={polyPath(s)} fill={fill} fillOpacity={s.fillOpacity} stroke={stroke} strokeWidth={s.strokeWidth} strokeDasharray={da} {...line} />
          {s.text && (
            <RichText text={shapeText(s)} x={shapeTitle(s).x} y={shapeTitle(s).y} anchor={shapeTitle(s).anchor} fontSize={s.fontSize ?? 13} fill={textColor} fontWeight={textWeight(s)} style={face} />
          )}
        </g>
      );
    case 'image':
      return (
        <g className="shape" data-id={s.id}>
          <g transform={s.flipX ? `translate(${2 * s.x + s.w} 0) scale(-1 1)` : undefined}>
            <image href={s.src} xlinkHref={s.src} x={Math.min(s.x, s.x + s.w)} y={Math.min(s.y, s.y + s.h)} width={Math.abs(s.w)} height={Math.abs(s.h)} preserveAspectRatio="none" />
          </g>
          {s.strokeWidth > 0 && <rect x={s.x} y={s.y} width={s.w} height={s.h} fill="none" stroke={stroke} strokeWidth={s.strokeWidth} strokeDasharray={da} {...line} />}
        </g>
      );
    case 'line':
    case 'arrow': {
      // the path as resolved: bends, routing and glued ends; heads point along its first / last stretch
      const p = conn ?? resolveConnector(null, s);
      const size = s.headSize ?? defaultHeadSize(s.strokeWidth);
      const endKind: HeadKind = s.headEnd ?? (s.kind === 'arrow' ? 'open' : 'none');
      const startKind: HeadKind = s.headStart ?? 'none';
      return (
        <g className="shape" data-id={s.id}>
          <path d={connectorD(p, headInset(startKind, size), headInset(endKind, size))} fill="none" stroke={ink} strokeWidth={s.strokeWidth} strokeDasharray={da} {...line} />
          <ArrowHeadEl tip={p.end} x={p.endDir.x} y={p.endDir.y} size={size} kind={endKind} color={ink} sw={s.strokeWidth} />
          <ArrowHeadEl tip={p.start} x={p.startDir.x} y={p.startDir.y} size={size} kind={startKind} color={ink} sw={s.strokeWidth} />
          {s.text && (
            <RichText text={shapeText(s)} x={p.mid.x} y={p.mid.y - 6} anchor={s.align ?? defaultAlign(s)} fontSize={s.fontSize ?? 13} fill={textColor} fontWeight={textWeight(s)} style={face} />
          )}
        </g>
      );
    }
    case 'ink': {
      const pts = inkPoints(s);
      if (s.highlighter) {
        return (
          <g className="shape ink" data-id={s.id}>
            <path d={inkCenterPath(pts)} fill="none" stroke={ink} strokeOpacity={0.36} strokeWidth={s.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
          </g>
        );
      }
      return (
        <g className="shape ink" data-id={s.id}>
          <path d={inkOutline(pts, s.strokeWidth)} fill={ink} />
        </g>
      );
    }
    case 'callout': {
      const L = calloutLayout(s);
      const fs = s.fontSize ?? 14;
      const leader = ax !== undefined && ay !== undefined ? leaderPath({ x: L.badge.cx, y: L.badge.cy }, L.badge.r, { x: ax, y: ay }) : null;
      return (
        <g className="shape callout" data-id={s.id}>
          {leader && <path d={leader} fill="none" stroke={ink} strokeWidth={s.strokeWidth || 1.5} strokeLinecap="round" />}
          {ax !== undefined && ay !== undefined && (
            <>
              <circle cx={ax} cy={ay} r={7} fill={ink} fillOpacity={0.18} className="callout-ping" />
              <circle cx={ax} cy={ay} r={3.2} fill={ink} stroke={palette.bg} strokeWidth={1.2} />
            </>
          )}
          {L.card && (
            <g className="callout-card">
              <rect x={L.card.x} y={L.card.y} width={L.card.w} height={L.card.h} rx={8} fill={palette.bg} stroke={ink} strokeWidth={1.25} />
              <rect x={L.card.x} y={L.card.y} width={L.card.w} height={L.card.h} rx={8} fill={ink} fillOpacity={0.07} />
              <RichText text={(s.text ?? '').trim()} x={L.card.tx} y={L.card.ty} fontSize={fs} fill={s.textColor ? inkColor(s.textColor, palette) : palette.label} fontWeight={500} />
            </g>
          )}
          <circle cx={L.badge.cx} cy={L.badge.cy} r={L.badge.r} fill={ink} />
          <text x={L.badge.cx} y={L.badge.cy + 4.4} textAnchor="middle" fontSize={12.5} fontWeight={700} fill={s.stroke === '#000000' ? palette.bg : '#ffffff'}>
            {s.step ?? ''}
          </text>
        </g>
      );
    }
    case 'text': {
      const fs = textSize(s);
      const text = shapeText(s);
      const m = measureTextShape(s);
      const first = hasMath(text) ? layoutRich(text, fs, textWeight(s), s.font)[0].ascent : fs;
      const anchor = s.align ?? 'start';
      return (
        <g className="shape" data-id={s.id}>
          {s.fillOpacity > 0 && <rect x={s.x - 6} y={s.y - 4} width={m.w + 12} height={m.h + 8} rx={4} fill={fill} fillOpacity={s.fillOpacity} />}
          <RichText text={text} x={s.x + (anchor === 'middle' ? m.w / 2 : anchor === 'end' ? m.w : 0)} y={s.y + Math.max(fs, first)} anchor={anchor} fontSize={fs} fill={textColor} fontWeight={textWeight(s)} style={face} className="free-text" />
        </g>
      );
    }
  }
}

export { measureText };

/* ------------------------------------------------------------------ */
/* See-through exports                                                 */
/* ------------------------------------------------------------------ */

/** The two canvas colours that mean "the page": a shape filled with one hides what is behind it. */
const isPageColour = (c?: string) => !!c && /^#(0f0e0c|fffdf9)$/i.test(c);

/** Whether a symbol primitive closes its outline (only those can have a fill). */
const isClosedPrim = (p: Prim) => p.t === 'poly' || p.t === 'rect' || p.t === 'circle' || p.t === 'ellipse' || (p.t === 'path' && /z/i.test(p.d));

/** A shape that paints the page colour, as a mask silhouette (null for anything that does not). */
function shapeKnockout(s: ShapeItem): ReactNode {
  if (!(s.fillOpacity > 0) || !isPageColour(s.fill) || hasGradient(s)) return null;
  // a see-through fill lets that much of what is behind through, like the canvas does
  const opacity = s.fillOpacity * (s.opacity ?? 1);
  let body: ReactNode = null;
  if (s.kind === 'rect' || s.kind === 'zone') body = <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={s.radius} fill="#000000" fillOpacity={opacity} />;
  else if (s.kind === 'ellipse') body = <ellipse cx={s.x + s.w / 2} cy={s.y + s.h / 2} rx={Math.abs(s.w / 2)} ry={Math.abs(s.h / 2)} fill="#000000" fillOpacity={opacity} />;
  else if (s.kind === 'polygon') body = <path d={polyPath(s)} fill="#000000" fillOpacity={opacity} />;
  else if (s.kind === 'text' && (s.text ?? '').trim()) {
    const m = measureTextShape(s);
    body = <rect x={s.x - 6} y={s.y - 4} width={m.w + 12} height={m.h + 8} rx={4} fill="#000000" fillOpacity={opacity} />;
  }
  if (!body) return null;
  const tf = shapeTransform(s);
  return tf ? <g transform={tf}>{body}</g> : body;
}

/** A part's page-coloured body and its label backdrops, as mask silhouettes. */
function componentKnockout(c: ComponentItem, def: SymbolDef, settings: DocSettings): ReactNode[] {
  const out: ReactNode[] = [];
  // a part fill colour is painted opaquely, so it already hides what is behind it
  if (!c.fill || c.fill === 'none') {
    const bg = def.prims.filter((p): p is Prim & { fill: 'bg' } => 'fill' in p && p.fill === 'bg' && isClosedPrim(p));
    if (bg.length) {
      const tf = `translate(${c.x} ${c.y}) rotate(${c.rot}) scale(${c.flipX ? -1 : 1} 1) translate(${-def.w / 2} ${-def.h / 2})`;
      // a DNP part is dimmed by the stylesheet, so its body hides that much less
      const dim = isDnp(c) ? 0.45 : 1;
      out.push(
        <g key="body" transform={tf} stroke="none">
          {bg.map((p, i) => (
            <PrimEl key={i} p={p} sw={0} look={{ sw: 0, fill: '#000000', fillOpacity: dim }} />
          ))}
        </g>,
      );
    }
  }
  const shown = labelsShown(settings, c, def);
  const shownC = { ...c, showRef: shown.ref, showValue: shown.value };
  const labels = labelLayout(c, def);
  for (const which of ['ref', 'value'] as const) {
    if (!shownC[which === 'ref' ? 'showRef' : 'showValue'] || !c[which]) continue;
    const at = labels[which];
    if (!at) continue;
    const look = labelLook(shownC, which, def);
    if (!look.st.backdrop) continue;
    const b = labelBox(at, look);
    const rect = <rect x={b.x - 2} y={b.y - 1} width={b.w + 4} height={b.h + 1} rx={2} fill="#000000" fillOpacity={look.st.opacity ?? 1} />;
    out.push(look.st.rotate ? <g key={which} transform={`rotate(${look.st.rotate} ${at.x} ${at.y})`}>{rect}</g> : <Fragment key={which}>{rect}</Fragment>);
  }
  return out;
}

/** The mask that makes an item hide what is behind it, without painting a colour into a transparent export. */
function knockoutMask(doc: CircuitDoc, it: Item, key: string, index: number, box: Rect): { id: string; node: ReactNode } | null {
  const nodes =
    it.type === 'component'
      ? componentKnockout(it, instanceSymbol(doc, it), doc.settings)
      : it.type === 'shape'
        ? [shapeKnockout(it)].filter((n): n is ReactNode => !!n).map((n, i) => <Fragment key={`s${i}`}>{n}</Fragment>)
        : [];
  if (!nodes.length) return null;
  const id = `nodal-knockout-${key}-${index}`;
  return {
    id,
    node: (
      <mask key={id} id={id} maskUnits="userSpaceOnUse" x={box.x} y={box.y} width={box.w} height={box.h}>
        <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="#ffffff" />
        {nodes}
      </mask>
    ),
  };
}

/** How many see-through scenes have been rendered; keeps mask ids apart when several pages print into one document. */
let knockoutSeq = 0;

/**
 * Back-to-front stack where every item that paints the page colour erases the
 * items behind it through a mask. The page itself stays transparent, so the
 * export still composites without a background, but overlapping items hide
 * each other exactly as they do on the canvas (a symbol body over a wire, a
 * zone over a picture, a label backdrop over a trace).
 */
function knockoutStack(doc: CircuitDoc, stack: (WireItem | ComponentItem | ShapeItem)[], els: ReactNode[], box: Rect): { masks: ReactNode[]; content: ReactNode[] } {
  const key = String(++knockoutSeq);
  const masks: ReactNode[] = [];
  let content: ReactNode[] = [];
  stack.forEach((it, i) => {
    // everything drawn so far is behind this item, so one mask hides all of it
    const mask = content.length ? knockoutMask(doc, it, key, i, box) : null;
    if (mask) {
      masks.push(mask.node);
      content = [
        <g key={`knockout-${i}`} mask={`url(#${mask.id})`}>
          {content}
        </g>,
      ];
    }
    content.push(els[i]);
  });
  return { masks, content };
}

/* ------------------------------------------------------------------ */
/* Whole scene                                                         */
/* ------------------------------------------------------------------ */

/** Memoised: the editor re-renders on every pointer move, the drawing only when what it shows changes. */
export const Scene = memo(function Scene({
  doc,
  data,
  palette,
  highlight,
  frames = false,
  xrefs,
  knockout = false,
  knockoutBox,
}: {
  doc: CircuitDoc;
  data: SceneData;
  palette: Palette;
  highlight?: Set<string> | null;
  frames?: boolean;
  xrefs?: ReadonlyMap<string, string>;
  /** See-through image export: page-coloured parts erase the items behind them instead of painting a colour. */
  knockout?: boolean;
  /** The exported area, for the knockout masks' extent. */
  knockoutBox?: Rect;
}) {
  // presentation frames are only drawn while editing
  const items = Object.values(doc.items).filter((i) => !i.hidden && (frames || !(i.type === 'shape' && i.kind === 'frame')));
  // one back-to-front stack for shapes, wires and parts (the layers panel order, z else creation order)
  const order = drawOrderCached(doc);
  const byOrder = (a: { id: string }, b: { id: string }) => order.get(a.id)! - order.get(b.id)!;
  const wires = items.filter((i): i is WireItem => i.type === 'wire');
  const stack = items.filter((i): i is WireItem | ComponentItem | ShapeItem => i.type !== 'junction').sort(byOrder);
  const shapeEl = (s: ShapeItem) => {
    const a = s.kind === 'callout' ? calloutAnchor(doc, s) : null;
    // lines and arrows are drawn along their resolved path (glued ends follow their targets)
    return <ShapeView key={s.id} s={s} palette={palette} ax={a?.x} ay={a?.y} path={isConnector(s) ? resolveConnector(doc, s) : undefined} />;
  };
  const stackEls = stack.map((it) =>
    it.type === 'wire' ? (
      <WireView key={it.id} w={it} pts={data.polys.get(it.id) ?? []} hops={data.hops.get(it.id)} settings={doc.settings} palette={palette} dim={!!highlight && !highlight.has(it.id)} />
    ) : it.type === 'component' ? (
      <ComponentView key={it.id} c={it} def={instanceSymbol(doc, it)} settings={doc.settings} palette={palette} xref={xrefs?.get(it.id)} knockout={knockout} />
    ) : (
      shapeEl(it)
    ),
  );
  const knockoutScene = knockout && knockoutBox ? knockoutStack(doc, stack, stackEls, knockoutBox) : null;
  const dots: { x: number; y: number; color: string; key: string }[] = [];
  const js = doc.settings.junctionSize;
  // the first wire at each junction gives its dot colour
  const wireAt = new Map<string, WireItem>();
  for (const w of wires) {
    if (w.a.kind === 'junction' && !wireAt.has(w.a.id)) wireAt.set(w.a.id, w);
    if (w.b.kind === 'junction' && !wireAt.has(w.b.id)) wireAt.set(w.b.id, w);
  }
  for (const it of items) {
    if (it.type === 'junction' && (data.junctionDegree.get(it.id) ?? 0) >= 3) {
      const w = wireAt.get(it.id);
      dots.push({ x: it.x, y: it.y, color: w ? wireStyle(doc, w).color : doc.settings.wire.color, key: it.id });
    }
  }
  // butted pins count as joined: with a wire on them too, three or more branches meet there
  const dotted = new Set<string>();
  for (const keys of data.touchCells.values()) {
    if (keys.length < 2 || !keys.some((k) => data.touching.has(k))) continue;
    const n = keys.reduce((sum, k) => sum + (data.portDegree.get(k) ?? 0), keys.length);
    if (n < 3) continue;
    for (const k of keys) dotted.add(k);
    const [comp, port] = keys[0].split(':');
    const c = doc.items[comp];
    const p = c?.type === 'component' ? portPosition(doc, c, port) : null;
    if (p) dots.push({ x: p.pt.x, y: p.pt.y, color: doc.settings.wire.color, key: keys[0] });
  }
  for (const [k, n] of data.portDegree) {
    if (n < 2 || dotted.has(k)) continue;
    const [comp, port] = k.split(':');
    const c = doc.items[comp];
    if (!c || c.type !== 'component') continue;
    const p = portPosition(doc, c, port);
    if (p) dots.push({ x: p.pt.x, y: p.pt.y, color: doc.settings.wire.color, key: k });
  }
  return (
    <>
      <ShapeDefs shapes={items.filter((i): i is ShapeItem => i.type === 'shape')} palette={palette} />
      {knockoutScene && knockoutScene.masks.length > 0 && <defs>{knockoutScene.masks}</defs>}
      <SheetFrame doc={doc} ink={palette.sym} dim={palette.value} />
      {/* shapes, wires and parts share one stack, so the layers panel order is what you see */}
      <g className="layer-stack">{knockoutScene ? knockoutScene.content : stackEls}</g>
      <g className="layer-dots">
        {dots.map((d) => (
          <circle key={d.key} cx={d.x} cy={d.y} r={js} fill={inkColor(d.color, palette)} />
        ))}
      </g>
    </>
  );
});

