import { CheckCircle2, Info, XCircle } from 'lucide-react';
import { COMMAND_MAP } from '../store/commands';
import { useStore } from '../store/store';

export function StatusBar() {
  const cursor = useStore((s) => s.cursor);
  const selection = useStore((s) => s.selection.length);
  const tool = useStore((s) => s.tool);
  const placing = useStore((s) => s.placing);
  const snapOn = useStore((s) => s.doc.settings.snap);
  const grid = useStore((s) => s.doc.settings.grid);
  const zoom = useStore((s) => s.view.zoom);
  const scope = useStore((s) => s.scope);
  const filePath = useStore((s) => s.filePath);
  const hint = placing
    ? 'Placing — click to drop, R rotate, X/Y flip, Esc cancel'
    : tool === 'wire'
      ? 'Wire — click or drag from a pin, wire or the grid · click to bend, double-click to finish · Space flips the bend · Tab: 90° / 45° / any angle'
      : tool === 'select'
        ? 'Click a wire, click again on a segment to select it · Del removes the segment · Alt-drag on a wire to branch'
        : tool === 'node'
          ? 'Drag a wire bend or polygon corner · drag a polygon edge to move it, its middle dot to add a corner · double-click or Del removes a node · Alt-drag freely'
          : tool === 'zone' || tool === 'rect' || tool === 'ellipse'
          ? 'Drag to draw · hold Shift to keep the tool'
          : tool === 'polygon'
            ? 'Click the corners · click the first corner again (or double-click / Enter) to close · Shift 45° · Backspace undo corner'
          : tool === 'text'
            ? 'Click to place text'
            : tool === 'pan'
              ? 'Drag to pan'
              : 'Drag to draw';
  return (
    <footer className="statusbar">
      <span className="status-hint">{hint}</span>
      <span className="grow" />
      {filePath && <span className="status-item path" title={filePath}>{filePath.split(/[\\/]/).pop()}</span>}
      {scope && <span className="status-item accent">in group</span>}
      {selection > 0 && <span className="status-item">{selection} selected</span>}
      <button className="status-item btn" onClick={() => COMMAND_MAP.get('view.snap')!.run()} title="Toggle snap (Ctrl+')">
        snap {snapOn ? `${grid}px` : 'off'}
      </button>
      <span className="status-item mono">
        {Math.round(cursor.x)}, {Math.round(cursor.y)}
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
