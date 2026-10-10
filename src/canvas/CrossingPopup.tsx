import { ChevronDown, ChevronUp, CircleDot, GripVertical } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { computeNets, netOfWire } from '../model/netlist';
import { cleanup, solderWires } from '../model/ops';
import type { CircuitDoc, Point, WireItem } from '../model/types';
import { crossingStack, restack, wireStyle } from '../model/wires';
import { S, mutate, set, toast } from '../store/store';
import { EDITOR_PALETTE, inkColor, type SceneData } from './Scene';

/**
 * Popup shown after hovering a wire crossing: lists the wires stacked there
 * by name (top hops over the ones below) and lets the user reorder them.
 */
export function CrossingPopup({
  pt,
  doc,
  data,
  onEnter,
  onLeave,
  onClose,
}: {
  pt: Point;
  doc: CircuitDoc;
  data: SceneData;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const view = S().view;
  const size = S().canvasSize;
  const stack = crossingStack(data.crossings, pt, 1, data.layers);
  const nets = useMemo(() => computeNets(doc), [doc]);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  // hovering a row highlights that wire; restore whatever was highlighted before
  const prevHighlight = useRef(S().highlight);
  useEffect(() => () => set({ highlight: prevHighlight.current }), []);

  // the crossing can disappear (wire moved or deleted)
  useEffect(() => {
    if (stack.length < 2) onClose();
  });
  if (stack.length < 2) return null;

  // wires are referred to by net name (every net has one; unnamed nets are net1, net2…)
  const baseNames = stack.map((s) => netOfWire(nets, s.wire)?.name ?? 'net?');
  const names = baseNames.map((n, i) => (baseNames.filter((m) => m === n).length > 1 ? `${n} · ${baseNames.slice(0, i + 1).filter((m) => m === n).length}` : n));

  const reorder = (from: number, to: number) => {
    if (from === to || to < 0 || to >= stack.length) return;
    const order = stack.map((s) => s.wire);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    const layers = restack(order, data.layers);
    mutate((d) => {
      for (const [id, layer] of layers) {
        const w = d.items[id] as WireItem | undefined;
        if (!w) continue;
        if (layer) w.hopLayer = layer;
        else delete w.hopLayer;
      }
    });
  };

  const solder = () => {
    let jid: string | null = null;
    mutate((dd) => {
      const d = dd as CircuitDoc;
      jid = solderWires(d, stack.map((s) => s.wire), pt);
      cleanup(d);
    });
    toast(jid ? `Soldered ${stack.length} wires together` : 'Could not solder here', jid ? 'success' : 'error');
    onClose();
  };

  const W = 230;
  const sx = view.x + pt.x * view.zoom;
  const sy = view.y + pt.y * view.zoom;
  const left = Math.max(8, Math.min(sx + 16, size.w - W - 8));
  const top = Math.max(8, Math.min(sy + 16, size.h - (104 + stack.length * 34)));

  return (
    <div
      className="cross-pop"
      style={{ left, top, width: W }}
      onPointerEnter={onEnter}
      onPointerLeave={() => {
        set({ highlight: prevHighlight.current });
        onLeave();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="cross-pop-title">Crossing order</div>
      <div className="cross-pop-sub">Top wire hops over the ones below · drag to reorder</div>
      <ol className="cross-pop-list">
        {stack.map((s, i) => {
          const w = doc.items[s.wire] as WireItem | undefined;
          const color = w ? inkColor(wireStyle(doc, w).color, EDITOR_PALETTE) : 'currentColor';
          return (
            <li
              key={s.wire}
              className={['cross-pop-row', drag === i ? 'dragging' : '', over === i && drag !== null && drag !== i ? 'drop' : ''].join(' ')}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                setDrag(i);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag !== null) reorder(drag, i);
                setDrag(null);
                setOver(null);
              }}
              onDragEnd={() => {
                setDrag(null);
                setOver(null);
              }}
              onMouseEnter={() => set({ highlight: new Set([s.wire]) })}
            >
              <GripVertical size={13} className="cross-pop-grip" />
              <span className="cross-pop-swatch" style={{ background: color }} />
              <span className="cross-pop-name" title={w?.label ? `${names[i]} — label “${w.label}”` : names[i]}>
                {names[i]}
              </span>
              <span className="cross-pop-tag">{i === 0 ? 'over' : i === stack.length - 1 ? 'under' : ''}</span>
              <button type="button" className="cross-pop-btn" title="Move up (hop over)" disabled={i === 0} onClick={() => reorder(i, i - 1)}>
                <ChevronUp size={14} />
              </button>
              <button type="button" className="cross-pop-btn" title="Move down (stay under)" disabled={i === stack.length - 1} onClick={() => reorder(i, i + 1)}>
                <ChevronDown size={14} />
              </button>
            </li>
          );
        })}
      </ol>
      <button type="button" className="cross-pop-solder" onClick={solder} title="Join these wires here with a junction dot (they become one net)">
        <CircleDot size={14} /> Solder here
      </button>
    </div>
  );
}
