import { memo } from 'react';
import type { Fill, Prim, SymbolDef } from '../model/types';

const fillOf = (p: { fill: Fill; fc?: string; color?: string }) => (p.fill === 'solid' ? (p.fc ?? p.color ?? 'currentColor') : p.fill === 'bg' ? 'var(--sym-bg)' : 'none');

function arcPath(cx: number, cy: number, r: number, a1: number, a2: number) {
  const rad = (a: number) => (a * Math.PI) / 180;
  const x1 = cx + r * Math.cos(rad(a1));
  const y1 = cy + r * Math.sin(rad(a1));
  const x2 = cx + r * Math.cos(rad(a2));
  const y2 = cy + r * Math.sin(rad(a2));
  const sweep = a2 - a1;
  if (Math.abs(sweep) >= 359.99) return `M${cx - r},${cy}a${r},${r} 0 1 1 ${2 * r},0a${r},${r} 0 1 1 ${-2 * r},0`;
  return `M${x1.toFixed(2)},${y1.toFixed(2)}A${r},${r} 0 ${Math.abs(sweep) > 180 ? 1 : 0} ${sweep > 0 ? 1 : 0} ${x2.toFixed(2)},${y2.toFixed(2)}`;
}

/** Per-part styling laid over a symbol's own drawing. */
export interface PrimLook {
  /** Line width of primitives without one of their own. */
  sw: number;
  /** Factor for primitives that set their own width. */
  k?: number;
  /** Fills closed shapes that are outlined or background-filled. */
  fill?: string;
  fillOpacity?: number;
}

const closed = (p: Prim) => p.t === 'poly' || p.t === 'rect' || p.t === 'circle' || p.t === 'ellipse' || (p.t === 'path' && /z/i.test(p.d));

export function PrimEl({ p, sw, look }: { p: Prim; sw: number; look?: PrimLook }) {
  const lk: PrimLook = look ?? { sw };
  const el = primShape(p, lk);
  if (!el || (!p.color && !p.dash)) return el;
  const w = widthOf(p, lk);
  return (
    <g stroke={p.color} strokeDasharray={p.dash ? `${2 * w} ${1.5 * w}` : undefined}>
      {el}
    </g>
  );
}

function widthOf(p: Prim, lk: PrimLook) {
  const own = p.t === 'rect' ? p.sw : 'w' in p ? p.w : undefined;
  return own != null ? own * (lk.k ?? 1) : lk.sw;
}

function primShape(p: Prim, lk: PrimLook) {
  const w = widthOf(p, lk);
  // a part's fill colour goes into closed shapes that aren't solid ink
  const over = lk.fill && closed(p) && 'fill' in p && p.fill !== 'solid';
  const f = over ? lk.fill : 'fill' in p ? fillOf(p) : 'none';
  const fo = over && lk.fillOpacity != null && lk.fillOpacity < 1 ? lk.fillOpacity : undefined;
  switch (p.t) {
    case 'line': {
      const pts = [];
      for (let i = 0; i < p.pts.length; i += 2) pts.push(`${p.pts[i]},${p.pts[i + 1]}`);
      return <polyline points={pts.join(' ')} fill="none" strokeWidth={w} />;
    }
    case 'poly': {
      const pts = [];
      for (let i = 0; i < p.pts.length; i += 2) pts.push(`${p.pts[i]},${p.pts[i + 1]}`);
      return <polygon points={pts.join(' ')} fill={f} fillOpacity={fo} strokeWidth={w} />;
    }
    case 'rect':
      return <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={p.rx} fill={f} fillOpacity={fo} strokeWidth={w} />;
    case 'circle':
      return <circle cx={p.cx} cy={p.cy} r={p.r} fill={f} fillOpacity={fo} strokeWidth={w} />;
    case 'ellipse':
      return <ellipse cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} fill={f} fillOpacity={fo} strokeWidth={w} />;
    case 'arc':
      return <path d={arcPath(p.cx, p.cy, p.r, p.a1, p.a2)} fill="none" strokeWidth={w} />;
    case 'path':
      return <path d={p.d} fill={f} fillOpacity={fo} strokeWidth={w} />;
    case 'text':
      return null;
  }
}

/** Renders the drawing of a symbol in its local coordinate space. Text is rendered by the caller (kept upright). */
export const SymbolBody = memo(function SymbolBody({ def, sw = 2, look }: { def: SymbolDef; sw?: number; look?: PrimLook }) {
  const lk = look ?? { sw };
  return (
    <g strokeLinecap="round" strokeLinejoin="round" stroke="currentColor">
      {def.prims.map((p, i) => (
        <PrimEl key={i} p={p} sw={lk.sw} look={lk} />
      ))}
    </g>
  );
});

/** Stand-alone preview of a symbol scaled to fit a box (library tiles, editors). */
export const SymbolPreview = memo(function SymbolPreview({ def, size = 48, pad = 4, ports = false }: { def: SymbolDef; size?: number; pad?: number; ports?: boolean }) {
  const s = Math.max(def.w, def.h) + pad * 2;
  const ox = (s - def.w) / 2;
  const oy = (s - def.h) / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${s} ${s}`} className="sym-preview">
      <g transform={`translate(${ox} ${oy})`}>
        <SymbolBody def={def} sw={s > 120 ? 2.5 : 2} />
        {def.prims.map((p, i) =>
          p.t === 'text' ? (
            <text key={i} x={p.x} y={p.y} fontSize={p.size} textAnchor={p.anchor} fill={p.color ?? 'currentColor'} stroke="none" className="sym-text">
              {p.text}
            </text>
          ) : null,
        )}
        {ports && def.ports.map((p) => <circle key={p.id} cx={p.x} cy={p.y} r={2.5} className="port-dot" />)}
      </g>
    </svg>
  );
});
