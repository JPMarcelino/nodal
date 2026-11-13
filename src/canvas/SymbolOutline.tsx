import { memo, useMemo } from 'react';
import { inferSide } from '../model/symbols/dsl';
import { pagePins, pageToSymbol, pinId } from '../model/symbolPage';
import type { CircuitDoc, Side } from '../model/types';

const OUT: Record<Side, [number, number]> = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

/**
 * The symbol editor page's guide: the outline the saved symbol will have
 * (drawing and pins, on the 10 px grid), and at each pin a short tick showing
 * the side wires will leave it from. Pins sharing a name are ringed in red.
 */
export const SymbolOutline = memo(function SymbolOutline({ doc, z }: { doc: CircuitDoc; z: number }) {
  const info = useMemo(() => {
    let box: { x: number; y: number; w: number; h: number } | null = null;
    try {
      const s = pageToSymbol(doc);
      if (s) box = { x: s.origin.x, y: s.origin.y, w: s.w, h: s.h };
    } catch {
      /* duplicate pin names: drawn below */
    }
    const pins = pagePins(doc);
    const count = new Map<string, number>();
    for (const p of pins) count.set(pinId(p.ref), (count.get(pinId(p.ref)) ?? 0) + 1);
    return { box, pins, dup: (ref: string) => (count.get(pinId(ref)) ?? 0) > 1 };
  }, [doc]);
  const { box, pins, dup } = info;
  const k = 1 / z;
  return (
    <g className="symbol-outline" pointerEvents="none">
      {box && (
        <>
          <rect x={box.x} y={box.y} width={box.w} height={box.h} className="symbol-outline-box" strokeWidth={1.25 * k} strokeDasharray={`${5 * k} ${4 * k}`} />
          <text x={box.x} y={box.y - 6 * k} fontSize={11 * k} className="symbol-outline-label">
            Symbol · {box.w} × {box.h}
          </text>
        </>
      )}
      {pins.map((p) => {
        const side = box ? inferSide(p.x - box.x, p.y - box.y, box.w, box.h) : 'left';
        const [dx, dy] = OUT[side];
        const len = Math.max(8, 14 * k);
        return (
          <g key={p.id} className={dup(p.ref) ? 'symbol-pin-guide dup' : 'symbol-pin-guide'}>
            <line x1={p.x} y1={p.y} x2={p.x + dx * len} y2={p.y + dy * len} strokeWidth={2 * k} />
            <circle cx={p.x + dx * len} cy={p.y + dy * len} r={2 * k} />
            {dup(p.ref) && <circle cx={p.x} cy={p.y} r={9} strokeWidth={1.5 * k} className="symbol-pin-dup" />}
          </g>
        );
      })}
    </g>
  );
});
