import {
  Check,
  CircleDot,
  Unplug,
  Pentagon,
  Route,
  PenTool,
  ArrowUpRight,
  Circle,
  Download,
  Hand,
  Keyboard,
  Minus,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Redo2,
  RectangleHorizontal,
  Search,
  Spline,
  Square,
  Type,
  Undo2,
  Presentation,
  Frame,
  Film,
  Lock,
  LockOpen,
  Eye,
  X as XIcon,
} from 'lucide-react';
import { isExplainTool, useExplain } from '../store/explain';
import { useEffect, useRef, useState } from 'react';
import type { Tool } from '../model/types';
import * as A from '../store/actions';
import { openExport } from '../io/fileActions';
import { COMMANDS, COMMAND_MAP, keysFor, prettyKey } from '../store/commands';
import { S, mutate, readOnly, redo, set, undo, useStore } from '../store/store';
import { CollabBar } from './CollabBar';
import { Logo } from './Logo';
import { toggleTimeline } from './Timeline';
import { WireAngleButton } from './WireAngleButton';

const MENUS: { label: string; items: (string | '-')[] }[] = [
  {
    label: 'File',
    items: ['file.new', 'file.open', 'file.import', '-', 'file.save', 'file.saveAs', '-', 'file.export', 'file.exportSelection', 'file.print', '-', 'collab.share'],
  },
  {
    label: 'Edit',
    items: ['edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'file.copyPng', 'file.copySvg', 'edit.paste', 'edit.pasteHere', 'edit.duplicate', 'edit.delete', '-', 'edit.selectAll', 'edit.find', 'edit.lock', 'edit.hide', '-', 'edit.annotate', '-', 'help.settings'],
  },
  {
    label: 'Place',
    items: ['tool.wire', 'tool.placeLast', 'tool.lock', '-', 'tool.resistor', 'tool.capacitor', 'tool.ground', 'tool.vcc', 'tool.netLabel', 'tool.junction', '-', 'tool.rect', 'tool.zone', 'tool.ellipse', 'tool.polygon', 'tool.path', 'tool.line', 'tool.arrow', 'tool.text', '-', 'symbols.new', 'symbols.fromSelection', 'symbols.edit'],
  },
  {
    label: 'Arrange',
    items: [
      'arrange.rotateCw', 'arrange.rotateCcw', 'arrange.flipH', 'arrange.flipV', '-',
      'arrange.group', 'arrange.ungroup', 'arrange.enterGroup', 'arrange.exitGroup', 'arrange.toPath', '-',
      'arrange.alignLeft', 'arrange.alignHCenter', 'arrange.alignRight', 'arrange.alignTop', 'arrange.alignVCenter', 'arrange.alignBottom', 'arrange.distH', 'arrange.distV', '-',
      'arrange.sameWidth', 'arrange.sameHeight', 'arrange.sameSize', '-',
      'arrange.front', 'arrange.forward', 'arrange.backward', 'arrange.back',
    ],
  },
  { label: 'Page', items: ['page.new', 'page.duplicate', 'page.rename', 'page.delete', '-', 'page.prev', 'page.next', '-', 'page.moveLeft', 'page.moveRight'] },
  { label: 'Wire', items: ['tool.wire', 'tool.solder', 'wire.reroute', 'wire.highlightNet', '-', 'wire.hops', 'wire.corners'] },
  {
    label: 'Explain',
    items: ['explain.toggle', '-', 'tool.pen', 'tool.highlighter', 'tool.laser', 'tool.eraser', '-', 'tool.trace', 'tool.callout', '-', 'tool.frame', 'present.timeline', 'explain.present', 'present.video', '-', 'explain.renumber', 'explain.clear'],
  },
  {
    label: 'View',
    items: ['view.zoomIn', 'view.zoomOut', 'view.fit', 'view.fitSel', 'view.100', '-', 'view.viewMode', 'view.stats', '-', 'view.grid', 'view.gridStyle', 'view.snap', 'view.minimap', 'view.alignGuides', 'view.spacingGuides', 'view.labelGuides', '-', 'view.refs', 'view.values', 'view.wireLabels', '-', 'view.library', 'view.layers', 'view.check', 'view.inspector', 'view.focus', '-', 'view.theme'],
  },
  { label: 'Help', items: ['help.palette', 'help.shortcuts', '-', 'help.about'] },
];

function MenuBar() {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open === null) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div className="menubar" ref={ref}>
      {MENUS.map((m, i) => (
        <div key={m.label} className="menu-root">
          <button className={open === i ? 'menu-btn open' : 'menu-btn'} onClick={() => setOpen(open === i ? null : i)} onPointerEnter={() => open !== null && setOpen(i)}>
            {m.label}
          </button>
          {open === i && (
            <div className="dropdown">
              {m.items.map((id, j, all) => {
                if (id === '-') return <div key={j} className="dropdown-sep" />;
                const c = COMMAND_MAP.get(id);
                if (!c) return null;
                const k = keysFor(id)[0];
                const on = c.checked?.();
                // keep labels aligned when some entries of this menu carry a tick
                const slot = all.some((x) => COMMAND_MAP.get(x)?.checked);
                return (
                  <button
                    key={id}
                    className="dropdown-item"
                    disabled={c.when ? !c.when() : false}
                    onClick={() => {
                      setOpen(null);
                      c.run();
                    }}
                  >
                    <span className="dropdown-label">
                      {slot && <span className="dropdown-check">{on && <Check size={13} />}</span>}
                      {c.label}
                    </span>
                    {k && <kbd>{prettyKey(k)}</kbd>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DocName() {
  const name = useStore((s) => s.doc.name);
  const dirty = useStore((s) => s.dirty);
  const locked = useStore(readOnly);
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  if (editing)
    return (
      <input
        className="doc-name-input"
        autoFocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (v.trim() && v !== name) mutate((d) => void (d.name = v.trim()));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setV(name);
            setEditing(false);
          }
        }}
      />
    );
  return (
    <button className="doc-name" onClick={() => !locked && setEditing(true)} title={locked ? name : 'Rename circuit'}>
      <span className="doc-name-text">{name}</span>
      {dirty && <span className="dirty-dot" title="Unsaved changes" />}
    </button>
  );
}

/** Shown while View mode is on; a click goes back to editing. */
function ViewModePill() {
  const on = useStore((s) => s.viewMode);
  useStore((s) => s.prefs.keymap);
  useStore((s) => s.prefs.keymapCadence);
  if (!on) return null;
  const k = prettyKey(keysFor('view.viewMode')[0] ?? '');
  return (
    <button className="view-pill" onClick={() => A.setViewMode(false)} title={`View mode: the circuit can’t be changed. Click to edit${k ? ` (${k})` : ''}`}>
      <Eye size={13} />
      <span className="view-pill-label">View mode</span>
      <XIcon size={12} className="view-pill-x" />
    </button>
  );
}

export function TopBar() {
  const canUndo = useStore((s) => s.past.length > 0 && !readOnly(s));
  const canRedo = useStore((s) => s.future.length > 0 && !readOnly(s));
  const zoom = useStore((s) => s.view.zoom);
  const left = useStore((s) => s.leftPanel);
  const right = useStore((s) => s.rightPanel);
  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand" title="Nodal">
          <Logo size={22} />
          <span>Nodal</span>
        </div>
        <MenuBar />
      </div>
      <div className="topbar-center">
        <DocName />
        <ViewModePill />
      </div>
      <div className="topbar-right">
        <button className="icon-btn" title={`Command palette (${prettyKey(keysFor('help.palette')[0] ?? '')})`} onClick={() => set({ dialog: 'palette' })}>
          <Search size={16} />
          <span className="palette-hint">{prettyKey(keysFor('help.palette')[0] ?? '')}</span>
        </button>
        <span className="divider" />
        <button className="icon-btn" disabled={!canUndo} onClick={undo} title={`Undo (${prettyKey(keysFor('edit.undo')[0] ?? '')})`}>
          <Undo2 size={16} />
        </button>
        <button className="icon-btn" disabled={!canRedo} onClick={redo} title={`Redo (${prettyKey(keysFor('edit.redo')[0] ?? '')})`}>
          <Redo2 size={16} />
        </button>
        <span className="divider" />
        <button className="zoom-chip" onClick={() => A.fitView()} title="Zoom to fit (F)">
          {Math.round(zoom * 100)}%
        </button>
        <button className={left ? 'icon-btn active' : 'icon-btn'} onClick={() => set({ leftPanel: !left })} title="Toggle library (Ctrl+B)">
          <PanelLeft size={16} />
        </button>
        <button className={right ? 'icon-btn active' : 'icon-btn'} onClick={() => set({ rightPanel: !right })} title="Toggle properties (Ctrl+I)">
          <PanelRight size={16} />
        </button>
        <button className="icon-btn tb-optional" onClick={() => set({ dialog: 'shortcuts' })} title="Keyboard shortcuts (?)">
          <Keyboard size={16} />
        </button>
        <span className="divider" />
        <CollabBar />
        <button className="primary-btn" onClick={() => openExport()} title="Export">
          <Download size={15} /> <span className="btn-label">Export</span>
        </button>
      </div>
    </header>
  );
}

/** The keycap under a tool icon: the key itself, not the modifiers (the tooltip has the whole combo). */
const railKey = (id: string) => {
  const k = keysFor(id)[0];
  return k ? prettyKey(k.split('+').pop() ?? k) : '';
};

const TOOLS: { tool: Tool; icon: JSX.Element; label: string; cmd: string; alt?: boolean; desc?: string }[] = [
  { tool: 'select', icon: <MousePointer2 size={17} />, label: 'Move / select', cmd: 'tool.select', desc: 'Click to select · drag to move · drag empty canvas to box-select' },
  { tool: 'select', alt: true, icon: <Unplug size={17} />, label: 'Alt move (leave wires behind)', cmd: 'tool.altMove', desc: 'Moves parts without dragging their wires along' },
  { tool: 'node', icon: <PenTool size={17} />, label: 'Edit points', cmd: 'tool.node', desc: 'Drag bends, wire ends and shape nodes' },
  { tool: 'pan', icon: <Hand size={17} />, label: 'Pan', cmd: 'tool.pan', desc: 'Drag to look around · or hold Space with any tool' },
  { tool: 'wire', icon: <Spline size={17} />, label: 'Wire', cmd: 'tool.wire', desc: 'Drag from a pin, or click to add bends' },
  { tool: 'solder', icon: <CircleDot size={17} />, label: 'Solder', cmd: 'tool.solder', desc: 'Click a crossing or touching end to join it; click a junction to split it' },
  { tool: 'rect', icon: <Square size={17} />, label: 'Rectangle', cmd: 'tool.rect', desc: 'Outline box · double-click it to add a title' },
  { tool: 'zone', icon: <RectangleHorizontal size={17} fill="currentColor" fillOpacity={0.35} />, label: 'Filled zone', cmd: 'tool.zone', desc: 'Tinted area with a title, drawn behind the circuit' },
  { tool: 'ellipse', icon: <Circle size={17} />, label: 'Ellipse', cmd: 'tool.ellipse', desc: 'Drag to draw an ellipse' },
  { tool: 'polygon', icon: <Pentagon size={17} />, label: 'Polygon', cmd: 'tool.polygon', desc: 'Click for corners · click the first one to close' },
  { tool: 'path', icon: <Route size={17} />, label: 'Path', cmd: 'tool.path', desc: 'Click for corners, drag for curves' },
  { tool: 'line', icon: <Minus size={17} style={{ transform: 'rotate(-45deg)' }} />, label: 'Line', cmd: 'tool.line', desc: 'Ends attach to shapes and parts · Shift for 45°' },
  { tool: 'arrow', icon: <ArrowUpRight size={17} />, label: 'Arrow', cmd: 'tool.arrow', desc: 'Ends attach to shapes and parts · Shift for 45°' },
  { tool: 'text', icon: <Type size={17} />, label: 'Text', cmd: 'tool.text', desc: 'Click to place text · $…$ typesets maths' },
  { tool: 'frame', icon: <Frame size={17} />, label: 'Presentation frame', cmd: 'tool.frame', desc: 'Drag an area to show as a step when presenting' },
];

export function ToolRail() {
  const tool = useStore((s) => s.tool);
  const placing = useStore((s) => s.placing);
  const altMove = useStore((s) => s.altMove);
  const armed = useStore((s) => s.shapePreset);
  const lastExplain = useExplain((s) => s.lastTool);
  const timelineOpen = useExplain((s) => s.timelineOpen);
  const toolLock = useStore((s) => s.prefs.toolLock);
  const lockKey = prettyKey(keysFor('tool.lock')[0] ?? '');
  const locked = useStore(readOnly);
  if (locked) {
    // View mode (or a view-only session): only the tools that look
    return (
      <div className="tool-rail" onPointerDown={(e) => e.stopPropagation()}>
        {TOOLS.filter((t) => !t.alt && A.VIEW_TOOLS.has(t.tool)).map((t) => (
          <button key={t.cmd} className={tool === t.tool ? 'tool-btn active' : 'tool-btn'} onClick={() => A.setTool(t.tool)} title={`${t.label} (${prettyKey(keysFor(t.cmd)[0] ?? '')})`}>
            {t.icon}
            <span className="tool-key">{railKey(t.cmd)}</span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="tool-rail" onPointerDown={(e) => e.stopPropagation()}>
      <button
        className={toolLock ? 'tool-btn lock-btn on' : 'tool-btn lock-btn'}
        onClick={A.toggleToolLock}
        aria-pressed={toolLock}
        title={`Tool lock: keep placing parts after each click${lockKey ? ` (${lockKey})` : ''}`}
      >
        {toolLock ? <Lock size={16} /> : <LockOpen size={16} />}
      </button>
      <span className="rail-sep" />
      {TOOLS.map((t, i) => (
        <span key={t.cmd} style={{ display: 'contents' }}>
          {(i === 4 || i === 6) && <span className="rail-sep" />}
          <button
            className={tool === t.tool && !!t.alt === altMove && !placing && !(armed && t.tool === 'rect') ? 'tool-btn active' : 'tool-btn'}
            onClick={() => (t.alt ? A.setAltMove() : A.setTool(t.tool))}
            title={`${t.label} (${prettyKey(keysFor(t.cmd)[0] ?? '')})`}
            data-tip-desc={t.desc}
          >
            {t.icon}
            <span className="tool-key">{railKey(t.cmd)}</span>
          </button>
          {t.tool === 'wire' && <WireAngleButton />}
        </span>
      ))}
      <span className="rail-sep" />
      <button
        className={isExplainTool(tool) ? 'tool-btn explain-btn active' : 'tool-btn explain-btn'}
        onClick={A.toggleExplain}
        title="Explain tools"
        data-tip-desc="Pen, highlighter, laser, callouts and net tracing"
      >
        <Presentation size={17} />
        <span className="tool-key">{railKey(`tool.${lastExplain}`)}</span>
      </button>
      <button className={timelineOpen ? 'tool-btn active' : 'tool-btn'} onClick={toggleTimeline} title={`Presentation timeline (${prettyKey(keysFor('present.timeline')[0] ?? '')})`}>
        <Film size={17} />
      </button>
    </div>
  );
}

export const ALL_COMMANDS = COMMANDS;
export const getState = S;
