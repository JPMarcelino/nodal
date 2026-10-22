import { CheckCircle2, Info, XCircle } from 'lucide-react';
import type { Tool } from '../model/types';
import { COMMAND_MAP, keysFor, prettyKey } from '../store/commands';
import { useStore } from '../store/store';

const DRAG = 'Drag to draw · Esc returns to select';
const TOOL_HINT: Record<Tool, string> = {
  select: 'Click a wire, click again on a segment to select it · Del removes the segment · Alt-drag on a wire to branch',
  wire: 'Wire — click or drag from a pin, wire or the grid · click to bend, double-click to finish · Space flips the bend · Tab: 90° / 45° / any angle',
  node: 'Drag a wire bend, shape node or handle · click a shape edge to add a node · double-click a node: corner / smooth · Alt-drag a handle to break it · Del removes a node',
  solder: 'Click a wire crossing or a pin to solder it · click a junction to unsolder',
  rect: DRAG,
  zone: DRAG,
  ellipse: DRAG,
  line: `${DRAG} · Shift 45°`,
  arrow: `${DRAG} · Shift 45°`,
  frame: 'Drag a presentation frame · its order is the slide order',
  polygon: 'Click the corners · click the first corner again (or double-click / Enter) to close · Shift 45° · Backspace undo corner',
  path: 'Click for a corner, drag for a curve · click the first node to close · double-click / Enter ends an open path · Shift 45° · Backspace removes the last node',
  text: 'Click to place text',
  pan: 'Drag to pan',
  pen: 'Draw freehand · hold still at the end to snap to a clean line or shape',
  highlighter: 'Drag to highlight',
  laser: 'Point with the laser · its trail fades',
  eraser: 'Drag over ink to erase it',
  trace: 'Click a wire, pin or part to light up its nets · click again to clear',
  callout: 'Click to drop a numbered callout',
};
const keyOf = (id: string) => prettyKey(keysFor(id)[0] ?? '');

export function StatusBar() {
  // whole units only, so sub-unit pointer moves don't re-render the status bar
  const cx = useStore((s) => Math.round(s.cursor.x));
  const cy = useStore((s) => Math.round(s.cursor.y));
  const selection = useStore((s) => s.selection.length);
  const tool = useStore((s) => s.tool);
  const placing = useStore((s) => s.placing);
  const snapOn = useStore((s) => s.doc.settings.snap);
  const grid = useStore((s) => s.doc.settings.grid);
  const zoom = useStore((s) => s.view.zoom);
  const scope = useStore((s) => s.scope);
  const filePath = useStore((s) => s.filePath);
  const hint = placing ? `Placing — click to drop · ${keyOf('arrange.rotateCw')} rotate · ${keyOf('arrange.flipH')}/${keyOf('arrange.flipV')} flip · Esc cancel` : TOOL_HINT[tool];
  return (
    <footer className="statusbar">
      <span className="status-hint">{hint}</span>
      <span className="grow" />
      {filePath && <span className="status-item path" title={filePath}>{filePath.split(/[\\/]/).pop()}</span>}
      {scope && <span className="status-item accent">in group</span>}
      {selection > 0 && <span className="status-item">{selection} selected</span>}
      <button className="status-item btn" onClick={() => COMMAND_MAP.get('view.snap')!.run()} title={`Toggle snap (${keyOf('view.snap')})`}>
        snap {snapOn ? `${grid}px` : 'off'}
      </button>
      <span className="status-item mono">
        {cx}, {cy}
      </span>
      <span className="status-item mono">{Math.round(zoom * 100)}%</span>
    </footer>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'success' ? <CheckCircle2 size={15} /> : t.kind === 'error' ? <XCircle size={15} /> : <Info size={15} />}
          {t.text}
        </div>
      ))}
    </div>
  );
}
