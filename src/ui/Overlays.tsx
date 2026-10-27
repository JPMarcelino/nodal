import { CheckCircle2, Columns3, Crosshair, Grid2x2, Grid3x3, Grip, Hash, Info, Magnet, Plus, Type, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { GridStyle, Tool } from '../model/types';
import { GRID_STYLE_NAMES } from '../model/doc';
import { COMMAND_MAP, keysFor, prettyKey } from '../store/commands';
import { useStore } from '../store/store';
import { isExplainTool } from '../store/explain';

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
  const zoom = useStore((s) => s.view.zoom);
  const scope = useStore((s) => s.scope);
  const filePath = useStore((s) => s.filePath);
  // the hint line on the canvas says it better; explain tools keep theirs here
  const hintLine = useStore((s) => s.prefs.showHints && !s.viewOnly && !isExplainTool(s.tool));
  const hint = placing ? `Placing — click to drop · ${keyOf('arrange.rotateCw')} rotate · ${keyOf('arrange.flipH')}/${keyOf('arrange.flipV')} flip · Esc cancel` : TOOL_HINT[tool];
  return (
    <footer className="statusbar">
      <span className="status-hint">{hintLine ? null : hint}</span>
      <span className="grow" />
      {filePath && <span className="status-item path" title={filePath}>{filePath.split(/[\\/]/).pop()}</span>}
      {scope && <span className="status-item accent">in group</span>}
      {selection > 0 && <span className="status-item">{selection} selected</span>}
      <SnapToggles />
      <span className="status-item mono status-coords">
        {cx}, {cy}
      </span>
      <span className="status-item mono">{Math.round(zoom * 100)}%</span>
    </footer>
  );
}

const GRID_STYLE_ICONS: Record<GridStyle, ReactNode> = { dots: <Grip size={13} />, lines: <Hash size={13} />, crosses: <Plus size={13} />, major: <Grid2x2 size={13} /> };

/** One-click toggles for the grid (and its style), snapping, the kinds of guide and part names / values, without going through menus. */
function SnapToggles() {
  const showGrid = useStore((s) => s.doc.settings.showGrid);
  const snapOn = useStore((s) => s.doc.settings.snap);
  const grid = useStore((s) => s.doc.settings.grid);
  const align = useStore((s) => s.prefs.alignGuides);
  const spacing = useStore((s) => s.prefs.spacingGuides);
  const labels = useStore((s) => s.prefs.labelGuides);
  const viewOnly = useStore((s) => s.viewOnly);
  const gridStyle = useStore((s) => s.doc.settings.gridStyle ?? 'dots');
  const refs = useStore((s) => !s.doc.settings.hideRefs);
  const values = useStore((s) => !s.doc.settings.hideValues);
  const wireNames = useStore((s) => !s.doc.settings.hideWireLabels);
  const docSetting = (id: string) => ['view.grid', 'view.snap', 'view.gridStyle', 'view.refs', 'view.values', 'view.wireLabels'].includes(id);
  const toggle = (id: string, on: boolean, label: string, icon: ReactNode, text?: string) => (
    <button
      className={`status-toggle${on ? ' on' : ''}`}
      onClick={() => COMMAND_MAP.get(id)!.run()}
      title={`${label}: ${on ? 'on' : 'off'}${keyOf(id) ? ` (${keyOf(id)})` : ''}`}
      aria-pressed={on}
      disabled={viewOnly && docSetting(id)}
    >
      {icon}
      {text && <span>{text}</span>}
    </button>
  );
  return (
    <span className="status-toggles">
      {toggle('view.grid', showGrid, 'Show grid', <Grid3x3 size={13} />)}
      <button
        className="status-toggle"
        onClick={() => COMMAND_MAP.get('view.gridStyle')!.run()}
        title={`Grid style: ${GRID_STYLE_NAMES[gridStyle]} (click for the next)`}
        disabled={viewOnly}
      >
        {GRID_STYLE_ICONS[gridStyle]}
      </button>
      {toggle('view.snap', snapOn, 'Snap to grid', <Magnet size={13} />, snapOn ? `${grid}px` : 'off')}
      <span className="status-sep" />
      {toggle('view.alignGuides', align, 'Alignment guides', <Crosshair size={13} />)}
      {toggle('view.spacingGuides', spacing, 'Equal-spacing guides', <Columns3 size={13} />)}
      {toggle('view.labelGuides', labels, 'Part names and values follow guides', <Type size={13} />)}
      <span className="status-sep" />
      {toggle('view.refs', refs, 'Show part names', null, 'R1')}
      {toggle('view.values', values, 'Show part values', null, '10k')}
      {toggle('view.wireLabels', wireNames, 'Show wire names', null, 'net')}
    </span>
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
