import { memo } from 'react';
import type { Fill, Prim, SymbolDef } from '../model/types';

const fillOf = (f: Fill) => (f === 'solid' ? 'currentColor' : f === 'bg' ? 'var(--sym-bg)' : 'none');

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

export function PrimEl({ p, sw }: { p: Prim; sw: number }) {
  switch (p.t) {
    case 'line': {
      const pts = [];
      for (let i = 0; i < p.pts.length; i += 2) pts.push(`${p.pts[i]},${p.pts[i + 1]}`);
      return <polyline points={pts.join(' ')} fill="none" strokeWidth={p.w ?? sw} strokeDasharray={p.dash ? '4 3' : undefined} />;
    }
    case 'poly': {
      const pts = [];
      for (let i = 0; i < p.pts.length; i += 2) pts.push(`${p.pts[i]},${p.pts[i + 1]}`);
      return <polygon points={pts.join(' ')} fill={fillOf(p.fill)} strokeWidth={p.w ?? sw} />;
    }
    case 'rect':
      return <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={p.rx} fill={fillOf(p.fill)} strokeWidth={p.sw ?? sw} />;
    case 'circle':
      return <circle cx={p.cx} cy={p.cy} r={p.r} fill={fillOf(p.fill)} strokeWidth={p.w ?? sw} />;
    case 'ellipse':
      return <ellipse cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} fill={fillOf(p.fill)} strokeWidth={p.w ?? sw} />;
    case 'arc':
      return <path d={arcPath(p.cx, p.cy, p.r, p.a1, p.a2)} fill="none" strokeWidth={p.w ?? sw} />;
    case 'path':
      return <path d={p.d} fill={fillOf(p.fill)} strokeWidth={p.w ?? sw} />;
    case 'text':
      return null;
  }
}

/** Renders the drawing of a symbol in its local coordinate space. Text is rendered by the caller (kept upright). */
export const SymbolBody = memo(function SymbolBody({ def, sw = 2 }: { def: SymbolDef; sw?: number }) {
  return (
    <g strokeLinecap="round" strokeLinejoin="round" stroke="currentColor">
      {def.prims.map((p, i) => (
        <PrimEl key={i} p={p} sw={sw} />
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
            <text key={i} x={p.x} y={p.y} fontSize={p.size} textAnchor={p.anchor} fill="currentColor" stroke="none" className="sym-text">
              {p.text}
            </text>
          ) : null,
        )}
        {ports && def.ports.map((p) => <circle key={p.id} cx={p.x} cy={p.y} r={2.5} className="port-dot" />)}
      </g>
    </svg>
  );
});
