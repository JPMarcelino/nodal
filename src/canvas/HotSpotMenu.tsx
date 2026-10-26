import { ChevronDown, ChevronUp, CircleDot, GripVertical, Spline, Trash2, Unlink, Waypoints } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { HotSpot } from '../model/hotspots';
import { computeNets, netOfWire } from '../model/netlist';
import { attachedWires } from '../model/doc';
import { deleteItems } from '../model/ops';
import { applySolder } from './solder';
import { instanceSymbol } from '../model/registry';
import type { CircuitDoc, WireItem } from '../model/types';
import { crossingStack, restack, wireStyle } from '../model/wires';
import { S, goToItems, mutate, select, set, toast } from '../store/store';
import { EDITOR_PALETTE, inkColor, pagePalette, type SceneData } from './Scene';

/**
 * Menu shown after the pointer rests on a hot spot: a wire crossing (reorder /
 * solder), a solder junction (unsolder), a loose end touching something
 * (solder) or a loose wire end (continue / select / delete).
 */
export function HotSpotMenu({
  spot,
  doc,
  data,
  onEnter,
  onLeave,
  onClose,
  onContinueWire,
  onHold,
}: {
  spot: HotSpot;
  doc: CircuitDoc;
  data: SceneData;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
  onContinueWire: (wire: string, end: 'a' | 'b') => void;
  /** Keeps the menu open while true (e.g. during a drag), whatever the pointer does. */
  onHold: (hold: boolean) => void;
}) {
  const view = S().view;
  const size = S().canvasSize;
  const nets = useMemo(() => computeNets(doc), [doc]);
  const netName = (wire: string) => netOfWire(nets, wire)?.name ?? 'net?';

  // hovering a row highlights that wire; restore whatever was highlighted before
  const prevHighlight = useRef(S().highlight);
  useEffect(() => () => set({ highlight: prevHighlight.current }), []);

  const valid = spotStillValid(spot, doc, data);
  useEffect(() => {
    if (!valid) onClose();
  });
  if (!valid) return null;

  const run = (fn: (d: CircuitDoc) => string | null, ok: string) => {
    let err: string | null = null;
    mutate((dd) => {
      err = fn(dd as CircuitDoc);
    });
    toast(err ?? ok, err ? 'error' : 'success');
    onClose();
  };
  const selectNet = (wire: string) => {
    const net = netOfWire(nets, wire);
    if (!net) return;
    prevHighlight.current = null;
    select(goToItems(net.wires));
    set({ highlight: new Set(net.wires) });
    onClose();
  };

  let body: ReactNode;
  switch (spot.kind) {
    case 'crossing': {
      const stack = crossingStack(data.crossings, spot.pt, 1, data.layers);
      body = (
        <>
          <Title>Crossing</Title>
          <Sub>Top wire hops over the ones below · drag to reorder</Sub>
          <OrderList doc={doc} data={data} wires={stack.map((s) => s.wire)} names={dedupe(stack.map((s) => netName(s.wire)))} onHold={onHold} />
          <Actions>
            <Item icon={<CircleDot size={14} />} label="Solder here" hint="join into one net" onClick={() => run((d) => applySolder(d, spot, data), `Soldered ${stack.length} wires`)} />
          </Actions>
        </>
      );
      break;
    }
    case 'junction': {
      const wires = attachedWires(doc, spot.id);
      body = (
        <>
          <Title>Junction · {netName(wires[0] ?? '')}</Title>
          <Sub>{wires.length} wires soldered together here</Sub>
          <Actions>
            <Item
              icon={<Unlink size={14} />}
              label="Unsolder"
              hint="straight runs hop, branches detach"
              onClick={() =>
                run((d) => applySolder(d, spot, data), 'Unsoldered — the wires cross without connecting')
              }
            />
            {wires[0] && <Item icon={<Waypoints size={14} />} label="Select net" onClick={() => selectNet(wires[0])} />}
          </Actions>
        </>
      );
      break;
    }
    case 'touch': {
      const t = spot.target;
      const what =
        t.kind === 'port'
          ? `pin ${(doc.items[t.comp] as { ref?: string } | undefined)?.ref ?? '?'}.${portName(doc, t.comp, t.port)}`
          : t.kind === 'junction'
            ? 'a junction'
            : `${netName(t.wire)}${t.kind === 'end' ? ' (end)' : ''}`;
      body = (
        <>
          <Title>Touching, not connected</Title>
          <Sub>
            {netName(spot.wire)} ends on {what}
          </Sub>
          <Actions>
            <Item icon={<CircleDot size={14} />} label="Solder here" hint="connect" onClick={() => run((d) => applySolder(d, spot, data), 'Soldered')} />
            <Item icon={<Waypoints size={14} />} label="Select net" onClick={() => selectNet(spot.wire)} />
          </Actions>
        </>
      );
      break;
    }
    case 'pinTouch':
      body = (
        <>
          <Title>Pin on a wire, not connected</Title>
          <Sub>
            {pinLabel(doc, spot.comp, spot.port)} sits on {netName(spot.wire)}
          </Sub>
          <Actions>
            <Item
              icon={<CircleDot size={14} />}
              label="Solder here"
              hint="connect the pin"
              onClick={() => run((d) => applySolder(d, spot, data), `Soldered ${pinLabel(doc, spot.comp, spot.port)}`)}
            />
            <Item icon={<Waypoints size={14} />} label="Select net" onClick={() => selectNet(spot.wire)} />
          </Actions>
        </>
      );
      break;
    case 'pin': {
      const wire = Object.values(doc.items).find((it) => it.type === 'wire' && [it.a, it.b].some((ep) => ep.kind === 'port' && ep.comp === spot.comp && ep.port === spot.port));
      body = (
        <>
          <Title>
            Pin {pinLabel(doc, spot.comp, spot.port)}
            {wire ? ` · ${netName(wire.id)}` : ''}
          </Title>
          <Sub>
            {spot.ends} wire{spot.ends === 1 ? '' : 's'} connected
          </Sub>
          <Actions>
            <Item
              icon={<Unlink size={14} />}
              label="Unsolder"
              hint="disconnect the pin"
              onClick={() => run((d) => applySolder(d, spot, data), `Unsoldered ${pinLabel(doc, spot.comp, spot.port)}`)}
            />
            {wire && <Item icon={<Waypoints size={14} />} label="Select net" onClick={() => selectNet(wire.id)} />}
          </Actions>
        </>
      );
      break;
    }
    case 'end':
      body = (
        <>
          <Title>Loose end · {netName(spot.wire)}</Title>
          <Sub>Not connected to anything</Sub>
          <Actions>
            <Item
              icon={<Spline size={14} />}
              label="Continue wire"
              hint="draw from here"
              onClick={() => {
                onClose();
                onContinueWire(spot.wire, spot.end);
              }}
            />
            <Item icon={<Waypoints size={14} />} label="Select net" onClick={() => selectNet(spot.wire)} />
            <Item icon={<Trash2 size={14} />} label="Delete wire" danger onClick={() => run((d) => (deleteItems(d, [spot.wire]), null), 'Wire deleted')} />
          </Actions>
        </>
      );
      break;
  }

  const W = spot.kind === 'crossing' ? 236 : 216;
  const sx = view.x + spot.pt.x * view.zoom;
  const sy = view.y + spot.pt.y * view.zoom;
  const left = Math.max(8, Math.min(sx + 16, size.w - W - 8));
  const top = Math.max(8, Math.min(sy + 16, size.h - 220));

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
      {body}
    </div>
  );
}

