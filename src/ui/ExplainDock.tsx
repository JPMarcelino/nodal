import { Eraser, Flashlight, Focus, Ghost, Highlighter, MessageSquareText, PenLine, Play, Sparkles, Trash2, Waypoints, X as Close, Zap } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import { callouts } from '../model/callout';
import { EXPLAIN_COLORS } from '../model/ink';
import type { Net } from '../model/netlist';
import type { NetFlow } from '../model/trace';
import * as A from '../store/actions';
import { keysFor, prettyKey } from '../store/commands';
import { clearExplainOverlays, isExplainTool, setX, useExplain, type ExplainTool, type Trace } from '../store/explain';
import { S, mutate, select, set, toast, useStore } from '../store/store';
import { startPresenting } from './Presenter';

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

const TOOLS: { tool: ExplainTool; icon: JSX.Element; label: string; cmd: string }[] = [
  { tool: 'pen', icon: <PenLine size={17} />, label: 'Pen', cmd: 'tool.pen' },
  { tool: 'highlighter', icon: <Highlighter size={17} />, label: 'Highlighter', cmd: 'tool.highlighter' },
  { tool: 'laser', icon: <Zap size={17} />, label: 'Laser pointer', cmd: 'tool.laser' },
  { tool: 'eraser', icon: <Eraser size={17} />, label: 'Eraser', cmd: 'tool.eraser' },
];
const REASON: typeof TOOLS = [
  { tool: 'trace', icon: <Waypoints size={17} />, label: 'Trace net (watch the signal flow)', cmd: 'tool.trace' },
  { tool: 'spotlight', icon: <Flashlight size={17} />, label: 'Spotlight', cmd: 'tool.spotlight' },
  { tool: 'callout', icon: <MessageSquareText size={17} />, label: 'Numbered callout', cmd: 'tool.callout' },
];

export const EXPLAIN_HINTS: Record<ExplainTool, JSX.Element> = {
  pen: (
    <>
      Draw anywhere · <b>hold still</b> at the end to snap it into a clean line, circle or box · <kbd>Shift</kbd> straight · <kbd>1</kbd>–<kbd>7</kbd> colour · <kbd>[</kbd> <kbd>]</kbd> size
    </>
  ),
  highlighter: (
    <>
      Mark up parts and paths — it sits <b>under</b> the circuit so wires stay crisp · hold still to straighten · <kbd>Shift</kbd> straight
    </>
  ),
  laser: <>Point things out — the trail fades by itself, and people in a live session see it too</>,
  eraser: <>Swipe over ink or callouts to erase them</>,
  trace: (
    <>
      Click a <b>wire or pin</b> to light its net and watch the signal spread from there · click a <b>part</b> to trace every net it touches · click again to turn off
    </>
  ),
  spotlight: (
    <>
      Click parts or wires to put them in the <b>spotlight</b> · drag to light an area · click empty space to clear
    </>
  ),
  callout: (
    <>
      Click a part, pin or wire to pin a <b>numbered note</b> (drag to place the bubble) · the numbers become your walkthrough — <kbd>F5</kbd> presents it
    </>
  ),
};

const SIZES = [
  { v: 2, r: 2.5 },
  { v: 4, r: 4 },
  { v: 7, r: 6 },
];

