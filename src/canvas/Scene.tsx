import { memo, useMemo } from 'react';
import { componentBounds, sideVector, toWorld } from '../model/geometry';
import { getSymbol } from '../model/registry';
import type { CircuitDoc, ComponentItem, Dash, DocSettings, HeadKind, Point, ShapeItem, SymbolDef, WireItem } from '../model/types';
import { buildWirePath, computeHops, hopPrefMap, portPosition, wirePolyline, wireStyle, type Hop } from '../model/wires';
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
  /** Number of wire ends at each port key "comp:port". */
  portDegree: Map<string, number>;
  junctionDegree: Map<string, number>;
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
  const hops = doc.settings.hops === 'none' ? new Map() : computeHops(polys, doc.settings.hopSize, hopPrefMap(Object.values(doc.items)));
  return { polys, hops, portDegree, junctionDegree };
}

/* ------------------------------------------------------------------ */
/* Components                                                          */
/* ------------------------------------------------------------------ */

export function labelLayout(c: ComponentItem, def: SymbolDef) {
  const b = componentBounds(c, def);
  const dx = c.labelDx ?? 0;
  const dy = c.labelDy ?? 0;
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
  if (b.w >= b.h) {
    return {
      ref: { x: c.x + dx, y: b.y - 5 + dy, anchor: 'middle' as const },
      value: { x: c.x + dx, y: b.y + b.h + 14 + dy, anchor: 'middle' as const },
    };
  }
  return {
    ref: { x: b.x + b.w + 6 + dx, y: c.y - 2 + dy, anchor: 'start' as const },
    value: { x: b.x + b.w + 6 + dx, y: c.y + 12 + dy, anchor: 'start' as const },
  };
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
  return (
    <g className={ghost ? 'comp ghost' : 'comp'} data-id={c.id} style={{ color, ['--sym-bg' as string]: palette.symBg }}>
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
        <text x={labels.ref.x} y={labels.ref.y} textAnchor={labels.ref.anchor} className="ref-label" fill={labelColor}>
          {c.ref}
        </text>
      )}
      {c.showValue && c.value && labels.value && (
        <text
          x={labels.value.x}
          y={labels.value.y}
          textAnchor={labels.value.anchor}
          className={def.valueIsLabel ? 'net-label' : 'value-label'}
          fill={def.valueIsLabel ? color : settings.labelColor || palette.value}
        >
          {c.value}
        </text>
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
        <text x={mid.x} y={mid.y - st.width - 3} textAnchor="middle" className="wire-label" fill={color}>
          {w.label}
        </text>
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
            <text x={s.x + 10} y={s.y + (s.fontSize ?? 13) + 6} fontSize={s.fontSize ?? 13} fill={textColor} fontWeight={s.bold === false ? 400 : 600} className="shape-title">
              {s.text}
            </text>
          )}
        </g>
      );
    case 'ellipse':
      return (
        <g className="shape" data-id={s.id}>
          <ellipse cx={s.x + s.w / 2} cy={s.y + s.h / 2} rx={Math.abs(s.w / 2)} ry={Math.abs(s.h / 2)} fill={fill} fillOpacity={s.fillOpacity} stroke={stroke} strokeWidth={s.strokeWidth} strokeDasharray={da} />
          {s.text && (
            <text x={s.x + s.w / 2} y={s.y + s.h / 2 + 5} textAnchor="middle" fontSize={s.fontSize ?? 13} fill={textColor} fontWeight={600}>
              {s.text}
            </text>
          )}
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
            <text x={s.x + s.w / 2} y={s.y + s.h / 2 - 6} textAnchor="middle" fontSize={s.fontSize ?? 13} fill={textColor}>
              {s.text}
            </text>
          )}
        </g>
      );
    }
    case 'text': {
      const fs = s.fontSize ?? 16;
      const lines = (s.text ?? '').split('\n');
      return (
        <g className="shape" data-id={s.id}>
          {s.fillOpacity > 0 && <rect x={s.x - 6} y={s.y - 4} width={s.w + 12} height={s.h + 8} rx={4} fill={fill} fillOpacity={s.fillOpacity} />}
          <text x={s.x} y={s.y + fs} fontSize={fs} fill={textColor} fontWeight={s.bold ? 700 : 400} className="free-text">
            {lines.map((l, i) => (
              <tspan key={i} x={s.x} dy={i === 0 ? 0 : fs * 1.3}>
                {l || ' '}
              </tspan>
            ))}
          </text>
        </g>
      );
    }
  }
});

export function measureText(text: string, fontSize: number) {
  const lines = text.split('\n');
  const longest = Math.max(1, ...lines.map((l) => l.length));
  return { w: Math.ceil(longest * fontSize * 0.58), h: Math.ceil(lines.length * fontSize * 1.3) };
}

/* ------------------------------------------------------------------ */
/* Whole scene                                                         */
/* ------------------------------------------------------------------ */

export function Scene({ doc, data, palette, highlight }: { doc: CircuitDoc; data: SceneData; palette: Palette; highlight?: Set<string> | null }) {
  const items = Object.values(doc.items).filter((i) => !i.hidden);
  const shapes = items.filter((i): i is ShapeItem => i.type === 'shape').sort((a, b) => a.z - b.z);
  const below = shapes.filter((s) => s.layer === 'below');
  const above = shapes.filter((s) => s.layer === 'above');
  const wires = items.filter((i): i is WireItem => i.type === 'wire');
  const comps = items.filter((i): i is ComponentItem => i.type === 'component');
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