/** The spot can vanish while the menu is open (wire moved, deleted, soldered…). */
function spotStillValid(spot: HotSpot, doc: CircuitDoc, data: SceneData): boolean {
  switch (spot.kind) {
    case 'crossing':
      return crossingStack(data.crossings, spot.pt, 1).length >= 2;
    case 'junction':
      return !!doc.items[spot.id];
    case 'pinTouch':
      return !!doc.items[spot.comp] && !!doc.items[spot.wire];
    case 'pin':
      return Object.values(doc.items).some((it) => it.type === 'wire' && [it.a, it.b].some((ep) => ep.kind === 'port' && ep.comp === spot.comp && ep.port === spot.port));
    case 'touch':
    case 'end': {
      const w = doc.items[spot.wire];
      const ep = w?.type === 'wire' ? w[spot.end] : null;
      return !!ep && ep.kind === 'free' && ep.x === spot.pt.x && ep.y === spot.pt.y;
    }
  }
}

/** "C1.2"-style pin name. */
const pinLabel = (doc: CircuitDoc, comp: string, port: string) => `${(doc.items[comp] as { ref?: string } | undefined)?.ref ?? '?'}.${portName(doc, comp, port)}`;

const portName = (doc: CircuitDoc, comp: string, port: string) => {
  const c = doc.items[comp];
  if (!c || c.type !== 'component') return port;
  return instanceSymbol(doc, c).ports.find((p) => p.id === port)?.name ?? port;
};

/** Same-named entries get " · 1", " · 2"… so every row is distinguishable. */
const dedupe = (names: string[]) =>
  names.map((n, i) => (names.filter((m) => m === n).length > 1 ? `${n} · ${names.slice(0, i + 1).filter((m) => m === n).length}` : n));

