import { useRef } from 'react';
import { docBounds, itemBounds } from '../model/doc';
import { S, set, useStore } from '../store/store';
import type { SceneData } from './Scene';

const W = 200;
const H = 130;

export function Minimap({ data }: { data: SceneData }) {
  const doc = useStore((s) => s.doc);
  const view = useStore((s) => s.view);
  const size = useStore((s) => s.canvasSize);
  const ref = useRef<SVGSVGElement>(null);
  const b = docBounds(doc);
  const vp = { x: -view.x / view.zoom, y: -view.y / view.zoom, w: size.w / view.zoom, h: size.h / view.zoom };
  const all = b
    ? {
        x: Math.min(b.x, vp.x),
        y: Math.min(b.y, vp.y),
        w: Math.max(b.x + b.w, vp.x + vp.w) - Math.min(b.x, vp.x),
        h: Math.max(b.y + b.h, vp.y + vp.h) - Math.min(b.y, vp.y),
      }
    : vp;
  const pad = 40;
  const box = { x: all.x - pad, y: all.y - pad, w: all.w + pad * 2, h: all.h + pad * 2 };
  const k = Math.min(W / box.w, H / box.h);

  const navigate = (clientX: number, clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    const ox = (W - box.w * k) / 2;
    const oy = (H - box.h * k) / 2;
    const wx = (clientX - r.left - ox) / k + box.x;
    const wy = (clientY - r.top - oy) / k + box.y;
    const v = S().view;
    set({ view: { ...v, x: size.w / 2 - wx * v.zoom, y: size.h / 2 - wy * v.zoom } });
  };

  return (
    <div className="minimap" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <svg
        ref={ref}
        width={W}
        height={H}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          navigate(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => e.buttons === 1 && navigate(e.clientX, e.clientY)}
      >
        <g transform={`translate(${(W - box.w * k) / 2} ${(H - box.h * k) / 2}) scale(${k}) translate(${-box.x} ${-box.y})`}>
          {Object.values(doc.items).map((it) => {
            if (it.hidden) return null;
            if (it.type === 'shape' && (it.kind === 'zone' || it.kind === 'rect')) {
              return <rect key={it.id} x={it.x} y={it.y} width={it.w} height={it.h} fill={it.fill} fillOpacity={Math.max(0.15, it.fillOpacity)} stroke="none" />;
            }
            if (it.type === 'component') {
              const r = itemBounds(doc, it)!;
              return <rect key={it.id} x={r.x} y={r.y} width={r.w} height={r.h} className="mm-comp" />;
            }
            return null;
          })}
          {[...data.polys].map(([id, pts]) => (
            <polyline key={id} points={pts.map((p) => `${p.x},${p.y}`).join(' ')} className="mm-wire" strokeWidth={2 / k} fill="none" />
          ))}
          <rect x={vp.x} y={vp.y} width={vp.w} height={vp.h} className="mm-view" strokeWidth={1.5 / k} />
        </g>
      </svg>
    </div>
  );
}
