import { useEffect, useMemo, useState } from 'react';
import { docBounds, itemBounds } from '../model/doc';
import { viewPage } from '../model/pages';
import type { CircuitDoc } from '../model/types';
import { guardActive, useAgent } from './state';

const FLASH_MS = 1600;
const BUBBLE_MS = 7000;

/** Re-renders once `ms` have passed since `t` (to let a flash or bubble go). */
function useExpiry(t: number | undefined, ms: number): boolean {
  const [, tick] = useState(0);
  const live = t !== undefined && Date.now() - t < ms;
  useEffect(() => {
    if (!live || t === undefined) return;
    const id = setTimeout(() => tick((n) => n + 1), ms - (Date.now() - t) + 20);
    return () => clearTimeout(id);
  }, [live, t, ms]);
  return live;
}

function clip(text: string, n: number) {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

/**
 * The AI agent on the canvas (world coordinates, inside the view transform):
 * its cursor with name and latest message, a brief outline around what it
 * just changed, and — while the guard is on — a dashed frame around the work
 * it is protecting. Only for the page in view.
 */
export function AgentPresence({ doc, z }: { doc: CircuitDoc; z: number }) {
  const a = useAgent();
  const page = viewPage(doc);
  const flashLive = useExpiry(a.flash?.t, FLASH_MS);
  const bubbleLive = useExpiry(a.bubble?.t, BUBBLE_MS);
  const guarded = guardActive(a) && a.guard === 'items';
  const owned = useMemo(() => (guarded ? docBounds(doc, [...a.owned].filter((id) => doc.items[id])) : null), [guarded, doc, a.owned]);
  if (!a.connected && a.status === 'idle') return null;

  const k = 1 / z;
  const flash = flashLive && a.flash?.page === page ? a.flash.ids.slice(0, 400) : [];
  const cursor = a.cursor?.page === page && a.status !== 'idle' ? a.cursor : null;
  const label = a.name;
  const bubble = bubbleLive && a.bubble ? clip(a.bubble.text, 90) : null;

  return (
    <g className="agent-presence" pointerEvents="none" style={{ '--agent': a.color } as React.CSSProperties}>
      {owned && (
        <g className="agent-owned">
          <rect x={owned.x - 14} y={owned.y - 14} width={owned.w + 28} height={owned.h + 28} rx={10} strokeWidth={1.4 * k} strokeDasharray={`${6 * k} ${5 * k}`} />
          <g transform={`translate(${owned.x - 14} ${owned.y - 14}) scale(${k})`}>
            <rect className="agent-owned-tag" x={0} y={-22} width={(label.length + 16) * 6.6 + 12} height={18} rx={5} />
            <text x={8} y={-9.5} fontSize={11}>
              {label} is working here
            </text>
          </g>
        </g>
      )}
      {flash.length > 0 && (
        <g className="agent-flash" key={a.flash!.t}>
          {flash.map((id) => {
            const it = doc.items[id];
            const b = it && itemBounds(doc, it);
            if (!b) return null;
            return <rect key={id} x={b.x - 6} y={b.y - 6} width={b.w + 12} height={b.h + 12} rx={5} strokeWidth={2 * k} />;
          })}
        </g>
      )}
      {cursor && (
        <g className="agent-cursor" style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}>
          <g transform={`scale(${k})`}>
            <path className="agent-cursor-mark" d="M0 -11 L3 -3 L11 0 L3 3 L0 11 L-3 3 L-11 0 L-3 -3 Z" />
            <g transform="translate(14 10)">
              <rect className="agent-cursor-tag" width={label.length * 7 + 16} height={19} rx={9.5} />
              <text x={8} y={13.2} fontSize={11.5} fontWeight={600}>
                {label}
              </text>
            </g>
            {bubble && (
              <g transform="translate(14 34)" className={`agent-bubble t-${a.bubble!.tone ?? 'info'}`}>
                <rect width={Math.min(640, bubble.length * 7 + 22)} height={24} rx={7} />
                <text x={10} y={16} fontSize={11.5}>
                  {bubble}
                </text>
              </g>
            )}
          </g>
        </g>
      )}
    </g>
  );
}