const Title = ({ children }: { children: ReactNode }) => <div className="cross-pop-title">{children}</div>;
const Sub = ({ children }: { children: ReactNode }) => <div className="cross-pop-sub">{children}</div>;
const Actions = ({ children }: { children: ReactNode }) => <div className="hot-actions">{children}</div>;

function Item({ icon, label, hint, danger, onClick }: { icon: ReactNode; label: string; hint?: string; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={danger ? 'hot-item danger' : 'hot-item'} onClick={onClick}>
      {icon}
      <span className="hot-item-label">{label}</span>
      {hint && <span className="hot-item-hint">{hint}</span>}
    </button>
  );
}

const ROW_H = 34; // row height + gap in the order list

/** Reorderable stack of the wires at a crossing, top (hops over the rest) first. */
function OrderList({ doc, data, wires, names, onHold }: { doc: CircuitDoc; data: SceneData; wires: string[]; names: string[]; onHold: (hold: boolean) => void }) {
  // pointer-driven dragging (native drag-and-drop fires pointer-leave on the menu and is flaky in webviews)
  const [drag, setDrag] = useState<{ from: number; startY: number; dy: number } | null>(null);
  const lockedAt = (i: number) => !!doc.items[wires[i]]?.locked;
  // A locked wire is a fixed anchor: no row may move across it.
  const crossesLocked = (from: number, to: number) => {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    for (let i = lo; i <= hi; i++) if (i !== from && lockedAt(i)) return true;
    return false;
  };
  const target = drag ? Math.max(0, Math.min(wires.length - 1, drag.from + Math.round(drag.dy / ROW_H))) : null;
  const reorder = (from: number, to: number) => {
    if (from === to || to < 0 || to >= wires.length || lockedAt(from) || crossesLocked(from, to)) return;
    const order = [...wires];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    const layers = restack(order, data.layers);
    // Never leave a locked wire's layer out of step with the new order.
    for (const [id, layer] of layers) {
      const w = doc.items[id] as WireItem | undefined;
      if (w?.locked && (w.hopLayer ?? 0) !== layer) return;
    }
    mutate((d) => {
      for (const [id, layer] of layers) {
        const w = d.items[id] as WireItem | undefined;
        if (!w || w.locked) continue;
        if (layer) w.hopLayer = layer;
        else delete w.hopLayer;
      }
    });
  };
  const end = (commit: boolean) => {
    if (drag && commit && target !== null) reorder(drag.from, target);
    setDrag(null);
    onHold(false);
  };
  return (
    <ol className="cross-pop-list">
      {wires.map((id, i) => {
        const w = doc.items[id] as WireItem | undefined;
        const locked = !!w?.locked;
        const color = w ? inkColor(wireStyle(doc, w).color, pagePalette(doc.settings, EDITOR_PALETTE)) : 'currentColor';
        const dragging = drag?.from === i;
        // rows between the dragged one and its target slide out of the way
        const shift = drag && !dragging && target !== null ? (i > drag.from && i <= target ? -ROW_H : i < drag.from && i >= target ? ROW_H : 0) : 0;
        return (
          <li
            key={id}
            className={dragging ? 'cross-pop-row dragging' : 'cross-pop-row'}
            style={{ transform: `translateY(${dragging ? drag!.dy : shift}px)` }}
            onPointerDown={(e) => {
              if (locked || (e.target as HTMLElement).closest('button')) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              onHold(true);
              setDrag({ from: i, startY: e.clientY, dy: 0 });
            }}
            onPointerMove={(e) => {
              if (dragging) setDrag({ ...drag!, dy: e.clientY - drag!.startY });
            }}
            onPointerUp={() => dragging && end(true)}
            onPointerCancel={() => dragging && end(false)}
            onMouseEnter={() => !drag && set({ highlight: new Set([id]) })}
          >
            <GripVertical size={13} className="cross-pop-grip" />
            <span className="cross-pop-swatch" style={{ background: color }} />
            <span className="cross-pop-name" title={w?.label ? `${names[i]} — label “${w.label}”` : names[i]}>
              {names[i]}
            </span>
            <span className="cross-pop-tag">{i === 0 ? 'over' : i === wires.length - 1 ? 'under' : ''}</span>
            <button
              type="button"
              className="cross-pop-btn"
              title="Move up (hop over)"
              disabled={locked || i === 0 || crossesLocked(i, i - 1)}
              onClick={() => reorder(i, i - 1)}
            >
              <ChevronUp size={14} />
            </button>
            <button
              type="button"
              className="cross-pop-btn"
              title="Move down (stay under)"
              disabled={locked || i === wires.length - 1 || crossesLocked(i, i + 1)}
              onClick={() => reorder(i, i + 1)}
            >
              <ChevronDown size={14} />
            </button>
          </li>
        );
      })}
    </ol>
  );
}