export function ExplainDock() {
  const tool = useStore((s) => s.tool);
  const theme = useStore((s) => s.prefs.theme);
  const ex = useExplain();
  const [clearOpen, setClearOpen] = useState(false);
  const active = isExplainTool(tool);

  if (!active) {
    // lit nets / spotlight stay on while editing; a small chip turns them off
    return (
      <div className="explain-chip" onPointerDown={stop}>
        <Sparkles size={14} />
        <span>Highlights on</span>
        <button onClick={() => clearExplainOverlays()}>Clear</button>
        <button onClick={() => A.setTool(ex.lastTool)}>Explain</button>
      </div>
    );
  }

  const isHl = tool === 'highlighter';
  const color = isHl ? ex.highlightColor : ex.color;
  const showColors = tool === 'pen' || tool === 'highlighter' || tool === 'callout';
  const swatch = (c: string): CSSProperties => ({ background: c === '#000000' ? (theme === 'dark' ? '#ece6d8' : '#1d1a14') : c });

  const btn = (t: (typeof TOOLS)[number]) => {
    const k = prettyKey(keysFor(t.cmd)[0] ?? '');
    return (
      <button key={t.tool} className={tool === t.tool ? 'xd-btn active' : 'xd-btn'} onClick={() => A.setTool(t.tool)} title={`${t.label}${k ? ` (${k})` : ''}`}>
        {t.icon}
        {k && <span className="xd-key">{k}</span>}
      </button>
    );
  };

  return (
    <div className="explain-dock-wrap" onPointerDown={stop} onPointerUp={stop} onWheel={stop}>
      <div className="explain-hint" key={tool}>
        {EXPLAIN_HINTS[tool]}
      </div>
      <div className="explain-dock">
        <div className="xd-group">{TOOLS.map(btn)}</div>
        <span className="xd-sep" />
        <div className="xd-group">{REASON.map(btn)}</div>
        {showColors && (
          <>
            <span className="xd-sep" />
            <div className="xd-group xd-colors">
              {EXPLAIN_COLORS.map((c, i) => (
                <button
                  key={c}
                  className={c === color ? 'xd-swatch active' : 'xd-swatch'}
                  style={swatch(c)}
                  title={`Colour ${i + 1}`}
                  onClick={() => setX(isHl ? { highlightColor: c } : { color: c })}
                />
              ))}
            </div>
          </>
        )}
        {(tool === 'pen' || tool === 'highlighter') && (
          <>
            <span className="xd-sep" />
            <div className="xd-group">
              {SIZES.map((s) => (
                <button key={s.v} className={ex.size === s.v ? 'xd-btn xd-size active' : 'xd-btn xd-size'} onClick={() => setX({ size: s.v })} title={`Size ${s.v} ([ / ])`}>
                  <span style={{ width: s.r * 2, height: s.r * 2, ...swatch(color) }} />
                </button>
              ))}
              {tool === 'pen' && (
                <button className={ex.vanish ? 'xd-btn active' : 'xd-btn'} onClick={() => setX({ vanish: !ex.vanish })} title="Vanishing ink: strokes fade away after a few seconds">
                  <Ghost size={17} />
                </button>
              )}
            </div>
          </>
        )}
        <span className="xd-sep" />
        <div className="xd-group">
          <button className="xd-present" onClick={startPresenting} title={`Present the walkthrough (${prettyKey(keysFor('explain.present')[0] ?? 'F5')})`}>
            <Play size={15} fill="currentColor" />
            Present
          </button>
          <div className="xd-clear">
            <button className="xd-btn" onClick={() => setClearOpen((o) => !o)} title="Clear…">
              <Trash2 size={17} />
            </button>
            {clearOpen && (
              <div className="xd-menu" onMouseLeave={() => setClearOpen(false)}>
                <button onClick={() => (clearExplainOverlays(), setClearOpen(false))}>Turn off traces &amp; spotlight</button>
                <button onClick={() => (clearShapes('ink'), setClearOpen(false))}>Erase all ink</button>
                <button onClick={() => (clearShapes('callout'), setClearOpen(false))}>Delete all callouts</button>
                <button onClick={() => (renumberCallouts(), setClearOpen(false))}>Renumber callouts 1, 2, 3…</button>
              </div>
            )}
          </div>
          <button className="xd-btn" onClick={() => A.setTool('select')} title="Back to editing (Esc)">
            <Close size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}

function clearShapes(kind: 'ink' | 'callout') {
  const ids = Object.values(S().doc.items)
    .filter((i) => i.type === 'shape' && i.kind === kind && !i.locked)
    .map((i) => i.id);
  if (!ids.length) return toast(kind === 'ink' ? 'No ink to erase' : 'No callouts yet');
  mutate((d) => ids.forEach((id) => delete d.items[id]), S().selection.filter((id) => !ids.includes(id)));
  toast(`${kind === 'ink' ? 'Erased' : 'Deleted'} ${ids.length} ${kind === 'ink' ? 'stroke' : 'callout'}${ids.length === 1 ? '' : 's'} · Ctrl+Z brings them back`);
}

export function renumberCallouts() {
  const list = callouts(S().doc);
  mutate((d) => list.forEach((c, i) => ((d.items[c.id] as typeof c).step = i + 1)));
}

/** Lit nets with what is on them; hovering a pin outlines its part. */
export function TracePanel({ flows }: { flows: { t: Trace; net: Net; flow: NetFlow }[] }) {
  return (
    <div className="trace-panel" onPointerDown={stop} onWheel={stop}>
      <div className="trace-panel-head">
        <Waypoints size={14} />
        <span>Traced nets</span>
        <button onClick={() => setX({ traces: [] })}>Clear</button>
      </div>
      {flows.map(({ t, net }) => (
        <div key={t.id} className="trace-card" style={{ '--c': t.color } as CSSProperties}>
          <div className="trace-card-top">
            <span className="trace-swatch" />
            <b>{net.name}</b>
            <span className="trace-meta">
              {net.pins.length} pin{net.pins.length === 1 ? '' : 's'} · {net.wires.length} wire{net.wires.length === 1 ? '' : 's'}
            </span>
            <button className="trace-x" title="Spotlight this net" onClick={() => setX({ focus: [...net.wires, ...new Set(net.pins.map((p) => p.comp))] })}>
              <Focus size={13} />
            </button>
            <button className="trace-x" title="Turn off" onClick={() => setX((s) => ({ traces: s.traces.filter((x) => x.id !== t.id) }))}>
              <Close size={13} />
            </button>
          </div>
          {net.names.length > 1 && <div className="trace-warn">Joins differently named nets: {net.names.join(', ')}</div>}
          {net.pins.length > 0 && (
            <div className="trace-pins">
              {net.pins.map((p) => (
                <button
                  key={`${p.comp}:${p.port}`}
                  className="trace-pin-chip"
                  onMouseEnter={() => set({ layerHover: [p.comp] })}
                  onMouseLeave={() => set({ layerHover: [] })}
                  onClick={() => select([p.comp])}
                  title={`${p.ref} pin ${p.portName}`}
                >
                  {p.ref}
                  <i>{p.portName}</i>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

